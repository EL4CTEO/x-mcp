use serde_json::{Value, json};

use super::*;
use crate::handler;

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "auth_status",
            title: "Authentication status",
            description: "Diagnose credentials: which auth modes are configured, whether a user session can post/DM, token expiry and scopes, plus the effective server flags (read-only, dry-run, cache, API base). Never returns secrets. Call this first when a tool fails with 401/403.",
            ann: READ,
            fields: vec![],
            handler: handler!(auth_status),
        },
        Action {
            action: "rate_limits",
            title: "Observed rate limits and cache stats",
            description: "Shows the last rate-limit window X reported for each endpoint (remaining requests and reset time), the in-memory cache hit/miss counters, and whether the server waits or fails when a bucket is exhausted. Use this before planning a large batch of calls.",
            ann: READ,
            fields: vec![],
            handler: handler!(rate_limits),
        },
        Action {
            action: "usage",
            title: "API usage and post cap",
            description: "Current billing-period post consumption for the X project: the cap, how many posts have been consumed, and daily usage. Requires an app-only bearer token. Check this before large read/search jobs, since X bills per returned post.",
            ann: READ,
            fields: vec![],
            handler: handler!(usage),
        },
    ]
}

pub fn auth_status_json(c: &Ctx) -> Json {
    let status = c.x.auth.status();
    let user = status.oauth2 || status.oauth1;
    let cfg = &c.config;
    obj! {
        "credentials" => obj! {
            "appOnlyBearer" => status.bearer,
            "oauth2" => status.oauth2,
            "oauth1" => status.oauth1,
            "oauth2Source" => status.oauth2_source,
            "oauth2ExpiresAt" => status.oauth2_expires_at.map(crate::util::iso),
            "oauth2Scopes" => status.oauth2_scopes.clone().map(|s| json!(s)),
            "modes" => status.modes(),
        },
        "capabilities" => obj! {
            "publicReads" => status.bearer || user,
            "userReads" => user,
            "writes" => user,
            "mediaUpload" => user,
            "directMessages" => user,
        },
        "config" => obj! {
            "apiBase" => cfg.api_base.clone(),
            "readOnly" => cfg.read_only,
            "dryRun" => cfg.dry_run,
            "cache" => if cfg.cache_enabled { json!({ "ttlMs": cfg.cache_ttl_ms, "maxEntries": cfg.cache_max }) } else { json!("disabled") },
            "rateLimitMode" => cfg.rate_limit_mode.as_str(),
            "credentialFile" => cfg.credential_file.display().to_string(),
            "toolsets" => json!({ "include": cfg.toolsets_include, "exclude": cfg.toolsets_exclude }),
        },
        "missing" => json!(status.missing),
        "hint" => (!status.missing.is_empty()).then_some("Some tools will fail until these credentials are configured."),
    }
}

async fn auth_status(c: &Ctx, _: &Args, _: &Call) -> Out {
    Ok(auth_status_json(c).into())
}

pub fn rate_limits_json(c: &Ctx) -> Json {
    let cfg = &c.config;
    let cache = if cfg.cache_enabled {
        let mut stats = c.x.cache_stats();
        stats.insert("ttlMs".into(), cfg.cache_ttl_ms.into());
        stats.insert("maxEntries".into(), (cfg.cache_max as u64).into());
        Value::Object(stats)
    } else {
        json!({ "enabled": false })
    };
    obj! {
        "mode" => cfg.rate_limit_mode.as_str(),
        "maxWaitMs" => cfg.max_wait_ms,
        "buckets" => c.x.rate_limits(),
        "cache" => cache,
    }
}

async fn rate_limits(c: &Ctx, _: &Args, _: &Call) -> Out {
    Ok(rate_limits_json(c).into())
}

async fn usage(c: &Ctx, _: &Args, _: &Call) -> Out {
    let res = c
        .req(
            XRequest::get("/2/usage/tweets")
                .auth(crate::x::client::Auth::App)
                .cache_ttl(60_000),
        )
        .await?;
    Ok(Output::Json(res.data))
}
