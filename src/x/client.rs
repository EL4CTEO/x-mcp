//! The single gateway to api.x.com: URL assembly, auth selection, rate-limit
//! pre-flight, caching with coalescing, one-shot 401 recovery, error
//! normalisation, dry-run auditing and mutation-driven cache invalidation.

use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use reqwest::Method;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::cache::TtlCache;
use super::errors::{RateLimitInfo, ToolError, XApiError, XResult};
use super::http::{Body, FormValue, HttpRequest, HttpTransport};
use super::ratelimit::{RateLimiter, bucket_key};
use crate::auth::manager::{AuthManager, UserKind};
use crate::auth::oauth1;
use crate::config::{Config, RateLimitMode};
use crate::obj;
use crate::util::Json;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Auth {
    /// App-only bearer when available (cheapest, separate quota), else user.
    Auto,
    App,
    User,
    OAuth2,
    OAuth1,
}

#[derive(Clone, Copy, Debug)]
pub enum CacheMode {
    Default,
    Off,
    Ttl(u64),
}

#[derive(Clone, Debug)]
pub struct XRequest {
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    pub form: Option<Vec<(String, FormValue)>>,
    pub auth: Auth,
    pub cache: CacheMode,
    pub idempotent: bool,
    /// Media uploads go to X_UPLOAD_BASE.
    pub upload: bool,
}

impl XRequest {
    pub fn new(method: Method, path: impl Into<String>) -> Self {
        XRequest {
            method,
            path: path.into(),
            query: vec![],
            body: None,
            form: None,
            auth: Auth::Auto,
            cache: CacheMode::Default,
            idempotent: false,
            upload: false,
        }
    }
    pub fn get(path: impl Into<String>) -> Self {
        Self::new(Method::GET, path)
    }
    pub fn post(path: impl Into<String>) -> Self {
        Self::new(Method::POST, path)
    }
    pub fn put(path: impl Into<String>) -> Self {
        Self::new(Method::PUT, path)
    }
    pub fn delete(path: impl Into<String>) -> Self {
        Self::new(Method::DELETE, path)
    }
    pub fn auth(mut self, auth: Auth) -> Self {
        self.auth = auth;
        self
    }
    pub fn user(self) -> Self {
        self.auth(Auth::User)
    }
    pub fn cache_ttl(mut self, ms: u64) -> Self {
        self.cache = CacheMode::Ttl(ms);
        self
    }
    pub fn no_cache(mut self) -> Self {
        self.cache = CacheMode::Off;
        self
    }
    pub fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }
    pub fn form(mut self, form: Vec<(String, FormValue)>) -> Self {
        self.form = Some(form);
        self
    }
    pub fn upload(mut self) -> Self {
        self.upload = true;
        self
    }
    pub fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }
    /// Adds a query parameter; `None` values are skipped.
    pub fn q(mut self, key: &str, value: impl QueryValue) -> Self {
        if let Some(value) = value.query_value() {
            if let Some(slot) = self.query.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value;
            } else {
                self.query.push((key.to_owned(), value));
            }
        }
        self
    }
    pub fn qs(mut self, pairs: &[(&str, &str)]) -> Self {
        for (k, v) in pairs {
            self = self.q(k, *v);
        }
        self
    }
}

pub trait QueryValue {
    fn query_value(self) -> Option<String>;
}
impl QueryValue for &str {
    fn query_value(self) -> Option<String> {
        Some(self.to_owned())
    }
}
impl QueryValue for String {
    fn query_value(self) -> Option<String> {
        Some(self)
    }
}
impl QueryValue for Option<String> {
    fn query_value(self) -> Option<String> {
        self
    }
}
impl QueryValue for Option<&str> {
    fn query_value(self) -> Option<String> {
        self.map(str::to_owned)
    }
}
impl QueryValue for u64 {
    fn query_value(self) -> Option<String> {
        Some(self.to_string())
    }
}
impl QueryValue for Option<u64> {
    fn query_value(self) -> Option<String> {
        self.map(|v| v.to_string())
    }
}
impl QueryValue for &Value {
    fn query_value(self) -> Option<String> {
        match self {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        }
    }
}

