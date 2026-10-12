//! Fallback for Codex: ask `codex app-server` (a JSON-RPC program that ships with the Codex CLI) for the rate limits.
//! Fixed argv (`app-server`), no shell, the child is killed when we are done or the deadline passes, output is read in bounded
//! chunks on a helper thread and split into lines HERE, so two replies arriving in one chunk are both seen at once
//! (the Mac bar once waited 20 s for the second line: tests/appserver below cover it).

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub const DEADLINE: Duration = Duration::from_secs(10);
pub const MAX_TOTAL: usize = 512 * 1024;
pub const MAX_LINE: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum AppServerError {
    Spawn,
    Timeout,
    Closed,
    TooMuchOutput,
    Rpc,
}

impl AppServerError {
    pub fn reason(&self) -> &'static str {
        match self {
            AppServerError::Spawn => "could not start codex",
            AppServerError::Timeout => "codex did not answer in time",
            AppServerError::Closed => "codex closed without an answer",
            AppServerError::TooMuchOutput => "codex sent too much output",
            AppServerError::Rpc => "codex returned an error",
        }
    }
}

/// Splits a growing byte buffer into complete lines (without the newline). The rest stays in `buf`.
pub fn take_lines(buf: &mut Vec<u8>) -> Result<Vec<Vec<u8>>, AppServerError> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        out.push(line[..line.len() - 1].to_vec());
    }
    if buf.len() > MAX_LINE {
        return Err(AppServerError::TooMuchOutput);
    }
    Ok(out)
}

/// The only environment the child gets: PATH, the home folder, CODEX_HOME when set, and on Windows SystemRoot / TEMP / TMP.
/// Everything else the app inherited (tokens in the environment, proxies, API keys) stays out of the child.
pub fn child_env(env: &dyn Fn(&str) -> Option<String>, windows: bool) -> Vec<(String, String)> {
    let names: &[&str] = if windows {
        &[
            "PATH",
            "USERPROFILE",
            "CODEX_HOME",
            "SystemRoot",
            "TEMP",
            "TMP",
        ]
    } else {
        &["PATH", "HOME", "CODEX_HOME"]
    };
    names
        .iter()
        .filter_map(|n| {
            env(n)
                .filter(|v| !v.is_empty() && !v.contains('\0'))
                .map(|v| (n.to_string(), v))
        })
        .collect()
}

/// Characters that mean something to cmd.exe: a `.cmd` path containing one is refused rather than quoted.
fn cmd_unsafe(p: &str) -> bool {
    p.chars().any(|c| {
        matches!(
            c,
            '%' | '^' | '&' | '|' | '<' | '>' | '"' | '(' | ')' | '!' | '\n' | '\r' | '\0'
        )
    })
}

/// `bin app-server`. A Windows `.cmd` / `.bat` shim (how npm installs codex there) cannot be started directly: it goes through
/// `cmd.exe /d /c <validated path> app-server` with a fixed argument list; no user data is ever part of the command line.
pub fn build_command(
    bin: &Path,
    env: &[(String, String)],
    windows: bool,
) -> Result<Command, AppServerError> {
    let ext = bin
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let mut cmd;
    if windows && (ext == "cmd" || ext == "bat") {
        let p = bin.to_str().ok_or(AppServerError::Spawn)?;
        if cmd_unsafe(p) {
            return Err(AppServerError::Spawn);
        }
        let root = env
            .iter()
            .find(|(k, _)| k == "SystemRoot")
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "C:\\Windows".into());
        cmd = Command::new(format!("{root}\\System32\\cmd.exe"));
        cmd.args(["/d", "/c", p, "app-server"]);
    } else {
        cmd = Command::new(bin);
        cmd.arg("app-server");
    }
    cmd.env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches nothing in the parent; it makes the child the leader of its own
        // session and process group, so the whole group can be killed later.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    Ok(cmd)
}

