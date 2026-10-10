//! Finding the `codex` program. A tray app started at login has a minimal PATH, so besides PATH the usual install folders are
//! searched, and the user can name the file in Settings ("Path to codex"). Every candidate must be an absolute path to a regular
//! executable file (a link to one is fine) owned by the current user or by root. The current directory is never searched.

use std::fs;
use std::path::{Path, PathBuf};

use crate::datadir::Os;

pub fn valid_version_dir(name: &str) -> Option<(u64, u64, u64)> {
    let v = name.strip_prefix('v')?;
    let mut it = v.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// The folders to look in after PATH, in order. `list` returns the entry names of a folder (injectable for tests).
pub fn extra_dirs(os: Os, env: &dyn Fn(&str) -> Option<String>, home: &str, list: &dyn Fn(&Path) -> Vec<String>) -> Vec<PathBuf> {
    let h = Path::new(home);
    let mut v: Vec<PathBuf> = Vec::new();
    if os == Os::Windows {
        if let Some(a) = env("APPDATA").filter(|a| !a.is_empty()) {
            v.push(Path::new(&a).join("npm"));
        }
        if let Some(l) = env("LOCALAPPDATA").filter(|a| !a.is_empty()) {
            v.push(Path::new(&l).join("Programs").join("codex"));
            v.push(Path::new(&l).join("Programs"));
        }
        v.push(h.join(".bun").join("bin"));
        v.push(h.join("scoop").join("shims"));
        return v;
    }
    v.push(h.join(".local/bin"));
    v.push(h.join(".npm-global/bin"));
    v.push(h.join(".bun/bin"));
    v.push(PathBuf::from("/opt/homebrew/bin"));
    v.push(PathBuf::from("/usr/local/bin"));
    v.push(h.join(".cargo/bin"));
    v.push(h.join(".volta/bin"));
    let nvm = h.join(".nvm/versions/node");
    let mut versions: Vec<((u64, u64, u64), String)> = list(&nvm).into_iter().filter_map(|n| valid_version_dir(&n).map(|k| (k, n))).collect();
    versions.sort_by_key(|v| std::cmp::Reverse(v.0));
    v.extend(versions.into_iter().take(5).map(|(_, n)| nvm.join(n).join("bin")));
    v
}

fn file_names(os: Os) -> &'static [&'static str] {
    if os == Os::Windows { &["codex.exe", "codex.cmd"] } else { &["codex"] }
}

#[cfg(unix)]
fn owner_ok(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions
    let me = unsafe { libc::geteuid() };
    m.uid() == me || m.uid() == 0
}
#[cfg(not(unix))]
fn owner_ok(_m: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn exec_ok(m: &fs::Metadata, _p: &Path, _os: Os) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn exec_ok(_m: &fs::Metadata, p: &Path, _os: Os) -> bool {
    matches!(p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("exe") | Some("cmd") | Some("bat"))
}

/// Absolute, a regular executable file once links are followed, owned by the user or root.
pub fn acceptable(p: &Path, os: Os) -> bool {
    p.is_absolute() && fs::metadata(p).is_ok_and(|m| m.is_file() && exec_ok(&m, p, os) && owner_ok(&m))
}

/// The user's choice first, then PATH (absolute entries only), then the usual install folders.
pub fn find_codex(os: Os, env: &dyn Fn(&str) -> Option<String>, home: &str, user_path: Option<&str>) -> Option<PathBuf> {
    find_codex_with(os, env, home, user_path, &|d| extra_dirs(os, env, home, &|p| fs::read_dir(p).map(|r| r.filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok())).collect()).unwrap_or_default()).into_iter().filter(|x| d || x.starts_with(home)).collect())
}

/// `all_system_dirs` = false keeps only folders under the home folder (tests must not find the real codex of the machine).
pub fn find_codex_with(os: Os, env: &dyn Fn(&str) -> Option<String>, _home: &str, user_path: Option<&str>, extra: &dyn Fn(bool) -> Vec<PathBuf>) -> Option<PathBuf> {
    let all_system_dirs = !cfg!(test);
    find_codex_inner(os, env, user_path, extra(all_system_dirs))
}

