use base64::Engine;
use serde_json::{Value, json};

use super::schema::{Ty, field, int, max_len, string, url};
use super::*;
use crate::handler;
use crate::x::fields::Fields;
use crate::x::media::{CATEGORIES, Source, UploadOptions, check_media_root};
use crate::x::normalize;
use crate::x::viewer::{Kind, ViewOptions};

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "upload",
            title: "Upload media",
            description: "Upload an image, GIF, video or subtitle file and get a media_id to attach to x_posts action \"create\" or x_dms action \"send\". Provide exactly one of path (inside an allowed media root, streamed in 4 MB chunks), base64 (max 25 MB), or url (downloaded, max 100 MB). Alt text is strongly recommended for accessibility. Videos are processed asynchronously; when wait_for_processing is true (default) the tool polls until X reports success. Requires user auth (OAuth 2.0 media.write, or OAuth 1.0a which uses the legacy upload flow).",
            ann: SEND,
            fields: vec![
                field("path", Ty::Str { min: Some(1), max: None, pattern: None, url: false })
                    .opt()
                    .desc("Path to a local media file inside X_MCP_MEDIA_ROOTS (default: current directory)."),
                field("base64", Ty::Str { min: Some(1), max: None, pattern: None, url: false })
                    .opt()
                    .desc("Base64-encoded file contents (no data: prefix, max 25 MB decoded)."),
                field("url", url()).opt().desc("Public https URL to download media from."),
                field("media_type", string()).opt().desc("MIME type, e.g. image/png or video/mp4. Inferred when omitted."),
                field("category", Ty::Enum(&CATEGORIES)).opt().desc("X media category. Inferred from the MIME type when omitted."),
                field("filename", string()).opt().desc("Filename used to infer the MIME type for base64 uploads."),
                field("alt_text", max_len(1_000)).opt().desc("Accessibility description (max 1000 chars)."),
                field("wait_for_processing", Ty::Bool).def(json!(true)).desc("Poll until video processing finishes."),
            ],
            handler: handler!(upload),
        },
        Action {
            action: "status",
            title: "Check media processing status",
            description: "Poll the processing state of an uploaded video or GIF. Requires user auth. Returns pending/in_progress/succeeded/failed, and error details when X provides them.",
            ann: READ,
            fields: vec![field("media_id", super::schema::pattern(super::schema::Pattern::Digits, Some("Media id must be numeric"))).inner("Media id returned by an upload.")],
            handler: handler!(status),
        },
        Action {
            action: "view",
            title: "See images and video frames",
            description: "Downloads media attached to a post and returns it as MCP image content, so vision-capable models can actually see pictures instead of only reading URLs. Photos come back directly (up to 4 per post via media_index). Videos and animated GIFs are sampled into evenly spaced JPEG frames when ffmpeg is available (install it, or point X_MCP_FFMPEG at the binary); without ffmpeg the preview frame and the video URL are returned instead, for clients with native video support. Using tweet_id costs one post read; fetching the media itself is not billed by X.",
            ann: READ,
            fields: vec![
                field("tweet_id", tweet_id()).opt().desc("Post whose media should be viewed."),
                field("url", url()).opt().desc("Direct media URL (image or video) when you already have one."),
                field("media_index", int(0, Some(3))).def(json!(0)).desc("Which attachment to view for multi-image posts (0-3)."),
                field("frames", int(1, Some(6))).def(json!(3)).desc("How many video frames to extract when ffmpeg is available."),
            ],
            handler: handler!(view),
        },
    ]
}

