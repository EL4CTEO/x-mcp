//! Turns post media into MCP image content. Photos come back as-is; videos
//! and GIFs (MP4 under the hood) are sampled into JPEG frames with ffmpeg.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;

use super::errors::{ToolError, XResult};
use super::media::{download_client, open_media};
use crate::config::Config;
use crate::obj;
use crate::util::{Json, mb};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Photo,
    Video,
    AnimatedGif,
    Auto,
}

impl Kind {
    pub fn parse(value: Option<&str>) -> Kind {
        match value {
            Some("photo") => Kind::Photo,
            Some("video") => Kind::Video,
            Some("animated_gif") => Kind::AnimatedGif,
            _ => Kind::Auto,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Kind::Photo => "photo",
            Kind::Video => "video",
            Kind::AnimatedGif => "animated_gif",
            Kind::Auto => "unknown",
        }
    }
}

/// Evenly spaced timestamps, never on the (often black) first or last frame.
pub fn frame_timestamps(duration_ms: Option<f64>, count: u32) -> Vec<f64> {
    let frames = count.clamp(1, 6);
    let Some(duration) = duration_ms.filter(|d| *d > 0.0) else {
        return vec![0.0];
    };
    let seconds = duration / 1000.0;
    (0..frames)
        .map(|i| {
            let t = seconds * f64::from(i + 1) / f64::from(frames + 1);
            (t.min(seconds - 0.05).max(0.0) * 1000.0).round() / 1000.0
        })
        .collect()
}

pub fn kind_from_url(raw: &str) -> Kind {
    let Ok(url) = url::Url::parse(raw) else {
        return Kind::Auto;
    };
    let path = url.path().to_lowercase();
    let ends = |exts: &[&str]| exts.iter().any(|e| path.ends_with(e));
    if ends(&[".mp4", ".m4v", ".mov", ".webm"]) {
        Kind::Video
    } else if ends(&[".gif"]) {
        Kind::AnimatedGif
    } else if ends(&[".jpg", ".jpeg", ".png", ".webp", ".bmp"]) {
        Kind::Photo
    } else {
        Kind::Auto
    }
}

pub struct Image {
    pub data: String,
    pub mime: String,
    pub label: String,
    pub bytes: usize,
}

pub struct View {
    pub kind: &'static str,
    pub source_url: String,
    pub preview_url: Option<String>,
    pub alt_text: Option<String>,
    pub duration_ms: Option<Value>,
    pub ffmpeg: bool,
    pub images: Vec<Image>,
    pub notes: Vec<String>,
}

pub struct ViewOptions {
    pub url: String,
    pub kind: Kind,
    pub preview_url: Option<String>,
    pub duration_ms: Option<Value>,
    pub alt_text: Option<String>,
    pub frames: u32,
}

pub struct MediaViewer {
    config: Config,
    client: reqwest::Client,
    ffmpeg: OnceCell<Option<String>>,
}

async fn run(bin: &str, args: &[String], timeout: Duration) -> bool {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        _ => {
            let _ = child.kill().await;
            false
        }
    }
}

pub async fn find_ffmpeg(configured: Option<&str>) -> Option<String> {
    let mut candidates: Vec<String> = vec![];
    for c in [
        configured.map(str::to_owned),
        std::env::var("X_MCP_FFMPEG").ok(),
        Some("ffmpeg".into()),
    ]
    .into_iter()
    .flatten()
    {
        if !c.is_empty() && !candidates.contains(&c) {
            candidates.push(c);
        }
    }
    for candidate in candidates {
        if run(&candidate, &["-version".into()], Duration::from_secs(4)).await {
            return Some(candidate);
        }
    }
    None
}

impl MediaViewer {
    pub fn new(config: &Config) -> Self {
        MediaViewer {
            client: download_client(config.timeout_ms),
            config: config.clone(),
            ffmpeg: OnceCell::new(),
        }
    }

    async fn ffmpeg(&self) -> Option<String> {
        self.ffmpeg
            .get_or_init(|| async {
                let found = find_ffmpeg(self.config.ffmpeg_path.as_deref()).await;
                if found.is_none() {
                    crate::info!("ffmpeg not found: video media falls back to preview frames");
                }
                found
            })
            .await
            .clone()
    }