/// A parsed X response. `data` is the payload's `data`, or the whole
/// payload when it has none (legacy endpoints).
#[derive(Clone, Debug)]
pub struct XResponse {
    pub data: Value,
    pub includes: Option<Value>,
    pub meta: Option<Value>,
    pub errors: Option<Value>,
}

impl XResponse {
    /// `{data, includes, meta, errors}` for the normalisers.
    pub fn payload(&self) -> Value {
        Value::Object(obj! {
            "data" => self.data.clone(),
            "includes" => self.includes.clone(),
            "meta" => self.meta.clone(),
            "errors" => self.errors.clone(),
        })
    }

    pub fn data_str(&self, key: &str) -> Option<String> {
        self.data
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    pub fn data_true(&self, key: &str) -> bool {
        self.data.get(key) == Some(&Value::Bool(true))
    }

    pub fn meta_field(&self, key: &str) -> Option<Value> {
        self.meta.as_ref().and_then(|m| m.get(key)).cloned()
    }
}

struct Audit {
    seq: u64,
    entries: Vec<(u64, Value)>,
}

pub struct XClient {
    pub config: Config,
    pub auth: AuthManager,
    pub limiter: RateLimiter,
    http: HttpTransport,
    cache: Arc<TtlCache<Arc<XResponse>, ToolError>>,
    audit: Mutex<Audit>,
}

impl XClient {
    pub fn new(config: &Config) -> Arc<Self> {
        let http = HttpTransport::new(config);
        Arc::new(XClient {
            auth: AuthManager::new(config, http.client().clone()),
            limiter: RateLimiter::new(config.rate_limit_mode, config.max_wait_ms),
            cache: Arc::new(TtlCache::new(config.cache_max)),
            http,
            config: config.clone(),
            audit: Mutex::new(Audit {
                seq: 0,
                entries: vec![],
            }),
        })
    }

    pub fn url(&self, request: &XRequest) -> String {
        let base = if request.upload {
            &self.config.upload_base
        } else {
            &self.config.api_base
        };
        let raw = if request.path.starts_with("http") {
            request.path.clone()
        } else {
            format!("{base}{}", request.path)
        };
        let mut url = url::Url::parse(&raw)
            .unwrap_or_else(|_| url::Url::parse("http://invalid/").expect("url"));
        if !request.query.is_empty() {
            let existing: Vec<(String, String)> = url.query_pairs().into_owned().collect();
            let mut merged = existing;
            for (k, v) in &request.query {
                merged.retain(|(ek, _)| ek != k);
                merged.push((k.clone(), v.clone()));
            }
            url.query_pairs_mut().clear().extend_pairs(merged);
        }
        url.to_string()
    }

    pub async fn request(self: &Arc<Self>, request: XRequest) -> XResult<XResponse> {
        let url = self.url(&request);
        let path = url::Url::parse(&url)
            .map(|u| u.path().to_owned())
            .unwrap_or_default();
        let bucket = bucket_key(request.method.as_str(), &path);

        if self.config.dry_run && request.method != Method::GET {
            return Ok(self.preview(&request, &url));
        }

        let is_get = request.method == Method::GET;
        let cacheable = is_get
            && self.config.cache_enabled
            && !matches!(request.cache, CacheMode::Off)
            && !self.config.dry_run;
        if !cacheable {
            let result = self.execute(&request, &url, &bucket).await;
            if !is_get {
                self.cache.clear();
            }
            return result;
        }
        let ttl = match request.cache {
            CacheMode::Ttl(ms) => ms,
            _ => self.config.cache_ttl_ms,
        };
        if ttl == 0 {
            return self.execute(&request, &url, &bucket).await;
        }
        let key = format!(
            "{} {} {}",
            request.method,
            url,
            self.fingerprint(request.auth)
        );
        let me = Arc::clone(self);
        let load = async move { me.execute(&request, &url, &bucket).await.map(Arc::new) }.boxed();
        let (result, cached) = self.cache.get_or_load(&key, ttl, load).await;
        let _ = cached;
        result.map(|r| (*r).clone())
    }

