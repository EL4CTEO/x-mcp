//! Media uploads (chunked, v2 for OAuth 2.0 and legacy v1.1 for OAuth 1.0a)
//! and the SSRF guard shared with the viewer.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::client::{Auth, XClient, XRequest};
use super::errors::{ToolError, XApiError, XResult};
use super::http::FormValue;
use crate::obj;
use crate::util::{Json, mb};

pub const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const REMOTE_FETCH_LIMIT: u64 = 100 * 1024 * 1024;

const MIME_BY_EXTENSION: [(&str, &str); 12] = [
    (".bmp", "image/bmp"),
    (".gif", "image/gif"),
    (".jpeg", "image/jpeg"),
    (".jpg", "image/jpeg"),
    (".m4v", "video/x-m4v"),
    (".mov", "video/quicktime"),
    (".mp4", "video/mp4"),
    (".png", "image/png"),
    (".srt", "text/plain"),
    (".vtt", "text/vtt"),
    (".webm", "video/webm"),
    (".webp", "image/webp"),
];

pub const CATEGORIES: [&str; 8] = [
    "tweet_image",
    "tweet_gif",
    "tweet_video",
    "amplify_video",
    "dm_image",
    "dm_gif",
    "dm_video",
    "subtitles",
];

/// `path.extname(name).toLowerCase()`.
pub fn extension(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn mime_for(ext: &str) -> Option<&'static str> {
    MIME_BY_EXTENSION
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
}

pub fn infer_media_type(filename: Option<&str>, provided: Option<&str>) -> String {
    if let Some(p) = provided.filter(|p| !p.is_empty()) {
        return p.to_owned();
    }
    mime_for(&filename.map(extension).unwrap_or_default())
        .unwrap_or("application/octet-stream")
        .to_owned()
}

pub fn infer_category(media_type: &str, provided: Option<&str>) -> String {
    if let Some(p) = provided {
        return p.to_owned();
    }
    let c = if media_type.starts_with("text/") {
        "subtitles"
    } else if media_type == "image/gif" {
        "tweet_gif"
    } else if media_type.starts_with("image/") {
        "tweet_image"
    } else if media_type.starts_with("video/") {
        "tweet_video"
    } else {
        "tweet_image"
    };
    c.to_owned()
}

/// Uploading arbitrary local files would make the agent an exfiltration
/// channel (a prompt injection could ask for ~/.ssh/id_rsa): only real media
/// extensions are allowed.
pub fn assert_supported_path(path: &str) -> XResult<()> {
    let ext = extension(path);
    if ext.is_empty() || mime_for(&ext).is_none() {
        let allowed: Vec<&str> = MIME_BY_EXTENSION.iter().map(|(e, _)| *e).collect();
        let what = if ext.is_empty() {
            "files without an extension".to_owned()
        } else {
            ext
        };
        return Err(ToolError::msg(format!(
            "Refusing to upload \"{path}\": {what} are not supported media. Allowed: {}.",
            allowed.join(", ")
        )));
    }
    Ok(())
}

pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            a == 0
                || a == 10
                || (a == 100 && (64..128).contains(&b))
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && (16..32).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 168)
                || (a == 198 && (18..20).contains(&b))
                || a >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

const BLOCKED_SUFFIXES: [&str; 4] = [".localhost", ".local", ".internal", ".home.arpa"];

/// Media URLs are fetched by the server, so they are an SSRF surface:
/// require https, reject private hosts by name and by resolved address, and
/// re-check every redirect.
pub async fn assert_media_url(raw: &str, allow_private: bool) -> XResult<url::Url> {
    let url = url::Url::parse(raw).map_err(|_| ToolError::msg("Invalid media URL."))?;
    if url.scheme() != "https" && !(allow_private && url.scheme() == "http") {
        return Err(ToolError::msg("Remote media URLs must use https."));
    }
    if allow_private {
        return Ok(url);
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host.is_empty() {
        return Err(ToolError::msg("Media URL is missing a host."));
    }
    if host == "localhost" || BLOCKED_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return Err(ToolError::msg(format!(
            "Refusing to download media from a local or private host ({host})."
        )));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(ip) {
            return Err(ToolError::msg(format!(
                "Refusing to download media from a private address ({host})."
            )));
        }
        return Ok(url);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| ToolError::msg(format!("Could not resolve media host {host}: {e}")))?
        .map(|a| a.ip())
        .collect();
    if addrs.is_empty() {
        return Err(ToolError::msg(format!(
            "Could not resolve media host {host}."
        )));
    }
    if let Some(blocked) = addrs.iter().find(|a| is_private_ip(**a)) {
        return Err(ToolError::msg(format!(
            "Refusing to download media from {host}: it resolves to the private address {blocked}."
        )));
    }
    Ok(url)
}

