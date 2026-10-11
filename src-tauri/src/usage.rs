//! One provider's usage, end to end: find the credentials, ask the provider, hand the page a status and the (depth- and
//! size-capped) response. Tokens live only inside this module and `http.rs`; the result type has no field that could hold one.
//!
//! WHERE THE NUMBERS COME FROM (see README, "How the usage numbers are obtained"):
//! - Claude: GET https://api.anthropic.com/api/oauth/usage with the Claude Code OAuth token and `anthropic-beta: oauth-2025-04-20`.
//! - Codex: GET https://chatgpt.com/backend-api/wham/usage with the Codex ChatGPT token (+ `ChatGPT-Account-Id`), and, when
//!   that fails, `codex app-server` -> `account/rateLimits/read`.
//!
//! Neither endpoint is documented by its owner; both are what the CLIs' own sign-in tokens are accepted by today.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::appserver;
use crate::appsettings::RustSettings;
use crate::creds::{self, CredError, Provider};
use crate::datadir::Os;
use crate::http::{self, Http, HttpError};
use crate::locate;
use crate::project;
use crate::safe::scrub;

pub const CLAUDE_BASE: &str = "https://api.anthropic.com";
pub const CLAUDE_PATH: &str = "/api/oauth/usage";
pub const CODEX_BASE: &str = "https://chatgpt.com";
pub const CODEX_PATH: &str = "/backend-api/wham/usage";

