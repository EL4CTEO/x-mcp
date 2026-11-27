//! Tool registry: ten grouped MCP tools, each taking an `action` plus that
//! action's parameters. Every action declares its parameters once (see
//! `schema`), and one adapter applies guardrails, validation, dry-run
//! auditing and error mapping for all of them.

pub mod schema;

mod dms;
mod engagement;
mod lists;
mod media;
mod meta;
mod posts;
mod spaces;
mod timelines;
mod trends;
mod users;

use std::sync::{Arc, OnceLock};

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use crate::config::{Config, TOOLSETS};
use crate::obj;
use crate::util::{Json, pretty, utf16_len, utf16_prefix};
use crate::x::client::{XClient, XRequest, XResponse};
use crate::x::errors::{ToolError, XResult};
use crate::x::media::MediaUploader;
use crate::x::viewer::MediaViewer;
use schema::{Field, Pattern, Ty, field, int, merged_schema, pattern};

/// Shared runtime for every action and every session.
pub struct Ctx {
    pub config: Config,
    pub x: Arc<XClient>,
    pub media: MediaUploader,
    pub viewer: MediaViewer,
}

impl Ctx {
    pub fn new(config: &Config) -> Arc<Self> {
        let x = XClient::new(config);
        Arc::new(Ctx {
            config: config.clone(),
            media: MediaUploader::new(Arc::clone(&x)),
            viewer: MediaViewer::new(config),
            x,
        })
    }

    pub async fn req(&self, request: XRequest) -> XResult<XResponse> {
        self.x.request(request).await
    }
}

/// Per-call hooks: MCP progress notifications when the client asked for them.
#[derive(Clone, Default)]
pub struct Call {
    pub progress: Option<ProgressFn>,
}

pub type ProgressFn = Arc<dyn Fn(u64, u64, String) + Send + Sync>;

/// Validated arguments with defaults applied.
pub struct Args(pub Json);

impl Args {
    pub fn s(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }
    pub fn req(&self, key: &str) -> &str {
        self.s(key).unwrap_or_default()
    }
    pub fn owned(&self, key: &str) -> Option<String> {
        self.s(key).map(str::to_owned)
    }
    pub fn u(&self, key: &str) -> Option<u64> {
        self.0.get(key).and_then(Value::as_u64)
    }
    pub fn b(&self, key: &str) -> bool {
        self.0.get(key) == Some(&Value::Bool(true))
    }
    pub fn v(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
    pub fn strs(&self, key: &str) -> Option<Vec<String>> {
        self.0.get(key)?.as_array().map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    }
    pub fn joined(&self, key: &str) -> Option<String> {
        self.strs(key).map(|v| v.join(","))
    }
}

pub enum Output {
    Json(Value),
    /// Rich MCP content (images) plus the structured summary.
    Rich {
        content: Vec<Value>,
        structured: Json,
    },
}

impl From<Json> for Output {
    fn from(map: Json) -> Self {
        Output::Json(Value::Object(map))
    }
}
impl From<Value> for Output {
    fn from(value: Value) -> Self {
        Output::Json(value)
    }
}

pub type Out = XResult<Output>;
pub type Handler = for<'a> fn(&'a Ctx, &'a Args, &'a Call) -> BoxFuture<'a, Out>;

