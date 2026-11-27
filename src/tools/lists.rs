use serde_json::{Value, json};

use super::schema::{Ty, field, max_len, text};
use super::*;
use crate::handler;
use crate::x::fields::Fields;
use crate::x::normalize;

pub fn actions() -> Vec<Action> {
    let page =
        |max: i64, default: i64| vec![f_list_id(), max_results(1, max, default), next_token()];
    vec![
        Action {
            action: "create",
            title: "Create a List",
            description: "Create a curated List. Requires user auth with list.write. Lists are the cheapest way to build a topic feed: one List timeline call replaces dozens of per-account calls.",
            ann: WRITE,
            fields: vec![
                field("name", text(1, 25)).desc("List name (max 25 chars)."),
                field("description", max_len(100))
                    .opt()
                    .desc("List description (max 100 chars)."),
                field("private", Ty::Bool)
                    .def(json!(false))
                    .desc("Private Lists are visible only to you."),
            ],
            handler: handler!(create),
        },
        Action {
            action: "update",
            title: "Update a List",
            description: "Rename, re-describe or change the visibility of a List you own. Requires user auth with list.write.",
            ann: WRITE,
            fields: vec![
                f_list_id(),
                field("name", text(1, 25))
                    .opt()
                    .desc("List name (max 25 chars)."),
                field("description", max_len(100))
                    .opt()
                    .desc("List description (max 100 chars)."),
                field("private", Ty::Bool)
                    .opt()
                    .desc("Private Lists are visible only to you."),
            ],
            handler: handler!(update),
        },
        Action {
            action: "delete",
            title: "Delete a List",
            description: "Delete a List you own. Requires user auth with list.write. This cannot be undone.",
            ann: DESTROY,
            fields: vec![f_list_id()],
            handler: handler!(delete),
        },
        Action {
            action: "get",
            title: "Get a List",
            description: "Fetch a List by id: name, description, owner, member/follower counts and visibility.",
            ann: READ,
            fields: vec![f_list_id()],
            handler: handler!(get),
        },
        Action {
            action: "owned",
            title: "Lists owned by a user",
            description: "Lists created by a user (defaults to the authenticated account), 1-100 per page.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 100, 100), next_token()],
            ]),
            handler: handler!(owned),
        },
        Action {
            action: "memberships",
            title: "Lists a user belongs to",
            description: "Lists a user is a member of (defaults to the authenticated account), 1-100 per page.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 100, 100), next_token()],
            ]),
            handler: handler!(memberships),
        },
        Action {
            action: "pinned",
            title: "Pinned Lists of a user",
            description: "Lists pinned to a user profile (defaults to the authenticated account).",
            ann: READ,
            fields: user_ref(),
            handler: handler!(pinned),
        },
        Action {
            action: "add_member",
            title: "Add a member to a List",
            description: "Add a user to a List you manage. Requires user auth with list.write.",
            ann: WRITE,
            fields: vec![
                f_list_id(),
                field("user_id", user_id_ty()).inner("Numeric X user id."),
            ],
            handler: handler!(add_member),
        },
        Action {
            action: "remove_member",
            title: "Remove a member from a List",
            description: "Remove a user from a List you manage. Requires user auth with list.write.",
            ann: DESTROY,
            fields: vec![
                f_list_id(),
                field("user_id", user_id_ty()).inner("Numeric X user id."),
            ],
            handler: handler!(remove_member),
        },
        Action {
            action: "posts",
            title: "Posts in a List timeline",
            description: "The timeline of a List, newest first (1-100 per page). Efficient for monitoring a topic: one call covers every account in the List.",
            ann: READ,
            fields: page(100, 20),
            handler: handler!(posts),
        },
        Action {
            action: "members",
            title: "Members of a List",
            description: "Users who belong to a List, 1-100 per page.",
            ann: READ,
            fields: page(100, 100),
            handler: handler!(members),
        },
        Action {
            action: "followers",
            title: "Followers of a List",
            description: "Users who follow a List, 1-100 per page.",
            ann: READ,
            fields: page(100, 100),
            handler: handler!(followers),
        },
        Action {
            action: "follow",
            title: "Follow a List",
            description: "Follow a List so its timeline appears in your Lists tab. Requires user auth with list.write.",
            ann: WRITE,
            fields: vec![f_list_id()],
            handler: handler!(follow),
        },
        Action {
            action: "unfollow",
            title: "Unfollow a List",
            description: "Stop following a List. Requires user auth with list.write.",
            ann: WRITE,
            fields: vec![f_list_id()],
            handler: handler!(unfollow),
        },
    ]
}

fn lists_of(res: &XResponse) -> Json {
    obj! {
        "data" => res.data.as_array().map(|l| l.iter().map(normalize::list).collect::<Vec<_>>()).unwrap_or_default(),
        "next_token" => res.meta_field("next_token").filter(|v| !v.is_null()),
        "result_count" => res.meta_field("result_count").filter(|v| !v.is_null()),
    }
}

async fn create(c: &Ctx, a: &Args, _: &Call) -> Out {
    let mut body = obj! { "name" => a.owned("name") };
    crate::util::put(
        &mut body,
        "description",
        a.owned("description").filter(|d| !d.is_empty()),
    );
    body.insert("private".into(), Value::Bool(a.b("private")));
    let res = c
        .req(XRequest::post("/2/lists").user().body(Value::Object(body)))
        .await?;
    let id = res
        .data_str("id")
        .ok_or_else(|| ToolError::msg("X did not return the new List id."))?;
    Ok(obj! {
        "id" => id.clone(),
        "name" => res.data_str("name").or_else(|| a.owned("name")),
        "private" => a.b("private"),
        "url" => format!("https://x.com/i/lists/{id}"),
    }
    .into())
}

