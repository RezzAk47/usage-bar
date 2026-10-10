//! Read-only access to the credential files of Claude Code and Codex, with the checks a secret file deserves:
//! a regular file (never a link), owned by this user, at most 64 KB, opened without following links.
//! Tokens are returned as `Secret`; this module never refreshes or writes anything.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::datadir::Os;
use crate::safe::Secret;

pub const MAX_CRED_BYTES: u64 = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum CredError {
    Missing,
    /// The file exists but must not be used; the text says why (a fixed phrase, never file content).
    Refused(&'static str),
    Malformed,
    /// A token is there but cannot be an HTTP credential (spaces, control or non-ASCII characters, wrong length).
    InvalidToken,
}

/// Visible ASCII only (`!` to `~`), 8 to 4096 characters: no spaces, tabs, line breaks, NUL or non-ASCII, so a token can never
/// split a header or smuggle another one.
pub fn valid_token(t: &str) -> bool {
    (8..=4096).contains(&t.len()) && t.bytes().all(|b| (0x21..=0x7E).contains(&b))
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// "2026-10-07T17:19:00.123Z" / "+02:00" to epoch milliseconds. None for anything else.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if s.len() < 19 || s.len() > 40 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut frac_ms = 0;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        frac_ms = format!("{digits:0<3}")[..3].parse::<i64>().ok()?;
        rest = &r[digits.len()..];
    }
    let off = match rest {
        "" | "Z" | "z" => 0,
        o if (o.starts_with('+') || o.starts_with('-')) && o.len() >= 3 => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            let d = o[1..].replace(':', "");
            let (oh, om) = (d.get(0..2)?.parse::<i64>().ok()?, d.get(2..4).map_or(Some(0), |x| x.parse::<i64>().ok())?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 3600 + om * 60)
        }
        _ => return None,
    };
    Some(((days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec - off) * 1000) + frac_ms)
}

/// `expiresAt` as epoch milliseconds. Numbers below 1e11 are seconds, below 1e14 milliseconds; numeric strings and ISO strings
/// are read too. Anything else (or a value that makes no sense) is None: "no expiry information", and the request decides (401).
pub fn parse_expiry(v: &serde_json::Value) -> Option<i64> {
    let from_number = |f: f64| -> Option<i64> {
        if !f.is_finite() || f <= 0.0 {
            None
        } else if f < 1e11 {
            Some((f * 1000.0) as i64)
        } else if f < 1e14 {
            Some(f as i64)
        } else {
            None
        }
    };
    match v {
        serde_json::Value::Number(n) => from_number(n.as_f64()?),
        serde_json::Value::String(s) => {
            let t = s.trim();
            t.parse::<f64>().ok().and_then(from_number).or_else(|| parse_iso_ms(t))
        }
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            _ => None,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

/// Where the provider's config folder is. Order: USAGEBAR_<X>_DIR (tests and manual runs), the tool's own variable
/// (CLAUDE_CONFIG_DIR, CODEX_HOME), then `~/.claude` / `~/.codex`.
pub fn config_dir(p: Provider, env: &dyn Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    let (own, tool, sub) = match p {
        Provider::Claude => ("USAGEBAR_CLAUDE_DIR", "CLAUDE_CONFIG_DIR", ".claude"),
        Provider::Codex => ("USAGEBAR_CODEX_DIR", "CODEX_HOME", ".codex"),
    };
    for name in [own, tool] {
        if let Some(v) = env(name) {
            if !v.trim().is_empty() {
                return PathBuf::from(v);
            }
        }
    }
    Path::new(home).join(sub)
}

pub fn cred_file(p: Provider, dir: &Path) -> PathBuf {
    match p {
        Provider::Claude => dir.join(".credentials.json"),
        Provider::Codex => dir.join("auth.json"),
    }
}

#[cfg(unix)]
fn owned_by_me(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions
    m.uid() == unsafe { libc::geteuid() }
}
#[cfg(not(unix))]
fn owned_by_me(_m: &fs::Metadata) -> bool {
    true // std has no owner query on Windows; the file lives in the user's profile and the other checks still apply
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}
#[cfg(not(unix))]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len()
}

/// The text of a credential file, after the safety checks. Never follows a link, never reads more than 64 KB.
pub fn read_cred_file(path: &Path) -> Result<String, CredError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CredError::Missing),
        Err(_) => return Err(CredError::Refused("cannot be inspected")),
    };
    if meta.file_type().is_symlink() {
        return Err(CredError::Refused("is a link"));
    }
    if !meta.is_file() {
        return Err(CredError::Refused("is not a regular file"));
    }
    if meta.len() > MAX_CRED_BYTES {
        return Err(CredError::Refused("is too large"));
    }
    if !owned_by_me(&meta) {
        return Err(CredError::Refused("belongs to another user"));
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path).map_err(|_| CredError::Refused("cannot be opened"))?;
    // the file we opened must be the file we checked (a swap between the check and the open is refused)
    match file.metadata() {
        Ok(m) if m.is_file() && same_file(&m, &meta) => {}
        _ => return Err(CredError::Refused("changed while being opened")),
    }
    let mut bytes = Vec::new();
    file.take(MAX_CRED_BYTES + 1).read_to_end(&mut bytes).map_err(|_| CredError::Refused("cannot be read"))?;
    if bytes.len() as u64 > MAX_CRED_BYTES {
        return Err(CredError::Refused("is too large"));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes).to_vec();
    String::from_utf8(bytes).map_err(|_| CredError::Malformed)
}

