use serde_json::{Value, json};

use super::schema::{array, field, text};
use super::*;
use crate::handler;
use crate::util::encode_component;
use crate::x::fields::Fields;
use crate::x::normalize;

fn target_ref() -> Vec<Field> {
    vec![
        field("target_user_id", user_id_ty())
            .opt()
            .desc("Numeric id of the target account."),
        field("target_username", username_ty())
            .opt()
            .desc("Handle of the target account (without @)."),
    ]
}

macro_rules! relation {
    ($action:literal, $title:literal, $desc:literal, $ann:expr, $f:ident) => {
        Action {
            action: $action,
            title: $title,
            description: $desc,
            ann: $ann,
            fields: target_ref(),
            handler: handler!($f),
        }
    };
}

const REL_WRITE: Ann = Ann {
    read_only: false,
    destructive: false,
    idempotent: true,
};
const REL_DESTROY: Ann = Ann {
    read_only: false,
    destructive: true,
    idempotent: true,
};

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "me",
            title: "Authenticated account",
            description: "Profile of the authenticated account: id, handle, bio, follower counts and pinned post. Requires user auth.",
            ann: READ,
            fields: vec![],
            handler: handler!(get_me),
        },
        Action {
            action: "get",
            title: "Get a user profile",
            description: "Look up one account by handle or numeric id. Returns bio, location, verification, follower/following/post counts and pinned post id.",
            ann: READ,
            fields: user_ref(),
            handler: handler!(get),
        },
        Action {
            action: "get_many",
            title: "Get multiple user profiles",
            description: "Batch lookup of up to 100 accounts by handle or id in a single request. Cheaper and faster than repeated get calls.",
            ann: READ,
            fields: vec![
                field(
                    "usernames",
                    array(username_ty().clone(), Some(1), Some(100)),
                )
                .opt()
                .desc("Handles to look up (no @)."),
                field("user_ids", array(user_id_ty(), Some(1), Some(100)))
                    .opt()
                    .desc("Numeric ids to look up."),
            ],
            handler: handler!(get_many),
        },
        Action {
            action: "search",
            title: "Search users",
            description: "Search accounts by keyword (name, handle, bio) with 1-100 results per page. Useful for discovering accounts in a niche before fetching their timelines.",
            ann: READ,
            fields: vec![
                field("query", text(1, 512))
                    .desc("Keyword or phrase, e.g. \"rust developer\" or \"climate tech\"."),
                max_results(1, 100, 20),
                next_token(),
            ],
            handler: handler!(search),
        },
        Action {
            action: "followers",
            title: "List followers",
            description: "Accounts following a user, 1-1000 per page (X caps at 1000). Requires user auth for protected accounts; public lists work with app-only auth.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 1_000, 100), next_token()],
            ]),
            handler: handler!(followers),
        },
        Action {
            action: "following",
            title: "List following",
            description: "Accounts a user follows, 1-1000 per page. Requires user auth for protected accounts.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 1_000, 100), next_token()],
            ]),
            handler: handler!(following),
        },
        relation!(
            "follow",
            "Follow a user",
            "Follow an account as the authenticated user. Requires user auth with follows.write. Idempotent: following an already-followed account succeeds.",
            REL_WRITE,
            follow
        ),
        relation!(
            "unfollow",
            "Unfollow a user",
            "Unfollow an account as the authenticated user. Requires user auth with follows.write.",
            REL_DESTROY,
            unfollow
        ),
        relation!(
            "mute",
            "Mute a user",
            "Mute an account for the authenticated user. Requires user auth with mute.write.",
            REL_WRITE,
            mute
        ),
        relation!(
            "unmute",
            "Unmute a user",
            "Unmute an account for the authenticated user. Requires user auth with mute.write.",
            REL_WRITE,
            unmute
        ),
        relation!(
            "block",
            "Block a user",
            "Block an account on behalf of the authenticated user. X documents this endpoint as Enterprise-plan only; self-serve apps may receive 403. Requires user auth with block.write.",
            REL_DESTROY,
            block
        ),
        relation!(
            "unblock",
            "Unblock a user",
            "Unblock an account. X documents this endpoint as Enterprise-plan only. Requires user auth with block.write.",
            REL_WRITE,
            unblock
        ),
        Action {
            action: "muted",
            title: "List muted users",
            description: "Accounts muted by the authenticated user (1-100 per page). Requires user auth.",
            ann: READ,
            fields: vec![max_results(1, 100, 50), next_token()],
            handler: handler!(muted),
        },
        Action {
            action: "blocked",
            title: "List blocked users",
            description: "Accounts blocked by the authenticated user (1-1000 per page). Requires user auth with block.read. Pair with unblock to audit and clean up a block list.",
            ann: READ,
            fields: vec![max_results(1, 1_000, 100), next_token()],
            handler: handler!(blocked),
        },
    ]
}

async fn get_me(c: &Ctx, _: &Args, _: &Call) -> Out {
    let res = c
        .req(
            XRequest::get("/2/users/me")
                .user()
                .users()
                .cache_ttl(60_000),
        )
        .await?;
    normalize::user_single(&res.payload())
        .map(Output::Json)
        .ok_or_else(|| ToolError::msg("X did not return the authenticated account."))
}

