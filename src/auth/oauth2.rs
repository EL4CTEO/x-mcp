//! OAuth 2.0 Authorization Code + PKCE, and token refresh.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const AUTHORIZE_URL: &str = "https://x.com/i/oauth2/authorize";

pub const KNOWN_SCOPES: [&str; 21] = [
    "tweet.read",
    "tweet.write",
    "users.read",
    "follows.read",
    "follows.write",
    "like.read",
    "like.write",
    "bookmark.read",
    "bookmark.write",
    "list.read",
    "list.write",
    "mute.read",
    "mute.write",
    "block.read",
    "block.write",
    "media.write",
    "dm.read",
    "dm.write",
    "space.read",
    "tweet.moderate.write",
    "offline.access",
];

pub const DEFAULT_SCOPES: [&str; 4] = ["tweet.read", "tweet.write", "users.read", "offline.access"];

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let mut bytes = [0u8; 48];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("authorize url");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    url.to_string()
}

#[derive(Clone, Debug)]
pub struct TokenSet {
    pub access_token: String,
    pub token_type: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: Option<Vec<String>>,
}

pub async fn token_request(
    http: &reqwest::Client,
    token_url: &str,
    params: &[(&str, &str)],
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<TokenSet, String> {
    let mut pairs: Vec<(&str, &str)> = params.to_vec();
    let mut request = http
        .post(token_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json");
    match client_secret {
        Some(secret) => {
            request = request.header(
                "authorization",
                format!("Basic {}", STANDARD.encode(format!("{client_id}:{secret}"))),
            );
        }
        None => pairs.push(("client_id", client_id)),
    }
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    let response = request.body(body).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("OAuth 2.0 token request failed ({status}): {text}"));
    }
    let short = crate::util::utf16_prefix(&text, 300).to_owned();
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("OAuth 2.0 token endpoint returned invalid JSON: {short}"))?;
    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("OAuth 2.0 token response is missing access_token: {short}"))?;
    Ok(TokenSet {
        access_token: access_token.to_owned(),
        token_type: parsed
            .get("token_type")
            .and_then(Value::as_str)
            .unwrap_or("bearer")
            .to_owned(),
        refresh_token: parsed
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_owned),
        expires_in: parsed
            .get("expires_in")
            .and_then(Value::as_f64)
            .map(|v| v as u64),
        scope: parsed.get("scope").and_then(Value::as_str).map(|s| {
            s.split([' ', ','])
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect()
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let pair = pkce();
        assert_eq!(pair.verifier.len(), 64);
        assert_eq!(
            pair.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(pair.verifier.as_bytes()))
        );
    }

    #[test]
    fn authorize_url_carries_every_parameter() {
        let url = authorize_url(
            "cid",
            "http://127.0.0.1:8787/callback",
            &["tweet.read".into(), "offline.access".into()],
            "st",
            "ch",
        );
        assert!(
            url.starts_with("https://x.com/i/oauth2/authorize?response_type=code&client_id=cid")
        );
        assert!(url.contains("scope=tweet.read+offline.access"));
        assert!(url.ends_with("code_challenge=ch&code_challenge_method=S256"));
    }
}