#[derive(Serialize, Debug, Default)]
pub struct FetchResult {
    pub id: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

impl FetchResult {
    fn status(p: Provider, status: &'static str) -> FetchResult {
        FetchResult {
            id: p.id().into(),
            status,
            ..Default::default()
        }
    }
    fn unavailable(p: Provider, reason: &str) -> FetchResult {
        FetchResult {
            id: p.id().into(),
            status: "unavailable",
            reason: Some(scrub(reason, 80)),
            ..Default::default()
        }
    }
}

const NO_HOME: &str = "no home folder found (HOME / USERPROFILE is not set)";

/// Everything that can differ between a real run and a test, resolved once from the environment.
pub struct Config {
    pub os: Os,
    pub test_mode: bool,
    /// None when there is no home folder and no override: the provider then reports "unavailable".
    pub claude_dir: Option<PathBuf>,
    pub codex_dir: Option<PathBuf>,
    pub claude_url: String,
    pub codex_url: String,
    pub codex_bin: Option<PathBuf>,
    /// The only environment the codex app-server child receives.
    pub child_env: Vec<(String, String)>,
    /// "Use system proxy settings" (Settings, default off): without it HTTPS_PROXY / ALL_PROXY are ignored.
    pub use_system_proxy: bool,
}

fn test_base(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    let v = env(name)?;
    http::url_allowed(&format!("{v}/x"), true).then(|| v.trim_end_matches('/').to_string())
}

impl Config {
    /// `USAGEBAR_API_BASE_*` and `USAGEBAR_CODEX_BIN` are honoured ONLY when `USAGEBAR_TEST=1`; in normal runs the hosts are the
    /// constants above and `codex` is looked up on PATH.
    pub fn from_env(
        os: Os,
        env: &dyn Fn(&str) -> Option<String>,
        settings: &RustSettings,
    ) -> Config {
        let test_mode = env("USAGEBAR_TEST").as_deref() == Some("1");
        let home = creds::home_for(os, env);
        let home = home.as_deref();
        let claude_base = test_mode
            .then(|| test_base(env, "USAGEBAR_API_BASE_CLAUDE"))
            .flatten()
            .unwrap_or_else(|| CLAUDE_BASE.into());
        let codex_base = test_mode
            .then(|| test_base(env, "USAGEBAR_API_BASE_CODEX"))
            .flatten()
            .unwrap_or_else(|| CODEX_BASE.into());
        let codex_bin = if test_mode {
            env("USAGEBAR_CODEX_BIN")
                .map(PathBuf::from)
                .filter(|p| p.is_file())
        } else {
            home.and_then(|h| locate::find_codex(os, env, h, settings.codex_path.as_deref()))
        };
        Config {
            os,
            test_mode,
            claude_dir: creds::config_dir(Provider::Claude, env, home),
            codex_dir: creds::config_dir(Provider::Codex, env, home),
            claude_url: format!("{claude_base}{CLAUDE_PATH}"),
            codex_url: format!("{codex_base}{CODEX_PATH}"),
            codex_bin,
            child_env: appserver::child_env(env, os == Os::Windows),
            use_system_proxy: settings.use_system_proxy,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn fetch(p: Provider, cfg: &Config, http: &dyn Http) -> FetchResult {
    match p {
        Provider::Claude => fetch_claude(cfg, http),
        Provider::Codex => fetch_codex(cfg, http),
    }
}

fn refused(p: Provider, what: &str, why: &str) -> FetchResult {
    FetchResult::unavailable(p, &format!("{what} {why}"))
}

fn fetch_claude(cfg: &Config, http: &dyn Http) -> FetchResult {
    let p = Provider::Claude;
    let Some(claude_dir) = cfg.claude_dir.as_deref() else {
        return FetchResult::unavailable(p, NO_HOME);
    };
    if !claude_dir.is_dir() {
        return FetchResult::status(p, "not_installed");
    }
    let text = match creds::read_cred_file(&creds::cred_file(p, claude_dir)) {
        Ok(t) => t,
        Err(CredError::Missing) if cfg.os == Os::Mac => {
            return FetchResult::unavailable(
                p,
                "macOS keeps Claude credentials in the Keychain, which this build does not read",
            );
        }
        Err(CredError::Missing) => return FetchResult::status(p, "not_signed_in"),
        Err(CredError::Refused(why)) => return refused(p, "credentials file", why),
        Err(CredError::Malformed) | Err(CredError::InvalidToken) => {
            return FetchResult::status(p, "not_signed_in")
        }
    };
    let c = match creds::parse_claude(&text) {
        Ok(c) => c,
        Err(CredError::InvalidToken) => {
            return FetchResult::unavailable(p, "credential file has an invalid token")
        }
        Err(_) => return FetchResult::status(p, "not_signed_in"),
    };
    if c.expires_ms.is_some_and(|e| e <= now_ms()) {
        return FetchResult {
            plan: c.plan.clone(),
            ..FetchResult::status(p, "expired")
        };
    }
    match http.get_json(
        &cfg.claude_url,
        &[("anthropic-beta", "oauth-2025-04-20")],
        &c.token,
    ) {
        Ok(raw) => projected(
            p,
            project::claude(&raw, Some(&c.token)),
            Some(&c.token),
            c.plan,
            "http",
        ),
        Err(HttpError::Unauthorized) => FetchResult {
            plan: c.plan,
            ..FetchResult::status(p, "expired")
        },
        Err(e) => FetchResult::unavailable(p, &http::describe(&e)),
    }
}

/// The page gets the projection of the response, never the response (see project.rs).
fn projected(
    p: Provider,
    v: Value,
    token: Option<&crate::safe::Secret>,
    plan: Option<String>,
    source: &'static str,
) -> FetchResult {
    match project::clean(v, token) {
        Some(raw) => FetchResult {
            plan,
            raw: Some(raw),
            source: Some(source),
            ..FetchResult::status(p, "ok")
        },
        None => FetchResult::unavailable(p, "response refused"),
    }
}

fn app_server(cfg: &Config) -> Option<Result<Value, appserver::AppServerError>> {
    cfg.codex_bin
        .as_ref()
        .map(|bin| appserver::rate_limits(bin, appserver::DEADLINE, &cfg.child_env))
}

fn fetch_codex(cfg: &Config, http: &dyn Http) -> FetchResult {
    let p = Provider::Codex;
    let Some(codex_dir) = cfg.codex_dir.as_deref() else {
        return FetchResult::unavailable(p, NO_HOME);
    };
    if !codex_dir.is_dir() && cfg.codex_bin.is_none() {
        return FetchResult::status(p, "not_installed");
    }
    let fallback = |first: Option<HttpError>| -> FetchResult {
        match app_server(cfg) {
            Some(Ok(raw)) => projected(p, project::codex(&raw, None), None, None, "app-server"),
            Some(Err(e)) => match first {
                Some(HttpError::Unauthorized) => FetchResult::status(p, "expired"),
                Some(h) => {
                    FetchResult::unavailable(p, &format!("{}; {}", http::describe(&h), e.reason()))
                }
                None => FetchResult::unavailable(p, e.reason()),
            },
            None => match first {
                Some(HttpError::Unauthorized) => FetchResult::status(p, "expired"),
                Some(h) => FetchResult::unavailable(p, &http::describe(&h)),
                None => FetchResult::status(p, "not_signed_in"),
            },
        }
    };
    let text = match creds::read_cred_file(&creds::cred_file(p, codex_dir)) {
        Ok(t) => t,
        Err(CredError::Missing) | Err(CredError::Malformed) | Err(CredError::InvalidToken) => {
            return fallback(None)
        }
        Err(CredError::Refused(why)) => return refused(p, "credentials file", why),
    };
    let c = match creds::parse_codex(&text) {
        Ok(c) => c,
        Err(CredError::InvalidToken) => {
            return FetchResult::unavailable(p, "credential file has an invalid token")
        }
        Err(_) => return fallback(None),
    };
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if let Some(id) = c.account_id.as_deref() {
        headers.push(("ChatGPT-Account-Id", id));
    }
    match http.get_json(&cfg.codex_url, &headers, &c.token) {
        Ok(raw) => projected(
            p,
            project::codex(&raw, Some(&c.token)),
            Some(&c.token),
            None,
            "http",
        ),
        Err(e) => fallback(Some(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safe::Secret;
    use std::cell::RefCell;
    use std::fs;

    type Seen = (String, Vec<(String, String)>, bool);
    struct Mock {
        reply: RefCell<Vec<Result<Value, HttpError>>>,
        seen: RefCell<Vec<Seen>>,
    }
    impl Mock {
        fn new(r: Vec<Result<Value, HttpError>>) -> Mock {
            Mock {
                reply: RefCell::new(r),
                seen: RefCell::new(vec![]),
            }
        }
    }
    impl Http for Mock {
        fn get_json(
            &self,
            url: &str,
            headers: &[(&str, &str)],
            token: &Secret,
        ) -> Result<Value, HttpError> {
            self.seen.borrow_mut().push((
                url.into(),
                headers
                    .iter()
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .collect(),
                !token.is_empty(),
            ));
            self.reply.borrow_mut().remove(0)
        }
    }

    fn cfg(os: Os, claude: &std::path::Path, codex: &std::path::Path) -> Config {
        Config {
            os,
            test_mode: true,
            claude_dir: Some(claude.into()),
            codex_dir: Some(codex.into()),
            claude_url: "http://127.0.0.1:1/c".into(),
            codex_url: "http://127.0.0.1:1/x".into(),
            codex_bin: None,
            child_env: vec![],
            use_system_proxy: false,
        }
    }

    fn claude_creds(dir: &std::path::Path, expires: i64) {
        fs::write(dir.join(".credentials.json"), format!(r#"{{"claudeAiOauth":{{"accessToken":"FAKE-t-12345","expiresAt":{expires},"subscriptionType":"max"}}}}"#)).unwrap();
    }

    #[test]
    fn claude_states() {
        let d = tempfile::tempdir().unwrap();
        let missing = d.path().join("nope");
        let m = Mock::new(vec![]);
        assert_eq!(
            fetch(Provider::Claude, &cfg(Os::Linux, &missing, &missing), &m).status,
            "not_installed"
        );
        let dir = d.path().join("c");
        fs::create_dir(&dir).unwrap();
        assert_eq!(
            fetch(Provider::Claude, &cfg(Os::Linux, &dir, &missing), &m).status,
            "not_signed_in"
        );
        let mac = fetch(Provider::Claude, &cfg(Os::Mac, &dir, &missing), &m);
        assert_eq!(mac.status, "unavailable");
        assert!(mac.reason.unwrap().contains("Keychain"));
        claude_creds(&dir, 1000); // long expired
        assert_eq!(
            fetch(Provider::Claude, &cfg(Os::Linux, &dir, &missing), &m).status,
            "expired"
        );
        assert!(
            m.seen.borrow().is_empty(),
            "an expired token is not even sent"
        );
        claude_creds(&dir, now_ms() + 3_600_000);
        let m = Mock::new(vec![Ok(
            serde_json::json!({"five_hour":{"utilization":5}, "junk": "<b>x</b>"}),
        )]);
        let r = fetch(Provider::Claude, &cfg(Os::Linux, &dir, &missing), &m);
        assert_eq!(
            (r.status, r.plan.as_deref(), r.source),
            ("ok", Some("max"), Some("http"))
        );
        assert_eq!(
            m.seen.borrow()[0].1,
            vec![("anthropic-beta".to_string(), "oauth-2025-04-20".to_string())]
        );
        let m = Mock::new(vec![Err(HttpError::Unauthorized)]);
        assert_eq!(
            fetch(Provider::Claude, &cfg(Os::Linux, &dir, &missing), &m).status,
            "expired"
        );
        let m = Mock::new(vec![Err(HttpError::Status(503))]);
        let r = fetch(Provider::Claude, &cfg(Os::Linux, &dir, &missing), &m);
        assert_eq!(
            (r.status, r.reason.as_deref()),
            ("unavailable", Some("HTTP 503"))
        );
    }

    #[test]
    fn the_result_never_contains_the_token() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("c");
        fs::create_dir(&dir).unwrap();
        claude_creds(&dir, now_ms() + 3_600_000);
        for reply in [
            Ok(serde_json::json!({"a":1})),
            Err(HttpError::Network),
            Err(HttpError::Unauthorized),
        ] {
            let r = fetch(
                Provider::Claude,
                &cfg(Os::Linux, &dir, &dir),
                &Mock::new(vec![reply]),
            );
            assert!(!format!("{r:?}").contains("FAKE-t-12345"));
            assert!(!serde_json::to_string(&r).unwrap().contains("FAKE-t-12345"));
        }
    }

    #[test]
    fn a_refused_credentials_file_is_reported_without_content() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("c");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join(".credentials.json"), vec![b'x'; 70_000]).unwrap();
        let r = fetch(
            Provider::Claude,
            &cfg(Os::Linux, &dir, &dir),
            &Mock::new(vec![]),
        );
        assert_eq!(r.status, "unavailable");
        assert_eq!(r.reason.as_deref(), Some("credentials file is too large"));
    }

    #[test]
    fn codex_http_then_fallback_rules() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("x");
        fs::create_dir(&dir).unwrap();
        let missing = d.path().join("none");
        // no token, no codex binary: not signed in
        assert_eq!(
            fetch(
                Provider::Codex,
                &cfg(Os::Linux, &missing, &dir),
                &Mock::new(vec![])
            )
            .status,
            "not_signed_in"
        );
        assert_eq!(
            fetch(
                Provider::Codex,
                &cfg(Os::Linux, &missing, &missing),
                &Mock::new(vec![])
            )
            .status,
            "not_installed"
        );
        fs::write(
            dir.join("auth.json"),
            r#"{"tokens":{"access_token":"FAKE-c-12345","account_id":"acct-9"}}"#,
        )
        .unwrap();
        let m = Mock::new(vec![Ok(serde_json::json!({"plan_type":"plus"}))]);
        let r = fetch(Provider::Codex, &cfg(Os::Linux, &missing, &dir), &m);
        assert_eq!((r.status, r.source), ("ok", Some("http")));
        assert_eq!(
            m.seen.borrow()[0].1,
            vec![("ChatGPT-Account-Id".to_string(), "acct-9".to_string())]
        );
        let r = fetch(
            Provider::Codex,
            &cfg(Os::Linux, &missing, &dir),
            &Mock::new(vec![Err(HttpError::Unauthorized)]),
        );
        assert_eq!(r.status, "expired");
        let r = fetch(
            Provider::Codex,
            &cfg(Os::Linux, &missing, &dir),
            &Mock::new(vec![Err(HttpError::Status(500))]),
        );
        assert_eq!(
            (r.status, r.reason.as_deref()),
            ("unavailable", Some("HTTP 500"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_falls_back_to_the_app_server() {
        let _g = crate::appserver::testlock::take();
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("x");
        fs::create_dir(&dir).unwrap();
        let bin = d.path().join("codex");
        fs::write(&bin, "#!/bin/sh\nprintf '%s\\n%s\\n' '{\"id\":1,\"result\":{}}' '{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":12}}}}'\nsleep 30\n").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let mut c = cfg(Os::Linux, &dir, &dir);
        c.codex_bin = Some(bin);
        // no auth file at all: straight to the app server
        let r = fetch(Provider::Codex, &c, &Mock::new(vec![]));
        assert_eq!((r.status, r.source), ("ok", Some("app-server")));
        assert_eq!(r.raw.unwrap()["rateLimits"]["primary"]["usedPercent"], 12.0);
        // http fails with a 500: the app server still answers
        fs::write(
            dir.join("auth.json"),
            r#"{"tokens":{"access_token":"FAKE-c-12345"}}"#,
        )
        .unwrap();
        let r = fetch(
            Provider::Codex,
            &c,
            &Mock::new(vec![Err(HttpError::Status(500))]),
        );
        assert_eq!(r.source, Some("app-server"));
    }

    #[test]
    fn overrides_are_honoured_only_in_test_mode() {
        let env = |pairs: Vec<(&'static str, &'static str)>| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(a, _)| *a == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        // ANY existing regular file will do as the stand-in program (this test only checks WHEN the override is honoured)
        let stand_in: &'static str = Box::leak(
            std::env::current_exe()
                .unwrap()
                .display()
                .to_string()
                .into_boxed_str(),
        );
        let hostile = vec![
            ("USAGEBAR_API_BASE_CLAUDE", "http://127.0.0.1:9999"),
            ("USAGEBAR_API_BASE_CODEX", "http://127.0.0.1:9998"),
            ("USAGEBAR_CODEX_BIN", stand_in),
            ("HOME", "/h"),
        ];
        let c = Config::from_env(Os::Linux, &env(hostile.clone()), &RustSettings::default());
        assert_eq!(c.claude_url, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(c.codex_url, "https://chatgpt.com/backend-api/wham/usage");
        assert_eq!(c.codex_bin, None);
        assert!(!c.test_mode);
        let mut t = hostile.clone();
        t.push(("USAGEBAR_TEST", "1"));
        let c = Config::from_env(Os::Linux, &env(t), &RustSettings::default());
        assert_eq!(c.claude_url, "http://127.0.0.1:9999/api/oauth/usage");
        assert_eq!(c.codex_url, "http://127.0.0.1:9998/backend-api/wham/usage");
        assert_eq!(c.codex_bin, Some(PathBuf::from(stand_in)));
        // even in test mode only loopback http is accepted
        let c = Config::from_env(
            Os::Linux,
            &env(vec![
                ("USAGEBAR_TEST", "1"),
                ("USAGEBAR_API_BASE_CLAUDE", "https://evil.example"),
            ]),
            &RustSettings::default(),
        );
        assert_eq!(c.claude_url, "https://api.anthropic.com/api/oauth/usage");
        let c = Config::from_env(
            Os::Linux,
            &env(vec![
                ("USAGEBAR_TEST", "yes"),
                ("USAGEBAR_API_BASE_CLAUDE", "http://127.0.0.1:5"),
            ]),
            &RustSettings::default(),
        );
        assert_eq!(c.claude_url, "https://api.anthropic.com/api/oauth/usage");
    }

    #[test]
    fn no_home_folder_means_unavailable_never_the_current_folder() {
        // a cred file in the current folder must NOT be picked up when there is no home
        let c = Config::from_env(Os::Linux, &|_: &str| None, &RustSettings::default());
        assert_eq!(c.claude_dir, None);
        assert_eq!(c.codex_dir, None);
        assert_eq!(c.codex_bin, None);
        for p in [Provider::Claude, Provider::Codex] {
            let m = Mock::new(vec![]);
            let r = fetch(p, &c, &m);
            assert_eq!(r.status, "unavailable", "{p:?}");
            assert!(r.reason.unwrap().contains("home folder"));
        }
        // an explicit override still works without a home
        let c = Config::from_env(
            Os::Linux,
            &|k: &str| (k == "CLAUDE_CONFIG_DIR").then(|| "/c".to_string()),
            &RustSettings::default(),
        );
        assert_eq!(c.claude_dir, Some(PathBuf::from("/c")));
    }
}
