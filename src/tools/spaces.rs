use serde_json::{Value, json};

use super::schema::{Pattern, Ty, array, field, pattern, text};
use super::*;
use crate::handler;
use crate::x::fields::Fields;
use crate::x::normalize;

fn space_id() -> Ty {
    pattern(Pattern::SpaceId, Some("Space id is alphanumeric"))
}

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "search",
            title: "Search Spaces",
            description: "Find live or scheduled audio Spaces by keyword (up to 100 results). X does not paginate this endpoint. Useful for discovering conversations an agent can summarize or join.",
            ann: READ,
            fields: vec![
                field("query", text(1, 512)).desc("Keyword or phrase."),
                field("state", Ty::Enum(&["live", "scheduled", "all"]))
                    .def(json!("all"))
                    .desc("Filter by Space state."),
                max_results(1, 100, 20),
            ],
            handler: handler!(search),
        },
        Action {
            action: "get",
            title: "Get a Space",
            description: "Fetch one Space by id: title, state, hosts, participant count and schedule.",
            ann: READ,
            fields: vec![field("space_id", space_id()).inner("Space id.")],
            handler: handler!(get),
        },
        Action {
            action: "get_many",
            title: "Get multiple Spaces",
            description: "Batch lookup of up to 100 Spaces by id.",
            ann: READ,
            fields: vec![
                field("space_ids", array(space_id(), Some(1), Some(100))).desc("1-100 Space ids."),
            ],
            handler: handler!(get_many),
        },
        Action {
            action: "posts",
            title: "Posts shared in a Space",
            description: "Posts attached to a Space, 1-100 per page.",
            ann: READ,
            fields: vec![
                field("space_id", space_id()).inner("Space id."),
                max_results(1, 100, 20),
                next_token(),
            ],
            handler: handler!(posts),
        },
    ]
}

fn spaces(res: &XResponse) -> Vec<Value> {
    res.data
        .as_array()
        .map(|l| l.iter().map(normalize::space).collect())
        .unwrap_or_default()
}

async fn search(c: &Ctx, a: &Args, _: &Call) -> Out {
    let state = a.req("state");
    let request = XRequest::get("/2/spaces/search")
        .q("query", a.req("query"))
        .q("state", (state != "all").then_some(state))
        .q("max_results", a.u("max_results"))
        .spaces()
        .cache_ttl(30_000);
    let res = c.req(request).await?;
    let data = spaces(&res);
    let count = res
        .meta_field("result_count")
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| json!(data.len()));
    Ok(obj! { "query" => a.req("query"), "state" => state, "data" => data, "result_count" => count }.into())
}

async fn get(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("space_id");
    let res = c
        .req(
            XRequest::get(format!("/2/spaces/{id}"))
                .spaces()
                .cache_ttl(30_000),
        )
        .await?;
    Ok(normalize::space(&res.data).into())
}

async fn get_many(c: &Ctx, a: &Args, _: &Call) -> Out {
    let res = c
        .req(
            XRequest::get("/2/spaces")
                .q("ids", a.joined("space_ids"))
                .spaces()
                .cache_ttl(30_000),
        )
        .await?;
    Ok(obj! { "data" => spaces(&res) }.into())
}

async fn posts(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("space_id");
    let request = XRequest::get(format!("/2/spaces/{id}/tweets"))
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
        .posts()
        .cache_ttl(30_000);
    let res = c.req(request).await?;
    let mut payload = res.payload();
    payload.as_object_mut().map(|p| p.remove("errors"));
    let mut out = obj! { "space_id" => id };
    out.extend(normalize::tweet_list(&payload));
    Ok(out.into())
}