    async fn execute(&self, request: &XRequest, url: &str, bucket: &str) -> XResult<XResponse> {
        self.limiter.acquire(bucket).await?;
        let mut refreshed = false;
        let mut fallback = false;
        loop {
            let (kind, authorization) = self.resolve_auth(request, url, fallback).await?;
            let body = if let Some(form) = &request.form {
                Body::Form(form.clone())
            } else if let Some(body) = &request.body {
                Body::Json(serde_json::to_string(body).unwrap_or_default())
            } else {
                Body::None
            };
            let response = self
                .http
                .request(HttpRequest {
                    method: request.method.clone(),
                    url,
                    headers: vec![
                        ("accept", "application/json".into()),
                        ("user-agent", self.config.user_agent.clone()),
                        ("authorization", authorization),
                    ],
                    body,
                    idempotent: request.method != Method::POST || request.idempotent,
                    retry_on_429: self.config.rate_limit_mode == RateLimitMode::Wait,
                    max_retry_delay_ms: self.config.max_wait_ms,
                })
                .await?;
            let info = RateLimitInfo::from_headers(&response.headers);
            self.limiter.observe(bucket, &info);
            let request_id = response
                .headers
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);

            if response.status == 401 && kind == Kind::OAuth2 && !refreshed {
                refreshed = true;
                crate::debug!("401 from X, forcing token refresh and retrying once", "url" => url);
                if self.auth.oauth2_token(true).await.is_ok() {
                    continue;
                }
            }
            // Auto auth prefers the bearer; protected resources reject it, so
            // retry once with the user session when one exists.
            if (response.status == 401 || response.status == 403)
                && kind == Kind::App
                && request.auth == Auth::Auto
                && !fallback
                && self.auth.has_user()
            {
                fallback = true;
                crate::debug!("retrying with user auth after app-only rejection", "url" => url, "status" => response.status as u64);
                continue;
            }
            if !(200..300).contains(&response.status) {
                return Err(XApiError::from_response(
                    response.status,
                    &response.headers,
                    &response.text,
                    request_id,
                )
                .into());
            }
            let payload: Value = if response.text.is_empty() {
                Value::Object(Json::new())
            } else {
                serde_json::from_str(&response.text).unwrap_or_else(|_| {
                    Value::Object(obj! { "data" => Value::Object(obj! { "raw" => response.text.clone() }), "status" => response.status as u64 })
                })
            };
            let errors = payload
                .get("errors")
                .filter(|e| e.as_array().is_some_and(|a| !a.is_empty()));
            if errors.is_some() && payload.get("data").is_none() {
                return Err(XApiError {
                    rate_limit: Some(info),
                    request_id,
                    ..XApiError::new(
                        response.status,
                        format!(
                            "X reported an error: {}",
                            errors.map(Value::to_string).unwrap_or_default()
                        ),
                    )
                }
                .into());
            }
            let field = |k: &str| payload.get(k).filter(|v| !v.is_null()).cloned();
            return Ok(XResponse {
                data: match payload.get("data") {
                    Some(d) if !d.is_null() => d.clone(),
                    _ => payload.clone(),
                },
                includes: field("includes"),
                meta: field("meta"),
                errors: payload.get("errors").filter(|e| e.is_array()).cloned(),
            });
        }
    }

