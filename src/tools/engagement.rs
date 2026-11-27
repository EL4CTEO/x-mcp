use serde_json::json;

use super::*;
use crate::handler;

macro_rules! engage {
    ($action:literal, $title:literal, $desc:literal, $f:ident) => {
        Action {
            action: $action,
            title: $title,
            description: $desc,
            ann: WRITE,
            fields: vec![f_tweet_id()],
            handler: handler!($f),
        }
    };
}

pub fn actions() -> Vec<Action> {
    vec![
        engage!(
            "like",
            "Like a post",
            "Like a post as the authenticated account. Requires user auth with like.write. Idempotent: liking an already-liked post is a no-op.",
            like
        ),
        engage!(
            "unlike",
            "Unlike a post",
            "Remove a like from a post. Requires user auth with like.write.",
            unlike
        ),
        engage!(
            "repost",
            "Repost (retweet) a post",
            "Repost a post to your followers. Requires user auth with tweet.write. Idempotent.",
            repost
        ),
        engage!(
            "unrepost",
            "Undo a repost",
            "Remove one of your reposts. Requires user auth with tweet.write.",
            unrepost
        ),
        engage!(
            "bookmark",
            "Bookmark a post",
            "Save a post to your bookmarks. Requires user auth with bookmark.write. Useful for building a research queue the agent can revisit with x_timelines action \"bookmarks\".",
            bookmark
        ),
        engage!(
            "unbookmark",
            "Remove a bookmark",
            "Remove a post from your bookmarks. Requires user auth with bookmark.write.",
            unbookmark
        ),
    ]
}

/// `segment` is the X collection, `flag` what X returns, `key` what we report.
async fn engage(
    c: &Ctx,
    a: &Args,
    verb: &str,
    segment: &str,
    undo: bool,
    flag: &str,
    key: &str,
) -> Out {
    let me = me(c).await?;
    let id = a.req("tweet_id");
    let request = if undo {
        XRequest::delete(format!("/2/users/{me}/{segment}/{id}")).user()
    } else {
        XRequest::post(format!("/2/users/{me}/{segment}"))
            .user()
            .body(json!({ "tweet_id": id }))
    };
    let res = c.req(request).await?;
    Ok(obj! { "action" => verb, "at" => crate::util::iso_now(), "user_id" => me, "tweet_id" => id, key => res.data_true(flag) }.into())
}

async fn like(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(c, a, "like", "likes", false, "liked", "liked").await
}
async fn unlike(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(c, a, "unlike", "likes", true, "liked", "liked").await
}
async fn repost(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(c, a, "repost", "retweets", false, "retweeted", "reposted").await
}
async fn unrepost(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(c, a, "unrepost", "retweets", true, "retweeted", "reposted").await
}
async fn bookmark(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(
        c,
        a,
        "bookmark",
        "bookmarks",
        false,
        "bookmarked",
        "bookmarked",
    )
    .await
}
async fn unbookmark(c: &Ctx, a: &Args, _: &Call) -> Out {
    engage(
        c,
        a,
        "unbookmark",
        "bookmarks",
        true,
        "bookmarked",
        "bookmarked",
    )
    .await
}
