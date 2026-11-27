use serde_json::{Value, json};

use super::schema::{Ty, array, field, int, text};
use super::*;
use crate::handler;
use crate::x::fields::Fields;
use crate::x::normalize;

fn reply_settings() -> Field {
    field(
        "reply_settings",
        Ty::Enum(&["following", "mentionedUsers", "subscribers", "verified"]),
    )
    .opt()
    .desc("Who may reply: following, mentionedUsers, subscribers or verified.")
}

fn media_ids() -> Ty {
    array(digits(), Some(1), Some(4))
}

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "create",
            title: "Create a post",
            description: "Publish a post (tweet), reply or quote on X as the authenticated account. Use media_ids from x_media action \"upload\" to attach up to 4 images, 1 GIF or 1 video. Polls take 2-4 options of at most 25 characters. Requires OAuth 2.0/1.0a user auth. Check the text carefully before sending: this is publicly visible and cannot be undone except by deleting.",
            ann: SEND,
            fields: vec![
                field("text", text(1, 25_000)).desc(
                    "Post text. Standard accounts are limited to 280 characters; X enforces it.",
                ),
                field("reply_to", tweet_id())
                    .opt()
                    .desc("Post id to reply to."),
                field("quote_of", tweet_id()).opt().desc(
                    "Post id to quote. Note: X currently limits quote posting to Enterprise plans.",
                ),
                field("media_ids", media_ids())
                    .opt()
                    .desc("Media ids from x_media action \"upload\"."),
                field(
                    "poll",
                    Ty::Object(vec![
                        field("options", array(text(1, 25), Some(2), Some(4))),
                        field("duration_minutes", int(5, Some(10_080))),
                    ]),
                )
                .opt()
                .desc("Poll configuration: 2-4 options, duration 5-10080 minutes."),
                reply_settings(),
                field("community_id", digits())
                    .opt()
                    .desc("Community id to post into."),
                field("made_with_ai", Ty::Bool)
                    .opt()
                    .desc("Disclose that the post contains AI-generated media."),
                field("paid_partnership", Ty::Bool)
                    .opt()
                    .desc("Disclose a paid partnership."),
            ],
            handler: handler!(create),
        },
        Action {
            action: "create_thread",
            title: "Publish a thread",
            description: "Publish a multi-post thread by chaining replies. Posts are sent sequentially; if one fails, the response reports which posts were already published (and their ids) so the agent can recover without duplicating content. All posts are validated up-front. Requires user auth.",
            ann: SEND,
            fields: vec![
                field(
                    "posts",
                    array(
                        Ty::Object(vec![
                            field("text", text(1, 25_000)),
                            field("media_ids", media_ids()).opt(),
                        ]),
                        Some(2),
                        Some(25),
                    ),
                )
                .desc("Thread posts in order (2-25)."),
                reply_settings(),
            ],
            handler: handler!(create_thread),
        },
        Action {
            action: "delete",
            title: "Delete a post",
            description: "Delete a post you authored. Requires user auth with tweet.write. This cannot be undone.",
            ann: DESTROY,
            fields: vec![f_tweet_id()],
            handler: handler!(delete),
        },
        Action {
            action: "get",
            title: "Get a post by id",
            description: "Fetch one post with its author, metrics, media, entities and (when present) the quoted or reposted post. This returns media URLs only; to actually see an image or video frame, pass the id to x_media action \"view\". Billed as one post read.",
            ann: READ,
            fields: vec![f_tweet_id()],
            handler: handler!(get),
        },
        Action {
            action: "get_many",
            title: "Get multiple posts by id",
            description: "Fetch up to 100 posts in one request. Far cheaper than calling get in a loop: X counts once per returned post, but you save round trips and rate-limit budget.",
            ann: READ,
            fields: vec![
                field("tweet_ids", array(tweet_id(), Some(1), Some(100))).desc("1-100 post ids."),
            ],
            handler: handler!(get_many),
        },
        Action {
            action: "search",
            title: "Search posts",
            description: "Search X posts with the v2 search operators. Use `archive: true` for the full archive (requires an elevated plan); otherwise the recent index covers the last 7 days. Operators: from:, to:, @mention, #hashtag, \"exact phrase\", OR, -, is:retweet, is:reply, is:verified, has:media, has:links, lang:en, -is:retweet, conversation_id:, url:, place_country:. Recent search supports 10-100 results per page.",
            ann: READ,
            fields: fields(vec![
                vec![
                    field("query", text(1, 4_096)).desc("Search query using X search operators."),
                    max_results(10, 100, 10),
                    next_token(),
                    field("sort_order", Ty::Enum(&["recency", "relevancy"]))
                        .def(json!("recency"))
                        .desc("Result ordering (recent search only)."),
                    field("archive", Ty::Bool)
                        .def(json!(false))
                        .desc("Use full-archive search instead of the 7-day recent index."),
                ],
                time_range(),
            ]),
            handler: handler!(search),
        },
        Action {
            action: "count",
            title: "Count posts over time",
            description: "Get post volume for a query without retrieving the posts themselves. Much cheaper than searching when you only need trend/volume data. Granularity is minute, hour or day. Recent counts cover up to 7 days; archive: true uses full-archive counts.",
            ann: READ,
            fields: fields(vec![
                vec![
                    field("query", text(1, 4_096)).desc("Search query using X search operators."),
                    field("granularity", Ty::Enum(&["minute", "hour", "day"]))
                        .def(json!("hour"))
                        .desc("Bucket size."),
                    field("archive", Ty::Bool)
                        .def(json!(false))
                        .desc("Use full-archive search instead of the 7-day recent index."),
                    next_token(),
                ],
                time_range(),
            ]),
            handler: handler!(count),
        },
        Action {
            action: "thread",
            title: "Read a conversation thread",
            description: "Reconstruct a conversation: fetches the root post and finds replies via conversation_id search. Recent search only covers the last 7 days, so older conversations may return only the root. Results are ordered oldest-first.",
            ann: READ,
            fields: vec![
                field("tweet_id", tweet_id()).desc("Any post in the conversation (root or reply)."),
                field("max_replies", int(10, Some(100)))
                    .def(json!(50))
                    .desc("Number of results to return (10-100)."),
            ],
            handler: handler!(thread),
        },
        Action {
            action: "likers",
            title: "List users who liked a post",
            description: "Returns up to 100 users per page who liked the post. Requires user auth (OAuth 2.0 like.read or OAuth 1.0a).",
            ann: READ,
            fields: vec![f_tweet_id(), max_results(1, 100, 100), next_token()],
            handler: handler!(likers),
        },
        Action {
            action: "reposters",
            title: "List users who reposted a post",
            description: "Returns up to 100 users per page who reposted the post. Requires user auth.",
            ann: READ,
            fields: vec![f_tweet_id(), max_results(1, 100, 100), next_token()],
            handler: handler!(reposters),
        },
        Action {
            action: "quotes",
            title: "List quote posts",
            description: "Returns up to 100 posts that quote the given post, with authors and metrics.",
            ann: READ,
            fields: vec![f_tweet_id(), max_results(10, 100, 20), next_token()],
            handler: handler!(quotes),
        },
        Action {
            action: "hide_reply",
            title: "Hide or unhide a reply",
            description: "Hide a reply to one of your posts, or unhide it. Requires user auth with tweet.moderate.write. Hiding is preferable to deleting because the author keeps their post visible in their own timeline.",
            ann: WRITE,
            fields: vec![
                field("tweet_id", tweet_id())
                    .desc("The reply to hide/unhide. You must have authored the parent post."),
                field("hidden", Ty::Bool)
                    .def(json!(true))
                    .desc("true hides the reply, false unhides it."),
            ],
            handler: handler!(hide_reply),
        },
    ]
}

