//! x-mcp: MCP server for the X (Twitter) API v2.

mod auth;
mod config;
mod log;
mod mcp;
mod tools;
mod util;
mod x;

use std::collections::BTreeSet;
use std::process::ExitCode;

use serde_json::{Value, json};

use config::{Config, VERSION};
use tools::Ctx;

fn help() -> String {
    format!(
        "x-mcp {VERSION} — MCP server for the X (Twitter) API v2

USAGE
  x-mcp [serve] [options]        Start the MCP server on stdio (default)
  x-mcp serve --http [port]      Start the Streamable HTTP transport instead
  x-mcp auth --client-id <id>    Authorize with OAuth 2.0 (PKCE) and store tokens
  x-mcp auth --logout            Remove stored tokens
  x-mcp doctor [--json]          Check credentials, connectivity and configuration
  x-mcp tools [--json]           List the tools this configuration exposes
  x-mcp version | help

OPTIONS
  --http [port]         Serve over Streamable HTTP at /mcp (default port 3333)
  --host <host>         HTTP bind address (default 127.0.0.1)
  --read-only           Refuse every mutation, even if credentials allow it
  --dry-run             Show the HTTP request a mutation would send, without sending it
  --log-level <level>   trace | debug | info | warn | error | silent
  --client-id <id>      OAuth 2.0 client id for `auth`
  --client-secret <s>   OAuth 2.0 client secret (confidential clients only)
  --scopes <list>       Space/comma separated OAuth 2.0 scopes
  --redirect-uri <uri>  OAuth 2.0 callback (default http://127.0.0.1:8787/callback)
  --manual              Paste the callback URL instead of opening a browser
  --no-browser          Print the authorize URL without opening a browser
  --json                Machine-readable output (doctor, tools, auth)
  --help, -h            Show this help
  --version, -v         Print the version

ENVIRONMENT
  Credentials: X_BEARER_TOKEN, X_OAUTH2_CLIENT_ID, X_OAUTH2_CLIENT_SECRET,
  X_OAUTH2_ACCESS_TOKEN, X_OAUTH2_REFRESH_TOKEN, X_API_KEY, X_API_SECRET,
  X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
  Behaviour: X_MCP_READ_ONLY, X_MCP_DRY_RUN, X_MCP_CACHE, X_MCP_CACHE_TTL_MS,
  X_MCP_RATE_LIMIT_MODE, X_MCP_MAX_WAIT_MS, X_MCP_TOOLSETS,
  X_MCP_DISABLE_TOOLSETS, X_MCP_LOG_LEVEL, X_MCP_HTTP_PORT, X_MCP_HTTP_HOST
  See .env.example for the full list.

MCP CLIENT CONFIG (stdio)
  {{
    \"mcpServers\": {{
      \"x\": {{ \"command\": \"npx\", \"args\": [\"-y\", \"@el4cteo/x-mcp\"], \"env\": {{ \"X_BEARER_TOKEN\": \"...\" }} }}
    }}
  }}
"
    )
}

struct Args {
    command: String,
    flags: Vec<(String, Option<String>)>,
}

impl Args {
    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(k, _)| k == name)
    }
    fn value(&self, name: &str) -> Option<String> {
        self.flags
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .and_then(|(_, v)| v.clone())
    }
}

const BOOLEAN_FLAGS: [&str; 8] = [
    "help",
    "version",
    "read-only",
    "dry-run",
    "json",
    "logout",
    "manual",
    "no-browser",
];

fn parse_args(argv: &[String]) -> Args {
    let mut flags: Vec<(String, Option<String>)> = vec![];
    let mut positional: Vec<String> = vec![];
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--" {
            positional.extend(argv[i + 1..].iter().cloned());
            break;
        }
        if let Some(body) = arg.strip_prefix("--") {
            if let Some((k, v)) = body.split_once('=') {
                flags.push((k.into(), Some(v.into())));
            } else if body == "http" {
                match argv.get(i + 1) {
                    Some(next) if !next.is_empty() && next.bytes().all(|b| b.is_ascii_digit()) => {
                        flags.push(("http".into(), Some(next.clone())));
                        i += 1;
                    }
                    _ => flags.push(("http".into(), None)),
                }
            } else if BOOLEAN_FLAGS.contains(&body) {
                flags.push((body.into(), None));
            } else {
                match argv.get(i + 1) {
                    Some(next) if !next.starts_with('-') => {
                        flags.push((body.into(), Some(next.clone())));
                        i += 1;
                    }
                    _ => flags.push((body.into(), None)),
                }
            }
        } else if arg.len() > 1 && arg.starts_with('-') {
            let name = match &arg[1..] {
                "h" => "help",
                "v" => "version",
                "r" => "read-only",
                "n" => "dry-run",
                other => other,
            };
            flags.push((name.into(), None));
        } else {
            positional.push(arg.clone());
        }
        i += 1;
    }
    Args {
        command: positional
            .first()
            .cloned()
            .unwrap_or_else(|| "serve".into()),
        flags,
    }
}