/// Ends the child AND everything it started.
///
/// One killpg is not enough: a process that is being forked at the moment of the signal can start after it and survive (seen on
/// macOS: the shell's foreground `sleep` outlived the kill, kept the output pipe open, and the reader thread and its file
/// descriptor leaked). So: kill the group, reap the child, then keep signalling the group until the system says no process is left in it.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pgid = child.id() as i32;
        // SAFETY: killpg with the id of a group we created (setsid above); at worst it fails with ESRCH
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        for _ in 0..250 {
            // SAFETY: as above. 0 = somebody was still in the group (now signalled); -1 (ESRCH) = the group is empty
            if unsafe { libc::killpg(pgid, libc::SIGKILL) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Starts a process, retrying a few times when the system says the executable is still open for writing (ETXTBSY, errno 26).
/// That happens when another thread forks at the moment a program file was just written: the child briefly holds a copy of the
/// write descriptor. It clears within milliseconds, so a short retry makes the start deterministic instead of a rare `Spawn` error.
fn spawn_retrying<T>(mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut tries = 0;
    loop {
        match f() {
            Err(e) if e.raw_os_error() == Some(26) && tries < 50 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            r => return r,
        }
    }
}

fn send(stdin: &mut impl Write, v: &Value) -> bool {
    let mut s = v.to_string();
    s.push('\n');
    stdin
        .write_all(s.as_bytes())
        .and_then(|_| stdin.flush())
        .is_ok()
}

/// Runs `bin app-server`, does the handshake and reads `account/rateLimits/read`. Returns the `result` object of that reply.
pub fn rate_limits(
    bin: &Path,
    deadline: Duration,
    env: &[(String, String)],
) -> Result<Value, AppServerError> {
    let mut cmd = build_command(bin, env, cfg!(windows))?;
    let mut child = spawn_retrying(|| cmd.spawn()).map_err(|_| AppServerError::Spawn)?;
    let mut reader: Option<std::thread::JoinHandle<()>> = None;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or(AppServerError::Spawn)?;
        let mut stdout = child.stdout.take().ok_or(AppServerError::Spawn)?;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        reader = Some(std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        }));
        let _ = send(
            &mut stdin,
            &json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"usage-bar","title":"Usage Bar","version":env!("CARGO_PKG_VERSION")}}}),
        );
        let end = Instant::now() + deadline;
        let (mut buf, mut total, mut sent_second) = (Vec::new(), 0usize, false);
        loop {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(AppServerError::Timeout);
            }
            let chunk = match rx.recv_timeout(left) {
                Ok(c) => c,
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(AppServerError::Timeout),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(AppServerError::Closed),
            };
            total += chunk.len();
            if total > MAX_TOTAL {
                return Err(AppServerError::TooMuchOutput);
            }
            buf.extend_from_slice(&chunk);
            // every complete line in the buffer is handled now, however many arrived in this chunk
            for line in take_lines(&mut buf)? {
                let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                match v.get("id").and_then(Value::as_i64) {
                    Some(1) if !sent_second => {
                        sent_second = true;
                        let _ = send(&mut stdin, &json!({"method":"initialized","params":{}}));
                        let _ = send(
                            &mut stdin,
                            &json!({"id":2,"method":"account/rateLimits/read"}),
                        );
                    }
                    Some(2) => {
                        return match v.get("result") {
                            Some(r) if r.is_object() => Ok(r.clone()),
                            _ => Err(AppServerError::Rpc),
                        };
                    }
                    _ => {}
                }
            }
        }
    })();
    kill_tree(&mut child);
    if let Some(h) = reader {
        // the reader ends when the pipe closes; give it a moment, never wait for it for long
        let t = Instant::now();
        while !h.is_finished() && t.elapsed() < Duration::from_millis(500) {
            std::thread::sleep(Duration::from_millis(5));
        }
        if h.is_finished() {
            let _ = h.join();
        }
    }
    result
}

/// Tests that start child processes take this lock, so they never overlap (and a descriptor count is not disturbed by a neighbour).
#[cfg(test)]
pub(crate) mod testlock {
    use std::sync::{Mutex, MutexGuard};
    static L: Mutex<()> = Mutex::new(());
    pub fn take() -> MutexGuard<'static, ()> {
        L.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn test_env() -> Vec<(String, String)> {
        child_env(&|k| std::env::var(k).ok(), false)
    }