    async fn resolve_auth(
        &self,
        request: &XRequest,
        url: &str,
        force_user: bool,
    ) -> XResult<(Kind, String)> {
        let a = &self.auth;
        let oauth2 = || async {
            Ok::<_, ToolError>((
                Kind::OAuth2,
                format!("Bearer {}", a.oauth2_token(false).await?),
            ))
        };
        let oauth1 = || -> XResult<(Kind, String)> {
            Ok((
                Kind::OAuth1,
                oauth1::sign(&a.oauth1()?, request.method.as_str(), url, None, None),
            ))
        };
        let bearer = || {
            (
                Kind::App,
                format!("Bearer {}", a.bearer().unwrap_or_default()),
            )
        };

        if force_user {
            if a.has_oauth2() {
                return oauth2().await;
            }
            if a.has_oauth1() {
                return oauth1();
            }
        }
        match request.auth {
            Auth::OAuth2 => oauth2().await,
            Auth::OAuth1 => oauth1(),
            Auth::User => match a.user_kind() {
                Some(UserKind::OAuth2) => oauth2().await,
                Some(UserKind::OAuth1) => oauth1(),
                None => Err(ToolError::auth(
                    "This tool needs a user-context credential (OAuth 2.0 or OAuth 1.0a), but none is configured.",
                    "missing_user_auth",
                    "Run `x-mcp auth`, set X_OAUTH2_ACCESS_TOKEN, or provide OAuth 1.0a keys.",
                )),
            },
            Auth::App => {
                if a.has_bearer() {
                    return Ok(bearer());
                }
                match a.user_kind() {
                    Some(UserKind::OAuth2) => oauth2().await,
                    Some(UserKind::OAuth1) => oauth1(),
                    None => Err(ToolError::auth(
                        "This tool needs an app-only bearer token (X_BEARER_TOKEN) or a user session.",
                        "missing_app_auth",
                        "Set X_BEARER_TOKEN for app-only access, or run `x-mcp auth` for user context.",
                    )),
                }
            }
            Auth::Auto => {
                if a.has_bearer() {
                    return Ok(bearer());
                }
                match a.user_kind() {
                    Some(UserKind::OAuth2) => oauth2().await,
                    Some(UserKind::OAuth1) => oauth1(),
                    None => Err(ToolError::auth(
                        "No X credentials are configured.",
                        "missing_app_auth",
                        "Set X_BEARER_TOKEN or run `x-mcp auth`.",
                    )),
                }
            }
        }
    }

    fn fingerprint(&self, auth: Auth) -> String {
        let a = &self.config.auth;
        let secret = a
            .bearer_token
            .clone()
            .or_else(|| a.oauth2.as_ref().and_then(|o| o.access_token.clone()))
            .or_else(|| a.oauth1.as_ref().and_then(|o| o.access_token.clone()))
            .unwrap_or_else(|| "anonymous".into());
        let digest = Sha256::digest(secret.as_bytes());
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        format!("{auth:?}:{hex}")
    }

    fn preview(&self, request: &XRequest, url: &str) -> XResponse {
        let auth = match self.auth.user_kind() {
            Some(kind) => format!("would use {}", kind.as_str()),
            None if self.auth.has_bearer() => "would use app".into(),
            None => "none (would fail: no credentials)".into(),
        };
        let mut audit = self.audit.lock().unwrap_or_else(|e| e.into_inner());
        audit.seq += 1;
        let seq = audit.seq;
        let mut entry = obj! { "seq" => seq, "method" => request.method.as_str(), "url" => url, "auth" => auth };
        if let Some(body) = &request.body {
            entry.insert("body".into(), body.clone());
        } else if let Some(form) = &request.form {
            let fields: Json = form
                .iter()
                .map(|(k, v)| {
                    let shown = match v {
                        FormValue::Text(t) => Value::String(t.clone()),
                        FormValue::File { data, mime, .. } => {
                            Value::String(format!("<{} bytes {mime}>", data.len()))
                        }
                    };
                    (k.clone(), shown)
                })
                .collect();
            entry.insert("form".into(), Value::Object(fields));
        }
        let entry = Value::Object(entry);
        audit.entries.push((seq, entry.clone()));
        if audit.entries.len() > 200 {
            audit.entries.remove(0);
        }
        crate::info!("dry-run: write not sent", "method" => request.method.as_str(), "url" => url);
        XResponse {
            data: Value::Object(obj! { "dry_run" => true, "request" => entry }),
            includes: None,
            meta: None,
            errors: None,
        }
    }

    pub fn audit_seq(&self) -> u64 {
        self.audit.lock().unwrap_or_else(|e| e.into_inner()).seq
    }

    pub fn audit_since(&self, seq: u64) -> Vec<Value> {
        let audit = self.audit.lock().unwrap_or_else(|e| e.into_inner());
        audit
            .entries
            .iter()
            .filter(|(s, _)| *s > seq)
            .map(|(_, e)| e.clone())
            .collect()
    }

    pub fn cache_stats(&self) -> Json {
        self.cache.stats()
    }

    pub fn rate_limits(&self) -> Json {
        self.limiter.snapshot()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    App,
    OAuth2,
    OAuth1,
}
