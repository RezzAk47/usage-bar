//! What the page may see of a provider's response. Nothing is passed through: the response is PROJECTED onto a small whitelist
//! (numbers, bounded reset values, a plan name, window names) and everything else is dropped here, in Rust. What remains is
//! checked once more for the token in every encoding (see `safe::leaks_token`), so a server that echoes our credential back in
//! any form, as a value or as a key, cannot hand it to the page.

use serde_json::{Map, Number, Value};

use crate::safe::{leaks_token, strip_display, Secret};

pub const MAX_WINDOWS: usize = 32;
pub const MAX_NAME: usize = 40;

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= MAX_NAME && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '-'))
}

fn leaky(s: &str, token: Option<&Secret>) -> bool {
    token.is_some_and(|t| leaks_token(s, t, true))
}

/// A finite number (or a numeric string, turned into a number); anything else is dropped.
fn num(v: &Value) -> Option<Value> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if s.len() <= 40 => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    f.is_finite().then(|| Number::from_f64(f).map(Value::Number)).flatten()
}

/// A reset time: a number, or a short string made only of what an ISO time or a number can contain.
fn reset(v: &Value, token: Option<&Secret>) -> Option<Value> {
    match v {
        Value::Number(_) => num(v),
        Value::String(s) if s.len() <= 40 && !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | '+' | 'T' | 't' | 'Z' | 'z' | ' ' | ',')) && !leaky(s, token) => Some(Value::String(s.clone())),
        _ => None,
    }
}

/// A plan or limit name: letters, digits, space, `_`, `-`, at most 40 characters, and never the token.
fn label(v: &Value, token: Option<&Secret>) -> Option<Value> {
    let s = v.as_str()?;
    let s = strip_display(s, MAX_NAME + 1);
    (name_ok(&s) && !leaky(&s, token)).then_some(Value::String(s))
}

fn put(o: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        o.insert(k.to_string(), v);
    }
}

/// `{five_hour: {utilization, resets_at}, ..., extra_usage: {is_enabled, utilization}}`.
pub fn claude(raw: &Value, token: Option<&Secret>) -> Value {
    let mut out = Map::new();
    let Some(obj) = raw.as_object() else { return Value::Object(out) };
    for (k, w) in obj.iter() {
        if out.len() >= MAX_WINDOWS {
            break;
        }
        if !name_ok(k) || leaky(k, token) {
            continue;
        }
        let Some(w) = w.as_object() else { continue };
        let mut o = Map::new();
        if k == "extra_usage" {
            if let Some(b) = w.get("is_enabled").and_then(Value::as_bool) {
                o.insert("is_enabled".into(), Value::Bool(b));
            }
            put(&mut o, "utilization", w.get("utilization").and_then(num));
        } else {
            put(&mut o, "utilization", w.get("utilization").and_then(num));
            put(&mut o, "resets_at", w.get("resets_at").and_then(|v| reset(v, token)));
        }
        if o.contains_key("utilization") {
            out.insert(k.clone(), Value::Object(o));
        }
    }
    Value::Object(out)
}

fn window(w: &Value, used: &[&str], secs: &[&str], resets: &[&str], token: Option<&Secret>) -> Option<Value> {
    let w = w.as_object()?;
    let mut o = Map::new();
    for k in used.iter().chain(secs).chain(["reset_after_seconds"].iter()) {
        put(&mut o, k, w.get(*k).and_then(num));
    }
    for k in resets {
        put(&mut o, k, w.get(*k).and_then(|v| reset(v, token)));
    }
    used.iter().any(|k| o.contains_key(*k)).then_some(Value::Object(o))
}

fn rate_limit(r: &Value, token: Option<&Secret>) -> Value {
    let mut o = Map::new();
    for k in ["primary_window", "secondary_window"] {
        put(&mut o, k, r.get(k).and_then(|w| window(w, &["used_percent"], &["limit_window_seconds"], &["reset_at"], token)));
    }
    Value::Object(o)
}

/// Codex: the web shape `{plan_type, rate_limit, additional_rate_limits}` and the app-server shape `{rateLimits: {...}}`.
pub fn codex(raw: &Value, token: Option<&Secret>) -> Value {
    let mut out = Map::new();
    put(&mut out, "plan_type", raw.get("plan_type").and_then(|v| label(v, token)));
    if let Some(r) = raw.get("rate_limit").filter(|r| r.is_object()) {
        out.insert("rate_limit".into(), rate_limit(r, token));
    }
    if let Some(list) = raw.get("additional_rate_limits").and_then(Value::as_array) {
        let items: Vec<Value> = list
            .iter()
            .take(20)
            .filter_map(|e| {
                let mut o = Map::new();
                put(&mut o, "limit_name", e.get("limit_name").or_else(|| e.get("metered_feature")).and_then(|v| label(v, token)));
                o.insert("rate_limit".into(), rate_limit(e.get("rate_limit")?, token));
                Some(Value::Object(o))
            })
            .collect();
        out.insert("additional_rate_limits".into(), Value::Array(items));
    }
    if let Some(r) = raw.get("rateLimits").filter(|r| r.is_object()) {
        let mut o = Map::new();
        put(&mut o, "planType", r.get("planType").and_then(|v| label(v, token)));
        for k in ["primary", "secondary"] {
            put(&mut o, k, r.get(k).and_then(|w| window(w, &["usedPercent"], &["windowDurationMins"], &["resetsAt"], token)));
        }
        out.insert("rateLimits".into(), Value::Object(o));
    }
    Value::Object(out)
}

