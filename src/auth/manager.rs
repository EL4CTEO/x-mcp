//! Picks the credential for every request, refreshes OAuth 2.0 tokens once
//! across concurrent calls, and persists rotated refresh tokens.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::oauth1;
use super::oauth2::{TokenSet, token_request};
use super::store::{CredentialStore, StoredOAuth2};
use crate::config::Config;
use crate::obj;
use crate::util::{Json, now_ms};
use crate::x::errors::ToolError;

const REFRESH_MARGIN_MS: u64 = 60_000;
pub const USER_HINT: &str = "Run `x-mcp auth` to sign in with OAuth 2.0 (PKCE), or set X_OAUTH2_ACCESS_TOKEN / OAuth 1.0a credentials.";

#[derive(Clone, Debug)]
struct Client {
    client_id: String,
    client_secret: Option<String>,
    scopes: Option<Vec<String>>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    from_env_token: bool,
}

#[derive(Clone, Debug, Default)]
struct Runtime {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    scopes: Option<Vec<String>>,
    refreshed: bool,
}

#[derive(Clone, Debug)]
struct State {
    client_id: String,
    client_secret: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    scopes: Option<Vec<String>>,
    from_env: bool,
    from_file: bool,
}

pub struct AuthManager {
    config: Config,
    store: CredentialStore,
    http: reqwest::Client,
    runtime: Mutex<Runtime>,
    refresh_lock: tokio::sync::Mutex<()>,
    generation: AtomicU64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UserKind {
    OAuth2,
    OAuth1,
}

impl UserKind {
    pub fn as_str(self) -> &'static str {
        match self {
            UserKind::OAuth2 => "oauth2",
            UserKind::OAuth1 => "oauth1",
        }
    }
}