/// Wraps an `async fn(&Ctx, &Args, &Call) -> Out` as a [`Handler`].
#[macro_export]
macro_rules! handler {
    ($f:path) => {
        |c, a, k| Box::pin($f(c, a, k))
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ann {
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

pub const READ: Ann = Ann {
    read_only: true,
    destructive: false,
    idempotent: true,
};
pub const WRITE: Ann = Ann {
    read_only: false,
    destructive: false,
    idempotent: true,
};
pub const SEND: Ann = Ann {
    read_only: false,
    destructive: false,
    idempotent: false,
};
pub const DESTROY: Ann = Ann {
    read_only: false,
    destructive: true,
    idempotent: true,
};

pub struct Action {
    pub action: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub ann: Ann,
    pub fields: Vec<Field>,
    pub handler: Handler,
}

pub struct Group {
    pub toolset: &'static str,
    pub name: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub description: String,
    pub actions: Vec<Action>,
    pub ann: Ann,
    pub input_schema: Value,
}

fn group_meta(toolset: &str) -> (&'static str, &'static str, &'static str) {
    match toolset {
        "posts" => (
            "x_posts",
            "X posts",
            "Create, read, search and moderate posts: publish posts and threads, fetch one or many by id, search recent or full-archive, count volume, reconstruct a conversation, list likers/reposters/quotes, hide replies, delete.",
        ),
        "timelines" => (
            "x_timelines",
            "X timelines",
            "Read home and user timelines, mentions, liked posts and your bookmarks.",
        ),
        "users" => (
            "x_users",
            "X users",
            "Profiles and relationships: look up me/one/many, search users, followers, following, follow/unfollow, mute/unmute, block/unblock, muted and blocked lists.",
        ),
        "engagement" => (
            "x_engagement",
            "X engagement",
            "Like, repost and bookmark posts, and undo those actions, as the authenticated account.",
        ),
        "lists" => (
            "x_lists",
            "X Lists",
            "Manage Lists and read their timelines: create, update, delete, look up, owned/memberships/pinned Lists, add/remove members, list members/followers/posts, follow/unfollow.",
        ),
        "spaces" => (
            "x_spaces",
            "X Spaces",
            "Search live or scheduled audio Spaces and read the posts shared in them.",
        ),
        "trends" => (
            "x_trends",
            "X trends",
            "Trending topics by location (WOEID) and personalised trends for the authenticated account.",
        ),
        "dms" => (
            "x_dms",
            "X Direct Messages",
            "Send and read Direct Messages: send to a user or an existing conversation, read events, read a conversation, and delete an event.",
        ),
        "media" => (
            "x_media",
            "X media",
            "Upload media, check video/GIF processing, and view attached media — photos are returned as images, videos are sampled into frames when ffmpeg is installed.",
        ),
        _ => (
            "x_meta",
            "X diagnostics",
            "Check credentials, observed rate limits and billed API usage.",
        ),
    }
}

fn actions_for(toolset: &str) -> Vec<Action> {
    match toolset {
        "posts" => posts::actions(),
        "timelines" => timelines::actions(),
        "users" => users::actions(),
        "engagement" => engagement::actions(),
        "lists" => lists::actions(),
        "spaces" => spaces::actions(),
        "trends" => trends::actions(),
        "dms" => dms::actions(),
        "media" => media::actions(),
        _ => meta::actions(),
    }
}

/// `text.match(/^(.+?[.!?])(?:\s|$)/)`, capped at 190 characters.
fn first_sentence(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut sentence: String = text.to_owned();
    for i in 1..chars.len() {
        if matches!(chars[i], '.' | '!' | '?')
            && (i + 1 == chars.len() || chars[i + 1].is_whitespace())
        {
            sentence = chars[..=i].iter().collect();
            break;
        }
    }
    if utf16_len(&sentence) > 190 {
        format!("{}…", utf16_prefix(&sentence, 187))
    } else {
        sentence
    }
}

fn build(toolset: &'static str) -> Group {
    let (name, title, summary) = group_meta(toolset);
    let actions = actions_for(toolset);
    let list: Vec<String> = actions
        .iter()
        .map(|a| {
            let required: Vec<&str> = a
                .fields
                .iter()
                .filter(|f| f.required)
                .map(|f| f.name)
                .collect();
            let needs = if required.is_empty() {
                String::new()
            } else {
                format!(" [requires: {}]", required.join(", "))
            };
            format!("- {}: {}{needs}", a.action, first_sentence(a.description))
        })
        .collect();
    let description = format!(
        "{summary}\n\nActions (pass \"action\" plus that action's parameters):\n{}",
        list.join("\n")
    );

    let names: Vec<&str> = actions.iter().map(|a| a.action).collect();
    let mut props = Json::new();
    props.insert(
        "action".into(),
        json!({ "type": "string", "enum": names, "description": format!("Action to perform. One of: {}.", names.join(", ")) }),
    );
    // Key order: first appearance across actions.
    let mut keys: Vec<&'static str> = vec![];
    for a in &actions {
        for f in &a.fields {
            assert_ne!(f.name, "action", "reserved parameter in {name}");
            if !keys.contains(&f.name) {
                keys.push(f.name);
            }
        }
    }
    for key in keys {
        let mut variants: Vec<(&Field, Vec<&'static str>)> = vec![];
        for a in &actions {
            if let Some(f) = a.fields.iter().find(|f| f.name == key) {
                // Optional-vs-required does not change the property shape.
                let mut probe = f.clone();
                probe.required = true;
                match variants.iter_mut().find(|(v, _)| {
                    let mut other = (*v).clone();
                    other.required = true;
                    other == probe
                }) {
                    Some((_, list)) => list.push(a.action),
                    None => variants.push((f, vec![a.action])),
                }
            }
        }
        props.insert(key.into(), Value::Object(merged_schema(&variants)));
    }
    let input_schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": props,
        "required": ["action"],
    });
    let ann = Ann {
        read_only: actions.iter().all(|a| a.ann.read_only),
        destructive: actions.iter().any(|a| a.ann.destructive),
        idempotent: actions.iter().all(|a| a.ann.idempotent),
    };
    Group {
        toolset,
        name,
        title,
        summary,
        description,
        actions,
        ann,
        input_schema,
    }
}

pub fn all_groups() -> &'static [Group] {
    static GROUPS: OnceLock<Vec<Group>> = OnceLock::new();
    GROUPS.get_or_init(|| TOOLSETS.iter().map(|t| build(t)).collect())
}

pub fn groups_for(config: &Config) -> Vec<&'static Group> {
    all_groups()
        .iter()
        .filter(|g| config.toolset_enabled(g.toolset))
        .collect()
}