#[derive(Debug)]
pub struct ClaudeCreds {
    pub token: Secret,
    /// Milliseconds since the epoch, when the file says.
    pub expires_ms: Option<i64>,
    pub plan: Option<String>,
}

#[derive(Debug)]
pub struct CodexCreds {
    pub token: Secret,
    pub account_id: Option<String>,
}

fn plain_label(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.len() <= 30 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-')).then(|| t.to_string())
}

/// `{"claudeAiOauth": {"accessToken": "...", "expiresAt": <ms>, "subscriptionType": "max"}}` (the format Claude Code writes).
pub fn parse_claude(text: &str) -> Result<ClaudeCreds, CredError> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| CredError::Malformed)?;
    let o = v.get("claudeAiOauth").and_then(|x| x.as_object()).ok_or(CredError::Malformed)?;
    let token = o.get("accessToken").and_then(|x| x.as_str()).ok_or(CredError::Malformed)?;
    if !valid_token(token) {
        return Err(CredError::InvalidToken);
    }
    Ok(ClaudeCreds {
        token: Secret::new(token.to_string()),
        expires_ms: o.get("expiresAt").and_then(parse_expiry),
        plan: o.get("subscriptionType").and_then(|x| x.as_str()).and_then(plain_label),
    })
}

/// `{"tokens": {"access_token": "...", "account_id": "..."}}` (the format Codex writes with ChatGPT sign-in).
pub fn parse_codex(text: &str) -> Result<CodexCreds, CredError> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|_| CredError::Malformed)?;
    let t = v.get("tokens").and_then(|x| x.as_object()).ok_or(CredError::Malformed)?;
    let token = t.get("access_token").and_then(|x| x.as_str()).ok_or(CredError::Malformed)?;
    if !valid_token(token) {
        return Err(CredError::InvalidToken);
    }
    let account_id = t.get("account_id").and_then(|x| x.as_str()).filter(|a| !a.is_empty() && a.len() <= 128 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).map(str::to_string);
    Ok(CodexCreds { token: Secret::new(token.to_string()), account_id })
}