    /// Streams a download through `sink`, enforcing the byte limit.
    async fn download<F>(&self, url: &str, max: u64, mut sink: F) -> XResult<(String, u64)>
    where
        F: AsyncSink,
    {
        let (_, response) = open_media(&self.client, url, self.config.allow_private_hosts).await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(ToolError::msg(format!(
                "Media download failed with HTTP {status}."
            )));
        }
        if let Some(declared) = response.content_length().filter(|l| *l > max) {
            return Err(ToolError::msg(format!(
                "Media is {}, above the {} limit.",
                mb(declared),
                mb(max)
            )));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        let mut total = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ToolError::msg(e.to_string()))?;
            total += chunk.len() as u64;
            if total > max {
                return Err(ToolError::msg(format!(
                    "Media exceeded the {} limit.",
                    mb(max)
                )));
            }
            sink.write(&chunk).await?;
        }
        Ok((content_type, total))
    }

    async fn download_buffer(&self, url: &str, max: u64) -> XResult<(Vec<u8>, String)> {
        let mut buffer: Vec<u8> = vec![];
        let (content_type, _) = self.download(url, max, &mut buffer).await?;
        Ok((buffer, content_type))
    }

    pub async fn view(&self, options: ViewOptions) -> XResult<View> {
        let kind = if options.kind == Kind::Auto {
            kind_from_url(&options.url)
        } else {
            options.kind
        };
        let frames = options.frames.clamp(1, 6);
        let ffmpeg = self.ffmpeg().await;
        let mut notes: Vec<String> = vec![];
        let mut images: Vec<Image> = vec![];
        let mut resolved = kind.label();
        let push = |images: &mut Vec<Image>, data: &[u8], mime: &str, label: String| {
            images.push(Image {
                data: base64::engine::general_purpose::STANDARD.encode(data),
                mime: mime.to_owned(),
                label,
                bytes: data.len(),
            });
        };

        if kind == Kind::Photo || kind == Kind::Auto {
            match self
                .download_buffer(&options.url, self.config.max_image_bytes)
                .await
            {
                Ok((data, content_type)) if content_type.starts_with("image/") => {
                    push(&mut images, &data, &content_type, "image".into());
                    resolved = "photo";
                }
                Ok((_, content_type)) => notes.push(format!(
                    "The URL returned {}, not an image.",
                    if content_type.is_empty() {
                        "an unknown content type"
                    } else {
                        &content_type
                    }
                )),
                Err(error) if kind == Kind::Photo => return Err(error),
                Err(error) => notes.push(format!("Could not download image: {}", error.message())),
            }
        }

        if kind == Kind::Video || kind == Kind::AnimatedGif {
            match &ffmpeg {
                Some(bin) => match self.video_frames(bin, &options, frames).await {
                    Ok(list) if !list.is_empty() => {
                        let count = list.len();
                        for (i, frame) in list.iter().enumerate() {
                            push(&mut images, frame, "image/jpeg", format!("frame {}/{count}", i + 1));
                        }
                    }
                    Ok(_) => notes.push("ffmpeg could not decode this video; returning the preview frame instead.".into()),
                    Err(error) => notes.push(format!("Could not process video: {}", error.message())),
                },
                None => notes.push(
                    "ffmpeg is not installed, so video frames were not extracted. Install ffmpeg (or set X_MCP_FFMPEG) and retry, or use the video URL directly with a client that supports video."
                        .into(),
                ),
            }
        }

        if images.is_empty()
            && let Some(preview) = options
                .preview_url
                .as_deref()
                .filter(|p| !p.is_empty() && *p != options.url)
        {
            match self
                .download_buffer(preview, self.config.max_image_bytes)
                .await
            {
                Ok((data, content_type)) if content_type.starts_with("image/") => {
                    push(&mut images, &data, &content_type, "preview".into());
                }
                Ok(_) => {}
                Err(error) => notes.push(format!(
                    "Could not download the preview image: {}",
                    error.message()
                )),
            }
        }
        if images.is_empty() && notes.is_empty() {
            notes.push("No readable media was found at this URL.".into());
        }
        crate::debug!("media viewed", "kind" => resolved, "images" => images.len(), "ffmpeg" => ffmpeg.is_some());
        Ok(View {
            kind: resolved,
            source_url: options.url,
            preview_url: options.preview_url.filter(|p| !p.is_empty()),
            alt_text: options.alt_text.filter(|a| !a.is_empty()),
            duration_ms: options
                .duration_ms
                .filter(|d| d.as_f64().is_some_and(|v| v != 0.0)),
            ffmpeg: ffmpeg.is_some(),
            images,
            notes,
        })
    }

    async fn video_frames(
        &self,
        bin: &str,
        options: &ViewOptions,
        frames: u32,
    ) -> XResult<Vec<Vec<u8>>> {
        let dir = tempfile::Builder::new()
            .prefix("x-mcp-media-")
            .tempdir()
            .map_err(|e| ToolError::msg(e.to_string()))?;
        let video = dir.path().join("media.mp4");
        {
            let mut file = tokio::fs::File::create(&video)
                .await
                .map_err(|e| ToolError::msg(e.to_string()))?;
            self.download(&options.url, self.config.max_video_bytes, &mut file)
                .await?;
            file.flush()
                .await
                .map_err(|e| ToolError::msg(e.to_string()))?;
        }
        let stamps = frame_timestamps(options.duration_ms.as_ref().and_then(Value::as_f64), frames);
        Ok(extract_frames(bin, &video, &stamps, self.config.frame_width, dir.path()).await)
    }
}

