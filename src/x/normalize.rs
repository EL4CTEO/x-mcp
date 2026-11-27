//! Response normalisation: raw X payloads spread related objects across
//! `includes` and change shape per endpoint. Agents get flat, stable objects
//! with URLs and resolved authors instead.

use std::collections::HashMap;

use serde_json::Value;

use crate::obj;
use crate::util::{Json, encode_component, get_arr, get_num, get_str};

fn s(value: &Value, key: &str) -> Option<String> {
    get_str(value, key).map(str::to_owned)
}

fn n(value: &Value, key: &str) -> Option<Value> {
    get_num(value, key)
}

fn empty() -> Value {
    Value::Object(Json::new())
}

#[derive(Default)]
pub struct Context<'a> {
    pub users: HashMap<&'a str, &'a Value>,
    pub media: HashMap<&'a str, &'a Value>,
    pub tweets: Vec<(&'a str, &'a Value)>,
}

impl<'a> Context<'a> {
    pub fn from(includes: Option<&'a Value>) -> Self {
        let mut ctx = Context::default();
        let Some(includes) = includes else { return ctx };
        let list = |key: &str| get_arr(includes, key).map(|a| a.as_slice()).unwrap_or(&[]);
        for user in list("users") {
            if let Some(id) = get_str(user, "id") {
                ctx.users.insert(id, user);
            }
        }
        for item in list("media") {
            if let Some(key) = get_str(item, "media_key") {
                ctx.media.insert(key, item);
            }
        }
        for tweet in list("tweets") {
            if let Some(id) = get_str(tweet, "id") {
                // Map semantics: a repeated id keeps its first position, last value.
                if let Some(slot) = ctx.tweets.iter_mut().find(|(k, _)| *k == id) {
                    slot.1 = tweet;
                } else {
                    ctx.tweets.push((id, tweet));
                }
            }
        }
        ctx
    }

    fn tweet(&self, id: &str) -> Option<&'a Value> {
        self.tweets.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
    }
}

