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
            (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || p.starts_with("\\\\")
        }
        _ => p.starts_with('/'),
    }
}

/// 1. USAGEBAR_DATA_DIR (every test and manual run sets it)
/// 2. macOS ~/Library/Application Support/UsageBar, Windows %APPDATA%\UsageBar,
///    Linux ${XDG_DATA_HOME:-~/.local/share}/UsageBar (an XDG_DATA_HOME that is not absolute is ignored).
pub fn default_data_dir(os: Os, env: &dyn Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    if let Some(o) = env("USAGEBAR_DATA_DIR") {
        if !o.trim().is_empty() {
            return PathBuf::from(o);
        }
    }
    let sep = if os == Os::Windows { '\\' } else { '/' };
    let h = trim_end(home, sep);
    let s = match os {
        Os::Mac => format!("{h}/Library/Application Support/UsageBar"),
        Os::Windows => {
            let appdata = env("APPDATA").filter(|a| !a.trim().is_empty()).unwrap_or_else(|| format!("{h}\\AppData\\Roaming"));
            format!("{}\\UsageBar", trim_end(&appdata, '\\'))
        }
        Os::Linux => {
            let base = match env("XDG_DATA_HOME") {
                Some(x) if is_absolute(&x, Os::Linux) => trim_end(&x, '/').to_string(),
                _ => format!("{h}/.local/share"),
            };
            format!("{base}/UsageBar")
        }
    };
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn mac() {
        assert_eq!(default_data_dir(Os::Mac, &env(&[]), "/Users/ann"), PathBuf::from("/Users/ann/Library/Application Support/UsageBar"));
    }

    #[test]
    fn windows_uses_appdata_then_profile() {
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming")]);
        assert_eq!(default_data_dir(Os::Windows, &e, "C:\\Users\\Ann"), PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"));
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming\\")]);
        assert_eq!(default_data_dir(Os::Windows, &e, "C:\\Users\\Ann"), PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"));
        assert_eq!(default_data_dir(Os::Windows, &env(&[]), "C:\\Users\\Ann"), PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\UsageBar"));
    }

    #[test]
    fn linux_uses_xdg_when_absolute() {
        assert_eq!(default_data_dir(Os::Linux, &env(&[]), "/home/ann"), PathBuf::from("/home/ann/.local/share/UsageBar"));
        assert_eq!(default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "/data/xdg")]), "/home/ann"), PathBuf::from("/data/xdg/UsageBar"));
        assert_eq!(default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "relative/dir")]), "/home/ann"), PathBuf::from("/home/ann/.local/share/UsageBar"));
        assert_eq!(default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "")]), "/home/ann/"), PathBuf::from("/home/ann/.local/share/UsageBar"));
    }

    #[test]
    fn override_wins_everywhere() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            assert_eq!(default_data_dir(os, &env(&[("USAGEBAR_DATA_DIR", "/tmp/x")]), "/h"), PathBuf::from("/tmp/x"));
        }
        assert_eq!(default_data_dir(Os::Linux, &env(&[("USAGEBAR_DATA_DIR", "  ")]), "/h"), PathBuf::from("/h/.local/share/UsageBar"));
    }
}
