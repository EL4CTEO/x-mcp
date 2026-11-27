//! A tiny parameter DSL: one definition drives argument validation (with
//! zod-compatible messages and defaults) and the published JSON Schema.

use serde_json::{Map, Value, json};

use crate::util::{Json, utf16_len};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    /// `^\d{1,19}$`: snowflake ids.
    Digits,
    /// `^[A-Za-z0-9_]{1,15}$`: handles.
    Username,
    /// `^[A-Za-z0-9]{1,40}$`: Space ids.
    SpaceId,
}

impl Pattern {
    pub fn regex(self) -> &'static str {
        match self {
            Pattern::Digits => r"^\d{1,19}$",
            Pattern::Username => r"^[A-Za-z0-9_]{1,15}$",
            Pattern::SpaceId => r"^[A-Za-z0-9]{1,40}$",
        }
    }
    fn matches(self, s: &str) -> bool {
        match self {
            Pattern::Digits => (1..=19).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()),
            Pattern::Username => {
                (1..=15).contains(&s.len())
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            }
            Pattern::SpaceId => {
                (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ty {
    Str {
        min: Option<usize>,
        max: Option<usize>,
        pattern: Option<(Pattern, Option<&'static str>)>,
        url: bool,
    },
    Int {
        min: Option<i64>,
        max: Option<i64>,
    },
    Bool,
    Enum(&'static [&'static str]),
    Array {
        items: Box<Ty>,
        min: Option<usize>,
        max: Option<usize>,
    },
    Object(Vec<Field>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub name: &'static str,
    pub ty: Ty,
    pub required: bool,
    pub default: Option<Value>,
    pub desc: Option<&'static str>,
    /// Description of the inner value (zod `.describe` before `.optional`).
    pub inner_desc: Option<&'static str>,
}

// ---- builders --------------------------------------------------------------

pub fn string() -> Ty {
    Ty::Str {
        min: None,
        max: None,
        pattern: None,
        url: false,
    }
}
pub fn text(min: usize, max: usize) -> Ty {
    Ty::Str {
        min: Some(min),
        max: Some(max),
        pattern: None,
        url: false,
    }
}
pub fn max_len(max: usize) -> Ty {
    Ty::Str {
        min: None,
        max: Some(max),
        pattern: None,
        url: false,
    }
}
pub fn pattern(p: Pattern, message: Option<&'static str>) -> Ty {
    Ty::Str {
        min: None,
        max: None,
        pattern: Some((p, message)),
        url: false,
    }
}
pub fn url() -> Ty {
    Ty::Str {
        min: None,
        max: None,
        pattern: None,
        url: true,
    }
}
pub fn int(min: i64, max: Option<i64>) -> Ty {
    Ty::Int {
        min: Some(min),
        max,
    }
}
pub fn array(items: Ty, min: Option<usize>, max: Option<usize>) -> Ty {
    Ty::Array {
        items: Box::new(items),
        min,
        max,
    }
}

pub fn field(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        required: true,
        default: None,
        desc: None,
        inner_desc: None,
    }
}

impl Field {
    pub fn opt(mut self) -> Self {
        self.required = false;
        self
    }
    pub fn def(mut self, value: Value) -> Self {
        self.required = false;
        self.default = Some(value);
        self
    }
    pub fn desc(mut self, desc: &'static str) -> Self {
        self.desc = Some(desc);
        self
    }
    /// A description that belongs to the value type (kept when re-described).
    pub fn inner(mut self, desc: &'static str) -> Self {
        self.inner_desc = Some(desc);
        self
    }
}

// ---- validation ------------------------------------------------------------

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expected(ty: &Ty) -> &'static str {
    match ty {
        Ty::Str { .. } | Ty::Enum(_) => "string",
        Ty::Int { .. } => "number",
        Ty::Bool => "boolean",
        Ty::Array { .. } => "array",
        Ty::Object(_) => "object",
    }
}

pub struct Issue {
    pub path: Vec<String>,
    pub message: String,
}

fn check(ty: &Ty, value: &Value, path: &mut Vec<String>, issues: &mut Vec<Issue>) -> Value {
    let mut issue = |path: &Vec<String>, message: String| {
        issues.push(Issue {
            path: path.clone(),
            message,
        })
    };
    match (ty, value) {
        (
            Ty::Str {
                min,
                max,
                pattern,
                url,
            },
            Value::String(s),
        ) => {
            let len = utf16_len(s);
            if let Some(min) = min.filter(|m| len < *m) {
                issue(
                    path,
                    format!("Too small: expected string to have >={min} characters"),
                );
            }
            if let Some(max) = max.filter(|m| len > *m) {
                issue(
                    path,
                    format!("Too big: expected string to have <={max} characters"),
                );
            }
            if let Some((p, message)) = pattern
                && !p.matches(s)
            {
                issue(
                    path,
                    message.map(str::to_owned).unwrap_or_else(|| {
                        format!("Invalid string: must match pattern /{}/", p.regex())
                    }),
                );
            }
            if *url && url::Url::parse(s).is_err() {
                issue(path, "Invalid URL".into());
            }
            value.clone()
        }
        (Ty::Enum(options), Value::String(s)) => {
            if !options.contains(&s.as_str()) {
                let list: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
                issue(
                    path,
                    format!("Invalid option: expected one of {}", list.join("|")),
                );
            }
            value.clone()
        }
        (Ty::Int { min, max }, Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.fract() != 0.0 {
                issue(path, "Invalid input: expected int, received number".into());
            } else {
                if let Some(min) = min.filter(|m| f < *m as f64) {
                    issue(path, format!("Too small: expected number to be >={min}"));
                }
                if let Some(max) = max.filter(|m| f > *m as f64) {
                    issue(path, format!("Too big: expected number to be <={max}"));
                }
            }
            // 20.0 from a JSON client becomes 20.
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                Value::from(f as i64)
            } else {
                value.clone()
            }
        }
        (Ty::Bool, Value::Bool(_)) => value.clone(),
        (Ty::Array { items, min, max }, Value::Array(list)) => {
            let out: Vec<Value> = list
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    path.push(i.to_string());
                    let v = check(items, item, path, issues);
                    path.pop();
                    v
                })
                .collect();
            let mut issue = |message: String| {
                issues.push(Issue {
                    path: path.clone(),
                    message,
                })
            };
            if let Some(min) = min.filter(|m| list.len() < *m) {
                issue(format!("Too small: expected array to have >={min} items"));
            }
            if let Some(max) = max.filter(|m| list.len() > *m) {
                issue(format!("Too big: expected array to have <={max} items"));
            }
            Value::Array(out)
        }
        (Ty::Object(fields), Value::Object(map)) => {
            Value::Object(check_fields(fields, map, path, issues))
        }
        (ty, other) => {
            issue(
                path,
                format!(
                    "Invalid input: expected {}, received {}",
                    expected(ty),
                    type_name(other)
                ),
            );
            other.clone()
        }
    }
}

