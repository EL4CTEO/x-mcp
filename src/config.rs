//! Configuration, read once at startup from the environment.
//!
//! Missing credentials never fail: the server must still boot so `doctor`,
//! `--dry-run` and tool discovery keep working. Invalid values do fail,
//! because silently ignoring a typo in `X_MCP_READ_ONLY` would be unsafe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const TOOLSETS: [&str; 10] = [
    "posts",
    "timelines",
    "users",
    "engagement",
    "lists",
    "spaces",
    "trends",
    "dms",
    "media",
    "meta",
];

const LOG_LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "silent"];

#[derive(Clone, Debug, Default)]
pub struct OAuth2Env {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub redirect_uri: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct OAuth1Env {
    pub consumer_key: String,
    pub consumer_secret: String,
    pub access_token: Option<String>,
    pub access_token_secret: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct AuthEnv {
    pub bearer_token: Option<String>,
    pub oauth2: Option<OAuth2Env>,
    pub oauth1: Option<OAuth1Env>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateLimitMode {
    Wait,
    Fail,
}

impl RateLimitMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Fail => "fail",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub credential_file: PathBuf,
    pub api_base: String,
    pub upload_base: String,
    pub token_url: String,
    pub auth: AuthEnv,
    pub read_only: bool,
    pub dry_run: bool,
    pub cache_enabled: bool,
    pub cache_ttl_ms: u64,
    pub cache_max: usize,
    pub timeout_ms: u64,
    pub max_retries: u32,
    pub retry_base_ms: u64,
    pub user_agent: String,
    pub proxy: Option<String>,
    pub rate_limit_mode: RateLimitMode,
    pub max_wait_ms: u64,
    pub ffmpeg_path: Option<String>,
    pub max_video_bytes: u64,
    pub max_image_bytes: u64,
    pub frame_width: u32,
    pub media_roots: Vec<PathBuf>,
    pub allow_private_hosts: bool,
    pub toolsets_include: Vec<String>,
    pub toolsets_exclude: Vec<String>,
    pub max_output_chars: usize,
    pub log_level: String,
    pub http_host: String,
    pub http_port: u16,
    pub http_token: Option<String>,
    pub http_cors: Vec<String>,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub type Env = HashMap<String, String>;

pub fn process_env() -> Env {
    std::env::vars().collect()
}

fn str_of(env: &Env, name: &str) -> Option<String> {
    env.get(name)
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn bool_of(env: &Env, name: &str, fallback: bool) -> Result<bool, ConfigError> {
    let Some(raw) = str_of(env, name).map(|v| v.to_lowercase()) else {
        return Ok(fallback);
    };
    match raw.as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ConfigError(format!(
            "{name} must be a boolean (true/false), got \"{raw}\""
        ))),
    }
}

fn int_of(env: &Env, name: &str, fallback: u64, min: u64, max: u64) -> Result<u64, ConfigError> {
    let Some(raw) = str_of(env, name) else {
        return Ok(fallback);
    };
    match raw.parse::<f64>() {
        Ok(v) if v.fract() == 0.0 && v >= min as f64 && v <= max as f64 => Ok(v as u64),
        _ => Err(ConfigError(format!(
            "{name} must be an integer between {min} and {max}, got \"{raw}\""
        ))),
    }
}

fn base_url(env: &Env, name: &str, fallback: &str) -> Result<String, ConfigError> {
    let raw = str_of(env, name).unwrap_or_else(|| fallback.to_owned());
    let url = url::Url::parse(&raw)
        .map_err(|_| ConfigError(format!("{name} must be a valid URL, got \"{raw}\"")))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(ConfigError(format!(
            "{name} must use http(s), got \"{raw}\""
        )));
    }
    let origin = url.origin().ascii_serialization();
    Ok(format!("{origin}{}", url.path().trim_end_matches('/')))
}

fn split_list(raw: &str, seps: &[char]) -> Vec<String> {
    raw.split(|c: char| seps.contains(&c) || c.is_whitespace())
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect()
}

fn toolset_list(env: &Env, name: &str) -> Result<Vec<String>, ConfigError> {
    let Some(raw) = str_of(env, name) else {
        return Ok(vec![]);
    };
    let parts = split_list(&raw, &[',', ';']);
    let unknown: Vec<&str> = parts
        .iter()
        .filter(|p| !TOOLSETS.contains(&p.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(ConfigError(format!(
            "{name} contains unknown toolset(s): {}. Valid: {}",
            unknown.join(", "),
            TOOLSETS.join(", ")
        )));
    }
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        if !out.contains(&part) {
            out.push(part);
        }
    }
    Ok(out)
}

/// Splits on commas and whitespace, keeping first occurrences.
pub fn split_scopes(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
    {
        if !out.iter().any(|s| s == part) {
            out.push(part.to_owned());
        }
    }
    out
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `path.resolve` without touching the filesystem.
pub fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

impl Config {
    pub fn load(env: &Env) -> Result<Config, ConfigError> {
        let home_dir = str_of(env, "X_MCP_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config").join("x-mcp"));
        let credential_file = home_dir.join("credentials.json");

        let oauth2 = str_of(env, "X_OAUTH2_CLIENT_ID").map(|client_id| OAuth2Env {
            client_id,
            client_secret: str_of(env, "X_OAUTH2_CLIENT_SECRET"),
            access_token: str_of(env, "X_OAUTH2_ACCESS_TOKEN"),
            refresh_token: str_of(env, "X_OAUTH2_REFRESH_TOKEN"),
            scopes: str_of(env, "X_OAUTH2_SCOPE").map(|s| split_scopes(&s)),
            redirect_uri: str_of(env, "X_OAUTH2_REDIRECT_URI"),
        });
        let oauth1 = str_of(env, "X_API_KEY").map(|consumer_key| OAuth1Env {
            consumer_key,
            consumer_secret: str_of(env, "X_API_SECRET").unwrap_or_default(),
            access_token: str_of(env, "X_ACCESS_TOKEN"),
            access_token_secret: str_of(env, "X_ACCESS_TOKEN_SECRET"),
        });

        let log_level = str_of(env, "X_MCP_LOG_LEVEL")
            .unwrap_or_else(|| "info".into())
            .to_lowercase();
        if !LOG_LEVELS.contains(&log_level.as_str()) {
            return Err(ConfigError(format!(
                "X_MCP_LOG_LEVEL must be one of {}, got \"{log_level}\"",
                LOG_LEVELS.join(", ")
            )));
        }
        let mode = str_of(env, "X_MCP_RATE_LIMIT_MODE")
            .unwrap_or_else(|| "wait".into())
            .to_lowercase();
        let rate_limit_mode = match mode.as_str() {
            "wait" => RateLimitMode::Wait,
            "fail" => RateLimitMode::Fail,
            _ => {
                return Err(ConfigError(format!(
                    "X_MCP_RATE_LIMIT_MODE must be \"wait\" or \"fail\", got \"{mode}\""
                )));
            }
        };

        let delimiter = if cfg!(windows) { ';' } else { ':' };
        let roots_raw = str_of(env, "X_MCP_MEDIA_ROOTS").unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        let media_roots = roots_raw
            .split(delimiter)
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(|r| absolute(Path::new(r)))
            .collect();

        let api_base = base_url(env, "X_API_BASE", "https://api.x.com")?;
        Ok(Config {
            credential_file,
            upload_base: base_url(env, "X_UPLOAD_BASE", &api_base)?,
            token_url: str_of(env, "X_OAUTH2_TOKEN_URL")
                .unwrap_or_else(|| "https://api.x.com/2/oauth2/token".into()),
            api_base,
            auth: AuthEnv {
                bearer_token: str_of(env, "X_BEARER_TOKEN"),
                oauth2,
                oauth1,
            },
            read_only: bool_of(env, "X_MCP_READ_ONLY", false)?,
            dry_run: bool_of(env, "X_MCP_DRY_RUN", false)?,
            cache_enabled: bool_of(env, "X_MCP_CACHE", true)?,
            cache_ttl_ms: int_of(env, "X_MCP_CACHE_TTL_MS", 30_000, 0, 3_600_000)?,
            cache_max: int_of(env, "X_MCP_CACHE_MAX", 512, 1, 100_000)? as usize,
            timeout_ms: int_of(env, "X_MCP_TIMEOUT_MS", 20_000, 1_000, 300_000)?,
            max_retries: int_of(env, "X_MCP_MAX_RETRIES", 2, 0, 10)? as u32,
            retry_base_ms: int_of(env, "X_MCP_RETRY_BASE_MS", 400, 0, 30_000)?,
            user_agent: format!("x-mcp/{VERSION} (Rust; +https://github.com/EL4CTEO/x-mcp)"),
            proxy: ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
                .iter()
                .find_map(|k| str_of(env, k)),
            rate_limit_mode,
            max_wait_ms: int_of(env, "X_MCP_MAX_WAIT_MS", 60_000, 0, 15 * 60_000)?,
            ffmpeg_path: str_of(env, "X_MCP_FFMPEG"),
            max_video_bytes: int_of(env, "X_MCP_MAX_VIDEO_MB", 200, 1, 8_192)? * 1024 * 1024,
            max_image_bytes: int_of(env, "X_MCP_MAX_IMAGE_MB", 15, 1, 100)? * 1024 * 1024,
            frame_width: int_of(env, "X_MCP_FRAME_WIDTH", 1_280, 160, 4_096)? as u32,
            media_roots,
            // Test-only escape hatch: production always validates media hosts.
            allow_private_hosts: bool_of(env, "X_MCP_MEDIA_ALLOW_PRIVATE", false)?
                && env.get("X_MCP_TEST").map(String::as_str) == Some("1"),
            toolsets_include: toolset_list(env, "X_MCP_TOOLSETS")?,
            toolsets_exclude: toolset_list(env, "X_MCP_DISABLE_TOOLSETS")?,
            max_output_chars: int_of(env, "X_MCP_MAX_OUTPUT_CHARS", 60_000, 2_000, 5_000_000)?
                as usize,
            log_level,
            http_host: str_of(env, "X_MCP_HTTP_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            http_port: int_of(env, "X_MCP_HTTP_PORT", 3333, 0, 65_535)? as u16,
            http_token: str_of(env, "X_MCP_HTTP_TOKEN"),
            http_cors: str_of(env, "X_MCP_HTTP_CORS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|o| !o.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }

    pub fn toolset_enabled(&self, toolset: &str) -> bool {
        if self.toolsets_exclude.iter().any(|t| t == toolset) {
            return false;
        }
        self.toolsets_include.is_empty() || self.toolsets_include.iter().any(|t| t == toolset)
    }
}

/// Reads a `.env` file in the working directory. Existing variables win.
pub fn load_dotenv(env: &mut Env) {
    let Ok(text) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        if let Some(stripped) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
            value = stripped;
        } else if let Some(stripped) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
            value = stripped;
        } else if let Some(index) = value.find(" #") {
            value = value[..index].trim_end();
        }
        env.entry(key.to_owned())
            .or_insert_with(|| value.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_boot_without_credentials() {
        let config = Config::load(&env(&[])).unwrap();
        assert_eq!(config.api_base, "https://api.x.com");
        assert!(config.auth.bearer_token.is_none());
        assert_eq!(config.rate_limit_mode, RateLimitMode::Wait);
        assert_eq!(config.max_image_bytes, 15 * 1024 * 1024);
    }

    #[test]
    fn invalid_values_fail_loudly() {
        let err = Config::load(&env(&[("X_MCP_READ_ONLY", "maybe")])).unwrap_err();
        assert_eq!(
            err.0,
            "X_MCP_READ_ONLY must be a boolean (true/false), got \"maybe\""
        );
        let err = Config::load(&env(&[("X_MCP_TOOLSETS", "posts,bogus")])).unwrap_err();
        assert!(err.0.contains("unknown toolset(s): bogus"));
        let err = Config::load(&env(&[("X_MCP_CACHE_TTL_MS", "1.5")])).unwrap_err();
        assert!(err.0.contains("integer between 0 and 3600000"));
    }

    #[test]
    fn base_url_strips_trailing_slashes() {
        let config = Config::load(&env(&[("X_API_BASE", "http://127.0.0.1:9/x//")])).unwrap();
        assert_eq!(config.api_base, "http://127.0.0.1:9/x");
    }

    #[test]
    fn toolset_filters() {
        let config = Config::load(&env(&[
            ("X_MCP_TOOLSETS", "posts users"),
            ("X_MCP_DISABLE_TOOLSETS", "users"),
        ]))
        .unwrap();
        assert!(config.toolset_enabled("posts"));
        assert!(!config.toolset_enabled("users"));
        assert!(!config.toolset_enabled("dms"));
    }
}
