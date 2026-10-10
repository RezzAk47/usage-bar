//! The only file access the webview has: four operations on a fixed set of names inside the data folder.
//! Names are validated (no separators, no `..`, only settings/usage json and their `.broken-` backups), the folder is
//! canonicalised, writes are atomic (temp file in the same folder, fsync, rename, fsync of the folder), and a symlinked
//! file keeps being a link (the real file behind it is replaced).
//!
//! Writes are also compare-and-swap: the page says which version of the file it last read (size, mtime, ctime, inode) and
//! the write is refused with `CONFLICT` when the file on disk is a different one. The check and the write happen while
//! holding the same `<file>.lock` (flock on Unix, LockFileEx on Windows), so two saves can never both read the old file and then overwrite each other.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Files over this size are not loaded (a runaway file must not freeze the popup).
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
pub const CONFLICT: &str = "CONFLICT: the file changed on disk";

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub size: u64,
    /// Modification time in whole microseconds since the epoch. An INTEGER on purpose: fractional milliseconds (f64) do not
    /// always come back bit-identical after Rust -> JSON -> page -> JSON -> Rust, and the compare-and-swap uses exact equality.
    pub mtime_us: i64,
    /// Change time (Unix) or creation time (Windows), whole microseconds.
    pub ctime_us: i64,
    /// Inode number as text on Unix (empty where the OS does not give one cheaply).
    pub ino: String,
}

/// `^(settings|usage-alerts|usage-history|usage-backoff)(\.broken-[0-9a-z-]{1,40})?\.json$`, written out by hand (no regex crate needed).
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = ["settings", "usage-alerts", "usage-history", "usage-backoff"]
        .iter()
        .find_map(|p| name.strip_prefix(p))
    else {
        return false;
    };
    let Some(mid) = rest.strip_suffix(".json") else {
        return false;
    };
    if mid.is_empty() {
        return true;
    }
    match mid.strip_prefix(".broken-") {
        Some(tail) => {
            !tail.is_empty()
                && tail.len() <= 40
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        }
        None => false,
    }
}

/// The path of a data file, or an error. Never returns a path outside `dir`.
pub fn resolve(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("not an allowed file name: {name:?}"));
    }
    // canonicalise the folder when it exists (it may be a symlink the user made); a missing folder is created on write
    let base = match dir.canonicalize() {
        Ok(c) => c,
        Err(_) => dir.to_path_buf(),
    };
    let p = base.join(name);
    if p.parent() != Some(base.as_path()) {
        return Err("path escapes the data folder".into());
    }
    Ok(p)
}

/// What a write will replace, after the symlink policy has been applied (see `plan_target`).
#[derive(Debug)]
struct Target {
    /// The file that gets replaced: `dir/name` itself, or the regular file a link points to.
    path: PathBuf,
    /// Where the temp file may be created: the data folder, or the target's folder when the target is on another filesystem.
    temp_dir: PathBuf,
    /// Identity of the validated target (device, inode) for the check right before the rename; None = it does not exist yet.
    identity: Option<(u64, u64)>,
}

#[cfg(unix)]
fn identity_of(m: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (m.dev(), m.ino())
}
#[cfg(not(unix))]
fn identity_of(m: &fs::Metadata) -> (u64, u64) {
    (m.len(), 0) // no stable file id in std on this OS: the size and the type checks are what is left
}

pub const LINK_REFUSED: &str = "is a link: not followed";

/// Decides what a write replaces. The data files (settings, alert state, history) are not precious and the credential files live
/// elsewhere, so a link in place of a data file is never followed, for reading or for writing: it is refused with a named error and
/// nothing is written. A hard link is replaced by a new file, never written through. (The data FOLDER may be a link the user made.)
fn plan_target(p: &Path, name: &str) -> Result<Target, String> {
    let base = p.parent().ok_or("no folder for the file")?.to_path_buf();
    let meta = match fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Target {
                path: p.to_path_buf(),
                temp_dir: base,
                identity: None,
            })
        }
        Err(e) => return Err(format!("cannot look at {name}: {e}")),
    };
    if meta.file_type().is_symlink() {
        return Err(format!("{name} {LINK_REFUSED}; nothing was written"));
    }
    if meta.is_file() {
        return Ok(Target {
            path: p.to_path_buf(),
            temp_dir: base,
            identity: Some(identity_of(&meta)),
        });
    }
    Err(format!("{name} is not a regular file; nothing was written"))
}