impl AuthManager {
    pub fn new(config: &Config, http: reqwest::Client) -> Self {
        AuthManager {
            store: CredentialStore::new(&config.credential_file),
            config: config.clone(),
            http,
            runtime: Mutex::new(Runtime::default()),
            refresh_lock: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    fn rt(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn bearer(&self) -> Option<&str> {
        self.config.auth.bearer_token.as_deref()
    }

    pub fn has_bearer(&self) -> bool {
        self.bearer().is_some()
    }

    pub fn has_oauth1(&self) -> bool {
        self.config.auth.oauth1.as_ref().is_some_and(|o| {
            !o.consumer_secret.is_empty()
                && o.access_token.is_some()
                && o.access_token_secret.is_some()
        })
    }

    pub fn has_oauth2(&self) -> bool {
        self.client()
            .is_some_and(|c| c.access_token.is_some() || c.refresh_token.is_some())
    }

    pub fn has_user(&self) -> bool {
        self.has_oauth2() || self.has_oauth1()
    }

    pub fn user_kind(&self) -> Option<UserKind> {
        if self.has_oauth2() {
            Some(UserKind::OAuth2)
        } else if self.has_oauth1() {
            Some(UserKind::OAuth1)
        } else {
            None
        }
    }

    pub fn oauth1(&self) -> Result<oauth1::Credentials, ToolError> {
        match &self.config.auth.oauth1 {
            Some(o) if self.has_oauth1() => Ok(oauth1::Credentials {
                consumer_key: o.consumer_key.clone(),
                consumer_secret: o.consumer_secret.clone(),
                access_token: o.access_token.clone().unwrap_or_default(),
                access_token_secret: o.access_token_secret.clone().unwrap_or_default(),
            }),
            _ => Err(ToolError::auth(
                "OAuth 1.0a user credentials are incomplete.",
                "missing_user_auth",
                USER_HINT,
            )),
        }
    }

    /// Environment over the credential file. X rotates refresh tokens on every
    /// use, so the stored (rotated) one beats a stale environment value.
    fn client(&self) -> Option<Client> {
        let env = self.config.auth.oauth2.as_ref();
        let stored = self.store.oauth2();
        let client_id = env
            .map(|e| e.client_id.clone())
            .or_else(|| stored.as_ref().map(|s| s.client_id.clone()))?;
        let env_token = env.and_then(|e| e.access_token.clone());
        Some(Client {
            client_id,
            client_secret: env
                .and_then(|e| e.client_secret.clone())
                .or_else(|| stored.as_ref().and_then(|s| s.client_secret.clone())),
            scopes: env
                .and_then(|e| e.scopes.clone())
                .or_else(|| stored.as_ref().and_then(|s| s.scopes.clone())),
            access_token: env_token
                .clone()
                .or_else(|| stored.as_ref().map(|s| s.access_token.clone())),
            refresh_token: stored
                .as_ref()
                .and_then(|s| s.refresh_token.clone())
                .or_else(|| env.and_then(|e| e.refresh_token.clone())),
            expires_at: if env_token.is_some() {
                None
            } else {
                stored.as_ref().and_then(|s| s.expires_at)
            },
            from_env_token: env_token.is_some(),
        })
    }

    fn state(&self) -> Option<State> {
        let client = self.client()?;
        let rt = self.rt().clone();
        if let Some(access_token) = rt.access_token {
            return Some(State {
                client_id: client.client_id,
                client_secret: client.client_secret,
                access_token,
                refresh_token: rt.refresh_token.or(client.refresh_token),
                expires_at: rt.expires_at,
                scopes: rt.scopes.or(client.scopes),
                from_env: false,
                from_file: rt.refreshed,
            });
        }
        let access_token = client.access_token?;
        Some(State {
            client_id: client.client_id,
            client_secret: client.client_secret,
            access_token,
            refresh_token: client.refresh_token,
            expires_at: client.expires_at,
            scopes: client.scopes,
            from_env: client.from_env_token,
            from_file: !client.from_env_token,
        })
    }

    /// A usable access token, refreshed when within 60 s of expiry or when
    /// `force` is set after a 401.
    pub async fn oauth2_token(&self, force: bool) -> Result<String, ToolError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let state = match self.state() {
            Some(state) => state,
            None => {
                let client = self.client();
                let Some(client) = client.filter(|c| c.refresh_token.is_some()) else {
                    return Err(ToolError::auth(
                        "No OAuth 2.0 session configured.",
                        "missing_user_auth",
                        USER_HINT,
                    ));
                };
                // A session can be a refresh token alone: mint an access token.
                let state = State {
                    client_id: client.client_id,
                    client_secret: client.client_secret,
                    access_token: String::new(),
                    refresh_token: client.refresh_token,
                    expires_at: Some(0),
                    scopes: client.scopes,
                    from_env: false,
                    from_file: self.store.oauth2().is_some(),
                };
                return self.refresh(state, generation).await;
            }
        };
        let expiring = state
            .expires_at
            .is_some_and(|at| (at as i64) - (now_ms() as i64) < REFRESH_MARGIN_MS as i64);
        if !force && !expiring {
            return Ok(state.access_token);
        }
        if state.refresh_token.is_none() {
            if force {
                return Err(ToolError::auth(
                    "The access token was rejected and no refresh token is available.",
                    "missing_refresh_token",
                    USER_HINT,
                ));
            }
            return Ok(state.access_token);
        }
        self.refresh(state, generation).await
    }

    async fn refresh(&self, state: State, generation: u64) -> Result<String, ToolError> {
        let _guard = self.refresh_lock.lock().await;
        if self.generation.load(Ordering::SeqCst) != generation
            && let Some(token) = self.rt().access_token.clone()
        {
            return Ok(token); // another caller refreshed while we waited
        }
        crate::debug!("refreshing OAuth 2.0 access token", "clientId" => state.client_id.clone());
        let refresh_token = state.refresh_token.clone().unwrap_or_default();
        let result = token_request(
            &self.http,
            &self.config.token_url,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh_token),
            ],
            &state.client_id,
            state.client_secret.as_deref(),
        )
        .await;
        match result {
            Ok(tokens) => {
                self.apply(&tokens, &state);
                self.generation.fetch_add(1, Ordering::SeqCst);
                Ok(tokens.access_token)
            }
            Err(detail) => {
                crate::warn!("OAuth 2.0 refresh failed", "err" => detail.clone());
                Err(ToolError::auth(
                    format!("Could not refresh the OAuth 2.0 access token: {detail}"),
                    "refresh_failed",
                    format!(
                        "{USER_HINT} The refresh token may have been revoked or already rotated."
                    ),
                ))
            }
        }
    }

