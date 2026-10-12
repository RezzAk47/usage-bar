//! The only network code in the app. One GET that returns JSON, with every limit spelled out:
//! - https only (plain http to 127.0.0.1 is allowed ONLY in test mode, `USAGEBAR_TEST=1`),
//! - certificate verification on (rustls with the bundled web PKI roots; there is no option to turn it off),
//! - no redirects at all (a 3xx is an error: a token must never follow a redirect to another host),
//! - 15 s for the whole request, 1 MB for the body, JSON nesting depth at most 12,
//! - the Authorization header is built here and never logged, printed or put in an error text.
//!
//! Environment proxies (HTTPS_PROXY ...) are IGNORED unless the user turns on "Use system proxy settings" in Settings.

use std::io::Read;
use std::time::Duration;

use serde_json::Value;

use crate::safe::{redact_exact, scrub, Secret};

pub const TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_BODY: u64 = 1_048_576;
pub const MAX_DEPTH: usize = 12;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum HttpError {
    Unauthorized,
    Status(u16),
    Redirect(u16),
    Timeout,
    TooLarge,
    BadJson,
    TooDeep,
    Network,
    NotAllowed,
}

impl HttpError {
    /// Short text for the 'usage unavailable (...)' note. Fixed phrases only: nothing from the server or the request.
    pub fn reason(&self) -> String {
        match self {
            HttpError::Unauthorized => "not authorised".into(),
            HttpError::Status(c) => format!("HTTP {c}"),
            HttpError::Redirect(c) => format!("unexpected redirect {c}"),
            HttpError::Timeout => "timeout".into(),
            HttpError::TooLarge => "response too large".into(),
            HttpError::BadJson => "unreadable response".into(),
            HttpError::TooDeep => "response too deeply nested".into(),
            HttpError::Network => "network error".into(),
            HttpError::NotAllowed => "address not allowed".into(),
        }
    }
}

/// What the rest of the app needs from the network (a mock in tests, `UreqHttp` for real).
pub trait Http {
    fn get_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        token: &Secret,
    ) -> Result<Value, HttpError>;
}