fn apply_overrides(args: &Args, env: &mut config::Env) {
    if args.has("read-only") {
        env.insert("X_MCP_READ_ONLY".into(), "true".into());
    }
    if args.has("dry-run") {
        env.insert("X_MCP_DRY_RUN".into(), "true".into());
    }
    if let Some(level) = args.value("log-level") {
        env.insert("X_MCP_LOG_LEVEL".into(), level);
    }
    if let Some(host) = args.value("host") {
        env.insert("X_MCP_HTTP_HOST".into(), host);
    }
    if let Some(port) = args.value("http").or_else(|| args.value("port")) {
        env.insert("X_MCP_HTTP_PORT".into(), port);
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&argv);
    if args.has("help") || args.command == "help" {
        print!("{}", help());
        return ExitCode::SUCCESS;
    }
    if args.has("version") || args.command == "version" {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }
    let mut env = config::process_env();
    config::load_dotenv(&mut env);
    apply_overrides(&args, &mut env);
    let config = match Config::load(&env) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("x-mcp: {e}");
            return ExitCode::from(1);
        }
    };
    log::set_level(&config.log_level);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = runtime.block_on(run(args, config));
    // Do not wait for idle keep-alive connections or blocked stdin reads.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    ExitCode::from(code as u8)
}

async fn run(args: Args, config: Config) -> i32 {
    match args.command.as_str() {
        "serve" => {
            if args.has("http") || args.value("port").is_some() {
                serve_http(config).await
            } else {
                serve_stdio(config).await
            }
        }
        "doctor" => doctor(config, args.has("json")).await,
        "tools" => list_tools(&config, args.has("json")),
        "auth" => {
            let options = auth::login::Options {
                client_id: args.value("client-id"),
                client_secret: args.value("client-secret"),
                scopes: args.value("scopes").map(|s| config::split_scopes(&s)),
                redirect_uri: args.value("redirect-uri"),
                manual: args.has("manual"),
                open_browser: !args.has("no-browser"),
                logout: args.has("logout"),
                json: args.has("json"),
            };
            auth::login::run(&config, options).await
        }
        other => {
            eprintln!("x-mcp: unknown command \"{other}\". Run `x-mcp help`.");
            1
        }
    }
}

async fn serve_stdio(config: Config) -> i32 {
    let ctx = Ctx::new(&config);
    let server = mcp::server::Server::new(ctx);
    info!("x-mcp ready", "transport" => "stdio", "tools" => server.tool_count(), "readOnly" => config.read_only, "dryRun" => config.dry_run);
    mcp::stdio::serve(server).await;
    0
}

async fn serve_http(config: Config) -> i32 {
    let ctx = Ctx::new(&config);
    let server = mcp::server::Server::new(ctx);
    let tools = server.tool_count();
    let (running, task) = match mcp::http::start(server, &config.http_host, config.http_port).await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("x-mcp: {e}");
            return 1;
        }
    };
    info!("x-mcp ready", "transport" => "http", "url" => running.url.clone(), "tools" => tools);
    println!(
        "x-mcp {VERSION} listening on {} ({tools} tools)",
        running.url
    );
    println!(
        "health check: {}",
        running.url.trim_end_matches("/mcp").to_owned() + "/health"
    );
    if !mcp::http::is_loopback(&config.http_host) {
        println!("warning: binding to a non-loopback address exposes the server to the network");
    }
    let _ = running.addr;
    let _ = task.await;
    0
}

fn list_tools(config: &Config, json: bool) -> i32 {
    let groups = tools::groups_for(config);
    if json {
        let list: Vec<Value> = groups
            .iter()
            .map(|g| {
                let actions: Vec<Value> = g
                    .actions
                    .iter()
                    .map(|a| json!({ "action": a.action, "title": a.title, "readOnly": a.ann.read_only, "destructive": a.ann.destructive }))
                    .collect();
                json!({
                    "name": g.name, "title": g.title, "toolset": g.toolset,
                    "readOnly": g.ann.read_only, "destructive": g.ann.destructive,
                    "description": g.summary, "actions": actions,
                })
            })
            .collect();
        println!("{}", util::pretty(&Value::Array(list)));
        return 0;
    }
    println!(
        "{} tools, {} actions",
        groups.len(),
        tools::action_count(&groups)
    );
    for g in &groups {
        println!("\n{}  {}", g.name, g.title);
        for a in &g.actions {
            let mode = if a.ann.read_only { "read " } else { "write" };
            println!("  {mode}  {:<22} {}", a.action, a.title);
        }
    }
    0
}

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