/// Right before the rename: the target must still be the very file that was validated (same device and inode, still a regular
/// file, not swapped for a link in the meantime).
fn still_same(t: &Target) -> Result<(), String> {
    match (fs::symlink_metadata(&t.path), t.identity) {
        (Ok(m), Some(id)) if m.is_file() && identity_of(&m) == id => Ok(()),
        (Err(e), None) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Ok(m), None) if m.is_file() => Ok(()), // created by someone else meanwhile: the compare-and-swap decides
        _ => Err("the file changed while it was being written; nothing was written".into()),
    }
}

/// Whole microseconds since the epoch (negative before it).
fn us(t: std::io::Result<std::time::SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_micros() as i64,
            Err(e) => -(e.duration().as_micros() as i64),
        },
        Err(_) => 0,
    }
}

fn stamp_of(m: &fs::Metadata) -> Stamp {
    #[cfg(unix)]
    let (ctime_us, ino) = {
        use std::os::unix::fs::MetadataExt;
        (
            m.ctime() * 1_000_000 + m.ctime_nsec() / 1000,
            m.ino().to_string(),
        )
    };
    #[cfg(not(unix))]
    let (ctime_us, ino) = (us(m.created()), String::new());
    Stamp {
        size: m.len(),
        mtime_us: us(m.modified()),
        ctime_us,
        ino,
    }
}

pub const NOT_UTF8: &str =
    "is not UTF-8 text; if you saved it as UTF-16 (some Windows editors do) save it again as UTF-8";

/// Looks at the final component without following a link: a link or anything but a regular file is refused by name.
fn regular_meta(p: &Path, name: &str) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("{name} {LINK_REFUSED}")),
        Ok(m) if !m.is_file() => Err(format!("{name} is not a regular file")),
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {name}: {e}")),
    }
}