/// A client that never follows redirects on its own (each hop is re-checked).
pub fn download_client(timeout_ms: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .expect("download client")
}

/// GETs a media URL hop by hop, validating every redirect target.
pub async fn open_media(
    client: &reqwest::Client,
    raw: &str,
    allow_private: bool,
) -> XResult<(url::Url, reqwest::Response)> {
    let mut current = assert_media_url(raw, allow_private).await?;
    for _ in 0..4 {
        let response =
            client.get(current.clone()).send().await.map_err(|e| {
                ToolError::msg(format!("Could not download media from {current}: {e}"))
            })?;
        let status = response.status().as_u16();
        if [301, 302, 303, 307, 308].contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|l| l.to_str().ok())
                .ok_or_else(|| {
                    ToolError::msg("Media redirect did not include a Location header.")
                })?;
            let next = current
                .join(location)
                .map_err(|_| ToolError::msg("Invalid media URL."))?;
            current = assert_media_url(next.as_str(), allow_private).await?;
            continue;
        }
        return Ok((current, response));
    }
    Err(ToolError::msg(
        "Too many redirects while downloading media.",
    ))
}

pub enum Source {
    Path(std::path::PathBuf),
    Buffer {
        data: Bytes,
        filename: Option<String>,
    },
    Url(String),
}

struct Resolved {
    size: u64,
    filename: String,
    type_hint: Option<String>,
    reader: Reader,
}

enum Reader {
    File(tokio::fs::File),
    Memory(Bytes),
}

impl Resolved {
    async fn read(&mut self, start: u64, end: u64) -> XResult<Bytes> {
        match &mut self.reader {
            Reader::Memory(data) => Ok(data.slice(start as usize..end as usize)),
            Reader::File(file) => {
                let mut buf = vec![0u8; (end - start) as usize];
                file.seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|e| ToolError::msg(e.to_string()))?;
                let mut filled = 0;
                while filled < buf.len() {
                    let n = file
                        .read(&mut buf[filled..])
                        .await
                        .map_err(|e| ToolError::msg(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                buf.truncate(filled);
                Ok(Bytes::from(buf))
            }
        }
    }
}

async fn resolve(
    source: Source,
    client: &reqwest::Client,
    allow_private: bool,
) -> XResult<Resolved> {
    match source {
        Source::Path(path) => {
            let shown = path.display().to_string();
            assert_supported_path(&shown)?;
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|e| ToolError::msg(format!("{e}: {shown}")))?;
            let meta = file
                .metadata()
                .await
                .map_err(|e| ToolError::msg(e.to_string()))?;
            if !meta.is_file() {
                return Err(ToolError::msg(format!("Not a file: {shown}")));
            }
            if meta.len() == 0 {
                return Err(ToolError::msg(format!("Media file is empty: {shown}")));
            }
            Ok(Resolved {
                size: meta.len(),
                filename: path
                    .file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                type_hint: None,
                reader: Reader::File(file),
            })
        }
        Source::Buffer { data, filename } => {
            if data.is_empty() {
                return Err(ToolError::msg("Base64 media data is empty."));
            }
            Ok(Resolved {
                size: data.len() as u64,
                filename: filename.unwrap_or_else(|| "upload.bin".into()),
                type_hint: None,
                reader: Reader::Memory(data),
            })
        }
        Source::Url(raw) => {
            let (current, response) = open_media(client, &raw, allow_private).await?;
            let status = response.status().as_u16();
            if !(200..300).contains(&status) {
                return Err(ToolError::msg(format!(
                    "Could not download media from {current}: HTTP {status}"
                )));
            }
            if let Some(declared) = response
                .content_length()
                .filter(|l| *l > REMOTE_FETCH_LIMIT)
            {
                return Err(ToolError::msg(format!(
                    "Remote media is {}, above the 100 MB limit for URL sources. Download it and pass a local path instead.",
                    mb(declared)
                )));
            }
            let type_hint = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty());
            let data = response
                .bytes()
                .await
                .map_err(|e| ToolError::msg(e.to_string()))?;
            if data.len() as u64 > REMOTE_FETCH_LIMIT {
                return Err(ToolError::msg("Remote media exceeded the 100 MB limit."));
            }
            let filename = url::Url::parse(&raw)
                .ok()
                .and_then(|u| {
                    u.path_segments()
                        .and_then(|mut s| s.next_back().map(str::to_owned))
                })
                .filter(|f| !f.is_empty())
                .unwrap_or_else(|| "upload.bin".into());
            crate::debug!("downloaded remote media", "url" => current.to_string(), "bytes" => data.len());
            Ok(Resolved {
                size: data.len() as u64,
                filename,
                type_hint,
                reader: Reader::Memory(data),
            })
        }
    }
}