fn status_url(id: &str) -> String {
    format!("https://x.com/i/status/{id}")
}

async fn create(c: &Ctx, a: &Args, _: &Call) -> Out {
    let mut body = obj! { "text" => a.owned("text") };
    if let Some(id) = a.s("reply_to") {
        body.insert("reply".into(), json!({ "in_reply_to_tweet_id": id }));
    }
    crate::util::put(&mut body, "quote_tweet_id", a.owned("quote_of"));
    if let Some(ids) = a
        .v("media_ids")
        .filter(|v| v.as_array().is_some_and(|l| !l.is_empty()))
    {
        body.insert("media".into(), json!({ "media_ids": ids }));
    }
    crate::util::put(&mut body, "poll", a.v("poll").cloned());
    crate::util::put(&mut body, "reply_settings", a.owned("reply_settings"));
    crate::util::put(&mut body, "community_id", a.owned("community_id"));
    if a.b("made_with_ai") {
        body.insert("made_with_ai".into(), true.into());
    }
    if a.b("paid_partnership") {
        body.insert("paid_partnership".into(), true.into());
    }
    let res = c
        .req(XRequest::post("/2/tweets").user().body(Value::Object(body)))
        .await?;
    let id = res
        .data_str("id")
        .ok_or_else(|| ToolError::msg("X accepted the request but did not return a post id."))?;
    Ok(obj! {
        "id" => id.clone(),
        "url" => status_url(&id),
        "text" => res.data_str("text").or_else(|| a.owned("text")),
        "reply_to" => a.owned("reply_to"),
        "quoted" => a.owned("quote_of"),
        "media_ids" => a.v("media_ids").cloned(),
    }
    .into())
}

