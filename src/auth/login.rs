//! `x-mcp auth`: OAuth 2.0 Authorization Code + PKCE with a loopback
//! callback listener (or manual paste), token persistence and a live check.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

use super::oauth2::{self, DEFAULT_SCOPES, KNOWN_SCOPES, TokenSet};
use super::store::{CredentialStore, StoredOAuth2};
use crate::config::Config;
use crate::util::{iso, now_ms, random_hex};
use crate::x::client::{XClient, XRequest};

pub struct Options {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub redirect_uri: Option<String>,
    pub manual: bool,
    pub open_browser: bool,
    pub logout: bool,
    pub json: bool,
}

const LOOPBACK: [&str; 4] = ["127.0.0.1", "localhost", "::1", "[::1]"];

fn resolve_scopes(provided: Option<Vec<String>>, config: &Config) -> Result<Vec<String>, String> {
    let raw = provided
        .or_else(|| config.auth.oauth2.as_ref().and_then(|o| o.scopes.clone()))
        .unwrap_or_else(|| DEFAULT_SCOPES.iter().map(|s| s.to_string()).collect());
    let unknown: Vec<&str> = raw
        .iter()
        .filter(|s| !KNOWN_SCOPES.contains(&s.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "Unknown OAuth 2.0 scope(s): {}. Valid scopes: {}",
            unknown.join(", "),
            KNOWN_SCOPES.join(", ")
        ));
    }
    let mut scopes: Vec<String> = vec![];
    for s in raw {
        if !scopes.contains(&s) {
            scopes.push(s);
        }
    }
    // Without offline.access X issues a 2-hour token and no refresh token.
    if !scopes.iter().any(|s| s == "offline.access") {
        scopes.push("offline.access".into());
    }
    Ok(scopes)
}

