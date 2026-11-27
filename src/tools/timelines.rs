use serde_json::Value;

use super::schema::{Ty, array, field};
use super::*;
use crate::handler;
use crate::x::fields::Fields;
use crate::x::normalize;

fn exclude() -> Field {
    field(
        "exclude",
        array(Ty::Enum(&["retweets", "replies"]), None, None),
    )
    .opt()
    .desc("Drop retweets and/or replies from the timeline.")
}

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "home",
            title: "Home timeline",
            description: "Reverse-chronological home timeline for the authenticated account. Requires user auth. Paginate with next_token; 1-100 posts per page. This is the best starting point for \"what is happening in my feed\".",
            ann: READ,
            fields: fields(vec![
                vec![max_results(1, 100, 20), next_token(), exclude()],
                time_range(),
            ]),
            handler: handler!(home),
        },
        Action {
            action: "user",
            title: "Posts by a user",
            description: "Timeline of posts authored by a user (1-100 per page). Works with public app-only auth for public accounts; user auth needed for protected accounts. Use exclude to filter retweets/replies.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 100, 20), next_token(), exclude()],
                time_range(),
            ]),
            handler: handler!(user),
        },
        Action {
            action: "mentions",
            title: "Mentions of a user",
            description: "Posts that mention a user (1-100 per page). Ideal for reply triage and reputation monitoring. Requires user auth for private accounts; public mentions work with app-only auth.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 100, 20), next_token()],
                time_range(),
            ]),
            handler: handler!(mentions),
        },
        Action {
            action: "liked",
            title: "Posts liked by a user",
            description: "Posts liked by a user, newest first (1-100 per page). Requires user auth.",
            ann: READ,
            fields: fields(vec![
                user_ref(),
                vec![max_results(1, 100, 20), next_token()],
            ]),
            handler: handler!(liked),
        },
        Action {
            action: "bookmarks",
            title: "Bookmarked posts",
            description: "The authenticated account's bookmarks (1-100 per page). Requires user auth with bookmark.read. Bookmark folders are not included; use only the default bookmark timeline.",
            ann: READ,
            fields: vec![max_results(1, 100, 20), next_token()],
            handler: handler!(bookmarks),
        },
    ]
}

async fn timeline(
    c: &Ctx,
    a: &Args,
    user_id: String,
    request: XRequest,
    ttl: u64,
    with_range: bool,
    with_exclude: bool,
) -> Out {
    let mut request = request
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"));
    if with_exclude {
        request = request.q("exclude", a.joined("exclude"));
    }
    if with_range {
        request = request
            .q("start_time", a.s("start_time"))
            .q("end_time", a.s("end_time"));
    }
    let res = c.req(request.posts().cache_ttl(ttl)).await?;
    let mut out = obj! { "user_id" => user_id };
    out.extend(normalize::tweet_list(&res.payload()));
    Ok(Output::Json(Value::Object(out)))
}

async fn home(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = me(c).await?;
    let request = XRequest::get(format!("/2/users/{id}/timelines/reverse_chronological")).user();
    timeline(c, a, id, request, 15_000, true, true).await
}

async fn user(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let request = XRequest::get(format!("/2/users/{id}/tweets"));
    timeline(c, a, id, request, 30_000, true, true).await
}

async fn mentions(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let request = XRequest::get(format!("/2/users/{id}/mentions"));
    timeline(c, a, id, request, 15_000, true, false).await
}

async fn liked(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = resolve_user_id(c, a.s("user_id"), a.s("username")).await?;
    let request = XRequest::get(format!("/2/users/{id}/liked_tweets")).user();
    timeline(c, a, id, request, 30_000, false, false).await
}

async fn bookmarks(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = me(c).await?;
    let request = XRequest::get(format!("/2/users/{id}/bookmarks")).user();
    timeline(c, a, id, request, 15_000, false, false).await
}