async fn get(c: &Ctx, a: &Args, _: &Call) -> Out {
    if let Some(id) = a.s("user_id").filter(|s| !s.is_empty()) {
        let res = c
            .req(XRequest::get(format!("/2/users/{id}")).users())
            .await?;
        return normalize::user_single(&res.payload())
            .map(Output::Json)
            .ok_or_else(|| ToolError::msg(format!("User {id} was not found.")));
    }
    let Some(name) = a.s("username").filter(|s| !s.is_empty()) else {
        return Err(ToolError::msg("Provide either user_id or username."));
    };
    let res = c
        .req(
            XRequest::get(format!("/2/users/by/username/{}", encode_component(name)))
                .users()
                .cache_ttl(300_000),
        )
        .await?;
    normalize::user_single(&res.payload())
        .map(Output::Json)
        .ok_or_else(|| ToolError::msg(format!("@{name} was not found.")))
}

async fn get_many(c: &Ctx, a: &Args, _: &Call) -> Out {
    let (names, ids) = (a.strs("usernames"), a.strs("user_ids"));
    let request = match (names, ids) {
        (None, None) => return Err(ToolError::msg("Provide usernames or user_ids.")),
        (Some(_), Some(_)) => {
            return Err(ToolError::msg(
                "Provide either usernames or user_ids, not both.",
            ));
        }
        (Some(names), None) if !names.is_empty() => {
            XRequest::get("/2/users/by").q("usernames", names.join(","))
        }
        (_, ids) => XRequest::get("/2/users").q("ids", ids.unwrap_or_default().join(",")),
    };
    let res = c.req(request.users().cache_ttl(300_000)).await?;
    Ok(normalize::user_list(&res.payload()).into())
}

async fn search(c: &Ctx, a: &Args, _: &Call) -> Out {
    let request = XRequest::get("/2/users/search")
        .q("query", a.req("query"))
        .q("max_results", a.u("max_results"))
        .q("next_token", a.s("next_token"))
        .users()
        .cache_ttl(60_000);
    let res = c.req(request).await?;
    let mut out = obj! { "query" => a.req("query") };
    out.extend(normalize::user_list(&res.payload()));
    Ok(out.into())
}

async fn graph(c: &Ctx, a: &Args, segment: &str) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let request = XRequest::get(format!("/2/users/{id}/{segment}"))
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
        .users()
        .cache_ttl(120_000);
    let res = c.req(request).await?;
    let mut out = obj! { "user_id" => id };
    out.extend(normalize::user_list(&res.payload()));
    Ok(out.into())
}

async fn followers(c: &Ctx, a: &Args, _: &Call) -> Out {
    graph(c, a, "followers").await
}

async fn following(c: &Ctx, a: &Args, _: &Call) -> Out {
    graph(c, a, "following").await
}

/// POST (or DELETE) a relationship and report the flag X returns.
async fn relate(c: &Ctx, a: &Args, action: &str, segment: &str, delete: bool, flag: &str) -> Out {
    let me = me(c).await?;
    let target = resolve_target(c, a.s("target_user_id"), a.s("target_username")).await?;
    let request = if delete {
        XRequest::delete(format!("/2/users/{me}/{segment}/{target}")).user()
    } else {
        XRequest::post(format!("/2/users/{me}/{segment}"))
            .user()
            .body(json!({ "target_user_id": target }))
    };
    let res = c.req(request).await?;
    let mut out = obj! {
        "action" => action,
        "at" => crate::util::iso_now(),
        "user_id" => me,
        "target_user_id" => target,
        flag => res.data_true(flag),
    };
    if action == "follow" {
        out.insert(
            "pending_follow".into(),
            Value::Bool(res.data_true("pending_follow")),
        );
    }
    Ok(out.into())
}

async fn follow(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "follow", "following", false, "following").await
}
async fn unfollow(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "unfollow", "following", true, "following").await
}
async fn mute(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "mute", "muting", false, "muting").await
}
async fn unmute(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "unmute", "muting", true, "muting").await
}
async fn block(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "block", "blocking", false, "blocking").await
}
async fn unblock(c: &Ctx, a: &Args, _: &Call) -> Out {
    relate(c, a, "unblock", "blocking", true, "blocking").await
}

async fn own_list(c: &Ctx, a: &Args, segment: &str) -> Out {
    let me = me(c).await?;
    let request = XRequest::get(format!("/2/users/{me}/{segment}"))
        .user()
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
        .users();
    let res = c.req(request).await?;
    let mut out = obj! { "user_id" => me };
    out.extend(normalize::user_list(&res.payload()));
    Ok(out.into())
}

async fn muted(c: &Ctx, a: &Args, _: &Call) -> Out {
    own_list(c, a, "muting").await
}

async fn blocked(c: &Ctx, a: &Args, _: &Call) -> Out {
    own_list(c, a, "blocking").await
}