pub type Progress = Box<dyn Fn(u64, u64) + Send + Sync>;

pub struct UploadOptions {
    pub source: Source,
    pub media_type: Option<String>,
    pub category: Option<String>,
    pub alt_text: Option<String>,
    pub wait: bool,
    pub progress: Option<Progress>,
}

pub struct MediaUploader {
    client: Arc<XClient>,
    downloads: reqwest::Client,
    /// Which flow created each media id, so status polls use the same API.
    flows: Mutex<HashMap<String, Auth>>,
}

impl MediaUploader {
    pub fn new(client: Arc<XClient>) -> Self {
        MediaUploader {
            downloads: download_client(client.config.timeout_ms),
            client,
            flows: Mutex::new(HashMap::new()),
        }
    }

    pub async fn upload(&self, options: UploadOptions) -> XResult<Json> {
        let started = Instant::now();
        let allow_private = self.client.config.allow_private_hosts;
        let filename_override = match &options.source {
            Source::Buffer { filename, .. } => filename.clone(),
            _ => None,
        };
        let mut source = resolve(options.source, &self.downloads, allow_private).await?;
        let media_type = infer_media_type(
            Some(filename_override.as_deref().unwrap_or(&source.filename)),
            options
                .media_type
                .as_deref()
                .or(source.type_hint.as_deref()),
        );
        let category = infer_category(&media_type, options.category.as_deref());
        let v2 = self.client.auth.has_oauth2();
        let segments = source.size.div_ceil(MAX_CHUNK_BYTES).max(1);
        crate::info!("uploading media", "filename" => source.filename.clone(), "bytes" => source.size, "mediaType" => media_type.clone(),
            "category" => category.clone(), "auth" => if v2 { "oauth2" } else { "oauth1" });

        let (media_id, media_key, processing) = if v2 {
            self.upload_v2(
                &mut source,
                &media_type,
                &category,
                segments,
                &options.progress,
            )
            .await?
        } else {
            self.upload_v1(
                &mut source,
                &media_type,
                &category,
                segments,
                &options.progress,
            )
            .await?
        };
        self.flows.lock().unwrap_or_else(|e| e.into_inner()).insert(
            media_id.clone(),
            if v2 { Auth::OAuth2 } else { Auth::OAuth1 },
        );

        if let Some(alt) = options
            .alt_text
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
        {
            self.set_alt_text(&media_id, alt, v2).await?;
        }

        let state = match processing {
            Some(info) if !options.wait => info
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_owned(),
            Some(info) => self.wait_for_processing(&media_id, v2, info).await?,
            None if category == "tweet_video" || category == "dm_video" => "succeeded".into(),
            None => "not_required".into(),
        };
        Ok(obj! {
            "media_id" => media_id,
            "media_key" => media_key,
            "media_type" => media_type,
            "category" => category,
            "bytes" => source.size,
            "segments" => segments,
            "processing_state" => state,
            "auth" => if v2 { "oauth2" } else { "oauth1" },
            "duration_ms" => started.elapsed().as_millis() as u64,
        })
    }

    pub async fn status(&self, media_id: &str) -> XResult<Json> {
        let flow = self
            .flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(media_id)
            .copied();
        let v2 = flow
            .map(|f| f == Auth::OAuth2)
            .unwrap_or_else(|| self.client.auth.has_oauth2());
        let res = self
            .client
            .request(self.status_request(media_id, v2))
            .await?;
        let mut out =
            obj! { "media_id" => media_id, "auth" => if v2 { "oauth2" } else { "oauth1" } };
        crate::util::spread(&mut out, res.data);
        Ok(out)
    }

    fn status_request(&self, media_id: &str, v2: bool) -> XRequest {
        let (path, auth) = if v2 {
            ("/2/media/upload", Auth::OAuth2)
        } else {
            ("/1.1/media/upload.json", Auth::OAuth1)
        };
        XRequest::get(path)
            .upload()
            .auth(auth)
            .no_cache()
            .q("command", "STATUS")
            .q("media_id", media_id)
    }

