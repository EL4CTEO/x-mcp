//! MCP resources: cheap, addressable access to common X objects through
//! the same cached client the tools use.

use serde_json::{Value, json};

use crate::tools::Ctx;
use crate::util::{encode_component, pretty};
use crate::x::client::{Auth, XRequest};
use crate::x::errors::ToolError;
use crate::x::fields::{Fields, LIST_FIELDS};
use crate::x::normalize;

pub fn list() -> Value {
    json!({ "resources": [
        { "uri": "x://me", "name": "me", "title": "Authenticated X account", "description": "Profile of the account the server is authenticated as.", "mimeType": "application/json" },
        { "uri": "x://rate-limits", "name": "rate-limits", "title": "Observed rate limits", "description": "Per-endpoint rate-limit windows observed during this session, plus cache statistics.", "mimeType": "application/json" },
        { "uri": "x://usage", "name": "usage", "title": "X API usage", "description": "Post consumption for the current billing period (requires an app-only bearer token).", "mimeType": "application/json" },
    ]})
}

pub fn templates() -> Value {
    json!({ "resourceTemplates": [
        { "uriTemplate": "x://users/{username}", "name": "user", "title": "X user profile", "description": "Fetch a public profile by handle, e.g. x://users/jack.", "mimeType": "application/json" },
        { "uriTemplate": "x://posts/{id}", "name": "post", "title": "X post", "description": "Fetch a post by id, e.g. x://posts/20.", "mimeType": "application/json" },
        { "uriTemplate": "x://lists/{id}", "name": "list", "title": "X List", "description": "Fetch a List by id, e.g. x://lists/1234.", "mimeType": "application/json" },
    ]})
}

/// `resources/read`. `Err(None)` means the URI is unknown.
pub async fn read(ctx: &Ctx, uri: &str) -> Result<Value, Option<ToolError>> {
    let value = if uri == "x://me" {
        let res = ctx
            .req(XRequest::get("/2/users/me").user().users())
            .await
            .map_err(Some)?;
        normalize::user_single(&res.payload()).unwrap_or(res.data)
    } else if uri == "x://rate-limits" {
        json!({ "buckets": ctx.x.rate_limits(), "cache": ctx.x.cache_stats() })
    } else if uri == "x://usage" {
        ctx.req(XRequest::get("/2/usage/tweets").auth(Auth::App))
            .await
            .map_err(Some)?
            .data
    } else if let Some(name) = uri
        .strip_prefix("x://users/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    {
        let name = url_decode(name);
        let res = ctx
            .req(XRequest::get(format!("/2/users/by/username/{}", encode_component(&name))).users())
            .await
            .map_err(Some)?;
        normalize::user_single(&res.payload()).unwrap_or(res.data)
    } else if let Some(id) = uri
        .strip_prefix("x://posts/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    {
        let id = url_decode(id);
        let res = ctx
            .req(XRequest::get(format!("/2/tweets/{}", encode_component(&id))).posts())
            .await
            .map_err(Some)?;
        normalize::tweet_single(&res.payload()).unwrap_or(res.data)
    } else if let Some(id) = uri
        .strip_prefix("x://lists/")
        .filter(|s| !s.is_empty() && !s.contains('/'))
    {
        let id = url_decode(id);
        ctx.req(
            XRequest::get(format!("/2/lists/{}", encode_component(&id)))
                .q("list.fields", LIST_FIELDS),
        )
        .await
        .map_err(Some)?
        .data
    } else {
        return Err(None);
    };
    Ok(
        json!({ "contents": [{ "uri": uri, "mimeType": "application/json", "text": pretty(&value) }] }),
    )
}

fn url_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("v={}", s.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}