    fn apply(&self, tokens: &TokenSet, previous: &State) {
        let (refresh_token, expires_at, scopes) = {
            let mut rt = self.rt();
            rt.access_token = Some(tokens.access_token.clone());
            rt.refresh_token = tokens
                .refresh_token
                .clone()
                .or_else(|| previous.refresh_token.clone());
            rt.expires_at = tokens.expires_in.map(|s| now_ms() + s * 1000);
            rt.scopes = tokens.scope.clone().or_else(|| previous.scopes.clone());
            rt.refreshed = true;
            (rt.refresh_token.clone(), rt.expires_at, rt.scopes.clone())
        };
        if refresh_token.is_some() {
            let saved = self.store.save(StoredOAuth2 {
                client_id: previous.client_id.clone(),
                client_secret: previous.client_secret.clone(),
                access_token: tokens.access_token.clone(),
                refresh_token,
                expires_at,
                scopes,
                token_type: Some(tokens.token_type.clone()),
                redirect_uri: None,
            });
            match saved {
                Ok(()) if !previous.from_file => crate::info!(
                    "persisted rotated OAuth 2.0 tokens; update environment refresh tokens or use x-mcp auth to keep them stable",
                    "file" => self.store.file.display().to_string()
                ),
                Ok(()) => {}
                Err(e) => crate::warn!("could not persist rotated tokens", "err" => e.to_string()),
            }
        }
    }

    pub fn status(&self) -> Status {
        let state = self.state();
        let refreshed = self.rt().refreshed;
        let mut missing = vec![];
        if !self.has_bearer() {
            missing.push("app-only bearer token (X_BEARER_TOKEN)".to_owned());
        }
        if !self.has_oauth2() {
            missing.push("OAuth 2.0 user session (run `x-mcp auth`)".to_owned());
        }
        if !self.has_oauth1() {
            missing.push("OAuth 1.0a user credentials".to_owned());
        }
        Status {
            bearer: self.has_bearer(),
            oauth2: self.has_oauth2(),
            oauth1: self.has_oauth1(),
            oauth2_expires_at: state.as_ref().and_then(|s| s.expires_at),
            oauth2_scopes: state.as_ref().and_then(|s| s.scopes.clone()),
            oauth2_source: if refreshed {
                Some("refreshed")
            } else {
                state.as_ref().and_then(|s| {
                    if s.from_env {
                        Some("env")
                    } else if s.from_file {
                        Some("file")
                    } else {
                        None
                    }
                })
            },
            missing,
        }
    }
}

pub struct Status {
    pub bearer: bool,
    pub oauth2: bool,
    pub oauth1: bool,
    pub oauth2_expires_at: Option<u64>,
    pub oauth2_scopes: Option<Vec<String>>,
    pub oauth2_source: Option<&'static str>,
    pub missing: Vec<String>,
}

impl Status {
    pub fn modes(&self) -> Vec<Value> {
        let mut modes = vec![];
        if self.bearer {
            modes.push("app-only bearer".into());
        }
        if self.oauth2 {
            modes.push("OAuth 2.0 user".into());
        }
        if self.oauth1 {
            modes.push("OAuth 1.0a user".into());
        }
        modes
    }

    pub fn to_json(&self) -> Json {
        obj! {
            "bearer" => self.bearer,
            "oauth2" => self.oauth2,
            "oauth1" => self.oauth1,
            "oauth2ExpiresAt" => self.oauth2_expires_at,
            "oauth2Scopes" => self.oauth2_scopes.clone().map(|s| s.into_iter().map(Value::String).collect::<Vec<_>>()),
            "oauth2Source" => self.oauth2_source,
            "missing" => self.missing.iter().cloned().map(Value::String).collect::<Vec<_>>(),
        }
    }
}
