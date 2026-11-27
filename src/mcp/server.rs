//! Transport-independent MCP dispatcher (JSON-RPC 2.0).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use super::{prompts, resources};
use crate::config::VERSION;
use crate::tools::{self, Call, Ctx, Group};

pub const PROTOCOL_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

pub const INSTRUCTIONS: &str = "X (Twitter) API v2 tools for AI agents.

TOOLS ARE GROUPED
- Ten domain tools (x_posts, x_timelines, x_users, x_engagement, x_lists, x_spaces, x_trends, x_dms, x_media, x_meta) each take an \"action\" field plus that action's parameters.
- Read the tool description for the action list, and the input schema for parameter names. Example: {\"action\":\"search\",\"query\":\"mcp -is:retweet\"} on x_posts.

AUTHENTICATION
- Public reads work with an app-only bearer token. Anything that acts as a person (posting, replying, liking, reposting, bookmarking, following, DMs, private timelines) needs a user session.
- Check x_meta action \"auth_status\" first when a call fails with 401/403.

COST AND RATE LIMITS
- X bills per post returned, not per request. Prefer batched reads (x_posts \"get_many\", x_users \"get_many\") over loops, keep max_results small, and use x_posts \"count\" when only volume matters.
- Responses are normalised to compact objects with URLs and resolved authors. Paging uses next_token from meta.
- If a rate-limit bucket is exhausted the server either waits for the reset or returns a 429 with the reset time (x_meta \"rate_limits\" shows the observed windows).

WORKING WITH IDS
- Never invent ids. Resolve handles with x_users action \"get\", then use the numeric id.
- Read a post with x_posts \"get\"; reconstruct a conversation with x_posts \"thread\".

PUBLIC ACTIONS
- Posting, replying, liking, following and DMs are visible to real people. Confirm intent with the user before performing them, never spam or run bulk engagement, and respect X's automation rules.
- Check context before replying with x_posts \"thread\" or \"search\".

RESOURCES AND PROMPTS
- x://me, x://users/{username}, x://posts/{id}, x://lists/{id}, x://rate-limits and x://usage are available as MCP resources.
- Prompts draft_thread, reply_triage, account_report and summarize_conversation encode proven workflows.

MEDIA
- Posts carry media URLs, but text alone cannot see them. Call x_media with action \"view\" and a post id to receive the actual image (or evenly spaced video frames when ffmpeg is installed) as MCP image content.
- Use media_index for carousels; for videos without ffmpeg the tool returns the preview frame and the video URL.";

/// Outgoing JSON-RPC messages (responses and notifications).
pub type Sink = mpsc::UnboundedSender<Value>;

pub struct Server {
    pub ctx: Arc<Ctx>,
    groups: Vec<&'static Group>,
    inflight: Mutex<HashMap<String, AbortHandle>>,
}

pub fn response(id: Value, result: Value) -> Value {
    json!({ "result": result, "jsonrpc": "2.0", "id": id })
}

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

impl Server {
    pub fn new(ctx: Arc<Ctx>) -> Arc<Self> {
        let groups = tools::groups_for(&ctx.config);
        Arc::new(Server {
            ctx,
            groups,
            inflight: Mutex::new(HashMap::new()),
        })
    }

    pub fn tool_count(&self) -> usize {
        self.groups.len()
    }

    /// Handles one parsed message. Requests run as their own task, so a slow
    /// call never blocks others and `notifications/cancelled` can abort it.
    /// The response (if any) goes to `sink`.
    pub fn dispatch(
        self: &Arc<Self>,
        message: Value,
        sink: Sink,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let Value::Object(map) = message else {
            let _ = sink.send(error(Value::Null, -32600, "Invalid Request"));
            return None;
        };
        let method = map.get("method").and_then(Value::as_str).map(str::to_owned);
        let id = map.get("id").cloned();
        let params = map
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(method) = method else {
            // A response from the client (we send no requests): ignore.
            return None;
        };
        let Some(id) = id.filter(|i| !i.is_null()) else {
            self.notification(&method, &params);
            return None;
        };
        let key = id.to_string();
        let me = Arc::clone(self);
        let task_key = key.clone();
        let handle = tokio::spawn(async move {
            let reply = me.request(&method, id, params, &sink).await;
            me.inflight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&task_key);
            let _ = sink.send(reply);
        });
        self.inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, handle.abort_handle());
        Some(handle)
    }

    fn notification(&self, method: &str, params: &Map<String, Value>) {
        if method == "notifications/cancelled"
            && let Some(id) = params.get("requestId")
            && let Some(handle) = self
                .inflight
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id.to_string())
        {
            crate::debug!("request cancelled by client", "id" => id.clone());
            handle.abort();
        }
    }

    async fn request(
        &self,
        method: &str,
        id: Value,
        params: Map<String, Value>,
        sink: &Sink,
    ) -> Value {
        match method {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = if PROTOCOL_VERSIONS.contains(&requested) {
                    requested
                } else {
                    PROTOCOL_VERSIONS[0]
                };
                response(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {
                            "tools": { "listChanged": false },
                            "resources": { "subscribe": false, "listChanged": false },
                            "prompts": { "listChanged": false },
                            "logging": {},
                        },
                        "serverInfo": { "name": "x-mcp", "title": "X (Twitter)", "version": VERSION },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" | "logging/setLevel" => response(id, json!({})),
            "tools/list" => {
                let list: Vec<Value> = self.groups.iter().map(|g| g.tool_json()).collect();
                response(id, json!({ "tools": list }))
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let Some(group) = self.groups.iter().find(|g| g.name == name) else {
                    return error(id, -32602, format!("Tool {name} not found"));
                };
                let args = params
                    .get("arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let call = Call {
                    progress: progress(&params, sink),
                };
                response(id, tools::call_tool(&self.ctx, group, &args, &call).await)
            }
            "prompts/list" => response(id, prompts::list()),
            "prompts/get" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params
                    .get("arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                match prompts::get(name, &args) {
                    Ok(result) => response(id, result),
                    Err((code, message)) => error(id, code, message),
                }
            }
            "resources/list" => response(id, resources::list()),
            "resources/templates/list" => response(id, resources::templates()),
            "resources/read" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                match resources::read(&self.ctx, uri).await {
                    Ok(result) => response(id, result),
                    Err(None) => error(id, -32002, format!("Resource {uri} not found")),
                    Err(Some(e)) => error(id, -32603, e.message()),
                }
            }
            "completion/complete" => response(
                id,
                json!({ "completion": { "values": [], "hasMore": false } }),
            ),
            _ => error(id, -32601, "Method not found"),
        }
    }
}

fn progress(params: &Map<String, Value>, sink: &Sink) -> Option<crate::tools::ProgressFn> {
    let token = params
        .get("_meta")
        .and_then(|m| m.get("progressToken"))
        .filter(|t| !t.is_null())?
        .clone();
    let sink = sink.clone();
    Some(Arc::new(move |progress, total, message| {
        let _ = sink.send(json!({
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": { "progressToken": token, "progress": progress, "total": total, "message": message },
        }));
    }))
}