async fn update(c: &Ctx, a: &Args, _: &Call) -> Out {
    let mut body = Json::new();
    for key in ["name", "description", "private"] {
        if let Some(v) = a.v(key) {
            body.insert(key.into(), v.clone());
        }
    }
    if body.is_empty() {
        return Err(ToolError::msg("Provide at least one field to update."));
    }
    let id = a.req("list_id");
    let res = c
        .req(
            XRequest::put(format!("/2/lists/{id}"))
                .user()
                .body(Value::Object(body.clone())),
        )
        .await?;
    let mut out = obj! { "list_id" => id, "updated" => res.data_true("updated") };
    out.extend(body);
    Ok(out.into())
}

async fn delete(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("list_id");
    let res = c
        .req(XRequest::delete(format!("/2/lists/{id}")).user())
        .await?;
    Ok(obj! { "list_id" => id, "deleted" => res.data_true("deleted") }.into())
}

async fn get(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("list_id");
    let res = c
        .req(
            XRequest::get(format!("/2/lists/{id}"))
                .lists()
                .q("expansions", "owner_id")
                .cache_ttl(60_000),
        )
        .await?;
    Ok(normalize::list(&res.data).into())
}

async fn user_lists(c: &Ctx, a: &Args, segment: &str) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let request = XRequest::get(format!("/2/users/{id}/{segment}"))
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
        .lists();
    let res = c.req(request).await?;
    let mut out = obj! { "user_id" => id };
    out.extend(lists_of(&res));
    Ok(out.into())
}

async fn owned(c: &Ctx, a: &Args, _: &Call) -> Out {
    user_lists(c, a, "owned_lists").await
}

async fn memberships(c: &Ctx, a: &Args, _: &Call) -> Out {
    user_lists(c, a, "list_memberships").await
}

async fn pinned(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let res = c
        .req(XRequest::get(format!("/2/users/{id}/pinned_lists")).lists())
        .await?;
    let data: Vec<Value> = res
        .data
        .as_array()
        .map(|l| l.iter().map(normalize::list).collect())
        .unwrap_or_default();
    Ok(obj! { "user_id" => id, "data" => data }.into())
}

async fn add_member(c: &Ctx, a: &Args, _: &Call) -> Out {
    let (list, user) = (a.req("list_id"), a.req("user_id"));
    let res = c
        .req(
            XRequest::post(format!("/2/lists/{list}/members"))
                .user()
                .body(json!({ "user_id": user })),
        )
        .await?;
    Ok(
        obj! { "list_id" => list, "user_id" => user, "is_member" => res.data_true("is_member") }
            .into(),
    )
}

async fn remove_member(c: &Ctx, a: &Args, _: &Call) -> Out {
    let (list, user) = (a.req("list_id"), a.req("user_id"));
    let res = c
        .req(XRequest::delete(format!("/2/lists/{list}/members/{user}")).user())
        .await?;
    Ok(
        obj! { "list_id" => list, "user_id" => user, "is_member" => res.data_true("is_member") }
            .into(),
    )
}

fn paged(a: &Args, path: String) -> XRequest {
    XRequest::get(path)
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
}

async fn posts(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("list_id");
    let res = c
        .req(
            paged(a, format!("/2/lists/{id}/tweets"))
                .posts()
                .cache_ttl(15_000),
        )
        .await?;
    let mut out = obj! { "list_id" => id };
    let mut payload = res.payload();
    payload.as_object_mut().map(|p| p.remove("errors"));
    out.extend(normalize::tweet_list(&payload));
    Ok(out.into())
}

async fn people(c: &Ctx, a: &Args, segment: &str) -> Out {
    let id = a.req("list_id");
    let res = c
        .req(paged(a, format!("/2/lists/{id}/{segment}")).users())
        .await?;
    let mut out = obj! { "list_id" => id };
    let mut payload = res.payload();
    payload.as_object_mut().map(|p| p.remove("errors"));
    out.extend(normalize::user_list(&payload));
    Ok(out.into())
}

async fn members(c: &Ctx, a: &Args, _: &Call) -> Out {
    people(c, a, "members").await
}

async fn followers(c: &Ctx, a: &Args, _: &Call) -> Out {
    people(c, a, "followers").await
}

async fn follow(c: &Ctx, a: &Args, _: &Call) -> Out {
    let me = me(c).await?;
    let id = a.req("list_id");
    let res = c
        .req(
            XRequest::post(format!("/2/users/{me}/followed_lists"))
                .user()
                .body(json!({ "list_id": id })),
        )
        .await?;
    Ok(obj! { "list_id" => id, "following" => res.data_true("following") }.into())
}

async fn unfollow(c: &Ctx, a: &Args, _: &Call) -> Out {
    let me = me(c).await?;
    let id = a.req("list_id");
    let res = c
        .req(XRequest::delete(format!("/2/users/{me}/followed_lists/{id}")).user())
        .await?;
    Ok(obj! { "list_id" => id, "following" => res.data_true("following") }.into())
}