async fn doctor(mut config: Config, json: bool) -> i32 {
    let mut checks: Vec<Check> = vec![];
    config.timeout_ms = 8_000;
    config.max_retries = 0;
    let ctx = Ctx::new(&config);
    let status = ctx.x.auth.status();
    let modes: Vec<String> = status
        .modes()
        .iter()
        .filter_map(|m| m.as_str().map(str::to_owned))
        .collect();
    checks.push(Check {
        name: "credentials",
        ok: status.bearer || status.oauth2 || status.oauth1,
        detail: if modes.is_empty() {
            "none configured".into()
        } else {
            modes.join(", ")
        },
    });

    let file = config.credential_file.display().to_string();
    checks.push(match std::fs::metadata(&config.credential_file) {
        Ok(meta) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode() & 0o777;
                Check {
                    name: "credential-file",
                    ok: mode == 0o600,
                    detail: format!(
                        "{file} (mode {mode:03o}{})",
                        if mode == 0o600 { "" } else { ", expected 600" }
                    ),
                }
            }
            #[cfg(not(unix))]
            {
                let _ = meta;
                Check {
                    name: "credential-file",
                    ok: true,
                    detail: file.clone(),
                }
            }
        }
        Err(_) => Check {
            name: "credential-file",
            ok: true,
            detail: format!("not present at {file} — using environment variables only"),
        },
    });

    let groups = tools::groups_for(&config);
    let toolsets: BTreeSet<&str> = groups.iter().map(|g| g.toolset).collect();
    checks.push(Check {
        name: "tools",
        ok: !groups.is_empty(),
        detail: format!(
            "{} tools ({} actions) across {} toolsets",
            groups.len(),
            tools::action_count(&groups),
            toolsets.len()
        ),
    });

    let ffmpeg = x::viewer::find_ffmpeg(config.ffmpeg_path.as_deref()).await;
    checks.push(Check {
        name: "ffmpeg",
        ok: true,
        detail: match ffmpeg {
            Some(bin) => format!("found ({bin}) — video frame extraction enabled"),
            None => "not found — video frames fall back to preview images".into(),
        },
    });

    let mut network = Check {
        name: "network",
        ok: true,
        detail: "skipped (no credentials to test)".into(),
    };
    if status.oauth2 || status.oauth1 || status.bearer {
        let started = std::time::Instant::now();
        let user = status.oauth2 || status.oauth1;
        let request = if user {
            x::client::XRequest::get("/2/users/me")
                .user()
                .q("user.fields", "id,username")
                .no_cache()
        } else {
            x::client::XRequest::get("/2/usage/tweets")
                .auth(x::client::Auth::App)
                .no_cache()
        };
        network = match ctx.req(request).await {
            Ok(_) => Check {
                name: "network",
                ok: true,
                detail: format!(
                    "{} reachable; {} auth verified in {}ms",
                    config
                        .api_base
                        .trim_start_matches("https://")
                        .trim_start_matches("http://"),
                    if user { "user" } else { "app-only" },
                    started.elapsed().as_millis()
                ),
            },
            Err(e) => Check {
                name: "network",
                ok: false,
                detail: format!("API check failed: {}", e.message()),
            },
        };
    }
    checks.push(network);

    let ok = checks.iter().all(|c| c.ok);
    if json {
        let list: Vec<Value> = checks
            .iter()
            .map(|c| json!({ "name": c.name, "ok": c.ok, "detail": c.detail }))
            .collect();
        println!(
            "{}",
            util::pretty(
                &json!({ "ok": ok, "version": VERSION, "checks": list, "credentials": status.to_json() })
            )
        );
    } else {
        println!("x-mcp {VERSION} doctor\n");
        for c in &checks {
            println!(
                "{}  {:<16} {}",
                if c.ok { "ok  " } else { "FAIL" },
                c.name,
                c.detail
            );
        }
        println!();
        println!(
            "state: read_only={} dry_run={} cache={} rate_limit={}",
            config.read_only,
            config.dry_run,
            config.cache_enabled,
            config.rate_limit_mode.as_str()
        );
        println!("api:   {}", config.api_base);
        if !status.missing.is_empty() {
            println!("\nnext steps:");
            println!("  - set X_BEARER_TOKEN for public reads");
            println!(
                "  - run `x-mcp auth --client-id <id>` for user context (posting, DMs, bookmarks)"
            );
        }
    }
    if ok { 0 } else { 1 }
}