fn check_fields(
    fields: &[Field],
    map: &Map<String, Value>,
    path: &mut Vec<String>,
    issues: &mut Vec<Issue>,
) -> Json {
    let mut out = Json::new();
    for f in fields {
        // `null` is treated as absent: many clients send it for optional fields.
        match map.get(f.name).filter(|v| !v.is_null()) {
            Some(value) => {
                path.push(f.name.to_owned());
                let v = check(&f.ty, value, path, issues);
                path.pop();
                out.insert(f.name.into(), v);
            }
            None => {
                if let Some(default) = &f.default {
                    out.insert(f.name.into(), default.clone());
                } else if f.required {
                    let mut p = path.clone();
                    p.push(f.name.to_owned());
                    let received = if map.contains_key(f.name) {
                        "null"
                    } else {
                        "undefined"
                    };
                    issues.push(Issue {
                        path: p,
                        message: format!(
                            "Invalid input: expected {}, received {received}",
                            expected(&f.ty)
                        ),
                    });
                }
            }
        }
    }
    out
}

/// Validates `args` against `fields`: unknown keys are dropped, defaults filled.
pub fn validate(fields: &[Field], args: &Map<String, Value>) -> Result<Json, String> {
    let mut issues = vec![];
    let out = check_fields(fields, args, &mut vec![], &mut issues);
    if issues.is_empty() {
        return Ok(out);
    }
    Err(issues
        .iter()
        .map(|i| {
            format!(
                "{}: {}",
                if i.path.is_empty() {
                    "value".into()
                } else {
                    i.path.join(".")
                },
                i.message
            )
        })
        .collect::<Vec<_>>()
        .join("; "))
}

