//! Tracks the window X reports per endpoint bucket. In `wait` mode it sleeps
//! until the window rolls over instead of burning a request on a sure 429.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use super::errors::{RateLimitInfo, ToolError, XApiError, num_value};
use crate::config::RateLimitMode;
use crate::obj;
use crate::util::{Json, iso, now_ms};

/// Collapses ids so every call to one route shares a bucket.
pub fn bucket_key(method: &str, path: &str) -> String {
    let segments: Vec<String> = path
        .split('/')
        .map(|segment| {
            let digits = segment.bytes().take_while(u8::is_ascii_digit).count();
            if digits >= 5 && digits == segment.len() {
                ":id".to_owned()
            } else if digits >= 10 {
                format!(":id{}", &segment[digits..])
            } else {
                segment.to_owned()
            }
        })
        .collect();
    format!("{} {}", method.to_uppercase(), segments.join("/"))
}

pub struct RateLimiter {
    mode: RateLimitMode,
    max_wait_ms: u64,
    buckets: Mutex<BTreeMap<String, RateLimitInfo>>,
}

impl RateLimiter {
    pub fn new(mode: RateLimitMode, max_wait_ms: u64) -> Self {
        RateLimiter {
            mode,
            max_wait_ms,
            buckets: Mutex::new(BTreeMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, RateLimitInfo>> {
        self.buckets.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn observe(&self, key: &str, info: &RateLimitInfo) {
        if !info.is_empty() {
            self.lock().insert(key.to_owned(), info.clone());
        }
    }

    /// Waits for an exhausted bucket (or fails, per mode).
    pub async fn acquire(&self, key: &str) -> Result<(), ToolError> {
        let (state, wait_ms) = {
            let mut buckets = self.lock();
            let Some(state) = buckets.get(key) else {
                return Ok(());
            };
            let (Some(remaining), Some(reset_at)) = (state.remaining, state.reset_at) else {
                return Ok(());
            };
            if remaining > 0.0 {
                return Ok(());
            }
            let wait = reset_at - now_ms() as f64;
            if wait <= 0.0 {
                buckets.remove(key);
                return Ok(());
            }
            (state.clone(), wait)
        };
        if self.mode == RateLimitMode::Fail {
            let when = state
                .reset_at
                .map(|r| iso(r as u64))
                .unwrap_or_else(|| "an unknown time".into());
            return Err(ToolError::from(XApiError {
                rate_limit: Some(state),
                ..XApiError::new(
                    429,
                    format!("Rate limit for {key} is exhausted until {when}."),
                )
            }));
        }
        let padded = wait_ms + 250.0;
        if padded > self.max_wait_ms as f64 {
            return Err(ToolError::from(XApiError {
                rate_limit: Some(state),
                ..XApiError::new(
                    429,
                    format!(
                        "Rate limit for {key} resets in {}s, longer than X_MCP_MAX_WAIT_MS ({}ms).",
                        (wait_ms / 1000.0).ceil(),
                        self.max_wait_ms
                    ),
                )
            }));
        }
        tokio::time::sleep(Duration::from_millis(padded as u64)).await;
        self.lock().remove(key);
        Ok(())
    }

    pub fn snapshot(&self) -> Json {
        let mut out = Json::new();
        for (key, state) in self.lock().iter() {
            out.insert(
                key.clone(),
                Value::Object(obj! {
                    "limit" => state.limit.map(num_value),
                    "remaining" => state.remaining.map(num_value),
                    "resetAt" => state.reset_at.filter(|r| *r != 0.0).map(|r| iso(r as u64)),
                }),
            );
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_keys_collapse_ids() {
        assert_eq!(
            bucket_key("get", "/2/tweets/1234567890123"),
            "GET /2/tweets/:id"
        );
        assert_eq!(
            bucket_key("GET", "/2/users/12345/following"),
            "GET /2/users/:id/following"
        );
        assert_eq!(
            bucket_key("GET", "/2/users/1234/following"),
            "GET /2/users/1234/following"
        );
    }

    #[tokio::test]
    async fn fail_mode_rejects_exhausted_bucket() {
        let limiter = RateLimiter::new(RateLimitMode::Fail, 1000);
        let info = RateLimitInfo {
            limit: Some(10.0),
            remaining: Some(0.0),
            reset_at: Some((now_ms() + 60_000) as f64),
        };
        limiter.observe("GET /x", &info);
        let err = limiter.acquire("GET /x").await.unwrap_err();
        let ToolError::Api(err) = err else {
            panic!("api error")
        };
        assert_eq!(err.status, 429);
        assert!(
            err.message
                .starts_with("Rate limit for GET /x is exhausted until")
        );
    }
}