async fn extract_frames(
    bin: &str,
    input: &Path,
    stamps: &[f64],
    width: u32,
    dir: &Path,
) -> Vec<Vec<u8>> {
    let mut out = vec![];
    for (i, stamp) in stamps.iter().enumerate() {
        let output: PathBuf = dir.join(format!("frame-{i}.jpg"));
        let args: Vec<String> = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-ss".into(),
            stamp.to_string(),
            "-i".into(),
            input.display().to_string(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            format!("scale={width}:-2"),
            "-q:v".into(),
            "3".into(),
            "-y".into(),
            output.display().to_string(),
        ];
        if run(bin, &args, Duration::from_secs(30)).await
            && let Ok(bytes) = tokio::fs::read(&output).await
        {
            out.push(bytes);
        }
    }
    out
}

/// Where downloaded bytes go: memory or a temp file.
pub trait AsyncSink {
    fn write(&mut self, chunk: &[u8]) -> impl std::future::Future<Output = XResult<()>> + Send;
}

impl AsyncSink for &mut Vec<u8> {
    async fn write(&mut self, chunk: &[u8]) -> XResult<()> {
        self.extend_from_slice(chunk);
        Ok(())
    }
}

impl AsyncSink for &mut tokio::fs::File {
    async fn write(&mut self, chunk: &[u8]) -> XResult<()> {
        self.write_all(chunk)
            .await
            .map_err(|e| ToolError::msg(e.to_string()))
    }
}

impl View {
    pub fn summary(&self) -> Json {
        obj! {
            "kind" => self.kind,
            "url" => self.source_url.clone(),
            "alt_text" => self.alt_text.clone(),
            "duration_ms" => self.duration_ms.clone(),
            "preview_url" => self.preview_url.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_evenly_spaced() {
        assert_eq!(frame_timestamps(Some(4000.0), 3), vec![1.0, 2.0, 3.0]);
        assert_eq!(frame_timestamps(None, 3), vec![0.0]);
        assert_eq!(frame_timestamps(Some(1000.0), 9).len(), 6);
    }

    #[test]
    fn kinds_from_extensions() {
        assert_eq!(
            kind_from_url("https://video.twimg.com/a/b.MP4?tag=1"),
            Kind::Video
        );
        assert_eq!(
            kind_from_url("https://pbs.twimg.com/media/x.jpg"),
            Kind::Photo
        );
        assert_eq!(kind_from_url("not a url"), Kind::Auto);
    }
}
