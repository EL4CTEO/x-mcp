//! Streamable HTTP transport (MCP 2025-06-18+): POST /mcp with JSON or SSE
//! replies, session ids, bearer auth, CORS allow-list and DNS-rebinding
//! protection on loopback binds.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::server::Server;
use crate::config::VERSION;
use crate::util::{ct_eq, uuid_v4};

const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_SESSIONS: usize = 100;
const IDLE: Duration = Duration::from_secs(30 * 60);

pub fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

struct State {
    server: Arc<Server>,
    sessions: Mutex<HashMap<String, Instant>>,
    token: Option<String>,
    cors: Vec<String>,
    loopback: bool,
}

pub struct Running {
    pub url: String,
    pub addr: SocketAddr,
}

pub async fn start(
    server: Arc<Server>,
    host: &str,
    port: u16,
) -> Result<(Running, tokio::task::JoinHandle<()>), String> {
    let config = server.ctx.config.clone();
    let loopback = is_loopback(host);
    let token = config.http_token.clone();
    if !loopback && token.is_none() {
        return Err("Refusing to bind the MCP HTTP transport to a non-loopback address without X_MCP_HTTP_TOKEN. Set a bearer token or bind to 127.0.0.1.".into());
    }
    if token.as_ref().is_some_and(|t| t.len() < 16) {
        return Err("X_MCP_HTTP_TOKEN must be at least 16 characters.".into());
    }
    let bind_host = host.trim_start_matches('[').trim_end_matches(']');
    let bind_host = if bind_host == "localhost" {
        "127.0.0.1"
    } else {
        bind_host
    };
    let listener = tokio::net::TcpListener::bind((bind_host, port))
        .await
        .map_err(|e| format!("Could not listen on {host}:{port}: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let state = Arc::new(State {
        server,
        sessions: Mutex::new(HashMap::new()),
        token,
        cors: config.http_cors.clone(),
        loopback,
    });

    let sweeper = Arc::clone(&state);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            sweeper
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|_, used| used.elapsed() < IDLE);
        }
    });

    let app_state = Arc::clone(&state);
    let app = axum::Router::new().fallback(move |req: Request<Body>| {
        let state = Arc::clone(&app_state);
        async move { Ok::<_, Infallible>(handle(state, req).await) }
    });
    let shown = if host == "0.0.0.0" || host == "::" {
        "127.0.0.1".to_owned()
    } else {
        host.to_owned()
    };
    let shown = if shown.contains(':') && !shown.starts_with('[') {
        format!("[{shown}]")
    } else {
        shown
    };
    let url = format!("http://{shown}:{}/mcp", addr.port());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(super::stdio::shutdown_signal())
            .await;
    });
    Ok((Running { url, addr }, task))
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    let text = serde_json::to_string(&body).unwrap_or_default();
    Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .body(Body::from(text))
        .expect("response")
}

fn rpc_error(status: StatusCode, code: i64, message: &str) -> Response<Body> {
    json_response(
        status,
        json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }),
    )
}

fn cors(state: &State, headers: &HeaderMap, response: &mut Response<Body>) {
    let Some(origin) = headers.get("origin").and_then(|o| o.to_str().ok()) else {
        return;
    };
    let any = state.cors.iter().any(|o| o == "*");
    if !(any || state.cors.iter().any(|o| o == origin)) {
        return; // never reflect arbitrary origins
    }
    let h = response.headers_mut();
    h.insert(
        "access-control-allow-origin",
        HeaderValue::from_str(if any { "*" } else { origin })
            .unwrap_or(HeaderValue::from_static("*")),
    );
    h.insert("vary", HeaderValue::from_static("origin"));
    h.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    h.insert(
        "access-control-allow-headers",
        HeaderValue::from_static(
            "content-type, mcp-session-id, mcp-protocol-version, authorization, last-event-id",
        ),
    );
    h.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("mcp-session-id, mcp-protocol-version"),
    );
}

async fn handle(state: Arc<State>, req: Request<Body>) -> Response<Body> {
    let headers = req.headers().clone();
    let mut response = route(&state, req).await;
    cors(&state, &headers, &mut response);
    response
}