pub fn action_count(groups: &[&Group]) -> usize {
    groups.iter().map(|g| g.actions.len()).sum()
}

impl Group {
    /// The `tools/list` entry.
    pub fn tool_json(&self) -> Value {
        let mut actions = Json::new();
        for a in &self.actions {
            let required: Vec<&str> = a
                .fields
                .iter()
                .filter(|f| f.required)
                .map(|f| f.name)
                .collect();
            actions.insert(
                a.action.into(),
                json!({ "readOnly": a.ann.read_only, "destructive": a.ann.destructive, "idempotent": a.ann.idempotent, "required": required }),
            );
        }
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": {
                "title": self.title,
                "readOnlyHint": self.ann.read_only,
                "destructiveHint": self.ann.destructive,
                "idempotentHint": self.ann.idempotent,
                "openWorldHint": true,
            },
            "_meta": { "x-mcp/actions": actions },
        })
    }
}

// ---- results ---------------------------------------------------------------

/// Pretty JSON for the text channel; valid JSON even when truncated.
fn json_text(value: &Value, max: usize) -> String {
    let text = pretty(value);
    let len = utf16_len(&text);
    if len <= max {
        return text;
    }
    pretty(&json!({
        "truncated": true,
        "original_chars": len,
        "preview": utf16_prefix(&text, max),
        "note": "Text preview truncated; structuredContent contains the full result.",
    }))
}

fn structured(output: &Value) -> Value {
    match output {
        Value::Array(_) => json!({ "items": output }),
        Value::Object(_) => output.clone(),
        other => json!({ "result": other }),
    }
}

pub fn ok_result(output: &Value, config: &Config) -> Value {
    json!({ "content": [{ "type": "text", "text": json_text(output, config.max_output_chars) }], "structuredContent": structured(output) })
}

pub fn error_result(payload: Json, config: &Config) -> Value {
    let payload = Value::Object(payload);
    json!({
        "content": [{ "type": "text", "text": json_text(&payload, config.max_output_chars) }],
        "structuredContent": payload,
        "isError": true,
    })
}

fn render(output: Output, config: &Config) -> Value {
    match output {
        Output::Json(value) => ok_result(&value, config),
        Output::Rich {
            content,
            structured,
        } => {
            let structured = Value::Object(structured);
            let mut all = vec![
                json!({ "type": "text", "text": json_text(&structured, config.max_output_chars) }),
            ];
            all.extend(content);
            json!({ "content": all, "structuredContent": structured })
        }
    }
}

/// `tools/call` for a group: dispatch on `action`, then guardrails,
/// validation, dry-run and error mapping.
pub async fn call_tool(ctx: &Ctx, group: &Group, args: &Map<String, Value>, call: &Call) -> Value {
    let requested = args.get("action").and_then(Value::as_str).unwrap_or("");
    let Some(action) = group.actions.iter().find(|a| a.action == requested) else {
        let valid: Vec<&str> = group.actions.iter().map(|a| a.action).collect();
        return error_result(
            obj! {
                "error" => format!("Unknown action \"{requested}\" for {}.", group.name),
                "code" => "invalid_action",
                "hint" => format!("Valid actions: {}.", valid.join(", ")),
            },
            &ctx.config,
        );
    };
    run_action(ctx, group, action, args, call).await
}