fn is_base64(s: &str) -> bool {
    let body = s.trim_end_matches('=');
    let pad = s.len() - body.len();
    !body.is_empty()
        && pad <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

async fn upload(c: &Ctx, a: &Args, call: &Call) -> Out {
    let sources = ["path", "base64", "url"]
        .iter()
        .filter(|k| a.v(k).is_some())
        .count();
    if sources != 1 {
        return Err(ToolError::msg(
            "Provide exactly one of path, base64 or url.",
        ));
    }
    let source = if let Some(path) = a.s("path") {
        Source::Path(check_media_root(
            std::path::Path::new(path),
            &c.config.media_roots,
        )?)
    } else if let Some(data) = a.s("base64") {
        let clean: String = data.chars().filter(|ch| !ch.is_whitespace()).collect();
        if !is_base64(&clean) {
            return Err(ToolError::msg("base64 data is not valid Base64."));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(clean.as_bytes())
            .or_else(|_| {
                base64::engine::general_purpose::STANDARD_NO_PAD
                    .decode(clean.trim_end_matches('=').as_bytes())
            })
            .map_err(|_| ToolError::msg("base64 data is not valid Base64."))?;
        if bytes.is_empty() {
            return Err(ToolError::msg("base64 data decoded to zero bytes."));
        }
        if bytes.len() > 25 * 1024 * 1024 {
            return Err(ToolError::msg(format!(
                "base64 media is {:.1} MB; the base64 limit is 25 MB. Use path or url for larger files.",
                bytes.len() as f64 / 1024.0 / 1024.0
            )));
        }
        Source::Buffer {
            data: bytes.into(),
            filename: a.owned("filename"),
        }
    } else {
        Source::Url(a.owned("url").unwrap_or_default())
    };
    let progress = call.progress.clone().map(|notify| {
        Box::new(move |segment: u64, total: u64| {
            notify(
                segment,
                total,
                format!("Uploaded segment {segment}/{total}"),
            )
        }) as crate::x::media::Progress
    });
    let mut result = c
        .media
        .upload(UploadOptions {
            source,
            media_type: a.owned("media_type"),
            category: a.owned("category"),
            alt_text: a.owned("alt_text"),
            wait: a.b("wait_for_processing"),
            progress,
        })
        .await?;
    result.insert(
        "attach_with".into(),
        "Pass media_ids: [media_id] to x_posts action \"create\", or media_id to x_dms action \"send\".".into(),
    );
    Ok(result.into())
}

async fn status(c: &Ctx, a: &Args, _: &Call) -> Out {
    Ok(c.media.status(a.req("media_id")).await?.into())
}

async fn view(c: &Ctx, a: &Args, _: &Call) -> Out {
    let tweet = a.s("tweet_id");
    if tweet.is_none() && a.s("url").is_none() {
        return Err(ToolError::msg("Provide either tweet_id or url."));
    }
    let index = a.u("media_index").unwrap_or(0);
    let mut options = ViewOptions {
        url: a.owned("url").unwrap_or_default(),
        kind: Kind::Auto,
        preview_url: None,
        duration_ms: None,
        alt_text: None,
        frames: a.u("frames").unwrap_or(3) as u32,
    };
    if let Some(id) = tweet {
        let res = c
            .req(XRequest::get(format!("/2/tweets/{id}")).posts())
            .await?;
        let post = normalize::tweet_single(&res.payload());
        let media: Vec<Value> = post
            .as_ref()
            .and_then(|p| p.get("media"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if media.is_empty() {
            return Err(ToolError::msg(format!(
                "Post {id} has no media attachments."
            )));
        }
        let Some(item) = media.get(index as usize) else {
            return Err(ToolError::msg(format!(
                "media_index {index} is out of range: post {id} has {} attachment(s).",
                media.len()
            )));
        };
        let field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_owned);
        options.url = field("url")
            .or_else(|| field("preview_image_url"))
            .unwrap_or_default();
        options.preview_url = field("preview_image_url");
        options.kind = Kind::parse(item.get("type").and_then(Value::as_str));
        options.duration_ms = item.get("duration_ms").filter(|d| d.is_number()).cloned();
        options.alt_text = field("alt_text");
        if options.url.is_empty() {
            return Err(ToolError::msg("The post media has no downloadable URL."));
        }
    }
    let view = c.viewer.view(options).await?;
    let content: Vec<Value> = view
        .images
        .iter()
        .map(|i| json!({ "type": "image", "data": i.data, "mimeType": i.mime }))
        .collect();
    let mut structured = Json::new();
    if let Some(id) = tweet {
        structured.insert("tweet_id".into(), id.into());
        structured.insert("media_index".into(), index.into());
    }
    structured.insert("media".into(), Value::Object(view.summary()));
    structured.insert(
        "images".into(),
        Value::Array(
            view.images
                .iter()
                .map(|i| json!({ "label": i.label, "mimeType": i.mime, "bytes": i.bytes }))
                .collect(),
        ),
    );
    structured.insert("ffmpeg".into(), view.ffmpeg.into());
    structured.insert("notes".into(), json!(view.notes));
    if view.images.is_empty() && !view.ffmpeg {
        structured.insert(
            "hint".into(),
            "Install ffmpeg to extract video frames, or pass a photo URL instead.".into(),
        );
    }
    Ok(Output::Rich {
        content,
        structured,
    })
}