pub async fn run(config: &Config, options: Options) -> i32 {
    let store = CredentialStore::new(&config.credential_file);
    let file = config.credential_file.display().to_string();
    if options.logout {
        store.clear();
        if options.json {
            println!(
                "{}",
                crate::util::pretty(&json!({ "loggedOut": true, "credentialFile": file }))
            );
        } else {
            println!("Removed stored credentials from {file}.");
            println!(
                "Environment tokens (X_OAUTH2_ACCESS_TOKEN, X_BEARER_TOKEN, OAuth 1.0a keys) are unaffected."
            );
        }
        return 0;
    }
    let stored = store.oauth2();
    let client_id = options
        .client_id
        .clone()
        .or_else(|| config.auth.oauth2.as_ref().map(|o| o.client_id.clone()))
        .or_else(|| stored.as_ref().map(|s| s.client_id.clone()));
    let Some(client_id) = client_id else {
        eprintln!(
            "Missing OAuth 2.0 client id.\n\nPass it explicitly:  x-mcp auth --client-id <client-id>\nor set it:          X_OAUTH2_CLIENT_ID=<client-id>  (e.g. in .env)\n\nCreate an OAuth 2.0 client in the X developer portal:\n  User authentication settings → OAuth 2.0 → App type \"Web App, Automated App or Bot\"\n  Callback URI: http://127.0.0.1:8787/callback\n  Scopes: tweet.read tweet.write users.read offline.access (add dm.*, list.*, bookmark.* as needed)"
        );
        return 1;
    };
    let scopes = match resolve_scopes(options.scopes.clone(), config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("x-mcp: {e}");
            return 1;
        }
    };
    let redirect_uri = options
        .redirect_uri
        .clone()
        .or_else(|| {
            config
                .auth
                .oauth2
                .as_ref()
                .and_then(|o| o.redirect_uri.clone())
        })
        .or_else(|| stored.as_ref().and_then(|s| s.redirect_uri.clone()))
        .unwrap_or_else(|| "http://127.0.0.1:8787/callback".into());
    let client_secret = options.client_secret.clone().or_else(|| {
        config
            .auth
            .oauth2
            .as_ref()
            .and_then(|o| o.client_secret.clone())
    });

    if !options.json {
        println!("Authorizing x-mcp against X");
        println!("  client:   {client_id}");
        println!("  scopes:   {}", scopes.join(" "));
        println!("  callback: {redirect_uri}");
        println!();
    }

    let http = reqwest::Client::new();
    let tokens = match login(
        &http,
        config,
        &client_id,
        client_secret.as_deref(),
        &scopes,
        &redirect_uri,
        &options,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("x-mcp: {e}");
            return 1;
        }
    };
    let expires_at = tokens.expires_in.map(|s| now_ms() + s * 1000);
    let saved = store.save(StoredOAuth2 {
        client_id: client_id.clone(),
        client_secret: client_secret.clone(),
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at,
        scopes: Some(tokens.scope.clone().unwrap_or_else(|| scopes.clone())),
        token_type: Some(tokens.token_type.clone()),
        redirect_uri: Some(redirect_uri.clone()),
    });
    if let Err(e) = saved {
        eprintln!("x-mcp: could not save credentials to {file}: {e}");
        return 1;
    }

    // Verify with the stored session.
    let mut verify = config.clone();
    verify.auth.oauth2 = Some(crate::config::OAuth2Env {
        client_id: client_id.clone(),
        client_secret: client_secret.clone(),
        access_token: Some(tokens.access_token.clone()),
        refresh_token: tokens.refresh_token.clone(),
        scopes: Some(scopes.clone()),
        redirect_uri: Some(redirect_uri.clone()),
    });
    verify.cache_enabled = false;
    let client = XClient::new(&verify);
    let (account, warning) = match client
        .request(
            XRequest::get("/2/users/me")
                .user()
                .q("user.fields", "id,username,name"),
        )
        .await
    {
        Ok(res) => (Some(res.data), None),
        Err(e) => (None, Some(e.message())),
    };
    if let (Some(w), false) = (&warning, options.json) {
        println!();
        println!("Tokens saved, but the verification call failed: {w}");
        println!(
            "This usually means a required scope was not granted or the X app is misconfigured."
        );
    }
    if options.json {
        let mut out = crate::obj! {
            "authorized" => true,
            "clientId" => client_id,
            "scopes" => json!(tokens.scope.clone().unwrap_or(scopes)),
            "expiresAt" => expires_at.map(iso),
            "refreshToken" => tokens.refresh_token.is_some(),
            "credentialFile" => file.clone(),
            "account" => account.clone(),
        };
        crate::util::put(&mut out, "warning", warning.clone());
        println!("{}", crate::util::pretty(&Value::Object(out)));
    } else {
        println!();
        let username = account
            .as_ref()
            .and_then(|a| a.get("username"))
            .and_then(Value::as_str);
        match username {
            Some(u) => println!(
                "Signed in as @{u} (id {}).",
                account
                    .as_ref()
                    .and_then(|a| a.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            ),
            None => println!("Authorization complete."),
        }
        println!("Tokens saved to {file} (mode 0600).");
        println!(
            "{}",
            if tokens.refresh_token.is_some() {
                "A refresh token is stored; access tokens renew automatically."
            } else {
                "No refresh token was issued. Add the offline.access scope to enable automatic renewal."
            }
        );
        println!();
        println!("Start the server with:  x-mcp");
    }
    if account.is_some() || warning.is_none() {
        0
    } else {
        2
    }
}

async fn login(
    http: &reqwest::Client,
    config: &Config,
    client_id: &str,
    client_secret: Option<&str>,
    scopes: &[String],
    redirect_uri: &str,
    options: &Options,
) -> Result<TokenSet, String> {
    let redirect = url::Url::parse(redirect_uri)
        .map_err(|_| format!("Invalid redirect URI: {redirect_uri}"))?;
    let host = redirect.host_str().unwrap_or("");
    let loopback = LOOPBACK.contains(&host);
    let pkce = oauth2::pkce();
    let state = random_hex(16);
    let url = oauth2::authorize_url(client_id, redirect_uri, scopes, &state, &pkce.challenge);
    crate::info!("starting OAuth 2.0 PKCE login", "redirectUri" => redirect_uri);
    let code = if options.manual || !loopback {
        if !loopback {
            crate::warn!("redirect URI is not loopback; using manual code entry", "redirectUri" => redirect_uri);
        }
        prompt_for_code(&url, &state).await?
    } else {
        capture(&url, &redirect, &state, options.open_browser).await?
    };
    oauth2::token_request(
        http,
        &config.token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", &pkce.verifier),
        ],
        client_id,
        client_secret,
    )
    .await
}