async fn run_action(
    ctx: &Ctx,
    group: &Group,
    action: &Action,
    args: &Map<String, Value>,
    call: &Call,
) -> Value {
    let started = std::time::Instant::now();
    let write = !action.ann.read_only;
    if write && ctx.config.read_only {
        return error_result(
            obj! {
                "error" => "Server is in read-only mode (X_MCP_READ_ONLY=true).",
                "code" => "read_only",
                "hint" => "Restart without X_MCP_READ_ONLY to allow mutations.",
            },
            &ctx.config,
        );
    }
    let parsed = match schema::validate(&action.fields, args) {
        Ok(parsed) => Args(parsed),
        Err(issues) => {
            return error_result(
                obj! {
                    "error" => format!("Invalid parameters for action \"{}\": {issues}", action.action),
                    "code" => "invalid_params",
                    "hint" => format!("Call {} with action \"{}\" and its documented parameters.", group.name, action.action),
                },
                &ctx.config,
            );
        }
    };
    if write && ctx.config.dry_run {
        let start = ctx.x.audit_seq();
        if let Err(error) = (action.handler)(ctx, &parsed, call).await {
            crate::debug!("dry-run action stopped early", "tool" => group.name, "action" => action.action, "err" => error.message());
        }
        return ok_result(
            &json!({
                "dry_run": true,
                "tool": format!("{}#{}", group.name, action.action),
                "note": "No request was sent. These are the HTTP calls the action would make.",
                "requests": ctx.x.audit_since(start),
            }),
            &ctx.config,
        );
    }
    match (action.handler)(ctx, &parsed, call).await {
        Ok(output) => {
            crate::debug!("action completed", "tool" => group.name, "action" => action.action, "durationMs" => started.elapsed().as_millis() as u64);
            render(output, &ctx.config)
        }
        Err(error) => {
            crate::warn!("action failed", "tool" => group.name, "action" => action.action, "err" => error.message(),
                "durationMs" => started.elapsed().as_millis() as u64);
            error_result(error.payload(), &ctx.config)
        }
    }
}

// ---- shared fragments ------------------------------------------------------

pub fn tweet_id() -> Ty {
    pattern(Pattern::Digits, Some("Post id must be numeric"))
}
pub fn user_id_ty() -> Ty {
    pattern(Pattern::Digits, Some("User id must be a numeric snowflake"))
}
pub fn username_ty() -> Ty {
    pattern(
        Pattern::Username,
        Some("Username must be 1-15 letters, digits or underscores"),
    )
}
pub fn list_id() -> Ty {
    pattern(Pattern::Digits, Some("List id must be numeric"))
}
pub fn digits() -> Ty {
    pattern(Pattern::Digits, None)
}

pub fn f_tweet_id() -> Field {
    field("tweet_id", tweet_id()).inner("Numeric post id.")
}
pub fn f_list_id() -> Field {
    field("list_id", list_id()).inner("Numeric List id.")
}
pub fn user_ref() -> Vec<Field> {
    vec![
        field("user_id", user_id_ty())
            .opt()
            .inner("Numeric X user id."),
        field("username", username_ty())
            .opt()
            .inner("X handle without the @ prefix."),
    ]
}
pub fn max_results(min: i64, max: i64, default: i64) -> Field {
    field("max_results", int(min, Some(max)))
        .def(json!(default))
        .desc(Box::leak(
            format!("Number of results to return ({min}-{max}).").into_boxed_str(),
        ))
}
pub fn next_token() -> Field {
    field("next_token", schema::max_len(2_000))
        .opt()
        .desc("Cursor from a previous response (meta.next_token).")
}
pub fn time_range() -> Vec<Field> {
    vec![
        field("start_time", schema::string())
            .opt()
            .desc("ISO 8601 timestamp (e.g. 2026-01-31T12:00:00Z). Inclusive lower bound."),
        field("end_time", schema::string())
            .opt()
            .desc("ISO 8601 timestamp. Exclusive upper bound."),
    ]
}

pub fn fields(groups: Vec<Vec<Field>>) -> Vec<Field> {
    groups.into_iter().flatten().collect()
}

/// Resolves `{user_id | username}` to an id, defaulting to the signed-in account.
pub async fn resolve_user_id(
    ctx: &Ctx,
    user_id: Option<&str>,
    username: Option<&str>,
) -> XResult<String> {
    if let Some(id) = user_id.filter(|i| !i.is_empty()) {
        return Ok(id.to_owned());
    }
    if let Some(name) = username.filter(|u| !u.is_empty()) {
        let res = ctx
            .req(
                XRequest::get(format!(
                    "/2/users/by/username/{}",
                    crate::util::encode_component(name)
                ))
                .q("user.fields", "id")
                .cache_ttl(300_000),
            )
            .await?;
        return res
            .data_str("id")
            .ok_or_else(|| ToolError::msg(format!("No user found for @{name}.")));
    }
    me(ctx).await
}

pub async fn me(ctx: &Ctx) -> XResult<String> {
    let res = ctx
        .req(
            XRequest::get("/2/users/me")
                .user()
                .q("user.fields", "id")
                .cache_ttl(60_000),
        )
        .await?;
    res.data_str("id")
        .ok_or_else(|| ToolError::msg("Could not resolve the authenticated account id."))
}

/// Target actions must name a user: defaulting to yourself would silently
/// follow, mute or DM your own account.
pub async fn resolve_target(
    ctx: &Ctx,
    user_id: Option<&str>,
    username: Option<&str>,
) -> XResult<String> {
    if user_id.is_none_or(str::is_empty) && username.is_none_or(str::is_empty) {
        return Err(ToolError::msg("Provide target_user_id or target_username."));
    }
    resolve_user_id(ctx, user_id, username).await
}