fn best_video_url(variants: Option<&Value>) -> Option<String> {
    let variants = variants?.as_array()?;
    let mut mp4: Vec<&Value> = variants
        .iter()
        .filter(|v| {
            get_str(v, "content_type") == Some("video/mp4")
                && v.get("url").is_some_and(Value::is_string)
        })
        .collect();
    let rate = |v: &Value| v.get("bit_rate").and_then(Value::as_f64).unwrap_or(0.0);
    mp4.sort_by(|a, b| {
        rate(b)
            .partial_cmp(&rate(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    mp4.first().and_then(|v| s(v, "url"))
}

pub fn media(raw: &Value) -> Value {
    let metrics = raw.get("public_metrics").cloned().unwrap_or_else(empty);
    Value::Object(obj! {
        "media_key" => s(raw, "media_key"),
        "type" => s(raw, "type"),
        "url" => s(raw, "url").or_else(|| best_video_url(raw.get("variants"))),
        "preview_image_url" => s(raw, "preview_image_url"),
        "alt_text" => s(raw, "alt_text"),
        "width" => n(raw, "width"),
        "height" => n(raw, "height"),
        "duration_ms" => n(raw, "duration_ms"),
        "views" => n(&metrics, "playback_count").or_else(|| n(&metrics, "view_count")),
    })
}

pub fn user(raw: &Value) -> Value {
    let metrics = raw.get("public_metrics").cloned().unwrap_or_else(empty);
    let username = s(raw, "username");
    Value::Object(obj! {
        "id" => s(raw, "id"),
        "username" => username.clone(),
        "name" => s(raw, "name"),
        "url" => username.map(|u| format!("https://x.com/{u}")),
        "bio" => s(raw, "description"),
        "location" => s(raw, "location"),
        "created_at" => s(raw, "created_at"),
        "verified" => raw.get("verified") == Some(&Value::Bool(true)),
        "verified_type" => s(raw, "verified_type"),
        "protected" => raw.get("protected") == Some(&Value::Bool(true)),
        "profile_image_url" => s(raw, "profile_image_url"),
        "followers" => n(&metrics, "followers_count"),
        "following" => n(&metrics, "following_count"),
        "posts" => n(&metrics, "tweet_count"),
        "listed" => n(&metrics, "listed_count"),
        "pinned_tweet_id" => s(raw, "pinned_tweet_id"),
    })
}

fn author(raw: Option<&Value>) -> Option<Value> {
    let user = user(raw?);
    Some(Value::Object(obj! {
        "id" => user.get("id").cloned(),
        "username" => user.get("username").cloned(),
        "name" => user.get("name").cloned(),
        "verified" => user.get("verified").cloned(),
    }))
}

fn non_empty(items: Vec<Value>) -> Option<Value> {
    (!items.is_empty()).then_some(Value::Array(items))
}

pub fn tweet(raw: &Value, ctx: &Context<'_>, depth: u8) -> Value {
    let author = get_str(raw, "author_id").and_then(|id| author(ctx.users.get(id).copied()));
    let metrics = raw.get("public_metrics").cloned().unwrap_or_else(empty);
    let entities = raw.get("entities").cloned().unwrap_or_else(empty);
    let note_text = raw
        .get("note_tweet")
        .filter(|v| !v.is_null())
        .and_then(|note| s(note, "text"));

    let attachments = raw.get("attachments").cloned().unwrap_or_else(empty);
    let media_items: Vec<Value> = get_arr(&attachments, "media_keys")
        .map(|keys| {
            keys.iter()
                .filter_map(|k| k.as_str().and_then(|k| ctx.media.get(k)))
                .map(|m| media(m))
                .collect()
        })
        .unwrap_or_default();

    let referenced: &[Value] = get_arr(raw, "referenced_tweets")
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let find = |t: &str| referenced.iter().find(|r| get_str(r, "type") == Some(t));
    let (replied, quoted, retweeted) = (find("replied_to"), find("quoted"), find("retweeted"));

    let strings = |list: Option<&Vec<Value>>, key: &str| -> Option<Value> {
        let list = list?;
        non_empty(
            list.iter()
                .filter_map(|e| get_str(e, key))
                .filter(|v| !v.is_empty())
                .map(|v| Value::String(v.into()))
                .collect(),
        )
    };
    let hashtags = strings(get_arr(&entities, "hashtags"), "tag");
    let mentions = strings(get_arr(&entities, "mentions"), "username");
    let urls = get_arr(&entities, "urls").and_then(|list| {
        non_empty(
            list.iter()
                .map(|e| {
                    Value::Object(obj! {
                        "url" => s(e, "url"),
                        "expanded_url" => s(e, "expanded_url"),
                        "display_url" => s(e, "display_url"),
                    })
                })
                .collect(),
        )
    });

    let metrics_value = obj! {
        "likes" => n(&metrics, "like_count"),
        "reposts" => n(&metrics, "retweet_count"),
        "replies" => n(&metrics, "reply_count"),
        "quotes" => n(&metrics, "quote_count"),
        "bookmarks" => n(&metrics, "bookmark_count"),
        "impressions" => n(&metrics, "impression_count"),
    };
    let edited = get_arr(raw, "edit_history_tweet_ids").is_some_and(|h| h.len() > 1);
    let id = s(raw, "id");
    let author_username = author
        .as_ref()
        .and_then(|a| get_str(a, "username"))
        .filter(|u| !u.is_empty())
        .map(str::to_owned);
    let url = match author_username {
        Some(u) => Some(format!(
            "https://x.com/{u}/status/{}",
            id.as_deref().unwrap_or("undefined")
        )),
        None => s(raw, "url").or_else(|| {
            id.as_ref()
                .filter(|i| !i.is_empty())
                .map(|i| format!("https://x.com/i/web/status/{i}"))
        }),
    };

    let mut out = obj! {
        "id" => id,
        "url" => url,
        "text" => note_text.or_else(|| s(raw, "text")),
        "created_at" => s(raw, "created_at"),
        "lang" => s(raw, "lang"),
        "author" => author,
        "metrics" => (!metrics_value.is_empty()).then_some(Value::Object(metrics_value)),
        "conversation_id" => s(raw, "conversation_id"),
        "in_reply_to_tweet_id" => replied.and_then(|r| s(r, "id")),
        "quoted_tweet_id" => quoted.and_then(|r| s(r, "id")),
        "retweeted_tweet_id" => retweeted.and_then(|r| s(r, "id")),
        "media" => non_empty(media_items),
        "hashtags" => hashtags,
        "mentions" => mentions,
        "urls" => urls,
        "possibly_sensitive" => (raw.get("possibly_sensitive") == Some(&Value::Bool(true))).then_some(true),
        "edited" => edited.then_some(true),
        "reply_settings" => s(raw, "reply_settings"),
        "source" => s(raw, "source"),
    };

    // One level of context for the referenced post.
    if depth == 0 && (quoted.is_some() || retweeted.is_some()) {
        let ref_id = quoted.or(retweeted).and_then(|r| get_str(r, "id"));
        if let Some(included) = ref_id.filter(|i| !i.is_empty()).and_then(|i| ctx.tweet(i)) {
            out.insert("referenced_post".into(), tweet(included, ctx, 1));
        }
    }
    Value::Object(out)
}

fn meta_of(payload: &Value) -> Json {
    let meta = payload.get("meta").cloned().unwrap_or_else(empty);
    obj! {
        "next_token" => s(&meta, "next_token"),
        "previous_token" => s(&meta, "previous_token"),
        "result_count" => n(&meta, "result_count"),
    }
}

fn errors_of(payload: &Value, out: &mut Json) {
    if let Some(errors) = get_arr(payload, "errors").filter(|e| !e.is_empty()) {
        out.insert("errors".into(), Value::Array(errors.clone()));
    }
}

fn data_list(payload: &Value) -> &[Value] {
    get_arr(payload, "data").map(Vec::as_slice).unwrap_or(&[])
}

pub fn tweet_list(payload: &Value) -> Json {
    let ctx = Context::from(payload.get("includes"));
    let mut out =
        obj! { "data" => data_list(payload).iter().map(|t| tweet(t, &ctx, 0)).collect::<Vec<_>>() };
    out.extend(meta_of(payload));
    errors_of(payload, &mut out);
    out
}

pub fn tweet_single(payload: &Value) -> Option<Value> {
    let ctx = Context::from(payload.get("includes"));
    match payload.get("data")? {
        Value::Array(items) => items.first().map(|t| tweet(t, &ctx, 0)),
        Value::Null | Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        data => Some(tweet(data, &ctx, 0)),
    }
}

pub fn user_list(payload: &Value) -> Json {
    let ctx = Context::from(payload.get("includes"));
    let mut out = obj! { "data" => data_list(payload).iter().map(user).collect::<Vec<_>>() };
    out.extend(meta_of(payload));
    if !ctx.tweets.is_empty() {
        let tweets: Vec<Value> = ctx.tweets.iter().map(|(_, t)| tweet(t, &ctx, 0)).collect();
        out.insert(
            "included".into(),
            Value::Object(obj! { "tweets" => tweets }),
        );
    }
    errors_of(payload, &mut out);
    out
}

pub fn user_single(payload: &Value) -> Option<Value> {
    match payload.get("data")? {
        Value::Array(items) => items.first().map(user),
        Value::Null | Value::Bool(false) => None,
        data => Some(user(data)),
    }
}

pub fn list(raw: &Value) -> Value {
    let id = s(raw, "id");
    Value::Object(obj! {
        "id" => id.clone(),
        "name" => s(raw, "name"),
        "description" => s(raw, "description"),
        "private" => raw.get("private") == Some(&Value::Bool(true)),
        "members" => n(raw, "member_count"),
        "followers" => n(raw, "follower_count"),
        "owner_id" => s(raw, "owner_id"),
        "created_at" => s(raw, "created_at"),
        "url" => id.filter(|i| !i.is_empty()).map(|i| format!("https://x.com/i/lists/{i}")),
    })
}

pub fn space(raw: &Value) -> Value {
    let id = s(raw, "id");
    Value::Object(obj! {
        "id" => id.clone(),
        "title" => s(raw, "title"),
        "state" => s(raw, "state"),
        "url" => id.filter(|i| !i.is_empty()).map(|i| format!("https://x.com/i/spaces/{i}")),
        "creator_id" => s(raw, "creator_id"),
        "hosts" => raw.get("host_ids").filter(|h| h.is_array()).cloned(),
        "participants" => n(raw, "participant_count"),
        "scheduled_start" => s(raw, "scheduled_start"),
        "started_at" => s(raw, "started_at"),
        "ended_at" => s(raw, "ended_at"),
        "is_ticketed" => (raw.get("is_ticketed") == Some(&Value::Bool(true))).then_some(true),
        "lang" => s(raw, "lang"),
    })
}

pub fn trend(raw: &Value) -> Value {
    let name = s(raw, "trend_name")
        .or_else(|| s(raw, "name"))
        .unwrap_or_default();
    Value::Object(obj! {
        "name" => name.clone(),
        "posts" => n(raw, "tweet_count").or_else(|| n(raw, "post_count")).or_else(|| n(raw, "tweet_volume")),
        "category" => s(raw, "category"),
        "trending_since" => s(raw, "trending_since"),
        "url" => (!name.is_empty()).then(|| format!("https://x.com/search?q={}", encode_component(&name))),
    })
}

pub fn dm_event(raw: &Value, ctx: &Context<'_>) -> Value {
    let keys: Vec<String> = match raw.get("attachments") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|a| get_str(a, "media_key"))
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(obj @ Value::Object(_)) => get_arr(obj, "media_keys")
            .map(|keys| {
                keys.iter()
                    .map(|k| {
                        k.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| k.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => vec![],
    };
    let attachments: Vec<Value> = keys
        .iter()
        .map(|key| match ctx.media.get(key.as_str()) {
            Some(m) => media(m),
            None => Value::Object(obj! { "media_key" => key.clone() }),
        })
        .collect();
    Value::Object(obj! {
        "id" => s(raw, "id"),
        "event_type" => s(raw, "event_type"),
        "conversation_id" => s(raw, "dm_conversation_id"),
        "text" => s(raw, "text"),
        "created_at" => s(raw, "created_at"),
        "sender_id" => s(raw, "sender_id"),
        "attachments" => non_empty(attachments),
    })
}

pub fn dm_events(payload: &Value) -> Json {
    let ctx = Context::from(payload.get("includes"));
    let mut out =
        obj! { "data" => data_list(payload).iter().map(|e| dm_event(e, &ctx)).collect::<Vec<_>>() };
    out.extend(meta_of(payload));
    errors_of(payload, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tweet_resolves_author_media_and_reference() {
        let payload = json!({
            "data": {"id": "1", "text": "short", "note_tweet": {"text": "long"}, "author_id": "9",
                     "attachments": {"media_keys": ["m1"]},
                     "referenced_tweets": [{"type": "quoted", "id": "2"}],
                     "entities": {"hashtags": [{"tag": "rust"}], "urls": [{"url": "u"}]},
                     "public_metrics": {"like_count": 3}, "edit_history_tweet_ids": ["1", "0"]},
            "includes": {"users": [{"id": "9", "username": "jack", "name": "Jack"}],
                         "media": [{"media_key": "m1", "type": "video", "variants": [
                             {"content_type": "video/mp4", "url": "lo", "bit_rate": 1},
                             {"content_type": "video/mp4", "url": "hi", "bit_rate": 9}]}],
                         "tweets": [{"id": "2", "text": "quoted"}]}
        });
        let t = tweet_single(&payload).unwrap();
        assert_eq!(t["text"], "long");
        assert_eq!(t["url"], "https://x.com/jack/status/1");
        assert_eq!(
            t["author"],
            json!({"id": "9", "username": "jack", "name": "Jack", "verified": false})
        );
        assert_eq!(t["media"][0]["url"], "hi");
        assert_eq!(t["metrics"], json!({"likes": 3}));
        assert_eq!(t["edited"], true);
        assert_eq!(t["hashtags"], json!(["rust"]));
        assert_eq!(t["referenced_post"]["url"], "https://x.com/i/web/status/2");
    }

    #[test]
    fn trend_url_is_encoded() {
        assert_eq!(
            trend(&json!({"trend_name": "#Rust Lang"}))["url"],
            "https://x.com/search?q=%23Rust%20Lang"
        );
    }
}
