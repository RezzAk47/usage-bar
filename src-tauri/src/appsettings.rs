//! The two settings Rust itself needs, read from settings.json in the data folder (never taken from the page's request):
//! `use_system_proxy` (default false) and `codex_path` (default none). Anything unreadable or of the wrong type means the default.

use std::path::Path;

use crate::files;

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct RustSettings {
    pub use_system_proxy: bool,
    pub codex_path: Option<String>,
}

pub fn parse(text: &str) -> RustSettings {
    let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(text) else { return RustSettings::default() };
    RustSettings {
        use_system_proxy: o.get("use_system_proxy").and_then(|v| v.as_bool()).unwrap_or(false),
        codex_path: o.get("codex_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(|c| c.is_control())).map(str::to_string),
    }
}

pub fn load(data_dir: &Path) -> RustSettings {
    files::read(data_dir, "settings.json").ok().flatten().map(|t| parse(&t)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_strictness() {
        assert_eq!(parse("{}"), RustSettings::default());
        assert_eq!(parse("not json"), RustSettings::default());
        assert_eq!(parse(r#"{"use_system_proxy":"yes","codex_path":5}"#), RustSettings::default());
        assert_eq!(parse(r#"{"use_system_proxy":true,"codex_path":"/usr/bin/codex"}"#), RustSettings { use_system_proxy: true, codex_path: Some("/usr/bin/codex".into()) });
        assert_eq!(parse("{\"codex_path\":\"/a\\nb\"}").codex_path, None);
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(d.path()), RustSettings::default());
        std::fs::write(d.path().join("settings.json"), r#"{"use_system_proxy":true}"#).unwrap();
        assert!(load(d.path()).use_system_proxy);
    }
}
