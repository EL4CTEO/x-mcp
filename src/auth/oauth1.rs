//! OAuth 1.0a request signing (HMAC-SHA1, RFC 5849).

use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;

#[derive(Clone, Debug)]
pub struct Credentials {
    pub consumer_key: String,
    pub consumer_secret: String,
    pub access_token: String,
    pub access_token_secret: String,
}

/// RFC 5849 §3.6: unreserved characters stay, everything else is %XX.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Produces the `Authorization: OAuth …` header. Query parameters of the
/// URL are signed; JSON bodies are not (per the spec).
pub fn sign(
    credentials: &Credentials,
    method: &str,
    url: &str,
    nonce: Option<&str>,
    timestamp: Option<&str>,
) -> String {
    let parsed = url::Url::parse(url).expect("signable url");
    let base_url = format!("{}{}", parsed.origin().ascii_serialization(), parsed.path());

    let mut params: Vec<(String, String)> = Vec::new();
    let mut set = |key: String, value: String| {
        if let Some(slot) = params.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            params.push((key, value));
        }
    };
    for (key, value) in parsed.query_pairs() {
        set(key.into_owned(), value.into_owned());
    }
    let nonce = nonce
        .map(str::to_owned)
        .unwrap_or_else(|| crate::util::random_hex(16));
    let timestamp = timestamp
        .map(str::to_owned)
        .unwrap_or_else(|| (crate::util::now_ms() / 1000).to_string());
    let mut oauth: Vec<(&str, String)> = vec![
        ("oauth_consumer_key", credentials.consumer_key.clone()),
        ("oauth_nonce", nonce),
        ("oauth_signature_method", "HMAC-SHA1".into()),
        ("oauth_timestamp", timestamp),
        ("oauth_version", "1.0".into()),
    ];
    if !credentials.access_token.is_empty() {
        oauth.push(("oauth_token", credentials.access_token.clone()));
    }
    for (key, value) in &oauth {
        set((*key).to_owned(), value.clone());
    }

    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (percent_encode(k), percent_encode(v)))
        .collect();
    encoded.sort();
    let parameter_string = encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let base = format!(
        "{}&{}&{}",
        method.to_uppercase(),
        percent_encode(&base_url),
        percent_encode(&parameter_string)
    );
    let key = format!(
        "{}&{}",
        percent_encode(&credentials.consumer_secret),
        percent_encode(&credentials.access_token_secret)
    );
    let mut mac = Hmac::<Sha1>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(base.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    oauth.push(("oauth_signature", signature));
    oauth.sort_by(|a, b| a.0.cmp(b.0));
    let header = oauth
        .iter()
        .map(|(k, v)| format!("{}=\"{}\"", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("OAuth {header}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from the X developer docs ("Creating a signature").
    #[test]
    fn matches_the_documented_signature() {
        let credentials = Credentials {
            consumer_key: "xvz1evFS4wEEPTGEFPHBog".into(),
            consumer_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw".into(),
            access_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb".into(),
            access_token_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE".into(),
        };
        let header = sign(
            &credentials,
            "POST",
            "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
            Some("kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"),
            Some("1318622958"),
        );
        assert!(
            header.contains("oauth_signature=\"hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D\""),
            "{header}"
        );
    }

    #[test]
    fn percent_encoding_is_rfc5849() {
        assert_eq!(
            percent_encode("Ladies + Gentlemen!*'()"),
            "Ladies%20%2B%20Gentlemen%21%2A%27%28%29"
        );
    }
}