    async fn upload_v2(
        &self,
        source: &mut Resolved,
        media_type: &str,
        category: &str,
        segments: u64,
        progress: &Option<Progress>,
    ) -> XResult<(String, Option<String>, Option<Value>)> {
        let init = self
            .client
            .request(
                XRequest::post("/2/media/upload/initialize")
                    .upload()
                    .auth(Auth::OAuth2)
                    .body(json!({ "media_type": media_type, "total_bytes": source.size, "media_category": category })),
            )
            .await?;
        let media_id = init
            .data_str("id")
            .ok_or_else(|| XApiError::new(500, "X did not return a media id for the upload."))?;
        let media_key = init.data_str("media_key");
        for segment in 0..segments {
            let start = segment * MAX_CHUNK_BYTES;
            let end = (start + MAX_CHUNK_BYTES).min(source.size);
            let chunk = source.read(start, end).await?;
            let form = vec![
                (
                    "segment_index".to_owned(),
                    FormValue::Text(segment.to_string()),
                ),
                (
                    "media".to_owned(),
                    FormValue::File {
                        data: chunk,
                        filename: format!("chunk-{segment}.bin"),
                        mime: media_type.to_owned(),
                    },
                ),
            ];
            self.client
                .request(
                    XRequest::post(format!("/2/media/upload/{media_id}/append"))
                        .upload()
                        .auth(Auth::OAuth2)
                        .form(form)
                        .idempotent(),
                )
                .await?;
            if let Some(p) = progress {
                p(segment + 1, segments);
            }
        }
        let finalized = self
            .client
            .request(
                XRequest::post(format!("/2/media/upload/{media_id}/finalize"))
                    .upload()
                    .auth(Auth::OAuth2),
            )
            .await?;
        Ok((
            media_id,
            media_key,
            finalized
                .data
                .get("processing_info")
                .filter(|p| p.is_object())
                .cloned(),
        ))
    }

    async fn upload_v1(
        &self,
        source: &mut Resolved,
        media_type: &str,
        category: &str,
        segments: u64,
        progress: &Option<Progress>,
    ) -> XResult<(String, Option<String>, Option<Value>)> {
        let text = |k: &str, v: String| (k.to_owned(), FormValue::Text(v));
        let init = self
            .client
            .request(
                XRequest::post("/1.1/media/upload.json")
                    .upload()
                    .auth(Auth::OAuth1)
                    .form(vec![
                        text("command", "INIT".into()),
                        text("total_bytes", source.size.to_string()),
                        text("media_type", media_type.to_owned()),
                        text("media_category", category.to_owned()),
                    ]),
            )
            .await?;
        let media_id = init
            .data_str("media_id_string")
            .or_else(|| {
                init.data.get("media_id").filter(|v| !v.is_null()).map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string())
                })
            })
            .ok_or_else(|| {
                XApiError::new(500, "X did not return a media id for the v1.1 upload.")
            })?;
        for segment in 0..segments {
            let start = segment * MAX_CHUNK_BYTES;
            let end = (start + MAX_CHUNK_BYTES).min(source.size);
            let chunk = source.read(start, end).await?;
            let form = vec![
                text("command", "APPEND".into()),
                text("media_id", media_id.clone()),
                text("segment_index", segment.to_string()),
                (
                    "media".to_owned(),
                    FormValue::File {
                        data: chunk,
                        filename: format!("chunk-{segment}.bin"),
                        mime: media_type.to_owned(),
                    },
                ),
            ];
            self.client
                .request(
                    XRequest::post("/1.1/media/upload.json")
                        .upload()
                        .auth(Auth::OAuth1)
                        .form(form)
                        .idempotent(),
                )
                .await?;
            if let Some(p) = progress {
                p(segment + 1, segments);
            }
        }
        let finalized = self
            .client
            .request(
                XRequest::post("/1.1/media/upload.json")
                    .upload()
                    .auth(Auth::OAuth1)
                    .form(vec![
                        text("command", "FINALIZE".into()),
                        text("media_id", media_id.clone()),
                    ]),
            )
            .await?;
        Ok((
            media_id,
            None,
            finalized
                .data
                .get("processing_info")
                .filter(|p| p.is_object())
                .cloned(),
        ))
    }

    async fn set_alt_text(&self, media_id: &str, alt: &str, v2: bool) -> XResult<()> {
        if crate::util::utf16_len(alt) > 1_000 {
            return Err(ToolError::msg("Alt text must be at most 1000 characters."));
        }
        let request = if v2 {
            XRequest::post("/2/media/metadata")
                .upload()
                .auth(Auth::OAuth2)
                .body(json!({ "id": media_id, "metadata": { "alt_text": { "text": alt } } }))
        } else {
            XRequest::post("/1.1/media/metadata/create.json")
                .upload()
                .auth(Auth::OAuth1)
                .body(json!({ "media_id": media_id, "alt_text": { "text": alt } }))
        };
        self.client.request(request).await.map(|_| ())
    }

    async fn wait_for_processing(
        &self,
        media_id: &str,
        v2: bool,
        initial: Value,
    ) -> XResult<String> {
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut info = initial;
        loop {
            let state = info
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if state == "succeeded" {
                return Ok(state);
            }
            if state == "failed" {
                let message = info
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                return Err(XApiError {
                    detail: message.clone(),
                    ..XApiError::new(
                        400,
                        format!(
                            "Media processing failed: {}",
                            message.as_deref().unwrap_or("unknown error")
                        ),
                    )
                }
                .into());
            }
            if Instant::now() > deadline {
                return Ok(state);
            }
            let wait = info
                .get("check_after_secs")
                .and_then(Value::as_f64)
                .unwrap_or(1.0);
            tokio::time::sleep(Duration::from_millis(((wait * 1000.0) as u64).min(10_000))).await;
            let status = self
                .client
                .request(self.status_request(media_id, v2))
                .await?;
            match status.data.get("processing_info").filter(|p| p.is_object()) {
                Some(next) => info = next.clone(),
                None => return Ok("succeeded".into()),
            }
        }
    }
}

