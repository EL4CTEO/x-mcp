//! HTTP transport with bounded retries. Network failures retry only for
//! idempotent requests: a timeout does not prove a POST /2/tweets did not land.

use std::time::{Duration, Instant};

use bytes::Bytes;
use rand::Rng;
use reqwest::header::HeaderMap;
use reqwest::{Client, Method};

use super::errors::{ToolError, retry_after_ms};
use crate::config::Config;
use crate::util::now_ms;

#[derive(Clone, Debug)]
pub enum FormValue {
    Text(String),
    File {
        data: Bytes,
        filename: String,
        mime: String,
    },
}

#[derive(Clone, Debug)]
pub enum Body {
    None,
    Json(String),
    Form(Vec<(String, FormValue)>),
}

pub struct HttpRequest<'a> {
    pub method: Method,
    pub url: &'a str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
    pub idempotent: bool,
    pub retry_on_429: bool,
    pub max_retry_delay_ms: u64,
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub text: String,
}

pub struct HttpTransport {
    client: Client,
    timeout_ms: u64,
    max_retries: u32,
    retry_base_ms: u64,
}

impl HttpTransport {
    pub fn new(config: &Config) -> Self {
        let mut builder = Client::builder()
            .no_proxy()
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .connect_timeout(Duration::from_millis(config.timeout_ms.min(10_000)))
            .redirect(reqwest::redirect::Policy::limited(10));
        if let Some(proxy) = config
            .proxy
            .as_deref()
            .and_then(|p| reqwest::Proxy::all(p).ok())
        {
            builder = builder.proxy(proxy);
        }
        HttpTransport {
            client: builder.build().expect("http client"),
            timeout_ms: config.timeout_ms,
            max_retries: config.max_retries,
            retry_base_ms: config.retry_base_ms,
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn build(&self, request: &HttpRequest<'_>) -> reqwest::RequestBuilder {
        let mut builder = self
            .client
            .request(request.method.clone(), request.url)
            .timeout(Duration::from_millis(self.timeout_ms));
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        match &request.body {
            Body::None => builder,
            Body::Json(text) => builder
                .header("content-type", "application/json")
                .body(text.clone()),
            Body::Form(parts) => {
                let mut form = reqwest::multipart::Form::new();
                for (name, value) in parts {
                    form = match value {
                        FormValue::Text(text) => form.text(name.clone(), text.clone()),
                        FormValue::File {
                            data,
                            filename,
                            mime,
                        } => {
                            let part = reqwest::multipart::Part::stream_with_length(
                                data.clone(),
                                data.len() as u64,
                            )
                            .file_name(filename.clone())
                            .mime_str(mime)
                            .unwrap_or_else(|_| {
                                reqwest::multipart::Part::stream(data.clone())
                                    .file_name(filename.clone())
                            });
                            form.part(name.clone(), part)
                        }
                    };
                }
                builder.multipart(form)
            }
        }
    }

    pub async fn request(&self, request: HttpRequest<'_>) -> Result<HttpResponse, ToolError> {
        let started = Instant::now();
        let mut attempt: u32 = 1;
        loop {
            let result = self.build(&request).send().await;
            let response = match result {
                Ok(response) => response,
                Err(error) => {
                    if request.idempotent && attempt <= self.max_retries {
                        let delay = backoff(attempt, self.retry_base_ms);
                        crate::debug!("network error, retrying", "attempt" => attempt as u64, "delay" => delay, "url" => request.url);
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(network_error(&error, &request, self.timeout_ms));
                }
            };
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let text = match response.text().await {
                Ok(text) => text,
                Err(error) => {
                    return Err(ToolError::Network {
                        message: format!(
                            "Failed reading the X response body: {}",
                            describe(&error)
                        ),
                        retryable: request.idempotent,
                    });
                }
            };
            let ok = (200..300).contains(&status);
            let server_error = (500..=599).contains(&status);
            let retryable = attempt <= self.max_retries
                && if status == 429 {
                    request.retry_on_429
                } else {
                    status == 408 || (request.idempotent && (server_error || status == 425))
                };
            if ok || !retryable {
                crate::debug!("x api request",
                    "method" => request.method.as_str(), "url" => request.url, "status" => status as u64,
                    "attempts" => attempt as u64, "durationMs" => started.elapsed().as_millis() as u64, "bytes" => text.len());
                return Ok(HttpResponse {
                    status,
                    headers,
                    text,
                });
            }
            let delay = retry_delay(status, &headers, attempt, self.retry_base_ms);
            if delay > request.max_retry_delay_ms {
                return Ok(HttpResponse {
                    status,
                    headers,
                    text,
                });
            }
            crate::debug!("retrying X request", "status" => status as u64, "delay" => delay, "attempt" => attempt as u64);
            tokio::time::sleep(Duration::from_millis(delay)).await;
            attempt += 1;
        }
    }
}

fn describe(error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(" ({cause})"));
        source = cause.source();
    }
    message
}

fn network_error(error: &reqwest::Error, request: &HttpRequest<'_>, timeout_ms: u64) -> ToolError {
    let message = if error.is_timeout() {
        format!(
            "Request to X timed out after {timeout_ms}ms: {} {}",
            request.method, request.url
        )
    } else {
        format!(
            "Network error calling X ({} {}): {}",
            request.method,
            request.url,
            describe(error)
        )
    };
    ToolError::Network {
        message,
        retryable: request.idempotent,
    }
}

fn retry_delay(status: u16, headers: &HeaderMap, attempt: u32, base_ms: u64) -> u64 {
    // Only 429s carry meaningful windows; 5xx always uses backoff.
    if status != 429 {
        return backoff(attempt, base_ms);
    }
    if let Some(after) = retry_after_ms(headers) {
        return after.min(15 * 60_000);
    }
    if let Some(reset) =
        super::errors::number_header(headers, "x-rate-limit-reset").filter(|r| *r > 0.0)
    {
        let until = reset * 1000.0 - now_ms() as f64;
        if until > 0.0 {
            return (until as u64 + 250).min(15 * 60_000);
        }
    }
    backoff(attempt, base_ms)
}

pub fn backoff(attempt: u32, base_ms: u64) -> u64 {
    let exponential = base_ms.saturating_mul(1u64 << (attempt.saturating_sub(1)).min(20));
    let jitter = rand::rng().random_range(0.0..1.0) * exponential.min(1_000) as f64;
    exponential + jitter.round() as u64
}
