//! End-to-end tests against the real binary: stdio, Streamable HTTP and
//! OAuth 2.0 refresh against a local fake X API. No X credentials needed.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_x-mcp");

fn base_env(cmd: &mut Command, home: &std::path::Path) {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(
            "SYSTEMROOT",
            std::env::var("SYSTEMROOT").unwrap_or_default(),
        )
        .env("X_MCP_HOME", home)
        .env("X_MCP_LOG_LEVEL", "silent")
        .env("X_MCP_MAX_RETRIES", "0");
}

/// Sends newline-delimited JSON-RPC messages and returns the replies by id.
fn stdio(messages: &[Value], env: &[(&str, &str)]) -> Vec<Value> {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(BIN);
    base_env(&mut cmd, home.path());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for m in messages {
        writeln!(stdin, "{m}").unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    let mut replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    replies.sort_by_key(|r| r["id"].as_i64().unwrap_or(-1));
    replies
}

fn rpc(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

#[test]
fn stdio_lists_ten_tools_with_sixty_nine_actions() {
    let replies = stdio(
        &[
            rpc(
                1,
                "initialize",
                json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }),
            ),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            rpc(2, "tools/list", json!({})),
            rpc(3, "prompts/list", json!({})),
            rpc(4, "resources/templates/list", json!({})),
            rpc(5, "nope/nope", json!({})),
            rpc(
                6,
                "prompts/get",
                json!({ "name": "account_report", "arguments": { "username": "jack" } }),
            ),
            rpc(
                7,
                "prompts/get",
                json!({ "name": "account_report", "arguments": {} }),
            ),
        ],
        &[],
    );
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "x-mcp");
    let tools = replies[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 10);
    let actions: usize = tools
        .iter()
        .map(|t| t["_meta"]["x-mcp/actions"].as_object().unwrap().len())
        .sum();
    assert_eq!(actions, 69);
    for tool in tools {
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["action"]));
        // Merged parameters stay single schemas, not near-duplicate anyOf lists.
        for (key, prop) in schema["properties"].as_object().unwrap() {
            assert!(
                prop.get("type").is_some() || prop.get("anyOf").is_some(),
                "{key}"
            );
        }
    }
    let posts = tools.iter().find(|t| t["name"] == "x_posts").unwrap();
    let max = &posts["inputSchema"]["properties"]["max_results"];
    assert_eq!(max["type"], "integer");
    assert!(
        max["description"]
            .as_str()
            .unwrap()
            .contains("Per action: search 10-100, default 10")
    );
    assert_eq!(replies[2]["result"]["prompts"].as_array().unwrap().len(), 4);
    assert_eq!(
        replies[3]["result"]["resourceTemplates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(replies[4]["error"]["code"], -32601);
    assert!(
        replies[5]["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("@jack")
    );
    assert_eq!(replies[6]["error"]["code"], -32602);
}

#[test]
fn guardrails_and_validation_errors_are_tool_errors() {
    let call = |id, args: Value| {
        rpc(
            id,
            "tools/call",
            json!({ "name": "x_posts", "arguments": args }),
        )
    };
    let replies = stdio(
        &[
            call(1, json!({ "action": "create", "text": "hi" })),
            call(2, json!({ "action": "get", "tweet_id": "abc" })),
            call(3, json!({ "action": "wat" })),
            rpc(
                4,
                "tools/call",
                json!({ "name": "x_nope", "arguments": {} }),
            ),
        ],
        &[("X_MCP_READ_ONLY", "true")],
    );
    let structured = |i: usize| replies[i]["result"]["structuredContent"].clone();
    assert_eq!(structured(0)["code"], "read_only");
    assert_eq!(structured(1)["code"], "invalid_params");
    assert_eq!(
        structured(1)["error"],
        "Invalid parameters for action \"get\": tweet_id: Post id must be numeric"
    );
    assert_eq!(structured(2)["code"], "invalid_action");
    assert_eq!(replies[3]["error"]["code"], -32602);
}

fn spawn_http(env: &[(&str, &str)]) -> (std::process::Child, String) {
    let home = tempfile::tempdir().unwrap().keep();
    let mut cmd = Command::new(BIN);
    base_env(&mut cmd, &home);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .args(["serve", "--http", "0"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    let url = line
        .split_whitespace()
        .find(|w| w.starts_with("http://"))
        .unwrap()
        .to_owned();
    (child, url)
}

#[tokio::test]
async fn streamable_http_sessions_and_auth() {
    let token = "0123456789abcdef-token";
    let (mut child, url) = spawn_http(&[("X_MCP_HTTP_TOKEN", token)]);
    let http = reqwest::Client::new();
    let auth = format!("Bearer {token}");
    let init = rpc(
        1,
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }),
    );

    let denied = http.post(&url).json(&init).send().await.unwrap();
    assert_eq!(denied.status(), 401);

    let no_session = http
        .post(&url)
        .header("authorization", &auth)
        .json(&rpc(2, "tools/list", json!({})))
        .send()
        .await
        .unwrap();
    assert_eq!(no_session.status(), 400);

    let res = http
        .post(&url)
        .header("authorization", &auth)
        .header("accept", "application/json, text/event-stream")
        .json(&init)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let session = res.headers()["mcp-session-id"].to_str().unwrap().to_owned();
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["result"]["serverInfo"]["name"], "x-mcp");

    let list: Value = http
        .post(&url)
        .header("authorization", &auth)
        .header("mcp-session-id", &session)
        .json(&rpc(2, "tools/list", json!({})))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 10);

    let note = http
        .post(&url)
        .header("authorization", &auth)
        .header("mcp-session-id", &session)
        .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .send()
        .await
        .unwrap();
    assert_eq!(note.status(), 202);

    let gone = http
        .post(&url)
        .header("authorization", &auth)
        .header("mcp-session-id", "nope")
        .json(&rpc(3, "ping", json!({})))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 404);

    let rebinding = http
        .post(&url)
        .header("authorization", &auth)
        .header("host", "evil.example:80")
        .json(&init)
        .send()
        .await
        .unwrap();
    assert_eq!(rebinding.status(), 403);

    let health: Value = http
        .get(url.replace("/mcp", "/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["sessions"], 1);
    child.kill().unwrap();
}

/// A 401 on an OAuth 2.0 call refreshes the token once, retries, and stores
/// the rotated refresh token.
#[tokio::test]
async fn oauth2_refreshes_after_401_and_persists_rotation() {
    let app = axum::Router::new()
        .route(
            "/2/users/me",
            get(|headers: HeaderMap| async move {
                if headers["authorization"] == "Bearer fresh-token" {
                    (StatusCode::OK, axum::Json(json!({ "data": { "id": "100", "username": "me_user" } })))
                } else {
                    (StatusCode::UNAUTHORIZED, axum::Json(json!({ "title": "Unauthorized", "detail": "expired" })))
                }
            }),
        )
        .route(
            "/token",
            post(|body: String| async move {
                assert!(body.contains("grant_type=refresh_token") && body.contains("refresh_token=old-refresh"));
                axum::Json(json!({ "access_token": "fresh-token", "refresh_token": "new-refresh", "expires_in": 7200, "token_type": "bearer" }))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let home = tempfile::tempdir().unwrap();
    let home_path = home.path().to_path_buf();
    let base2 = base.clone();
    let replies = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(BIN);
        base_env(&mut cmd, &home_path);
        cmd.env("X_API_BASE", &base2)
            .env("X_OAUTH2_TOKEN_URL", format!("{base2}/token"))
            .env("X_OAUTH2_CLIENT_ID", "cid")
            .env("X_OAUTH2_ACCESS_TOKEN", "stale-token")
            .env("X_OAUTH2_REFRESH_TOKEN", "old-refresh");
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            rpc(
                1,
                "tools/call",
                json!({ "name": "x_users", "arguments": { "action": "me" } })
            )
        )
        .unwrap();
        drop(stdin);
        String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
    })
    .await
    .unwrap();
    let reply: Value = serde_json::from_str(replies.lines().next().unwrap()).unwrap();
    assert_eq!(
        reply["result"]["structuredContent"]["username"], "me_user",
        "{reply}"
    );
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(home.path().join("credentials.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stored["oauth2"]["refreshToken"], "new-refresh");
    assert_eq!(stored["oauth2"]["accessToken"], "fresh-token");
}

fn call_once(env: &[(&str, String)], tool: &str, args: Value) -> Value {
    let home = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(BIN);
    base_env(&mut cmd, home.path());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        rpc(
            1,
            "tools/call",
            json!({ "name": tool, "arguments": args, "_meta": { "progressToken": "p" } })
        )
    )
    .unwrap();
    drop(stdin);
    let out = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
    // Progress notifications come first; the reply is the last line.
    serde_json::from_str(out.lines().last().unwrap()).unwrap()
}

async fn fake_x() -> String {
    use axum::extract::Path;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let img = format!("{base}/img.png");
    let png: &'static [u8] = b"\x89PNG\r\n\x1a\nfake";
    let app = axum::Router::new()
        .route(
            "/2/tweets/{id}",
            get(move |Path(_id): Path<String>| {
                let img = img.clone();
                async move {
                axum::Json(json!({
                    "data": { "id": "20", "text": "pic", "author_id": "12", "attachments": { "media_keys": ["3_1"] } },
                    "includes": { "media": [{ "media_key": "3_1", "type": "photo", "url": img, "alt_text": "alt" }] }
                }))
                }
            }),
        )
        .route("/img.png", get(move || async move { ([("content-type", "image/png")], png) }))
        .route("/2/media/upload/initialize", post(|| async { axum::Json(json!({ "data": { "id": "777", "media_key": "3_777" } })) }))
        .route("/2/media/upload/{id}/append", post(|| async { axum::Json(json!({})) }))
        .route("/2/media/upload/{id}/finalize", post(|| async { axum::Json(json!({ "data": { "id": "777" } })) }))
        .route("/2/media/metadata", post(|body: String| async move {
            assert!(body.contains("\"alt_text\":{\"text\":\"a cat\"}"));
            axum::Json(json!({}))
        }));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

#[tokio::test]
async fn media_upload_and_view_round_trip() {
    let base = fake_x().await;
    let env = vec![
        ("X_API_BASE", base.clone()),
        ("X_OAUTH2_CLIENT_ID", "cid".to_owned()),
        ("X_OAUTH2_ACCESS_TOKEN", "tok".to_owned()),
        ("X_MCP_TEST", "1".to_owned()),
        ("X_MCP_MEDIA_ALLOW_PRIVATE", "true".to_owned()),
        ("X_MCP_FFMPEG", "definitely-not-ffmpeg".to_owned()),
    ];
    let env2 = env.clone();
    let upload = tokio::task::spawn_blocking(move || {
        call_once(&env2, "x_media", json!({ "action": "upload", "base64": "aGVsbG8=", "filename": "cat.png", "alt_text": "a cat" }))
    })
    .await
    .unwrap();
    let s = &upload["result"]["structuredContent"];
    assert_eq!(s["media_id"], "777", "{upload}");
    assert_eq!(s["media_type"], "image/png");
    assert_eq!(s["category"], "tweet_image");
    assert_eq!(s["processing_state"], "not_required");

    let view = tokio::task::spawn_blocking(move || {
        call_once(
            &env,
            "x_media",
            json!({ "action": "view", "tweet_id": "20" }),
        )
    })
    .await
    .unwrap();
    let content = view["result"]["content"].as_array().unwrap();
    assert_eq!(content[1]["type"], "image", "{view}");
    assert_eq!(content[1]["mimeType"], "image/png");
    assert_eq!(
        view["result"]["structuredContent"]["media"]["alt_text"],
        "alt"
    );
}