/// The file as text. A UTF-8 byte order mark is dropped from the returned text (the file itself is not touched).
/// The file is looked at first (a link, a fifo, a device are refused), then opened without following links and without blocking.
pub fn read(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let p = resolve(dir, name)?;
    let Some(meta) = regular_meta(&p, name)? else {
        return Ok(None);
    };
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "{name} is larger than {} MB; it is not loaded",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut bytes = Vec::new();
    match opts.open(&p) {
        Ok(f) => {
            // what was opened must be the regular file that was looked at
            match f.metadata() {
                Ok(m) if m.is_file() && identity_of(&m) == identity_of(&meta) => {}
                _ => return Err(format!("{name} changed while it was being opened")),
            }
            f.take(MAX_READ_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("cannot read {name}: {e}"))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {name}: {e}")),
    }
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(format!(
            "{name} is larger than {} MB; it is not loaded",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    let slice = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(&bytes);
    String::from_utf8(slice.to_vec())
        .map(Some)
        .map_err(|_| format!("{name} {NOT_UTF8}"))
}

pub fn stat(dir: &Path, name: &str) -> Result<Option<Stamp>, String> {
    let p = resolve(dir, name)?;
    Ok(regular_meta(&p, name)?.map(|m| stamp_of(&m)))
}

/// Is this a failure that a Windows virus scanner, indexer or the other program holding the file open causes for a moment?
pub fn is_transient(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    // 5 ACCESS_DENIED, 32 sharing violation, 33 lock violation
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33)) && cfg!(windows)
}

pub const RETRY_DELAYS_MS: [u64; 5] = [20, 50, 100, 200, 400];

/// Runs `op`, retrying after each delay while it fails with a transient error. `sleep` is injectable for tests.
pub fn retry_transient<T>(
    mut op: impl FnMut() -> std::io::Result<T>,
    delays_ms: &[u64],
    mut sleep: impl FnMut(Duration),
) -> std::io::Result<T> {
    let mut i = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) && i < delays_ms.len() => {
                sleep(Duration::from_millis(delays_ms[i]));
                i += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// How long a write waits for another program's lock. Shorter than the 5 s the shell gives a file operation (lib.rs
/// `off_main`), so the page hears the real reason instead of a timeout while the write still runs on behind its back.
pub const LOCK_WAIT: Duration = Duration::from_secs(3);
const _: () = assert!(
    LOCK_WAIT.as_secs() < 5,
    "keep the lock wait under the shell's 5 s limit"
);
pub const BUSY: &str = "is busy (another program holds its lock); nothing was written";

/// Holds `<real file>.lock` exclusively (the same file another tool locks) until dropped.
/// A folder we cannot create the lock in, or a file system without locks, just means "no lock": the compare-and-swap still
/// protects the write. A lock that another program HOLDS past the wait is an error: the write never goes ahead unlocked.
struct Lock(Option<fs::File>);

impl Lock {
    fn take(target: &Path, wait: Duration) -> Result<Lock, ()> {
        // built on the OS string, so a folder name that is not valid UTF-8 still locks the right file
        let mut lock_path = target.as_os_str().to_os_string();
        lock_path.push(".lock");
        let Ok(f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(PathBuf::from(lock_path))
        else {
            return Ok(Lock(None));
        };
        let t0 = std::time::Instant::now();
        loop {
            match f.try_lock() {
                Ok(()) => return Ok(Lock(Some(f))),
                Err(fs::TryLockError::WouldBlock) if t0.elapsed() < wait => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(fs::TryLockError::WouldBlock) => return Err(()),
                Err(_) => return Ok(Lock(None)),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(f) = &self.0 {
            let _ = f.unlock();
        }
    }
}

/// `check`: None = no compare, Some(None) = the file must not exist, Some(Some(stamp)) = it must still be exactly that file.
pub fn write(
    dir: &Path,
    name: &str,
    text: &str,
    check: Option<Option<Stamp>>,
) -> Result<(), String> {
    write_waiting(dir, name, text, check, LOCK_WAIT)
}

fn write_waiting(
    dir: &Path,
    name: &str,
    text: &str,
    check: Option<Option<Stamp>>,
    lock_wait: Duration,
) -> Result<(), String> {
    let p = resolve(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create the data folder: {e}"))?;
    let target = plan_target(&p, name)?; // refuses before any file (even the lock file) is created
    let _lock = Lock::take(&target.path, lock_wait).map_err(|_| format!("{name} {BUSY}"))?;
    if let Some(expected) = check {
        let current = fs::metadata(&p).ok().map(|m| stamp_of(&m));
        if current != expected {
            return Err(CONFLICT.into());
        }
    }
    if let Ok(meta) = fs::metadata(&target.path) {
        if meta.permissions().readonly() {
            return Err(format!("{name} is read-only; nothing was saved"));
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target
        .temp_dir
        .join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&target.path) {
            let _ = fs::set_permissions(&tmp, meta.permissions()); // keep the mode the user gave the file
        }
        #[cfg(windows)]
        {
            // never inherit a read-only attribute from the target: rename onto it must work
            let mut perms = fs::metadata(&tmp)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(&tmp, perms);
        }
        still_same(&target).map_err(std::io::Error::other)?;
        retry_transient(
            || fs::rename(&tmp, &target.path),
            &RETRY_DELAYS_MS,
            std::thread::sleep,
        )?;
        #[cfg(unix)]
        {
            if let Some(d) = target.path.parent().and_then(|d| fs::File::open(d).ok()) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("could not write {name}: {e}"))
}

/// A crash between creating the temp file and the rename leaves `.<name>.tmp-<pid>-<nanos>` behind. This removes such leftovers
/// for the data files, at startup. Only regular files (never links) whose name is exactly that shape for a valid data file name,
/// and whose last change is older than `min_age` (a write in progress in another instance is younger). Returns how many went.
pub fn clean_stale_temp(dir: &Path, now: std::time::SystemTime, min_age: Duration) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in rd.flatten() {
        let fname = entry.file_name();
        let Some(fname) = fname.to_str() else {
            continue;
        };
        let Some(rest) = fname.strip_prefix('.') else {
            continue;
        };
        let Some((name, tail)) = rest.split_once(".tmp-") else {
            continue;
        };
        let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
        let shaped = valid_name(name)
            && tail
                .split_once('-')
                .is_some_and(|(pid, nanos)| digits(pid) && digits(nanos));
        if !shaped {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= min_age);
        if old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Keeps an unreadable file as a backup: renames it (or the link itself) to a UNIQUE `.broken-` name in the same folder.
/// The final name is the requested one plus a unique suffix, so nothing (not even a dangling symlink) is ever overwritten.
/// Returns the name it used.
pub fn move_aside(dir: &Path, name: &str, backup: &str) -> Result<String, String> {
    let from = resolve(dir, name)?;
    resolve(dir, backup)?;
    if !backup.contains(".broken-") {
        return Err("a backup name must contain .broken-".into());
    }
    let stem = backup.strip_suffix(".json").unwrap_or(backup);
    for n in 0..100u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let unique = format!("{stem}-{:x}{n}.json", nanos & 0xffff_ffff);
        let to = dir
            .canonicalize()
            .unwrap_or_else(|_| dir.to_path_buf())
            .join(&unique);
        // The name is RESERVED by creating it exclusively (create_new fails for any existing name, a dangling symlink included,
        // and never follows a link), so no other writer can take it between the check and the rename. The rename then replaces
        // only our own empty placeholder.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&to)
        {
            Ok(f) => drop(f),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not keep a backup of {name}: {e}")),
        }
        return match fs::rename(&from, &to) {
            Ok(()) => Ok(unique),
            Err(e) => {
                let _ = fs::remove_file(&to);
                Err(format!("could not keep a backup of {name}: {e}"))
            }
        };
    }
    Err("could not find an unused backup name".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_temp_files_of_the_data_files_are_removed_and_nothing_else() {
        let d = tempfile::tempdir().unwrap();
        let stale = [
            ".settings.json.tmp-123-456789",
            ".usage-alerts.json.tmp-9-1",
        ];
        let keep = [
            "settings.json",
            "settings.json.lock",
            ".settings.json.tmp-abc-1",
            ".other.json.tmp-1-2",
            ".settings.json.tmp-1",
            "notes.tmp-1-2",
            ".settings.json.tmp-1-2.bak",
        ];
        for n in stale.iter().chain(keep.iter()) {
            fs::write(d.path().join(n), "x").unwrap();
        }
        fs::create_dir(d.path().join(".usage-history.json.tmp-1-2")).unwrap();
        let now = std::time::SystemTime::now();
        // fresh files (a write may be running right now) are left alone
        assert_eq!(clean_stale_temp(d.path(), now, Duration::from_secs(60)), 0);
        // two minutes later they count as stale
        let later = now + Duration::from_secs(120);
        assert_eq!(
            clean_stale_temp(d.path(), later, Duration::from_secs(60)),
            2
        );
        for n in stale {
            assert!(!d.path().join(n).exists(), "{n}");
        }
        for n in keep {
            assert!(d.path().join(n).exists(), "{n}");
        }
        assert!(d.path().join(".usage-history.json.tmp-1-2").is_dir());
        assert_eq!(
            clean_stale_temp(&d.path().join("missing"), later, Duration::ZERO),
            0
        );
    }

    #[test]
    fn names_are_checked() {
        for ok in [
            "settings.json",
            "usage-alerts.json",
            "usage-history.json",
            "settings.broken-1760000000000-ab12cd.json",
            "usage-history.broken-1760000000000.json",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "../settings.json",
            "settings.json/",
            "a/settings.json",
            "..",
            ".",
            "settings.json.bak",
            "other.json",
            "settings.broken-.json",
            "settings.json\n",
            "C:\\x.json",
            "tasks\0.json",
            "settings.broken-UPPER.json",
            "settings.broken-../x.json",
            "/etc/passwd",
            "settings.json ",
            "TASKS.json",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        assert!(!valid_name(&format!(
            "settings.broken-{}.json",
            "a".repeat(41)
        )));
    }

    /// Every kind of link in place of a data file is refused for read, stat and write, and the file behind it stays byte for byte.
    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_a_data_file_is_refused_everywhere_and_the_target_is_untouched() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let fake_creds = br#"{"claudeAiOauth":{"accessToken":"FAKE-SYMLINK-TOKEN"}}"#.to_vec();
        let victims: Vec<(&str, Vec<u8>)> = vec![
            ("creds", fake_creds.clone()),
            ("zshrc", b"export PATH=/bin\n".to_vec()),
            ("mine.json", b"{\"layout\":\"glass\"}".to_vec()), // even a perfectly valid settings file of mine
            ("hist.json", b"{\"version\":1,\"series\":{}}".to_vec()),
            ("empty", Vec::new()),
        ];
        for name in ["settings.json", "usage-alerts.json", "usage-history.json"] {
            for (n, content) in &victims {
                let victim = d.path().join(n);
                fs::write(&victim, content).unwrap();
                let link = data.join(name);
                let _ = fs::remove_file(&link);
                symlink(&victim, &link).unwrap();
                for e in [
                    read(&data, name).unwrap_err(),
                    stat(&data, name).unwrap_err(),
                    write(&data, name, "{\"layout\":\"x\"}", None).unwrap_err(),
                ] {
                    assert!(e.contains("is a link: not followed"), "{name} -> {n}: {e}");
                }
                assert_eq!(
                    &fs::read(&victim).unwrap(),
                    content,
                    "{n} must be untouched"
                );
                assert!(fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                assert!(
                    !data.join(format!("{name}.lock")).exists(),
                    "no stray lock file"
                );
            }
        }
        // dangling and directory links are links too
        let link = data.join("settings.json");
        fs::remove_file(&link).unwrap();
        symlink(d.path().join("gone"), &link).unwrap();
        assert!(read(&data, "settings.json")
            .unwrap_err()
            .contains("is a link: not followed"));
        assert!(write(&data, "settings.json", "{}", None)
            .unwrap_err()
            .contains("is a link: not followed"));
        fs::remove_file(&link).unwrap();
        symlink(d.path(), &link).unwrap();
        assert!(read(&data, "settings.json")
            .unwrap_err()
            .contains("is a link: not followed"));
    }

    /// A fifo named like a data file must not block anything: refused at once, for read, stat and write, even with no writer.
    #[cfg(unix)]
    #[test]
    fn a_fifo_in_place_of_a_data_file_is_refused_without_blocking() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let dir = d.path().to_path_buf();
        let h = std::thread::spawn(move || {
            (
                read(&dir, "settings.json"),
                stat(&dir, "settings.json"),
                write(&dir, "settings.json", "{}", None),
            )
        });
        let t = std::time::Instant::now();
        while !h.is_finished() {
            assert!(
                t.elapsed() < Duration::from_secs(3),
                "the read of a fifo blocked"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let (r, s, w) = h.join().unwrap();
        for e in [r.unwrap_err(), s.unwrap_err(), w.unwrap_err()] {
            assert!(e.contains("not a regular file"), "{e}");
        }
        // a data FOLDER that is a link the user made still works
        let real = d.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = d.path().join("folder-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write(&link, "settings.json", "{}", None).unwrap();
        assert_eq!(read(&link, "settings.json").unwrap().as_deref(), Some("{}"));
    }

    #[test]
    fn traversal_is_refused_and_nothing_is_created() {
        let d = tempfile::tempdir().unwrap();
        let outside = d.path().join("outside.json");
        let data = d.path().join("data");
        for bad in [
            "../outside.json",
            "..\\outside.json",
            "settings.json/../../outside.json",
            "/tmp/x.json",
        ] {
            assert!(write(&data, bad, "x", None).is_err(), "{bad}");
            assert!(read(&data, bad).is_err(), "{bad}");
            assert!(stat(&data, bad).is_err(), "{bad}");
        }
        assert!(!outside.exists());
        assert!(
            !data.exists(),
            "a refused write must not even create the folder"
        );
    }

    #[test]
    fn write_read_stat_round_trip_and_no_temp_left() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("UsageBar");
        assert_eq!(read(&data, "settings.json").unwrap(), None);
        assert_eq!(stat(&data, "settings.json").unwrap(), None);
        write(&data, "settings.json", "{\"tasks\":[]}\n", None).unwrap();
        assert_eq!(
            read(&data, "settings.json").unwrap().as_deref(),
            Some("{\"tasks\":[]}\n")
        );
        let s = stat(&data, "settings.json").unwrap().unwrap();
        assert_eq!(s.size, 13);
        write(&data, "settings.json", "{\"tasks\":[1]}\n", None).unwrap();
        let s2 = stat(&data, "settings.json").unwrap().unwrap();
        assert_eq!(s2.size, 14);
        let mut names: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "settings.json".to_string(),
                "settings.json.lock".to_string()
            ],
            "no temp files left (the .lock file belongs to the compare-and-swap)"
        );
    }

    /// The reviewed attack: a planted link data/settings.json -> ~/.zshrc (or any other file) must never be overwritten.
    #[cfg(unix)]
    #[test]
    fn a_hard_link_is_replaced_not_written_through() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let victim = d.path().join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        fs::hard_link(&victim, data.join("settings.json")).unwrap();
        write(&data, "settings.json", "{\"tasks\":[]}", None).unwrap();
        assert_eq!(
            fs::read_to_string(&victim).unwrap(),
            "precious",
            "the other name of the file is untouched"
        );
        assert_eq!(
            fs::read_to_string(data.join("settings.json")).unwrap(),
            "{\"tasks\":[]}"
        );
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(data.join("settings.json")).unwrap().nlink(),
            1,
            "the data file is its own file now"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_data_folder_is_followed_and_a_planted_link_inside_it_is_still_refused() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let real_dir = d.path().join("elsewhere");
        fs::create_dir_all(&real_dir).unwrap();
        let data = d.path().join("data-link");
        symlink(&real_dir, &data).unwrap();
        write(&data, "settings.json", "{\"tasks\":[]}", None).unwrap();
        assert_eq!(
            fs::read_to_string(real_dir.join("settings.json")).unwrap(),
            "{\"tasks\":[]}"
        );
        let victim = d.path().join("zshrc");
        fs::write(&victim, "keep").unwrap();
        fs::remove_file(real_dir.join("settings.json")).unwrap();
        symlink(&victim, real_dir.join("settings.json")).unwrap();
        assert!(write(&data, "settings.json", "{\"tasks\":[]}", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
    }

    /// The target is swapped for another file between validation and the rename: refused.
    #[cfg(unix)]
    #[test]
    fn an_aside_file_is_never_written_through_a_link() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let victim = d.path().join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        // the data file itself is the planted link: moving it aside renames the LINK, the victim is untouched
        symlink(&victim, d.path().join("settings.json")).unwrap();
        let n = move_aside(d.path(), "settings.json", "settings.broken-1.json").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
        assert!(
            fs::symlink_metadata(d.path().join(&n))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link itself was renamed"
        );
        assert!(!d.path().join("settings.json").exists());
        // a planted link where the backup would go is skipped, not followed
        fs::write(d.path().join("settings.json"), "bad").unwrap();
        symlink(&victim, d.path().join("settings.broken-2.json")).unwrap();
        let n2 = move_aside(d.path(), "settings.json", "settings.broken-2.json").unwrap();
        assert_ne!(n2, "settings.broken-2.json");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
    }

    #[test]
    fn move_aside_keeps_a_backup_under_a_unique_name_and_never_overwrites_one() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "settings.json", "broken", None).unwrap();
        let first = move_aside(d.path(), "settings.json", "settings.broken-1-abc.json").unwrap();
        assert!(first.starts_with("settings.broken-1-abc-") && first.ends_with(".json"));
        assert!(!d.path().join("settings.json").exists());
        assert_eq!(fs::read_to_string(d.path().join(&first)).unwrap(), "broken");
        write(d.path(), "settings.json", "second", None).unwrap();
        let second = move_aside(d.path(), "settings.json", "settings.broken-1-abc.json").unwrap();
        assert_ne!(first, second);
        assert_eq!(
            fs::read_to_string(d.path().join(&first)).unwrap(),
            "broken",
            "the first backup is untouched"
        );
        let before = fs::read_dir(d.path()).unwrap().count();
        assert!(
            move_aside(d.path(), "settings.json", "settings.broken-1-abc.json").is_err(),
            "source is gone now"
        );
        assert_eq!(
            fs::read_dir(d.path()).unwrap().count(),
            before,
            "a failed move leaves no placeholder behind"
        );
        write(d.path(), "settings.json", "third", None).unwrap();
        assert!(move_aside(d.path(), "settings.json", "settings.json").is_err());
        assert_eq!(
            fs::read_to_string(d.path().join("settings.json")).unwrap(),
            "third"
        );
    }

    #[cfg(unix)]
    #[test]
    fn move_aside_never_overwrites_a_dangling_symlink() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("settings.json"), "bad").unwrap();
        let victim = d.path().join("nowhere");
        std::os::unix::fs::symlink(&victim, d.path().join("settings.broken-1.json")).unwrap();
        let name = move_aside(d.path(), "settings.json", "settings.broken-1.json").unwrap();
        assert_ne!(name, "settings.broken-1.json");
        assert!(
            !victim.exists(),
            "the symlink target was not created or written"
        );
        assert!(
            fs::symlink_metadata(d.path().join("settings.broken-1.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn a_stat_changes_when_the_content_changes_even_within_one_second() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "settings.json", "aaa", None).unwrap();
        let a = stat(d.path(), "settings.json").unwrap().unwrap();
        write(d.path(), "settings.json", "aaaa", None).unwrap();
        let b = stat(d.path(), "settings.json").unwrap().unwrap();
        assert_ne!(a, b);
    }

    /// Another program holds `<file>.lock` for longer than the wait: the write is refused with a clear error. It used to go
    /// ahead WITHOUT the lock after the wait (after the page had already been told the save timed out), so the other program's
    /// read-check-write could interleave with ours.
    #[test]
    fn a_lock_held_elsewhere_refuses_the_write_instead_of_writing_unlocked() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "settings.json", "old", None).unwrap();
        // the same open the production lock uses (create + append), retried: on Windows the previous write's lock file can be
        // briefly delete-pending, and opening it then fails with "Access is denied" until the system has let go of it
        let lock_path = d.path().join("settings.json.lock");
        let mut tries = 0;
        let holder = loop {
            match fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&lock_path)
            {
                Ok(f) => break f,
                Err(_) if tries < 100 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("cannot open the lock file: {e}"),
            }
        };
        holder.lock().unwrap();
        let e = write_waiting(
            d.path(),
            "settings.json",
            "new",
            None,
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(e.contains("busy"), "{e}");
        assert_eq!(
            read(d.path(), "settings.json").unwrap().as_deref(),
            Some("old")
        );
        holder.unlock().unwrap();
        write(d.path(), "settings.json", "new", None).unwrap();
        assert_eq!(
            read(d.path(), "settings.json").unwrap().as_deref(),
            Some("new")
        );
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_panic() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("settings.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(d.path(), "settings.json").is_err());
    }

    // ---- round 4: encoding, size, compare-and-swap, locking, read-only, retries

    #[test]
    fn a_utf8_bom_is_dropped_from_the_text_and_the_file_is_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("settings.json");
        fs::write(&p, b"\xEF\xBB\xBF{\"tasks\":[]}").unwrap();
        assert_eq!(
            read(d.path(), "settings.json").unwrap().as_deref(),
            Some("{\"tasks\":[]}")
        );
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBF{\"tasks\":[]}");
    }

    #[test]
    fn utf16_gives_a_clear_error() {
        let d = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(
                "{\"tasks\":[]}"
                    .encode_utf16()
                    .flat_map(|u| u.to_le_bytes()),
            )
            .collect();
        fs::write(d.path().join("settings.json"), bytes).unwrap();
        let e = read(d.path(), "settings.json").unwrap_err();
        assert!(
            e.contains("not UTF-8 text")
                && e.contains("UTF-16")
                && e.contains("save it again as UTF-8"),
            "{e}"
        );
    }

    #[test]
    fn a_file_over_the_cap_is_an_error_not_a_read() {
        let d = tempfile::tempdir().unwrap();
        let f = fs::File::create(d.path().join("settings.json")).unwrap();
        f.set_len(MAX_READ_BYTES + 1).unwrap(); // sparse: instant
        let e = read(d.path(), "settings.json").unwrap_err();
        assert!(e.contains("larger than 32 MB"), "{e}");
        f.set_len(MAX_READ_BYTES).unwrap();
        assert!(
            read(d.path(), "settings.json").is_ok(),
            "exactly at the cap is still read"
        );
    }

    fn compare_and_swap_basics(d: &Path) -> Stamp {
        write(d, "settings.json", "one", Some(None)).unwrap(); // must not exist: ok
        assert_eq!(
            write(d, "settings.json", "x", Some(None)).unwrap_err(),
            CONFLICT
        );
        let seen = stat(d, "settings.json").unwrap().unwrap();
        write(d, "settings.json", "two", Some(Some(seen.clone()))).unwrap();
        assert_eq!(
            write(d, "settings.json", "three", Some(Some(seen))).unwrap_err(),
            CONFLICT,
            "the stamp is stale now"
        );
        assert_eq!(read(d, "settings.json").unwrap().as_deref(), Some("two"));
        stat(d, "settings.json").unwrap().unwrap()
    }

    #[test]
    fn compare_and_swap_refuses_when_the_file_changed() {
        let d = tempfile::tempdir().unwrap();
        let fresh = compare_and_swap_basics(d.path());
        // what every OS guarantees: a different size or a different modification time is noticed
        let p = d.path().join("settings.json");
        fs::write(&p, "a longer text than before").unwrap();
        assert_eq!(
            write(d.path(), "settings.json", "four", Some(Some(fresh.clone()))).unwrap_err(),
            CONFLICT
        );
        let fresh2 = stat(d.path(), "settings.json").unwrap().unwrap();
        let mt = fs::metadata(&p).unwrap().modified().unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(mt + Duration::from_secs(5))
            .unwrap();
        assert_eq!(
            write(d.path(), "settings.json", "five", Some(Some(fresh2))).unwrap_err(),
            CONFLICT
        );
        write(d.path(), "settings.json", "six", None).unwrap();
    }

    /// Unix only: an in-place rewrite that keeps size AND modification time is still noticed, through ctime and the inode.
    /// On Windows there is no inode and "ctime" is the creation time, so that one edit is invisible there (a known blind
    /// spot, in the README): the page's own saves are never affected, only a same-size, same-mtime outside edit.
    #[cfg(unix)]
    #[test]
    fn compare_and_swap_notices_an_edit_that_keeps_size_and_mtime() {
        let d = tempfile::tempdir().unwrap();
        let fresh = compare_and_swap_basics(d.path());
        let p = d.path().join("settings.json");
        let mt = fs::metadata(&p).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&p, "TWO").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(mt)
            .unwrap();
        let after = stat(d.path(), "settings.json").unwrap().unwrap();
        assert_eq!((after.size, after.mtime_us), (fresh.size, fresh.mtime_us));
        assert_ne!(after, fresh, "ctime (or inode) tells the two apart");
        assert_eq!(
            write(d.path(), "settings.json", "four", Some(Some(fresh))).unwrap_err(),
            CONFLICT
        );
        write(d.path(), "settings.json", "five", None).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_file_is_refused_and_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "settings.json", "a", None).unwrap();
        let p = d.path().join("settings.json");
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let e = write(d.path(), "settings.json", "b", None).unwrap_err();
        assert!(e.contains("read-only"), "{e}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "a");
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }

    #[test]
    fn transient_errors_are_retried_with_backoff_and_others_are_not() {
        use std::io::{Error, ErrorKind};
        let mut slept = Vec::new();
        let mut n = 0;
        let r = retry_transient(
            || {
                n += 1;
                if n < 4 {
                    Err(Error::from(ErrorKind::PermissionDenied))
                } else {
                    Ok(n)
                }
            },
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r.unwrap(), 4);
        assert_eq!(slept, vec![20, 50, 100]);
        // gives up after five retries
        let mut slept = Vec::new();
        let r: std::io::Result<()> = retry_transient(
            || Err(Error::from(ErrorKind::PermissionDenied)),
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert!(r.is_err());
        assert_eq!(slept, vec![20, 50, 100, 200, 400]);
        // an error that is not transient is returned at once
        let mut slept = Vec::new();
        let r: std::io::Result<()> = retry_transient(
            || Err(Error::from(ErrorKind::NotFound)),
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert!(r.is_err() && slept.is_empty());
        #[cfg(windows)]
        {
            assert!(is_transient(&Error::from_raw_os_error(32)));
            assert!(is_transient(&Error::from_raw_os_error(5)));
        }
    }

    // ---- stamps survive JSON exactly

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    #[test]
    fn two_hundred_thousand_random_stamps_come_back_identical_through_json() {
        let mut r = XorShift(0x9E37_79B9_7F4A_7C15);
        for i in 0..200_000u32 {
            let stamp = Stamp {
                size: r.next() % (1u64 << 40),
                // realistic file times: 2001 .. 2100, any microsecond; also the odd far-past and far-future one
                mtime_us: if i % 1000 == 0 {
                    -((r.next() % (1 << 50)) as i64)
                } else {
                    1_000_000_000_000_000 + (r.next() % 3_000_000_000_000_000) as i64
                },
                ctime_us: 1_000_000_000_000_000 + (r.next() % 3_000_000_000_000_000) as i64,
                ino: (r.next() % (1u64 << 60)).to_string(),
            };
            let json = serde_json::to_string(&stamp).unwrap();
            let back: Stamp = serde_json::from_str(&json).unwrap();
            assert_eq!(back, stamp, "{json}");
            // the page parses it with JSON.parse (a double) and writes it back: integers below 2^53 are exact there
            assert!(
                stamp.mtime_us.unsigned_abs() < (1u64 << 53)
                    && stamp.ctime_us.unsigned_abs() < (1u64 << 53)
            );
            let via_f64 = stamp.mtime_us as f64 as i64;
            assert_eq!(via_f64, stamp.mtime_us);
        }
    }

    /// Save after save with the stamp the previous call returned (after a trip through JSON, as the page does): never a conflict.
    #[test]
    fn save_after_save_with_the_returned_stamp_never_conflicts() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "settings.json", "{\"tasks\":[]}", Some(None)).unwrap();
        let mut seen = stat(d.path(), "settings.json").unwrap();
        for i in 0..2000 {
            let seen_json = serde_json::to_string(&seen).unwrap();
            let expected: Option<Stamp> = serde_json::from_str(&seen_json).unwrap();
            write(
                d.path(),
                "settings.json",
                &format!("{{\"tasks\":[],\"n\":{i}}}"),
                Some(expected),
            )
            .unwrap_or_else(|e| panic!("iteration {i}: {e}"));
            seen = stat(d.path(), "settings.json").unwrap();
        }
        assert_eq!(
            read(d.path(), "settings.json").unwrap().unwrap(),
            "{\"tasks\":[],\"n\":1999}"
        );
    }
}