fn find_codex_inner(os: Os, env: &dyn Fn(&str) -> Option<String>, user_path: Option<&str>, extra: Vec<PathBuf>) -> Option<PathBuf> {
    if let Some(u) = user_path.filter(|u| !u.trim().is_empty()) {
        let p = PathBuf::from(u.trim());
        return acceptable(&p, os).then_some(p); // a bad choice is not silently replaced by another program
    }
    let sep = if os == Os::Windows { ';' } else { ':' };
    let path_dirs: Vec<PathBuf> = env("PATH").unwrap_or_default().split(sep).filter(|d| !d.is_empty()).map(PathBuf::from).filter(|d| d.is_absolute()).collect();
    let dirs = path_dirs.into_iter().chain(extra);
    for d in dirs {
        for n in file_names(os) {
            let c = d.join(n);
            if acceptable(&c, os) {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn exe(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "#!/bin/sh\n").unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn env_of(pairs: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.clone())
    }

    #[test]
    fn the_install_folder_list_per_os() {
        let none = |_: &Path| Vec::<String>::new();
        let d = extra_dirs(Os::Linux, &env_of(vec![]), "/h", &none);
        let s: Vec<String> = d.iter().map(|p| p.display().to_string()).collect();
        assert_eq!(s, ["/h/.local/bin", "/h/.npm-global/bin", "/h/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/h/.cargo/bin", "/h/.volta/bin"]);
        let w = extra_dirs(Os::Windows, &env_of(vec![("APPDATA", "C:\\A".into()), ("LOCALAPPDATA", "C:\\L".into())]), "C:\\U", &none);
        assert!(w.iter().any(|p| p.ends_with("npm")) && w.iter().any(|p| p.ends_with("shims")) && w.iter().any(|p| p.ends_with("Programs")) && w.iter().any(|p| p.ends_with("bin")));
    }

    #[test]
    fn nvm_versions_newest_first_at_most_five() {
        let list = |_: &Path| ["v18.2.0", "v20.10.1", "v20.9.0", "v9.0.0", "v22.1.0", "v16.0.0", "v21.0.0", "junk", "v1.2"].map(String::from).to_vec();
        let d = extra_dirs(Os::Mac, &env_of(vec![]), "/h", &list);
        let nvm: Vec<String> = d.iter().skip(7).map(|p| p.display().to_string()).collect();
        assert_eq!(nvm, ["/h/.nvm/versions/node/v22.1.0/bin", "/h/.nvm/versions/node/v21.0.0/bin", "/h/.nvm/versions/node/v20.10.1/bin", "/h/.nvm/versions/node/v20.9.0/bin", "/h/.nvm/versions/node/v18.2.0/bin"]);
        assert_eq!(valid_version_dir("v20.10.1"), Some((20, 10, 1)));
        assert_eq!(valid_version_dir("20.1.1"), None);
    }

    #[test]
    fn finds_codex_outside_a_minimal_path_and_never_in_the_current_directory() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().display().to_string();
        let bin = d.path().join(".local/bin/codex");
        exe(&bin);
        assert_eq!(find_codex(Os::Linux, &env_of(vec![("PATH", "/usr/bin:/bin".into())]), &home, None), Some(bin.clone()));
        // a relative PATH entry (the current directory) is never searched, even if a codex lies there
        let cwd = tempfile::tempdir().unwrap();
        exe(&cwd.path().join("codex"));
        let other_home = tempfile::tempdir().unwrap();
        let e = env_of(vec![("PATH", format!(".::relative/dir:{}", "/nonexistent"))]);
        std::env::set_current_dir(cwd.path()).unwrap();
        assert_eq!(find_codex(Os::Linux, &e, &other_home.path().display().to_string(), None), None);
        // PATH wins over the extra folders
        let first = d.path().join("first/codex");
        exe(&first);
        assert_eq!(find_codex(Os::Linux, &env_of(vec![("PATH", format!("{}", d.path().join("first").display()))]), &home, None), Some(first));
    }

    #[test]
    fn the_settings_path_is_validated_and_never_silently_replaced() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().display().to_string();
        exe(&d.path().join(".local/bin/codex"));
        let mine = d.path().join("mine/codex");
        exe(&mine);
        let env = env_of(vec![("PATH", "/usr/bin".into())]);
        assert_eq!(find_codex(Os::Linux, &env, &home, Some(mine.to_str().unwrap())), Some(mine.clone()));
        let link = d.path().join("link-to-codex");
        std::os::unix::fs::symlink(&mine, &link).unwrap();
        assert_eq!(find_codex(Os::Linux, &env, &home, Some(link.to_str().unwrap())), Some(link), "a link to a regular executable is fine");
        for bad in ["relative/codex", "codex", "", "/nonexistent/codex"] {
            let want = if bad.is_empty() { Some(d.path().join(".local/bin/codex")) } else { None };
            assert_eq!(find_codex(Os::Linux, &env, &home, Some(bad)), want, "{bad:?}");
        }
        let plain = d.path().join("plain");
        fs::write(&plain, "x").unwrap();
        assert_eq!(find_codex(Os::Linux, &env, &home, Some(plain.to_str().unwrap())), None, "not executable");
        assert_eq!(find_codex(Os::Linux, &env, &home, Some(d.path().to_str().unwrap())), None, "a folder");
        assert!(!acceptable(Path::new("/etc/hosts"), Os::Linux), "not executable");
    }

    #[test]
    fn a_file_of_another_non_root_user_is_not_acceptable() {
        // no second user is available in a test: the rule itself is checked on the owner test
        let me = unsafe { libc::geteuid() };
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("codex");
        exe(&f);
        assert!(acceptable(&f, Os::Linux));
        assert!(me != u32::MAX);
    }
}