/// The home folder: the ONE place this is decided (the data folder, the config folders and the codex search all use it).
/// Windows: USERPROFILE, then HOMEDRIVE + HOMEPATH, and HOME only when both are missing. Unix: HOME. Last resort ".".
pub fn home_for(os: Os, env: &dyn Fn(&str) -> Option<String>) -> String {
    let get = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    if os == Os::Windows {
        if let Some(p) = get("USERPROFILE") {
            return p;
        }
        if let (Some(d), Some(p)) = (get("HOMEDRIVE"), get("HOMEPATH")) {
            return format!("{d}{p}");
        }
    }
    get("HOME").unwrap_or_else(|| ".".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: std::collections::HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn config_dir_order() {
        assert_eq!(config_dir(Provider::Claude, &env(&[]), "/h"), PathBuf::from("/h/.claude"));
        assert_eq!(config_dir(Provider::Codex, &env(&[]), "/h"), PathBuf::from("/h/.codex"));
        assert_eq!(config_dir(Provider::Claude, &env(&[("CLAUDE_CONFIG_DIR", "/c")]), "/h"), PathBuf::from("/c"));
        assert_eq!(config_dir(Provider::Claude, &env(&[("CLAUDE_CONFIG_DIR", "/c"), ("USAGEBAR_CLAUDE_DIR", "/t")]), "/h"), PathBuf::from("/t"));
        assert_eq!(config_dir(Provider::Codex, &env(&[("CODEX_HOME", "/x"), ("USAGEBAR_CODEX_DIR", "  ")]), "/h"), PathBuf::from("/x"));
    }

    #[test]
    fn home_precedence_per_platform() {
        let e = |pairs: Vec<(&'static str, &'static str)>| move |k: &str| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string());
        let all = vec![("USERPROFILE", "C:\\Users\\a"), ("HOMEDRIVE", "D:"), ("HOMEPATH", "\\h"), ("HOME", "/msys/home/a")];
        assert_eq!(home_for(Os::Windows, &e(all.clone())), "C:\\Users\\a");
        assert_eq!(home_for(Os::Windows, &e(vec![("HOMEDRIVE", "D:"), ("HOMEPATH", "\\h"), ("HOME", "/m")])), "D:\\h");
        assert_eq!(home_for(Os::Windows, &e(vec![("HOME", "/m")])), "/m");
        assert_eq!(home_for(Os::Windows, &e(vec![("USERPROFILE", "  "), ("HOME", "/m")])), "/m");
        assert_eq!(home_for(Os::Windows, &e(vec![])), ".");
        for os in [Os::Linux, Os::Mac] {
            assert_eq!(home_for(os, &e(all.clone())), "/msys/home/a", "Unix ignores USERPROFILE");
            assert_eq!(home_for(os, &e(vec![("USERPROFILE", "C:\\x")])), ".");
        }
    }

    #[test]
    fn parses_the_two_formats() {
        let c = parse_claude(r#"{"claudeAiOauth":{"accessToken":"t0k-12345","expiresAt":1900000000000,"subscriptionType":"max"}}"#).unwrap();
        assert_eq!((c.token.expose(), c.expires_ms, c.plan.as_deref()), ("t0k-12345", Some(1900000000000), Some("max")));
        assert!(parse_claude(r#"{"claudeAiOauth":{}}"#).is_err());
        assert!(parse_claude("not json").is_err());
        assert_eq!(parse_claude(r#"{"claudeAiOauth":{"accessToken":"t0k-12345","subscriptionType":"<script>"}}"#).unwrap().plan, None);
        let d = parse_codex(r#"{"tokens":{"access_token":"abc-12345","account_id":"acct-1"}}"#).unwrap();
        assert_eq!((d.token.expose(), d.account_id.as_deref()), ("abc-12345", Some("acct-1")));
        assert!(parse_codex(r#"{"OPENAI_API_KEY":"x"}"#).is_err());
        assert_eq!(parse_codex(r#"{"tokens":{"access_token":"a-1234567","account_id":"bad id!"}}"#).unwrap().account_id, None);
    }

    fn claude_with(token: &str) -> String {
        serde_json::json!({"claudeAiOauth": {"accessToken": token}}).to_string()
    }

    #[test]
    fn token_validation_rejects_anything_that_is_not_visible_ascii_of_sane_length() {
        for bad in ["abc\r\nX-Evil: 1", "abc\nX-Evil: 1", "abcdefgh ijk", "ab\0cdefgh", "abc\tdefgh", "tok\u{e9}n12345", "\u{0430}bcdefghij", " abcdefgh", "abcdefgh ", "short", "", &"a".repeat(4097)] {
            assert_eq!(parse_claude(&claude_with(bad)).unwrap_err(), CredError::InvalidToken, "{bad:?}");
            assert!(parse_codex(&serde_json::json!({"tokens": {"access_token": bad}}).to_string()).is_err());
        }
        for good in ["abcdefgh", &"a".repeat(4096), "sk-ant-oat01-AbC_d.e/f+g=", "!~#$%&'*"] {
            assert!(parse_claude(&claude_with(good)).is_ok(), "{good:?}");
        }
        assert_eq!(parse_claude(r#"{"claudeAiOauth":{"accessToken":5}}"#).unwrap_err(), CredError::Malformed);
    }

    #[test]
    fn expiry_seconds_milliseconds_strings_iso_and_junk() {
        use serde_json::json;
        assert_eq!(parse_expiry(&json!(1900000000)), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!(1900000000000i64)), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!(1900000000.5)), Some(1_900_000_000_500));
        assert_eq!(parse_expiry(&json!("1900000000")), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!("1900000000000")), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!("2030-03-17T17:46:40Z")), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!("2030-03-17T17:46:40.250Z")), Some(1_900_000_000_250));
        assert_eq!(parse_expiry(&json!("2030-03-17T19:46:40+02:00")), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!("2030-03-17T10:46:40-07:00")), Some(1_900_000_000_000));
        assert_eq!(parse_expiry(&json!("2030-03-17T17:46:40.123456789Z")), Some(1_900_000_000_123));
        for junk in [json!(null), json!(true), json!("soon"), json!(0), json!(-5), json!(1e20), json!(1e15), json!([1]), json!({}), json!("2030-13-01T00:00:00Z"), json!("")] {
            assert_eq!(parse_expiry(&junk), None, "{junk}");
        }
    }

    #[test]
    fn errors_never_contain_file_content() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(".credentials.json");
        fs::write(&p, "SECRETCONTENT{").unwrap();
        let t = read_cred_file(&p).unwrap();
        let e = parse_claude(&t).unwrap_err();
        assert!(!format!("{e:?}").contains("SECRET"));
    }

    #[test]
    fn missing_big_dir_and_bad_utf8() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_cred_file(&d.path().join("nope.json")), Err(CredError::Missing));
        assert_eq!(read_cred_file(d.path()), Err(CredError::Refused("is not a regular file")));
        let big = d.path().join("big.json");
        fs::write(&big, vec![b' '; (MAX_CRED_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_cred_file(&big), Err(CredError::Refused("is too large")));
        let ok = d.path().join("edge.json");
        fs::write(&ok, vec![b' '; MAX_CRED_BYTES as usize]).unwrap();
        assert!(read_cred_file(&ok).is_ok());
        let bad = d.path().join("bad.json");
        fs::write(&bad, [0xFF, 0xFE, 0x00]).unwrap();
        assert_eq!(read_cred_file(&bad), Err(CredError::Malformed));
        let bom = d.path().join("bom.json");
        fs::write(&bom, b"\xEF\xBB\xBF{}").unwrap();
        assert_eq!(read_cred_file(&bom).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_refused_even_to_a_valid_file() {
        let d = tempfile::tempdir().unwrap();
        let real = d.path().join("real.json");
        fs::write(&real, r#"{"tokens":{"access_token":"a-1234567"}}"#).unwrap();
        let link = d.path().join("auth.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read_cred_file(&link), Err(CredError::Refused("is a link")));
        let dangling = d.path().join("dangling.json");
        std::os::unix::fs::symlink(d.path().join("gone"), &dangling).unwrap();
        assert_eq!(read_cred_file(&dangling), Err(CredError::Refused("is a link")));
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_and_a_file_of_another_user_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("fifo.json");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(read_cred_file(&fifo), Err(CredError::Refused("is not a regular file")));
        // /etc/hosts is a regular file owned by root: refused unless we are root
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(read_cred_file(Path::new("/etc/hosts")), Err(CredError::Refused("belongs to another user")));
        }
    }
}