/// Resolves a requested upload path inside the allowed media roots.
pub fn check_media_root(path: &Path, roots: &[std::path::PathBuf]) -> XResult<std::path::PathBuf> {
    let resolved = crate::config::absolute(path);
    let fold = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    let compare = fold(&resolved);
    let sep = std::path::MAIN_SEPARATOR;
    let allowed = roots.iter().any(|root| {
        let root = fold(root);
        let prefix = if root.ends_with(sep) {
            root.clone()
        } else {
            format!("{root}{sep}")
        };
        compare == root || compare.starts_with(&prefix)
    });
    if !allowed {
        let shown: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
        return Err(ToolError::msg(format!(
            "Refusing to read {}: it is outside the allowed media roots ({}). Set X_MCP_MEDIA_ROOTS to allow more directories.",
            resolved.display(),
            shown.join(", ")
        )));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses_are_blocked() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "fd00::1",
            "fe80::1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(!is_private_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn media_urls_need_https_and_public_hosts() {
        assert_eq!(
            assert_media_url("http://example.com/a.png", false)
                .await
                .unwrap_err()
                .message(),
            "Remote media URLs must use https."
        );
        assert!(
            assert_media_url("https://localhost/a.png", false)
                .await
                .unwrap_err()
                .message()
                .contains("local or private host")
        );
        assert!(
            assert_media_url("https://printer.local/a.png", false)
                .await
                .is_err()
        );
        assert!(
            assert_media_url("https://[::1]/a.png", false)
                .await
                .unwrap_err()
                .message()
                .contains("private address")
        );
    }

    #[test]
    fn only_media_extensions_upload() {
        assert!(assert_supported_path("photo.PNG").is_ok());
        assert!(
            assert_supported_path("id_rsa")
                .unwrap_err()
                .message()
                .contains("files without an extension")
        );
        assert!(
            assert_supported_path("notes.txt")
                .unwrap_err()
                .message()
                .contains(".txt are not supported media")
        );
    }

    #[test]
    fn inference() {
        assert_eq!(infer_media_type(Some("a.MOV"), None), "video/quicktime");
        assert_eq!(infer_category("image/gif", None), "tweet_gif");
        assert_eq!(infer_category("text/vtt", None), "subtitles");
    }

    #[test]
    fn media_roots_contain_paths() {
        let root = crate::config::absolute(Path::new("media"));
        assert!(check_media_root(&root.join("a.png"), std::slice::from_ref(&root)).is_ok());
        assert!(
            check_media_root(&root.join("..").join("x.png"), std::slice::from_ref(&root)).is_err()
        );
    }
}
