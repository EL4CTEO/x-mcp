//! Small helpers shared by every module: JSON shaping, UTF-16 aware
//! truncation (MCP clients count JavaScript string length), time formatting
//! and constant-time comparison.

use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Json = Map<String, Value>;

/// Builds an object from `(key, value)` pairs, skipping `None` values, so the
/// output never carries `null` placeholders for absent fields.
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = serde_json::Map::new();
        $( $crate::util::put(&mut map, $key, $value); )*
        map
    }};
}

/// Values that `obj!` knows how to insert (or skip).
pub trait IntoField {
    fn into_field(self) -> Option<Value>;
}
impl IntoField for Value {
    fn into_field(self) -> Option<Value> {
        Some(self)
    }
}
impl<T: Into<Value>> IntoField for Option<T> {
    fn into_field(self) -> Option<Value> {
        self.map(Into::into)
    }
}
impl IntoField for &str {
    fn into_field(self) -> Option<Value> {
        Some(Value::String(self.to_owned()))
    }
}
impl IntoField for String {
    fn into_field(self) -> Option<Value> {
        Some(Value::String(self))
    }
}
impl IntoField for bool {
    fn into_field(self) -> Option<Value> {
        Some(Value::Bool(self))
    }
}
impl IntoField for u64 {
    fn into_field(self) -> Option<Value> {
        Some(self.into())
    }
}
impl IntoField for i64 {
    fn into_field(self) -> Option<Value> {
        Some(self.into())
    }
}
impl IntoField for usize {
    fn into_field(self) -> Option<Value> {
        Some((self as u64).into())
    }
}
impl IntoField for Json {
    fn into_field(self) -> Option<Value> {
        Some(Value::Object(self))
    }
}
impl IntoField for Vec<Value> {
    fn into_field(self) -> Option<Value> {
        Some(Value::Array(self))
    }
}

pub fn put(map: &mut Json, key: &str, value: impl IntoField) {
    if let Some(value) = value.into_field() {
        map.insert(key.to_owned(), value);
    }
}

/// Appends every entry of `from` (an object) into `into`, like a JS spread.
pub fn spread(into: &mut Json, from: Value) {
    if let Value::Object(map) = from {
        for (key, value) in map {
            into.insert(key, value);
        }
    }
}

pub fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn get_num(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|v| v.is_number()).cloned()
}

pub fn get_arr<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    value.get(key).and_then(Value::as_array)
}

/// `JSON.stringify(value, null, 2)`.
pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}

/// Length in UTF-16 code units, as JavaScript counts it.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The longest prefix of `text` that is at most `units` UTF-16 code units.
pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `new Date(ms).toISOString()`: `2026-01-31T12:00:00.000Z`.
pub fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn iso_now() -> String {
    iso(now_ms())
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Constant-time byte comparison for bearer tokens.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn uuid_v4() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// `(bytes / 1024 / 1024).toFixed(1) + " MB"`.
pub fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formats_like_javascript() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_769_860_800_123), "2026-01-31T12:00:00.123Z");
    }

    #[test]
    fn utf16_prefix_counts_surrogates() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
    }

    #[test]
    fn encode_component_matches_js() {
        assert_eq!(encode_component("a b/c?é"), "a%20b%2Fc%3F%C3%A9");
        assert_eq!(encode_component("!'()*-._~"), "!'()*-._~");
    }
}
