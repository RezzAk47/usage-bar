//! Where the usage bar data files live. Pure: the OS and the environment are passed in, so every OS is tested on any OS.

use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Os::Mac => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
        }
    }
}

fn trim_end(p: &str, sep: char) -> &str {
    if p.len() > 1 && p.ends_with(sep) {
        &p[..p.len() - 1]
    } else {
        p
    }
}

fn is_absolute(p: &str, os: Os) -> bool {
    match os {
        Os::Windows => {
            let b = p.as_bytes();
            (b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && (b[2] == b'\\' || b[2] == b'/'))
                || p.starts_with("\\\\")
        }
        _ => p.starts_with('/'),
    }
}

/// 1. USAGEBAR_DATA_DIR (every test and manual run sets it)
/// 2. macOS ~/Library/Application Support/UsageBar, Windows %APPDATA%\UsageBar,
///    Linux ${XDG_DATA_HOME:-~/.local/share}/UsageBar (an XDG_DATA_HOME that is not absolute is ignored).
///
/// Err when the folder would have to be built from a home folder that does not exist (never the current folder).
pub fn default_data_dir(
    os: Os,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(o) = env("USAGEBAR_DATA_DIR") {
        if !o.trim().is_empty() {
            return Ok(PathBuf::from(o));
        }
    }
    let no_home = || {
        "no home folder found (HOME / USERPROFILE is not set), so the data folder cannot be chosen"
            .to_string()
    };
    let sep = if os == Os::Windows { '\\' } else { '/' };
    let h = home.map(|h| trim_end(h, sep));
    let s = match os {
        Os::Mac => format!(
            "{}/Library/Application Support/UsageBar",
            h.ok_or_else(no_home)?
        ),
        Os::Windows => {
            let appdata = match env("APPDATA").filter(|a| !a.trim().is_empty()) {
                Some(a) => a,
                None => format!("{}\\AppData\\Roaming", h.ok_or_else(no_home)?),
            };
            format!("{}\\UsageBar", trim_end(&appdata, '\\'))
        }
        Os::Linux => {
            let base = match env("XDG_DATA_HOME") {
                Some(x) if is_absolute(&x, Os::Linux) => trim_end(&x, '/').to_string(),
                _ => format!("{}/.local/share", h.ok_or_else(no_home)?),
            };
            format!("{base}/UsageBar")
        }
    };
    Ok(PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn mac() {
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[]), Some("/Users/ann")),
            Ok(PathBuf::from(
                "/Users/ann/Library/Application Support/UsageBar"
            ))
        );
    }

    #[test]
    fn windows_uses_appdata_then_profile() {
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, Some("C:\\Users\\Ann")),
            Ok(PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"))
        );
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming\\")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, Some("C:\\Users\\Ann")),
            Ok(PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"))
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[]), Some("C:\\Users\\Ann")),
            Ok(PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"))
        );
    }

    #[test]
    fn linux_uses_xdg_when_absolute() {
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[]), Some("/home/ann")),
            Ok(PathBuf::from("/home/ann/.local/share/UsageBar"))
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "/data/xdg")]),
                Some("/home/ann")
            ),
            Ok(PathBuf::from("/data/xdg/UsageBar"))
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "relative/dir")]),
                Some("/home/ann")
            ),
            Ok(PathBuf::from("/home/ann/.local/share/UsageBar"))
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "")]),
                Some("/home/ann/")
            ),
            Ok(PathBuf::from("/home/ann/.local/share/UsageBar"))
        );
    }

    #[test]
    fn override_wins_everywhere() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            assert_eq!(
                default_data_dir(os, &env(&[("USAGEBAR_DATA_DIR", "/tmp/x")]), Some("/h")),
                Ok(PathBuf::from("/tmp/x"))
            );
        }
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("USAGEBAR_DATA_DIR", "  ")]), Some("/h")),
            Ok(PathBuf::from("/h/.local/share/UsageBar"))
        );
    }

    #[test]
    fn no_home_is_an_error_not_the_current_folder() {
        for os in [Os::Mac, Os::Linux] {
            let r = default_data_dir(os, &env(&[]), None);
            assert!(r.is_err(), "{os:?}: {r:?}");
        }
        // Windows without APPDATA and without a home
        assert!(default_data_dir(Os::Windows, &env(&[]), None).is_err());
        // an explicit location still works without a home
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "/data/x")]), None),
            Ok(PathBuf::from("/data/x/UsageBar"))
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[("APPDATA", "C:\\A")]), None),
            Ok(PathBuf::from("C:\\A\\UsageBar"))
        );
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[("USAGEBAR_DATA_DIR", "/t")]), None),
            Ok(PathBuf::from("/t"))
        );
    }
}