// ---- JSON Schema -----------------------------------------------------------

pub fn ty_schema(ty: &Ty) -> Json {
    let mut s = Json::new();
    match ty {
        Ty::Str {
            min,
            max,
            pattern,
            url,
        } => {
            s.insert("type".into(), "string".into());
            if let Some(m) = min {
                s.insert("minLength".into(), (*m).into());
            }
            if let Some(m) = max {
                s.insert("maxLength".into(), (*m).into());
            }
            if let Some((p, _)) = pattern {
                s.insert("pattern".into(), p.regex().into());
            }
            if *url {
                s.insert("format".into(), "uri".into());
            }
        }
        Ty::Int { min, max } => {
            s.insert("type".into(), "integer".into());
            if let Some(m) = min {
                s.insert("minimum".into(), (*m).into());
            }
            if let Some(m) = max {
                s.insert("maximum".into(), (*m).into());
            }
        }
        Ty::Bool => {
            s.insert("type".into(), "boolean".into());
        }
        Ty::Enum(options) => {
            s.insert("type".into(), "string".into());
            s.insert("enum".into(), json!(options));
        }
        Ty::Array { items, min, max } => {
            s.insert("type".into(), "array".into());
            s.insert("items".into(), Value::Object(ty_schema(items)));
            if let Some(m) = min {
                s.insert("minItems".into(), (*m).into());
            }
            if let Some(m) = max {
                s.insert("maxItems".into(), (*m).into());
            }
        }
        Ty::Object(fields) => return object_schema(fields),
    }
    s
}

pub fn field_schema(f: &Field) -> Json {
    let mut s = ty_schema(&f.ty);
    if let Some(d) = &f.default {
        s.insert("default".into(), d.clone());
    }
    if let Some(d) = f.desc.or(f.inner_desc) {
        s.insert("description".into(), d.into());
    }
    s
}

pub fn object_schema(fields: &[Field]) -> Json {
    let mut props = Json::new();
    for f in fields {
        props.insert(f.name.into(), Value::Object(field_schema(f)));
    }
    let required: Vec<&str> = fields
        .iter()
        .filter(|f| f.required)
        .map(|f| f.name)
        .collect();
    let mut s = Json::new();
    s.insert("type".into(), "object".into());
    s.insert("properties".into(), Value::Object(props));
    if !required.is_empty() {
        s.insert("required".into(), json!(required));
    }
    s
}

