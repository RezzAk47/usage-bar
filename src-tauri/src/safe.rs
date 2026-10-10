//! Keeping secrets out of everything: a token wrapper that cannot be printed, error-text scrubbing, exact-match redaction.

use std::fmt;

/// A token. No `Display`, `Clone` or `Serialize`; `Debug` prints a placeholder; the bytes are overwritten on drop (best effort).
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Secret {
        Secret(s)
    }
    /// The only way to read it: used for the Authorization header and nothing else.
    pub fn expose(&self) -> &str {
        &self.0
    }
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY-free best effort: overwrite with zeros through the String's bytes
        let mut v = std::mem::take(&mut self.0).into_bytes();
        for b in v.iter_mut() {
            *b = 0;
        }
        std::hint::black_box(&v);
    }
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '=' | '+' | '/')
}

/// Error and status text that is safe to log or show: `Bearer ...` and any run of 24 or more token characters become
/// `[redacted]`, control characters become spaces, and the result is cut to `max` characters.
pub fn scrub(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max + 16));
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.chars().count() >= 24 {
            out.push_str("[redacted]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if token_char(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            if is_format_control(c) {
                continue;
            }
            out.push(if c.is_control() { ' ' } else { c });
        }
    }
    flush(&mut run, &mut out);
    // "Bearer xyz" with a short token is still a credential shape
    let mut cleaned = String::new();
    let mut words = out.split(' ').peekable();
    while let Some(w) = words.next() {
        if w.eq_ignore_ascii_case("bearer") && words.peek().is_some() {
            cleaned.push_str("Bearer [redacted]");
            words.next();
        } else {
            cleaned.push_str(w);
        }
        if words.peek().is_some() {
            cleaned.push(' ');
        }
    }
    if cleaned.chars().count() > max {
        let cut: String = cleaned.chars().take(max).collect();
        format!("{cut}…")
    } else {
        cleaned
    }
}

/// Characters that are invisible or reorder text (format controls, bidi overrides, zero-width, line/paragraph separators).
fn is_format_control(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{2028}' | '\u{2029}' | '\u{00AD}' | '\u{061C}' | '\u{180E}')
}

/// Text from outside (provider responses, labels) made safe to show or put in a notification or tray title: every control and
/// format-control character is removed, and the result is cut to `max` characters.
pub fn strip_display(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !is_format_control(*c))
        .take(max)
        .collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(data: &[u8], url: bool, pad: bool) -> String {
    let mut out = String::new();
    for ch in data.chunks(3) {
        let n = (ch[0] as u32) << 16
            | (*ch.get(1).unwrap_or(&0) as u32) << 8
            | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                let c = B64[((n >> (18 - 6 * i)) & 63) as usize] as char;
                out.push(if url {
                    match c {
                        '+' => '-',
                        '/' => '_',
                        x => x,
                    }
                } else {
                    c
                });
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn percent(text: &str, upper: bool) -> String {
    let mut o = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else if upper {
            o.push_str(&format!("%{b:02X}"));
        } else {
            o.push_str(&format!("%{b:02x}"));
        }
    }
    o
}

fn u_escaped(text: &str) -> String {
    text.encode_utf16().map(|u| format!("\\u{u:04x}")).collect()
}

/// Every form in which a token could come back inside a response: raw, JSON-escaped, fully \uXXXX-escaped (both hex cases),
/// base64 and base64url (padded or not, with and without the "Bearer " prefix), percent-encoded, and reversed.
pub fn encodings(token: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for base in [token.to_string(), format!("Bearer {token}")] {
        v.push(base.clone());
        v.push(
            serde_json::to_string(&base)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
        );
        let u = u_escaped(&base);
        v.push(u.to_uppercase().replace("\\U", "\\u"));
        v.push(u);
        for url in [false, true] {
            for pad in [false, true] {
                v.push(base64(base.as_bytes(), url, pad));
            }
        }
        v.push(percent(&base, true));
        v.push(percent(&base, false));
    }
    v.push(token.chars().rev().collect());
    v.retain(|e| e.len() >= 4);
    v.sort();
    v.dedup();
    v
}

/// Does `text` carry the token in any encoding? For tokens of 24 or more characters, any 8-character piece of the token also counts.
pub fn leaks_token(text: &str, secret: &Secret, windows: bool) -> bool {
    let t = secret.expose();
    if t.len() < 4 {
        return false;
    }
    if encodings(t).iter().any(|e| text.contains(e.as_str())) {
        return true;
    }
    if windows && t.len() >= 24 && t.is_ascii() {
        let b = t.as_bytes();
        return (0..=b.len() - 8).any(|i| text.contains(&t[i..i + 8]));
    }
    false
}

/// Replaces every occurrence of the exact token in `text` (a provider that echoes our header back must not reach the page).
pub fn redact_exact(text: &str, secret: &Secret) -> String {
    let s = secret.expose();
    if s.len() < 4 {
        return text.to_string();
    }
    text.replace(s, "[redacted]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_strings_lose_bidi_and_zero_width_controls() {
        assert_eq!(
            strip_display("a\u{202E}b\u{200B}c\u{FEFF}d\u{2028}e\u{7}f\u{2066}g", 50),
            "abcdefg"
        );
        assert_eq!(strip_display(&"x".repeat(100), 40).chars().count(), 40);
        assert_eq!(scrub("ok\u{202E}evil", 50), "okevil");
    }

    #[test]
    fn a_token_is_found_in_every_encoding() {
        let tok = "FAKE+CLAUDE/TOK<en>\\q\"-c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
        let s = Secret::new(tok.into());
        for e in encodings(tok) {
            assert!(leaks_token(&format!("x {e} y"), &s, false), "{e}");
        }
        assert!(
            leaks_token(&format!("..{}..", &tok[3..11]), &s, true),
            "an 8-character piece of a long token"
        );
        assert!(!leaks_token(&format!("..{}..", &tok[3..11]), &s, false));
        assert!(!leaks_token("five_hour utilization 85.0", &s, true));
        assert!(!leaks_token("anything", &Secret::new("abc".into()), true));
    }

    #[test]
    fn scrub_removes_token_shapes() {
        assert_eq!(scrub("Bearer abc.def", 100), "Bearer [redacted]");
        assert_eq!(
            scrub("x sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA y", 100),
            "x [redacted] y"
        );
        assert_eq!(scrub("a\nb\u{0}c", 100), "a b c");
        assert_eq!(scrub("HTTP 503", 100), "HTTP 503");
        assert!(scrub(&"z".repeat(500), 30).chars().count() <= 31);
        assert_eq!(
            scrub(
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
                100
            ),
            "[redacted]"
        );
    }

    #[test]
    fn debug_never_shows_the_value() {
        let s = Secret::new("super-secret-token-value-123456".into());
        assert_eq!(format!("{s:?}"), "Secret([redacted])");
        assert!(!format!("{:?}", Some(&s)).contains("super"));
    }

    #[test]
    fn exact_redaction() {
        let s = Secret::new("tok_ABCDEFGH".into());
        assert_eq!(
            redact_exact("{\"echo\":\"Bearer tok_ABCDEFGH\"}", &s),
            "{\"echo\":\"Bearer [redacted]\"}"
        );
        assert_eq!(redact_exact("nothing here", &s), "nothing here");
    }
}