async fn create_thread(c: &Ctx, a: &Args, _: &Call) -> Out {
    let posts = a
        .v("posts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut published: Vec<Value> = vec![];
    let mut reply_to: Option<String> = None;
    for (index, post) in posts.iter().enumerate() {
        let text = post.get("text").and_then(Value::as_str).unwrap_or_default();
        let mut body = obj! { "text" => text };
        if let Some(id) = &reply_to {
            body.insert("reply".into(), json!({ "in_reply_to_tweet_id": id }));
        }
        if let Some(ids) = post
            .get("media_ids")
            .filter(|v| v.as_array().is_some_and(|l| !l.is_empty()))
        {
            body.insert("media".into(), json!({ "media_ids": ids }));
        }
        crate::util::put(&mut body, "reply_settings", a.owned("reply_settings"));
        let result = c
            .req(XRequest::post("/2/tweets").user().body(Value::Object(body)))
            .await;
        let outcome = result.and_then(|res| {
            let id = res
                .data_str("id")
                .ok_or_else(|| ToolError::msg("X did not return a post id."))?;
            Ok((id, res.data_str("text")))
        });
        match outcome {
            Ok((id, returned)) => {
                published.push(json!({ "id": id, "url": status_url(&id), "text": returned.unwrap_or_else(|| text.to_owned()) }));
                reply_to = Some(id);
            }
            Err(error) => {
                let failure = match &error {
                    ToolError::Api(e) => e.to_json(),
                    other => obj! { "error" => other.message() },
                };
                let partial = !published.is_empty();
                return Ok(obj! {
                    "complete" => false,
                    "partial" => partial,
                    "posted_count" => published.len(),
                    "failed_at" => index,
                    "error" => failure,
                    "published" => published,
                    "hint" => if partial {
                        "Some posts were already published. Continue by replying to the last published id, or delete them with x_posts action \"delete\"."
                    } else {
                        "Nothing was published."
                    },
                }
                .into());
            }
        }
    }
    let first = published.first().cloned();
    Ok(obj! {
        "complete" => true,
        "posted_count" => published.len(),
        "thread_id" => first.as_ref().and_then(|p| p.get("id").cloned()),
        "url" => first.as_ref().and_then(|p| p.get("url").cloned()),
        "published" => published,
    }
    .into())
}

async fn delete(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("tweet_id");
    let res = c
        .req(XRequest::delete(format!("/2/tweets/{id}")).user())
        .await?;
    Ok(obj! { "deleted" => res.data_true("deleted"), "id" => id }.into())
}

async fn get(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("tweet_id");
    let res = c
        .req(XRequest::get(format!("/2/tweets/{id}")).posts())
        .await?;
    normalize::tweet_single(&res.payload())
        .map(Output::Json)
        .ok_or_else(|| ToolError::msg(format!("Post {id} was not found or is not visible.")))
}

async fn get_many(c: &Ctx, a: &Args, _: &Call) -> Out {
    let res = c
        .req(
            XRequest::get("/2/tweets")
                .q("ids", a.joined("tweet_ids"))
                .posts(),
        )
        .await?;
    Ok(normalize::tweet_list(&res.payload()).into())
}

async fn search(c: &Ctx, a: &Args, _: &Call) -> Out {
    let archive = a.b("archive");
    let path = if archive {
        "/2/tweets/search/all"
    } else {
        "/2/tweets/search/recent"
    };
    let mut request = XRequest::get(path)
        .q("query", a.req("query"))
        .q("max_results", a.u("max_results"))
        .q("next_token", a.s("next_token"));
    if !archive {
        request = request.q("sort_order", a.s("sort_order"));
    }
    let request = request
        .q("start_time", a.s("start_time"))
        .q("end_time", a.s("end_time"))
        .posts()
        .cache_ttl(15_000);
    let res = c.req(request).await?;
    let mut out = obj! { "query" => a.req("query"), "archive" => archive };
    out.extend(normalize::tweet_list(&res.payload()));
    Ok(out.into())
}

async fn count(c: &Ctx, a: &Args, _: &Call) -> Out {
    let path = if a.b("archive") {
        "/2/tweets/counts/all"
    } else {
        "/2/tweets/counts/recent"
    };
    let request = XRequest::get(path)
        .q("query", a.req("query"))
        .q("granularity", a.s("granularity"))
        .q("next_token", a.s("next_token"))
        .q("start_time", a.s("start_time"))
        .q("end_time", a.s("end_time"))
        .cache_ttl(30_000);
    let res = c.req(request).await?;
    Ok(obj! {
        "query" => a.req("query"),
        "total" => res.meta_field("total_tweet_count").filter(|v| !v.is_null()),
        "next_token" => res.meta_field("next_token").filter(|v| !v.is_null()),
        "buckets" => res.data.clone(),
    }
    .into())
}

async fn thread(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("tweet_id");
    let max = a.u("max_replies").unwrap_or(50);
    let root_res = c
        .req(XRequest::get(format!("/2/tweets/{id}")).posts())
        .await?;
    let root = normalize::tweet_single(&root_res.payload());
    let conversation_id = root
        .as_ref()
        .and_then(|r| r.get("conversation_id"))
        .and_then(Value::as_str)
        .unwrap_or(id)
        .to_owned();
    let replies_res = c
        .req(
            XRequest::get("/2/tweets/search/recent")
                .q(
                    "query",
                    format!("conversation_id:{conversation_id} -is:retweet"),
                )
                .q("max_results", max)
                .posts()
                .cache_ttl(15_000),
        )
        .await;
    // Cancellation aborts the task, so any error here means "no index".
    let replies_res = replies_res.ok();
    let page = replies_res
        .as_ref()
        .map(|r| normalize::tweet_list(&r.payload()));
    let replies: Vec<Value> = page
        .as_ref()
        .and_then(|p| p.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let root_id = root
        .as_ref()
        .and_then(|r| r.get("id"))
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_else(|| id.to_owned());
    // The root is already "seen", so only unique replies remain.
    let mut seen = vec![root_id];
    let mut merged: Vec<Value> = vec![];
    for post in &replies {
        let pid = post
            .get("id")
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_else(|| "undefined".into());
        if !seen.contains(&pid) {
            seen.push(pid);
            merged.push(post.clone());
        }
    }
    merged.sort_by(|x, y| {
        let k = |v: &Value| {
            v.get("created_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        k(x).cmp(&k(y))
    });
    let truncated =
        page.as_ref().is_some_and(|p| p.get("next_token").is_some()) || replies.len() as u64 >= max;
    let count = merged.len();
    let replies_out = merged;
    Ok(obj! {
        "conversation_id" => conversation_id,
        "root" => root,
        "replies" => replies_out,
        "count" => count,
        "truncated" => truncated,
        "warning" => replies_res.is_none().then_some(
            "The recent-search index could not be queried (older than 7 days or no access); only the root post is returned."
        ),
    }
    .into())
}

async fn users_of(c: &Ctx, a: &Args, segment: &str) -> Out {
    let id = a.req("tweet_id");
    let res = c
        .req(
            XRequest::get(format!("/2/tweets/{id}/{segment}"))
                .user()
                .q("max_results", a.u("max_results"))
                .q("pagination_token", a.s("next_token"))
                .users()
                .cache_ttl(60_000),
        )
        .await?;
    let users: Vec<Value> = res
        .data
        .as_array()
        .map(|l| l.iter().map(normalize::user).collect())
        .unwrap_or_default();
    let result_count = users.len();
    Ok(obj! {
        "tweet_id" => id,
        "users" => users,
        "next_token" => res.meta_field("next_token").filter(|v| !v.is_null()),
        "result_count" => result_count,
    }
    .into())
}

async fn likers(c: &Ctx, a: &Args, _: &Call) -> Out {
    users_of(c, a, "liking_users").await
}

async fn reposters(c: &Ctx, a: &Args, _: &Call) -> Out {
    users_of(c, a, "retweeted_by").await
}

async fn quotes(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("tweet_id");
    let res = c
        .req(
            XRequest::get(format!("/2/tweets/{id}/quote_tweets"))
                .q("max_results", a.u("max_results"))
                .q("next_token", a.s("next_token"))
                .posts()
                .cache_ttl(30_000),
        )
        .await?;
    let mut out = obj! { "tweet_id" => id };
    out.extend(normalize::tweet_list(&res.payload()));
    Ok(out.into())
}

async fn hide_reply(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("tweet_id");
    let res = c
        .req(
            XRequest::put(format!("/2/tweets/{id}/hidden"))
                .user()
                .body(json!({ "hidden": a.b("hidden") })),
        )
        .await?;
    Ok(obj! { "id" => id, "hidden" => res.data_true("hidden") }.into())
}