async fn route(state: &Arc<State>, req: Request<Body>) -> Response<Body> {
    if req.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .expect("response");
    }
    let path = req.uri().path().to_owned();
    if path == "/health" || path == "/" {
        let sessions = state
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        return json_response(
            StatusCode::OK,
            json!({ "status": "ok", "name": "x-mcp", "version": VERSION, "transport": "streamable-http", "endpoint": "/mcp", "sessions": sessions }),
        );
    }
    if path != "/mcp" {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "Not found. The MCP endpoint is /mcp." }),
        );
    }
    let headers = req.headers().clone();
    if state.loopback {
        // DNS rebinding: a loopback server only answers loopback Host headers.
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let name = host
            .rsplit_once(':')
            .filter(|(h, p)| !h.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            .map(|(h, _)| h)
            .unwrap_or(host);
        if !host.is_empty() && !is_loopback(name) {
            return rpc_error(
                StatusCode::FORBIDDEN,
                -32000,
                &format!("Invalid Host header: {host}"),
            );
        }
    }
    if let Some(token) = &state.token {
        let provided = headers
            .get("authorization")
            .map(|v| v.as_bytes().to_vec())
            .unwrap_or_default();
        if !ct_eq(&provided, format!("Bearer {token}").as_bytes()) {
            return rpc_error(
                StatusCode::UNAUTHORIZED,
                -32001,
                "Unauthorized: send Authorization: Bearer <X_MCP_HTTP_TOKEN>.",
            );
        }
    }
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let known = session.as_ref().is_some_and(|id| {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get_mut(id) {
            Some(used) => {
                *used = Instant::now();
                true
            }
            None => false,
        }
    });
    if session.as_ref().is_some_and(|s| !s.is_empty()) && !known {
        return rpc_error(
            StatusCode::NOT_FOUND,
            -32001,
            "Session not found or expired. Re-initialize the MCP connection.",
        );
    }

    match *req.method() {
        Method::GET => Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", "POST, DELETE")
            .body(Body::empty())
            .expect("response"),
        Method::DELETE => {
            if let Some(id) = session.filter(|_| known) {
                state
                    .sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                return Response::builder()
                    .status(StatusCode::OK)
                    .body(Body::empty())
                    .expect("response");
            }
            rpc_error(
                StatusCode::BAD_REQUEST,
                -32000,
                "Bad Request: No valid session ID provided",
            )
        }
        Method::POST => {
            post(
                state,
                &headers,
                known.then_some(session).flatten(),
                req.into_body(),
            )
            .await
        }
        _ => rpc_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed.",
        ),
    }
}

async fn post(
    state: &Arc<State>,
    headers: &HeaderMap,
    session: Option<String>,
    body: Body,
) -> Response<Body> {
    let bytes: Bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => {
            return rpc_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                -32603,
                &format!("Request body exceeds {MAX_BODY} bytes."),
            );
        }
    };
    let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else {
        return rpc_error(
            StatusCode::BAD_REQUEST,
            -32700,
            "Parse error: request body must be valid JSON.",
        );
    };
    let messages: Vec<Value> = match parsed {
        Value::Array(list) => list,
        other => vec![other],
    };
    let is_init = messages
        .iter()
        .any(|m| m.get("method").and_then(Value::as_str) == Some("initialize"));
    let mut new_session = None;
    if session.is_none() {
        if !is_init {
            return rpc_error(
                StatusCode::BAD_REQUEST,
                -32000,
                "Bad Request: Server not initialized. Send an initialize request first.",
            );
        }
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.len() >= MAX_SESSIONS {
            return rpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                -32000,
                &format!(
                    "Too many active sessions ({MAX_SESSIONS}). Close idle clients or restart the server."
                ),
            );
        }
        let id = uuid_v4();
        sessions.insert(id.clone(), Instant::now());
        crate::debug!("http session initialized", "sessionId" => id.clone(), "sessions" => sessions.len());
        new_session = Some(id);
    }
    let requests = messages
        .iter()
        .filter(|m| m.get("method").is_some() && m.get("id").is_some_and(|i| !i.is_null()))
        .count();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    for message in messages {
        state.server.dispatch(message, tx.clone());
    }
    drop(tx);
    let mut builder = Response::builder();
    if let Some(id) = &new_session {
        builder = builder.header("mcp-session-id", id.as_str());
    }
    if requests == 0 {
        return builder
            .status(StatusCode::ACCEPTED)
            .body(Body::empty())
            .expect("response");
    }
    let accept = headers
        .get("accept")
        .and_then(|a| a.to_str().ok())
        .unwrap_or("");
    let wants_sse = accept.contains("text/event-stream") && !accept.contains("application/json")
        || accept.contains("text/event-stream") && has_progress(&bytes);
    if wants_sse {
        // Stream progress notifications and the final responses as SSE events.
        let stream = futures_util::stream::unfold((rx, requests), |(mut rx, left)| async move {
            if left == 0 {
                return None;
            }
            let message = rx.recv().await?;
            let is_reply = message.get("id").is_some();
            let event = format!(
                "event: message\ndata: {}\n\n",
                serde_json::to_string(&message).unwrap_or_default()
            );
            Some((
                Ok::<_, Infallible>(event),
                (rx, if is_reply { left - 1 } else { left }),
            ))
        });
        return builder
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(stream))
            .expect("response");
    }
    let mut replies = vec![];
    while let Some(message) = rx.recv().await {
        if message.get("id").is_some() {
            replies.push(message);
        }
    }
    let body = if replies.len() == 1 {
        replies.remove(0)
    } else {
        Value::Array(replies)
    };
    builder
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap_or_default()))
        .expect("response")
}

fn has_progress(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok_and(|s| s.contains("progressToken"))
}
