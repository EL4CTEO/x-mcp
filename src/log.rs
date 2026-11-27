//! Structured logs on stderr (stdout carries MCP frames). One JSON object per
//! line, pino-compatible: `{"level":"info","time":"…","msg":"…",…}`.

use crate::util::{Json, iso_now};
use serde_json::Value;
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};

static LEVEL: AtomicU8 = AtomicU8::new(2);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 1,
    Info = 2,
    Warn = 3,
}

pub fn set_level(name: &str) {
    let value = match name {
        "trace" => 0,
        "debug" => 1,
        "info" => 2,
        "warn" => 3,
        "error" => 4,
        _ => 5,
    };
    LEVEL.store(value, Ordering::Relaxed);
}

pub fn enabled(level: Level) -> bool {
    level as u8 >= LEVEL.load(Ordering::Relaxed)
}

pub fn log(level: Level, msg: &str, fields: Json) {
    if !enabled(level) {
        return;
    }
    let label = match level {
        Level::Debug => "debug",
        Level::Info => "info",
        Level::Warn => "warn",
    };
    let mut line = Json::new();
    line.insert("level".into(), label.into());
    line.insert("time".into(), iso_now().into());
    for (key, value) in fields {
        line.insert(key, value);
    }
    line.insert("msg".into(), msg.into());
    let mut out = serde_json::to_string(&Value::Object(line)).unwrap_or_default();
    out.push('\n');
    let _ = std::io::stderr().lock().write_all(out.as_bytes());
}

#[macro_export]
macro_rules! debug { ($msg:expr $(, $k:expr => $v:expr)* $(,)?) => { if $crate::log::enabled($crate::log::Level::Debug) { $crate::log::log($crate::log::Level::Debug, $msg, $crate::obj!($($k => $v),*)) } }; }
#[macro_export]
macro_rules! info { ($msg:expr $(, $k:expr => $v:expr)* $(,)?) => { if $crate::log::enabled($crate::log::Level::Info) { $crate::log::log($crate::log::Level::Info, $msg, $crate::obj!($($k => $v),*)) } }; }
#[macro_export]
macro_rules! warn { ($msg:expr $(, $k:expr => $v:expr)* $(,)?) => { if $crate::log::enabled($crate::log::Level::Warn) { $crate::log::log($crate::log::Level::Warn, $msg, $crate::obj!($($k => $v),*)) } }; }