/// One property for a key shared by several actions. Identical definitions
/// collapse into one schema; differing ones keep the loosest bounds and say
/// per action what applies, instead of a wall of near-duplicate `anyOf`s.
pub fn merged_schema(variants: &[(&Field, Vec<&'static str>)]) -> Json {
    if variants.len() == 1 {
        return field_schema(variants[0].0);
    }
    let first = &variants[0].0.ty;
    let mut schema = match first {
        Ty::Int { .. } => {
            let (mut lo, mut hi) = (i64::MAX, i64::MIN);
            let mut unbounded = false;
            for (f, _) in variants {
                if let Ty::Int { min, max } = &f.ty {
                    lo = lo.min(min.unwrap_or(i64::MIN));
                    match max {
                        Some(m) => hi = hi.max(*m),
                        None => unbounded = true,
                    }
                }
            }
            let mut s = Json::new();
            s.insert("type".into(), "integer".into());
            if lo != i64::MIN {
                s.insert("minimum".into(), lo.into());
            }
            if !unbounded && hi != i64::MIN {
                s.insert("maximum".into(), hi.into());
            }
            s
        }
        _ if variants.iter().all(|(f, _)| f.ty == *first) => ty_schema(first),
        Ty::Str { .. } if variants.iter().all(|(f, _)| matches!(f.ty, Ty::Str { .. })) => {
            let mut s = Json::new();
            s.insert("type".into(), "string".into());
            s
        }
        _ => {
            let any: Vec<Value> = variants
                .iter()
                .map(|(f, _)| Value::Object(field_schema(f)))
                .collect();
            let mut s = Json::new();
            s.insert("anyOf".into(), Value::Array(any));
            return s;
        }
    };
    let notes: Vec<String> = variants
        .iter()
        .map(|(f, actions)| {
            let mut note = actions.join("/");
            let mut bits = vec![];
            if let Ty::Int { min, max } = &f.ty {
                match (min, max) {
                    (Some(a), Some(b)) => bits.push(format!("{a}-{b}")),
                    (Some(a), None) => bits.push(format!(">={a}")),
                    _ => {}
                }
            }
            if let Ty::Str { max: Some(m), .. } = &f.ty {
                bits.push(format!("max {m} chars"));
            }
            if let Some(d) = &f.default {
                bits.push(format!("default {d}"));
            }
            if !bits.is_empty() {
                note.push_str(&format!(" {}", bits.join(", ")));
            }
            if let Some(d) = f.desc.or(f.inner_desc)
                && !matches!(f.ty, Ty::Int { .. })
            {
                note.push_str(&format!(": {d}"));
            }
            note
        })
        .collect();
    let lead = variants.iter().find_map(|(f, _)| match f.ty {
        Ty::Int { .. } => f.desc.or(f.inner_desc).map(|d| {
            d.split(" (")
                .next()
                .unwrap_or(d)
                .trim_end_matches('.')
                .to_owned()
        }),
        _ => None,
    });
    let description = match lead {
        Some(lead) => format!("{lead}. Per action: {}.", notes.join("; ")),
        None => format!("Per action: {}.", notes.join("; ")),
    };
    schema.insert("description".into(), description.into());
    schema
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Vec<Field> {
        vec![
            field(
                "tweet_id",
                pattern(Pattern::Digits, Some("Post id must be numeric")),
            ),
            field("max_results", int(10, Some(100))).def(json!(10)),
            field("sort", Ty::Enum(&["recency", "relevancy"])).opt(),
            field(
                "posts",
                array(Ty::Object(vec![field("text", text(1, 5))]), Some(2), None),
            )
            .opt(),
        ]
    }

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn messages_match_zod() {
        let err = validate(&fields(), &args(json!({}))).unwrap_err();
        assert_eq!(
            err,
            "tweet_id: Invalid input: expected string, received undefined"
        );
        let err = validate(
            &fields(),
            &args(json!({"tweet_id": "x", "max_results": 5.5, "sort": "new"})),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "tweet_id: Post id must be numeric; max_results: Invalid input: expected int, received number; sort: Invalid option: expected one of \"recency\"|\"relevancy\""
        );
        let err = validate(
            &fields(),
            &args(json!({"tweet_id": "1", "posts": [{"text": ""}]})),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "posts.0.text: Too small: expected string to have >=1 characters; posts: Too small: expected array to have >=2 items"
        );
    }

    #[test]
    fn defaults_fill_and_unknown_keys_drop() {
        let ok = validate(
            &fields(),
            &args(json!({"tweet_id": "1", "extra": true, "sort": null})),
        )
        .unwrap();
        assert_eq!(
            Value::Object(ok),
            json!({"tweet_id": "1", "max_results": 10})
        );
    }
}