fn parse_code(input: &str, expected_state: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("No authorization code provided.".into());
    }
    let (code, state) = if value.starts_with("http://") || value.starts_with("https://") {
        let url =
            url::Url::parse(value).map_err(|_| "Could not parse the pasted URL.".to_owned())?;
        let get = |k: &str| {
            url.query_pairs()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.into_owned())
        };
        (get("code").unwrap_or_default(), get("state"))
    } else if value.contains("code=") {
        let pairs: Vec<(String, String)> =
            url::form_urlencoded::parse(value.trim_start_matches('?').as_bytes())
                .into_owned()
                .collect();
        let get = |k: &str| {
            pairs
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        };
        (get("code").unwrap_or_default(), get("state"))
    } else {
        (value.to_owned(), None)
    };
    if code.is_empty() {
        return Err("Could not find a code parameter in the pasted value.".into());
    }
    if state.is_some_and(|s| s != expected_state) {
        return Err("State mismatch — the callback does not belong to this login attempt.".into());
    }
    Ok(code)
}

async fn prompt_for_code(url: &str, state: &str) -> Result<String, String> {
    eprintln!("\nOpen this URL, authorize the app, then paste the full redirected URL:\n\n{url}\n");
    eprint!("Redirect URL (or code): ");
    let mut line = String::new();
    tokio::io::BufReader::new(tokio::io::stdin())
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    parse_code(&line, state)
}

pub fn open_browser(url: &str) -> bool {
    let result = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    result.is_ok()
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>body{{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}}</style></head><body><h1>{title}</h1><p>{body}</p></body></html>"
    )
}

async fn capture(
    url: &str,
    redirect: &url::Url,
    state: &str,
    open: bool,
) -> Result<String, String> {
    let port = redirect.port_or_known_default().unwrap_or(80);
    let host = match redirect.host_str().unwrap_or("127.0.0.1") {
        "[::1]" | "::1" => "::1",
        "localhost" => "127.0.0.1",
        h => h,
    }
    .to_owned();
    let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            crate::warn!("could not start the loopback listener; falling back to manual entry", "err" => e.to_string(), "port" => port as u64);
            return prompt_for_code(url, state).await;
        }
    };
    eprintln!("\nOpen this URL to authorize x-mcp:\n\n{url}\n");
    if open {
        open_browser(url);
    }
    let path = redirect.path().to_owned();
    let wait = async {
        loop {
            let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            let target = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let parsed = url::Url::parse(&format!("http://localhost{target}")).ok();
            let Some(parsed) = parsed.filter(|p| p.path() == path) else {
                let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nNot found").await;
                continue;
            };
            let get = |k: &str| {
                parsed
                    .query_pairs()
                    .find(|(key, _)| key == k)
                    .map(|(_, v)| v.into_owned())
            };
            let (status, html, result) = if let Some(error) = get("error") {
                let description = get("error_description").unwrap_or(error);
                (
                    "400 Bad Request",
                    page("Authorization failed", &description.replace('<', "&lt;")),
                    Err(format!("Authorization denied: {description}")),
                )
            } else if let Some(code) = get("code") {
                if get("state").as_deref() != Some(state) {
                    (
                        "400 Bad Request",
                        page("Authorization failed", "State mismatch."),
                        Err("OAuth state mismatch; aborting for safety.".into()),
                    )
                } else {
                    (
                        "200 OK",
                        page(
                            "Authorization complete",
                            "You can close this tab and return to the terminal.",
                        ),
                        Ok(code),
                    )
                }
            } else {
                (
                    "400 Bad Request",
                    page(
                        "Authorization failed",
                        "The callback did not include a code.",
                    ),
                    Err("The OAuth callback did not include a code.".into()),
                )
            };
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{html}",
                html.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            return result;
        }
    };
    match tokio::time::timeout(Duration::from_secs(300), wait).await {
        Ok(result) => result,
        Err(_) => Err("Timed out after 300s waiting for the OAuth callback.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_callbacks_are_parsed_and_state_checked() {
        assert_eq!(
            parse_code("http://127.0.0.1:8787/callback?state=s&code=abc", "s").unwrap(),
            "abc"
        );
        assert_eq!(parse_code("?code=xyz&state=s", "s").unwrap(), "xyz");
        assert_eq!(parse_code("rawcode", "s").unwrap(), "rawcode");
        assert!(
            parse_code("http://127.0.0.1/cb?code=a&state=other", "s")
                .unwrap_err()
                .contains("State mismatch")
        );
    }
}