    fn rate_limits(bin: &Path, d: Duration) -> Result<Value, AppServerError> {
        super::rate_limits(bin, d, &test_env())
    }

    fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn both_replies_in_one_write_do_not_wait_for_the_deadline() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let bin = script(
            d.path(),
            "codex",
            r#"printf '%s\n%s\n' '{"id":1,"result":{}}' '{"id":2,"result":{"rateLimits":{"planType":"plus","primary":{"usedPercent":12,"resetsAt":1900000000}}}}'
sleep 30"#,
        );
        // The old bug waited for the whole deadline for the second line. With a deadline this long, a bound of half of it cannot be
        // missed by a slow runner, yet a regression (waiting out the deadline) is still caught.
        let deadline = Duration::from_secs(120);
        let t = Instant::now();
        let v = rate_limits(&bin, deadline).unwrap();
        assert!(t.elapsed() < deadline / 2, "took {:?}", t.elapsed());
        assert_eq!(v["rateLimits"]["primary"]["usedPercent"], 12);
    }

    #[test]
    fn a_normal_handshake_reads_stdin_requests() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        // answers each request when it arrives (real app-server behaviour), then idles
        let bin = script(
            d.path(),
            "codex",
            r#"read a
printf '%s\n' '{"id":1,"result":{}}'
read b
read c
printf '%s\n' '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":7}}}}'
sleep 30"#,
        );
        let v = rate_limits(&bin, Duration::from_secs(10)).unwrap();
        assert_eq!(v["rateLimits"]["primary"]["usedPercent"], 7);
    }

    #[test]
    fn a_reply_split_across_chunks_is_reassembled() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let bin = script(
            d.path(),
            "codex",
            r#"printf '{"id":1,"res'
sleep 0.2
printf 'ult":{}}\n{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":3}}'
sleep 0.2
printf '}}\n'
sleep 30"#,
        );
        assert_eq!(
            rate_limits(&bin, Duration::from_secs(10)).unwrap()["rateLimits"]["primary"]
                ["usedPercent"],
            3
        );
    }

    #[test]
    fn a_busy_executable_is_retried_not_reported_as_spawn_failure() {
        let mut n = 0;
        let r = spawn_retrying(|| {
            n += 1;
            if n < 3 {
                Err(std::io::Error::from_raw_os_error(26))
            } else {
                Ok(n)
            }
        });
        assert_eq!(r.unwrap(), 3);
        let other = spawn_retrying::<()>(|| Err(std::io::Error::from_raw_os_error(2)));
        assert_eq!(other.unwrap_err().raw_os_error(), Some(2));
    }

    #[test]
    fn garbage_exit_silence_and_floods_are_errors_not_hangs() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            rate_limits(
                &script(d.path(), "g", "echo 'not json'"),
                Duration::from_secs(60)
            ),
            Err(AppServerError::Closed)
        );
        assert_eq!(
            rate_limits(&script(d.path(), "e", "exit 3"), Duration::from_secs(60)),
            Err(AppServerError::Closed)
        );
        assert_eq!(
            rate_limits(
                &script(d.path(), "s", "sleep 30"),
                Duration::from_millis(600)
            ),
            Err(AppServerError::Timeout)
        );
        assert_eq!(
            rate_limits(
                &script(
                    d.path(),
                    "r",
                    r#"printf '%s\n' '{"id":1,"result":{}}' '{"id":2,"error":{"code":-1}}'; sleep 30"#
                ),
                Duration::from_secs(60)
            ),
            Err(AppServerError::Rpc)
        );
        // No wall-clock bound is asserted: each case ends with its own specific error, and a hang would show up as Timeout instead
        // (the deadlines are generous so a slow runner cannot turn a Closed/Rpc/TooMuchOutput case into a Timeout).
        // 600 KB of noise without a newline, then silence: refused for size, the child is killed
        assert_eq!(
            rate_limits(
                &script(
                    d.path(),
                    "f",
                    "head -c 600000 /dev/zero | tr '\\0' 'x'; sleep 30"
                ),
                Duration::from_secs(60)
            ),
            Err(AppServerError::TooMuchOutput)
        );
    }

    #[test]
    fn the_child_is_killed_after_the_answer() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("alive");
        let bin = script(
            d.path(),
            "codex",
            &format!(
                r#"printf '%s\n%s\n' '{{"id":1,"result":{{}}}}' '{{"id":2,"result":{{"x":1}}}}'
while true; do touch '{}'; sleep 0.1; done"#,
                marker.display()
            ),
        );
        rate_limits(&bin, Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let _ = std::fs::remove_file(&marker);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !marker.exists(),
            "the fake codex was still running after we were done"
        );
    }

    #[test]
    fn missing_binary() {
        let _g = testlock::take();
        assert_eq!(
            rate_limits(Path::new("/nonexistent/codex"), Duration::from_secs(1)),
            Err(AppServerError::Spawn)
        );
        let d = tempfile::tempdir().unwrap();
        let bin = script(d.path(), "codex", "true");
        let _ = bin;
    }

    #[test]
    fn line_splitting() {
        let _g = testlock::take();
        let mut b = b"a\nb\nc".to_vec();
        assert_eq!(
            take_lines(&mut b).unwrap(),
            vec![b"a".to_vec(), b"b".to_vec()]
        );
        assert_eq!(b, b"c");
        let mut big = vec![b'x'; MAX_LINE + 1];
        assert_eq!(take_lines(&mut big), Err(AppServerError::TooMuchOutput));
    }

    /// Open PIPES of this process (fstat on every descriptor). Sockets, files and directories other tests open are not counted.
    fn count_fds() -> usize {
        (0..4096)
            .filter(|fd| {
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                // SAFETY: fstat on a possibly invalid descriptor just fails with EBADF
                unsafe {
                    libc::fstat(*fd, &mut st) == 0 && (st.st_mode & libc::S_IFMT) == libc::S_IFIFO
                }
            })
            .count()
    }

    fn pgrep(pattern: &str) -> usize {
        let out = std::process::Command::new("pgrep")
            .args(["-f", pattern])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().count()
    }

    #[test]
    fn a_hundred_fetches_leave_no_orphans_and_no_open_files() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        // the fake codex starts a background child of its own, like a real one might (node helpers, shells)
        let bin = script(
            d.path(),
            "codex",
            r#"sleep 4321 &
printf '%s\n%s\n' '{"id":1,"result":{}}' '{"id":2,"result":{"x":1}}'
sleep 4320"#,
        );
        let before = count_fds();
        for _ in 0..100 {
            rate_limits(&bin, Duration::from_secs(5)).unwrap();
        }
        // other tests run in parallel and open and close sockets: wait (up to 3 s) for the counts to settle instead of sampling once
        let t = Instant::now();
        let (mut orphans, mut after) = (pgrep("sleep 432"), count_fds());
        while (orphans != 0 || after > before + 4) && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(100));
            orphans = pgrep("sleep 432");
            after = count_fds();
        }
        assert_eq!(
            orphans, 0,
            "orphaned children survived (the background and the foreground sleep)"
        );
        assert!(after <= before + 4, "open files before {before}, after {after} (100 fetches would leak ~300 if the pipes stayed open)");
    }

    /// Standalone measurement (run alone: `cargo test --lib measure_fds -- --ignored --nocapture --test-threads=1`).
    #[test]
    #[ignore]
    fn measure_fds() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let bin = script(d.path(), "codex", "sleep 4399 &\nprintf '%s\\n%s\\n' '{\"id\":1,\"result\":{}}' '{\"id\":2,\"result\":{\"x\":1}}'\nsleep 4398");
        let before = count_fds();
        let t = Instant::now();
        for _ in 0..100 {
            rate_limits(&bin, Duration::from_secs(5)).unwrap();
        }
        let right_after = count_fds();
        std::thread::sleep(Duration::from_secs(3));
        println!("MEASURE pipes before {before} right-after {right_after} after-3s {} orphans {} took {:?}", count_fds(), pgrep("sleep 439"), t.elapsed());
    }

    #[test]
    fn a_timeout_also_kills_the_whole_group() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let bin = script(d.path(), "codex", "sleep 4322 &\nsleep 30");
        assert_eq!(
            rate_limits(&bin, Duration::from_millis(400)),
            Err(AppServerError::Timeout)
        );
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(pgrep("sleep 4322"), 0);
    }

    #[test]
    fn the_child_gets_a_minimal_environment() {
        let _g = testlock::take();
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("env.txt");
        let bin = script(
            d.path(),
            "codex",
            &format!(
                r#"env > '{}'
printf '%s\n%s\n' '{{"id":1,"result":{{}}}}' '{{"id":2,"result":{{"x":1}}}}'"#,
                out.display()
            ),
        );
        let env = child_env(
            &|k| match k {
                "PATH" => Some("/usr/bin:/bin".into()),
                "HOME" => Some("/h".into()),
                "CODEX_HOME" => Some("/ch".into()),
                "OPENAI_API_KEY" => Some("sk-fake-should-not-pass".into()),
                "HTTPS_PROXY" => Some("http://p".into()),
                _ => None,
            },
            false,
        );
        super::rate_limits(&bin, Duration::from_secs(5), &env).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(
            text.contains("HOME=/h")
                && text.contains("CODEX_HOME=/ch")
                && text.contains("PATH=/usr/bin:/bin")
        );
        assert!(
            !text.contains("OPENAI") && !text.contains("PROXY") && !text.contains("sk-fake"),
            "{text}"
        );
        let w = child_env(&|k| Some(format!("v-{k}")), true);
        assert_eq!(
            w.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec![
                "PATH",
                "USERPROFILE",
                "CODEX_HOME",
                "SystemRoot",
                "TEMP",
                "TMP"
            ]
        );
    }

    #[test]
    fn a_windows_cmd_shim_goes_through_cmd_exe_with_fixed_arguments_only() {
        let _g = testlock::take();
        let env = vec![("SystemRoot".to_string(), "C:\\Windows".to_string())];
        let c = build_command(
            Path::new("C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd"),
            &env,
            true,
        )
        .unwrap();
        assert!(c
            .get_program()
            .to_string_lossy()
            .ends_with("System32\\cmd.exe"));
        let args: Vec<String> = c
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "/d",
                "/c",
                "C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd",
                "app-server"
            ]
        );
        for bad in [
            "C:\\x&calc\\codex.cmd",
            "C:\\x%PATH%\\codex.cmd",
            "C:\\x\"y\\codex.cmd",
            "C:\\x^y\\codex.bat",
            "C:\\x|y\\codex.cmd",
        ] {
            assert!(build_command(Path::new(bad), &env, true).is_err(), "{bad}");
        }
        let exe = build_command(Path::new("C:\\bin\\codex.exe"), &env, true).unwrap();
        assert_eq!(exe.get_program().to_string_lossy(), "C:\\bin\\codex.exe");
    }
}

/// Runs on the Windows CI runner only.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn a_cmd_shim_and_an_exe_are_started_the_right_way() {
        let _g = testlock::take();
        let env = vec![("SystemRoot".to_string(), "C:\\Windows".to_string())];
        let c = build_command(Path::new("C:\\Users\\a\\npm\\codex.cmd"), &env, true).unwrap();
        assert!(c
            .get_program()
            .to_string_lossy()
            .ends_with("System32\\cmd.exe"));
        let e = build_command(Path::new("C:\\bin\\codex.exe"), &env, true).unwrap();
        assert_eq!(e.get_program().to_string_lossy(), "C:\\bin\\codex.exe");
        assert!(build_command(Path::new("C:\\x&y\\codex.cmd"), &env, true).is_err());
    }

    #[test]
    fn a_missing_program_is_a_spawn_error_not_a_panic() {
        let _g = testlock::take();
        assert_eq!(
            rate_limits(
                Path::new("C:\\nonexistent\\codex.exe"),
                Duration::from_secs(1),
                &[]
            ),
            Err(AppServerError::Spawn)
        );
    }
}