pub fn json_depth(v: &Value) -> usize {
    match v {
        Value::Array(a) => 1 + a.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(o) => 1 + o.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// Parses a response body: size and depth capped, anything that is not JSON is an error. The exact token is redacted from
/// the text first, so a server that echoes our header cannot hand it to the page.
pub fn parse_body(bytes: &[u8], token: &Secret) -> Result<Value, HttpError> {
    if bytes.len() as u64 > MAX_BODY {
        return Err(HttpError::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| HttpError::BadJson)?;
    let text = redact_exact(text, token);
    let v: Value = serde_json::from_str(&text).map_err(|_| HttpError::BadJson)?;
    if json_depth(&v) > MAX_DEPTH {
        return Err(HttpError::TooDeep);
    }
    Ok(v)
}

/// The two hosts the app talks to, and (test mode only) a loopback server. Anything else is refused before a socket opens.
pub fn url_allowed(url: &str, test_mode: bool) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.contains('@') {
            return false; // user info before the host is a classic way to point a trusted-looking URL elsewhere
        }
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        return (host == "api.anthropic.com" || host == "chatgpt.com")
            && (port.is_empty() || port == "443");
    }
    if test_mode {
        if let Some(rest) = url.strip_prefix("http://127.0.0.1:") {
            return rest.chars().next().is_some_and(|c| c.is_ascii_digit());
        }
    }
    false
}

pub struct UreqHttp {
    agent: ureq::Agent,
    test_mode: bool,
}

impl UreqHttp {
    #[cfg(test)]
    pub fn new(test_mode: bool) -> UreqHttp {
        UreqHttp::with_timeout(test_mode, TIMEOUT)
    }

    #[cfg(test)]
    pub fn with_timeout(test_mode: bool, timeout: Duration) -> UreqHttp {
        UreqHttp::build(test_mode, timeout, false)
    }

    /// `use_system_proxy` comes from settings.json (read by Rust itself), default false.
    pub fn with_proxy(test_mode: bool, use_system_proxy: bool) -> UreqHttp {
        UreqHttp::build(test_mode, TIMEOUT, use_system_proxy)
    }

    fn build(test_mode: bool, timeout: Duration, use_system_proxy: bool) -> UreqHttp {
        // An environment proxy would see the connection (and, for plain http, the token): off unless asked for.
        let proxy = if use_system_proxy {
            ureq::Proxy::try_from_env()
        } else {
            None
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .max_redirects(0)
            .max_redirects_will_error(false)
            .https_only(!test_mode)
            .http_status_as_error(false)
            .proxy(proxy)
            .user_agent("usage-bar/0.1")
            .build()
            .into();
        UreqHttp { agent, test_mode }
    }
}

fn map_err(e: &ureq::Error) -> HttpError {
    match e {
        ureq::Error::Timeout(_) => HttpError::Timeout,
        _ => HttpError::Network,
    }
}

impl Http for UreqHttp {
    fn get_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        token: &Secret,
    ) -> Result<Value, HttpError> {
        if !url_allowed(url, self.test_mode) {
            return Err(HttpError::NotAllowed);
        }
        let mut req = self.agent.get(url).header("Accept", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        // built here, handed to ureq, dropped at the end of this function; never formatted into any text
        let auth = format!("Bearer {}", token.expose());
        req = req.header("Authorization", auth.as_str());
        let resp = req.call().map_err(|e| map_err(&e))?;
        let code = resp.status().as_u16();
        match code {
            200..=299 => {}
            401 => return Err(HttpError::Unauthorized),
            300..=399 => return Err(HttpError::Redirect(code)),
            _ => return Err(HttpError::Status(code)),
        }
        let mut body = Vec::new();
        resp.into_body()
            .into_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut body)
            .map_err(|e| {
                // ureq reports a body that stalls past the deadline as an io::Error wrapping its own Timeout error
                let wrapped_timeout = e
                    .get_ref()
                    .and_then(|x| x.downcast_ref::<ureq::Error>())
                    .is_some_and(|x| matches!(x, ureq::Error::Timeout(_)));
                if e.kind() == std::io::ErrorKind::TimedOut || wrapped_timeout {
                    HttpError::Timeout
                } else {
                    HttpError::Network
                }
            })?;
        parse_body(&body, token)
    }
}

/// For logs: scrubbed.
pub fn describe(e: &HttpError) -> String {
    scrub(&e.reason(), 80)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn tok() -> Secret {
        Secret::new("FAKE-TOKEN-1234567890-abcdefghij".into())
    }

    #[test]
    fn urls_are_checked_before_any_socket() {
        assert!(url_allowed(
            "https://api.anthropic.com/api/oauth/usage",
            false
        ));
        assert!(url_allowed(
            "https://chatgpt.com/backend-api/wham/usage",
            false
        ));
        for bad in [
            "http://api.anthropic.com/x",
            "https://evil.example/x",
            "https://api.anthropic.com.evil.example/x",
            "https://chatgpt.com@evil.example/x",
            "ftp://x",
            "http://127.0.0.1:1/x",
            "file:///etc/passwd",
            "",
            "https://api.anthropic.com:443@evil/x",
        ] {
            assert!(!url_allowed(bad, false), "{bad}");
        }
        assert!(url_allowed("http://127.0.0.1:5000/x", true));
        assert!(!url_allowed("http://localhost:5000/x", true));
        assert!(!url_allowed("http://127.0.0.1.evil.example:5000/x", true));
        assert!(!url_allowed("http://127.0.0.1/x", true));
        assert!(!url_allowed("https://evil.example", true));
    }

    #[test]
    fn body_caps_and_depth() {
        assert!(parse_body(b"{\"a\":1}", &tok()).is_ok());
        assert_eq!(
            parse_body(&vec![b' '; (MAX_BODY + 1) as usize], &tok()),
            Err(HttpError::TooLarge)
        );
        assert_eq!(parse_body(b"not json", &tok()), Err(HttpError::BadJson));
        assert_eq!(parse_body(&[0xFF, 0xFE], &tok()), Err(HttpError::BadJson));
        let deep = format!("{}1{}", "[".repeat(40), "]".repeat(40));
        assert_eq!(parse_body(deep.as_bytes(), &tok()), Err(HttpError::TooDeep));
        let ok = format!("{}1{}", "[".repeat(10), "]".repeat(10));
        assert!(parse_body(ok.as_bytes(), &tok()).is_ok());
        let way_deep = format!("{}1{}", "[".repeat(100_000), "]".repeat(100_000));
        assert!(
            parse_body(way_deep.as_bytes(), &tok()).is_err(),
            "no stack overflow"
        );
    }

    #[test]
    fn an_echoed_token_never_reaches_the_caller() {
        let body = format!("{{\"echo\":\"Bearer {}\",\"x\":1}}", tok().expose());
        let v = parse_body(body.as_bytes(), &tok()).unwrap();
        assert!(!v.to_string().contains("FAKE-TOKEN"));
    }

    /// One-shot server on 127.0.0.1: reads the request, answers with `reply`, returns the raw request text.
    fn serve(reply: Vec<u8>) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/x", l.local_addr().unwrap().port());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let _ = s.write_all(&reply);
            let _ = s.flush();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (url, h)
    }

    fn reply(status: &str, extra: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len()).into_bytes()
    }

    #[test]
    fn real_request_against_a_local_fake_server() {
        let (url, h) = serve(reply(
            "200 OK",
            "",
            "{\"five_hour\":{\"utilization\":12.5}}",
        ));
        let v = UreqHttp::new(true)
            .get_json(&url, &[("anthropic-beta", "oauth-2025-04-20")], &tok())
            .unwrap();
        assert_eq!(v["five_hour"]["utilization"], 12.5);
        let req = h.join().unwrap().to_lowercase();
        assert!(req.starts_with("get /x"));
        assert!(req.contains("authorization: bearer fake-token-1234567890-abcdefghij"));
        assert!(req.contains("anthropic-beta: oauth-2025-04-20"));
    }

    #[test]
    fn statuses_redirects_and_junk() {
        for (status, extra, want) in [
            ("401 Unauthorized", "", HttpError::Unauthorized),
            ("503 Service Unavailable", "", HttpError::Status(503)),
            ("429 Too Many Requests", "", HttpError::Status(429)),
            (
                "302 Found",
                "Location: https://evil.example/steal\r\n",
                HttpError::Redirect(302),
            ),
        ] {
            let (url, h) = serve(reply(status, extra, "{}"));
            assert_eq!(
                UreqHttp::new(true).get_json(&url, &[], &tok()),
                Err(want.clone()),
                "{status}"
            );
            let _ = h.join();
        }
        let (url, h) = serve(reply("200 OK", "", "<html>nope</html>"));
        assert_eq!(
            UreqHttp::new(true).get_json(&url, &[], &tok()),
            Err(HttpError::BadJson)
        );
        let _ = h.join();
    }

    #[test]
    fn a_response_over_one_megabyte_is_refused() {
        let big = format!("[{}]", "1,".repeat(600_000));
        let (url, h) = serve(reply("200 OK", "", &big));
        assert_eq!(
            UreqHttp::new(true).get_json(&url, &[], &tok()),
            Err(HttpError::TooLarge)
        );
        let _ = h.join();
    }

    #[test]
    fn a_server_that_never_answers_times_out_or_fails_fast_when_closed() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/x", l.local_addr().unwrap().port());
        drop(l); // nothing listens: connection refused
        assert_eq!(
            UreqHttp::new(true).get_json(&url, &[], &tok()),
            Err(HttpError::Network)
        );
    }

    #[test]
    fn a_body_that_trickles_in_is_a_timeout_not_a_network_error() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/x", l.local_addr().unwrap().port());
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut b = [0u8; 4096];
            let _ = s.read(&mut b);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
            for _ in 0..40 {
                if s.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let t = std::time::Instant::now();
        let r =
            UreqHttp::with_timeout(true, Duration::from_millis(700)).get_json(&url, &[], &tok());
        assert_eq!(r, Err(HttpError::Timeout));
        assert!(t.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_server_that_never_answers_is_a_timeout() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/x", l.local_addr().unwrap().port());
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            std::thread::sleep(Duration::from_secs(5));
            drop(s);
        });
        assert_eq!(
            UreqHttp::with_timeout(true, Duration::from_millis(500)).get_json(&url, &[], &tok()),
            Err(HttpError::Timeout)
        );
    }

    /// The system proxy variables are ignored unless the user switched "Use system proxy settings" on.
    #[test]
    fn proxy_environment_is_ignored_by_default_and_used_only_when_enabled() {
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        proxy.set_nonblocking(true).unwrap();
        let purl = format!("http://127.0.0.1:{}", proxy.local_addr().unwrap().port());
        // SAFETY: tests in this module that read these variables run in this one test only
        for k in [
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "HTTPS_PROXY",
            "https_proxy",
        ] {
            std::env::set_var(k, &purl);
        }
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");
        // default: direct, the proxy sees nothing
        let (url, h) = serve(reply("200 OK", "", "{}"));
        let direct = UreqHttp::build(true, TIMEOUT, false); // test mode only allows the loopback http target; the proxy choice is what is under test
        assert!(direct.get_json(&url, &[], &tok()).is_ok());
        h.join().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            proxy.accept().is_err(),
            "the proxy was contacted although system proxies are off"
        );
        // enabled: the request goes to the proxy (which never answers, so the call fails fast)
        let via = UreqHttp::build(true, Duration::from_millis(500), true);
        let (url2, _h2) = serve(reply("200 OK", "", "{}"));
        let _ = via.get_json(&url2, &[], &tok());
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            proxy.accept().is_ok(),
            "with system proxies on, the proxy should be contacted"
        );
        for k in [
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "HTTPS_PROXY",
            "https_proxy",
        ] {
            std::env::remove_var(k);
        }
    }

    #[test]
    fn plain_http_is_refused_in_normal_mode() {
        let (url, _h) = serve(reply("200 OK", "", "{}"));
        assert_eq!(
            UreqHttp::new(false).get_json(&url, &[], &tok()),
            Err(HttpError::NotAllowed)
        );
    }

    #[test]
    fn reasons_are_fixed_phrases() {
        for e in [
            HttpError::Unauthorized,
            HttpError::Status(500),
            HttpError::Timeout,
            HttpError::Network,
            HttpError::BadJson,
        ] {
            assert!(!describe(&e).contains("Bearer"));
        }
    }
}