/// Last line of defence: the serialized projection must not contain the token in any exact encoding.
pub fn clean(v: Value, token: Option<&Secret>) -> Option<Value> {
    match token {
        Some(t) if leaks_token(&v.to_string(), t, false) => None,
        _ => Some(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOK: &str = "FAKE+CLAUDE/TOK<en>\\q\"-c1c1c1c1c1c1c1c1c1c1c1c1c1c1";

    #[test]
    fn claude_keeps_only_numbers_and_bounded_resets() {
        let t = Secret::new(TOK.into());
        let raw = json!({
            "echo": TOK, "five_hour": {"utilization": "37.5", "resets_at": "2026-10-07T17:19:00.123+00:00", "note": "<img onerror=1>"},
            "seven_day": {"utilization": 40, "resets_at": 1900000000},
            "bad key!": {"utilization": 1}, "seven_day_opus": {"utilization": true}, "x": {"utilization": "1e999"},
            "extra_usage": {"is_enabled": true, "utilization": 2.4, "currency": "USD"},
        });
        let out = claude(&raw, Some(&t));
        assert_eq!(out, json!({"five_hour": {"utilization": 37.5, "resets_at": "2026-10-07T17:19:00.123+00:00"}, "seven_day": {"utilization": 40.0, "resets_at": 1900000000.0}, "extra_usage": {"is_enabled": true, "utilization": 2.4}}));
    }

    #[test]
    fn a_token_in_any_encoding_never_survives_as_value_key_or_reset() {
        let t = Secret::new(TOK.into());
        for enc in crate::safe::encodings(TOK) {
            let raw = json!({
                enc.clone(): {"utilization": 5, "resets_at": enc.clone()},
                "five_hour": {"utilization": 5, "resets_at": enc.clone()},
                "echo": enc.clone(),
                "seven_day": {"utilization": 6, "label": enc.clone()},
            });
            let out = claude(&raw, Some(&t)).to_string();
            for e in crate::safe::encodings(TOK) {
                assert!(!out.contains(&e), "{e} survived in {out}");
            }
            assert!(!leaks_token(&out, &t, true), "{out}");
            let c = codex(&json!({"plan_type": enc.clone(), "additional_rate_limits": [{"limit_name": enc.clone(), "rate_limit": {"primary_window": {"used_percent": 1}}}]}), Some(&t)).to_string();
            assert!(!leaks_token(&c, &t, true), "{c}");
        }
    }

    #[test]
    fn a_short_alphanumeric_token_used_as_plan_or_name_is_dropped() {
        let t = Secret::new("abcd1234".into());
        assert_eq!(codex(&json!({"plan_type": "abcd1234"}), Some(&t)), json!({}));
        assert_eq!(claude(&json!({"abcd1234": {"utilization": 1}}), Some(&t)), json!({}), "a window named like the token is dropped");
        assert!(clean(json!({"k": "abcd1234"}), Some(&t)).is_none(), "the final check refuses a leftover exact match");
        assert!(clean(json!({"five_hour": {"utilization": 1.0}}), Some(&t)).is_some());
    }

    #[test]
    fn codex_whitelist_both_shapes() {
        let raw = json!({
            "plan_type": "plus<script>", "secret": "x",
            "rate_limit": {"primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_at": 1900000000, "junk": "z"}, "secondary_window": {"used_percent": null}},
            "additional_rate_limits": [{"limit_name": "spark", "rate_limit": {"primary_window": {"used_percent": 0}}}, 5],
            "rateLimits": {"planType": "plus", "primary": {"usedPercent": 7, "resetsAt": "1900000000", "windowDurationMins": 300}},
        });
        let out = codex(&raw, None);
        assert_eq!(out["rate_limit"], json!({"primary_window": {"used_percent": 12.0, "limit_window_seconds": 18000.0, "reset_at": 1900000000.0}}));
        assert_eq!(out["additional_rate_limits"], json!([{"limit_name": "spark", "rate_limit": {"primary_window": {"used_percent": 0.0}}}]));
        assert_eq!(out["rateLimits"]["primary"], json!({"usedPercent": 7.0, "windowDurationMins": 300.0, "resetsAt": "1900000000"}));
        assert!(out.get("plan_type").is_none() && out.get("secret").is_none());
        assert_eq!(out["rateLimits"]["planType"], "plus");
    }

    #[test]
    fn non_objects_and_window_cap() {
        for raw in [json!(null), json!([1]), json!("x"), json!(5)] {
            assert_eq!(claude(&raw, None), json!({}));
            assert_eq!(codex(&raw, None), json!({}));
        }
        let mut m = Map::new();
        for i in 0..100 {
            m.insert(format!("w{i}"), json!({"utilization": 1}));
        }
        assert_eq!(claude(&Value::Object(m), None).as_object().unwrap().len(), MAX_WINDOWS);
        let long = "a".repeat(41);
        assert_eq!(claude(&json!({long: {"utilization": 1}}), None), json!({}));
    }
}
