//! Agent-readable failures: X API errors, network errors, auth errors and
//! guardrail payloads all serialise to the same `{error, code?, hint?}` shape.

use crate::obj;
use crate::util::{Json, iso, now_ms};
use reqwest::header::HeaderMap;
use serde_json::{Value, json};

/// The rate-limit window X reported, as numbers exactly as the headers had them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RateLimitInfo {
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    /// Epoch milliseconds.
    pub reset_at: Option<f64>,
}

pub fn num_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::from(n as i64)
    } else {
        json!(n)
    }
}

impl RateLimitInfo {
    pub fn is_empty(&self) -> bool {
        self.limit.is_none() && self.remaining.is_none() && self.reset_at.is_none()
    }

    pub fn to_json(&self) -> Value {
        Value::Object(obj! {
            "limit" => self.limit.map(num_value),
            "remaining" => self.remaining.map(num_value),
            "resetAt" => self.reset_at.map(num_value),
        })
    }

    pub fn from_headers(headers: &HeaderMap) -> Self {
        let reset = number_header(headers, "x-rate-limit-reset");
        RateLimitInfo {
            limit: number_header(headers, "x-rate-limit-limit"),
            remaining: number_header(headers, "x-rate-limit-remaining"),
            reset_at: reset.map(|s| s * 1000.0),
        }
    }
}

/// `Number(header)`, keeping only finite values.
pub fn number_header(headers: &HeaderMap, name: &str) -> Option<f64> {
    let raw = headers.get(name)?.to_str().ok()?.trim();
    let value: f64 = if raw.is_empty() {
        0.0
    } else {
        raw.parse().ok()?
    };
    value.is_finite().then_some(value)
}

/// Retry-After as milliseconds (seconds or an HTTP date).
pub fn retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    let raw = headers.get("retry-after")?.to_str().ok()?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(seconds) = raw.parse::<f64>() {
        return Some((seconds.max(0.0) * 1000.0) as u64);
    }
    let date = httpdate::parse_http_date(raw).ok()?;
    let ms = date.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(ms.saturating_sub(now_ms()))
}

#[derive(Clone, Debug, Default)]
pub struct XApiError {
    pub status: u16,
    pub message: String,
    pub code: Option<Value>,
    pub kind: Option<String>,
    pub detail: Option<String>,
    pub request_id: Option<String>,
    pub rate_limit: Option<RateLimitInfo>,
}

impl XApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        XApiError {
            status,
            message: message.into(),
            ..Default::default()
        }
    }

    pub fn hint(&self) -> Option<String> {
        let s = self.status;
        Some(match s {
            429 => match self.rate_limit.as_ref().and_then(|r| r.reset_at) {
                Some(at) if at != 0.0 => format!(
                    "X rate limit exhausted for this endpoint. The window resets at {}. Retry later or wait for it.",
                    iso(at as u64)
                ),
                _ => "X rate limit exhausted for this endpoint. Retry later.".into(),
            },
            401 => "Credentials are missing, expired or revoked. Re-authenticate with `x-mcp auth`, or check X_BEARER_TOKEN / OAuth 1.0a keys.".into(),
            403 => "The token lacks the required scope, the account is not allowed to perform this action, or the endpoint requires a higher X API plan. Check the detail field and your app permissions.".into(),
            404 => "The resource does not exist, was deleted, or is not visible to the authenticated account.".into(),
            500..=u16::MAX => "X returned a server error. It is usually transient; retry with backoff.".into(),
            400 => "The request was rejected. Read the detail field and adjust the parameters.".into(),
            _ => return None,
        })
    }

    pub fn to_json(&self) -> Json {
        obj! {
            "error" => self.message.clone(),
            "status" => self.status as u64,
            "code" => self.code.clone(),
            "type" => self.kind.clone().filter(|t| !t.is_empty()),
            "detail" => self.detail.clone().filter(|d| !d.is_empty()),
            "request_id" => self.request_id.clone().filter(|d| !d.is_empty()),
            "rate_limit" => self.rate_limit.as_ref().map(RateLimitInfo::to_json),
            "hint" => self.hint(),
        }
    }

    /// Builds an error from a non-2xx response. X uses several error envelopes
    /// across v2 and the legacy media endpoints; all are handled here.
    pub fn from_response(
        status: u16,
        headers: &HeaderMap,
        body: &str,
        request_id: Option<String>,
    ) -> Self {
        let parsed: Option<Value> = if body.is_empty() {
            None
        } else {
            serde_json::from_str(body).ok()
        };
        let parsed = parsed.filter(Value::is_object);
        let field = |key: &str| {
            parsed
                .as_ref()
                .and_then(|p| p.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let first = parsed
            .as_ref()
            .and_then(|p| p.get("errors"))
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .cloned();
        let first_message = first
            .as_ref()
            .and_then(|f| f.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let title = field("title");
        let detail = field("detail");
        let message = detail
            .clone()
            .or_else(|| first_message.clone())
            .or_else(|| field("message"))
            .or_else(|| field("error"))
            .or_else(|| title.clone())
            .unwrap_or_else(|| {
                if body.is_empty() {
                    format!("HTTP {status}")
                } else {
                    crate::util::utf16_prefix(body, 300).to_owned()
                }
            });
        XApiError {
            status,
            message: format!(
                "{status} {}: {message}",
                title.as_deref().unwrap_or("X API error")
            ),
            code: first
                .as_ref()
                .and_then(|f| f.get("code"))
                .filter(|c| c.is_number() || c.is_string())
                .cloned(),
            kind: field("type"),
            detail: detail.or(first_message),
            request_id,
            rate_limit: Some(RateLimitInfo::from_headers(headers)),
        }
    }
}

/// Everything a tool action can fail with.
#[derive(Clone, Debug)]
pub enum ToolError {
    Api(Box<XApiError>),
    Network {
        message: String,
        retryable: bool,
    },
    Auth {
        message: String,
        code: &'static str,
        hint: String,
    },
    Msg(String),
}

impl ToolError {
    pub fn msg(message: impl Into<String>) -> Self {
        ToolError::Msg(message.into())
    }

    pub fn auth(message: impl Into<String>, code: &'static str, hint: impl Into<String>) -> Self {
        ToolError::Auth {
            message: message.into(),
            code,
            hint: hint.into(),
        }
    }

    pub fn message(&self) -> String {
        match self {
            ToolError::Api(e) => e.message.clone(),
            ToolError::Network { message, .. }
            | ToolError::Auth { message, .. }
            | ToolError::Msg(message) => message.clone(),
        }
    }

    pub fn payload(&self) -> Json {
        match self {
            ToolError::Api(e) => e.to_json(),
            ToolError::Network { message, retryable } => obj! {
                "error" => message.clone(),
                "retryable" => *retryable,
                "hint" => "Check network connectivity and the X API base URL. Transient failures can be retried.",
            },
            ToolError::Auth {
                message,
                code,
                hint,
            } => obj! { "error" => message.clone(), "code" => *code, "hint" => hint.clone() },
            ToolError::Msg(m) => obj! { "error" => m.clone() },
        }
    }
}

impl From<XApiError> for ToolError {
    fn from(e: XApiError) -> Self {
        ToolError::Api(Box::new(e))
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

pub type XResult<T> = Result<T, ToolError>;
