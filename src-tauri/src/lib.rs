//! Usage Bar: the Tauri shell. A tray icon (menu bar on macOS, notification area on Windows, indicator on Linux) and one
//! frameless, always-on-top popup that hosts the page in ../dist. The page does all the usage logic (limits, alerts, history);
//! this side owns the OS: the tray, the window, the data folder, notifications and the ONLY network access, which is
//! `fetch_usage`: it reads the credential files, asks the provider and returns a status plus the response. Tokens never
//! leave `usage.rs` / `http.rs`.

mod appserver;
mod appsettings;
mod creds;
mod datadir;
mod files;
mod http;
mod locate;
mod position;
mod project;
mod safe;
mod sleep;
mod usage;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect as TauriRect, State,
    WebviewWindow, WindowEvent,
};

use creds::Provider;
use datadir::Os;
use position::{
    fallback_corner, popup_height_logical, popup_position, popup_width_logical, settled_size,
    usable_icon, Rect,
};

const MARGIN: i32 = 8;

struct AppState {
    data_dir: PathBuf,
    /// When the popup last hid itself because it lost focus: the tray click that caused the blur must not re-open it.
    blurred_at: Mutex<Option<Instant>>,
    /// The tray icon rectangle of the last click (physical pixels), when the OS tells us.
    last_icon: Mutex<Option<Rect>>,
    tray: Mutex<Option<TrayIcon>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    data_dir: String,
    tray_note: Option<&'static str>,
    test_mode: bool,
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn home_dir() -> Option<String> {
    creds::home_for(Os::current(), &env_var)
}

/// Tell the person why the app cannot start (stderr always; a dialog on macOS where a menu bar app has no terminal).
fn refuse_to_start(why: &str) -> ! {
    eprintln!("usage-bar: cannot start: {why}");
    #[cfg(target_os = "macos")]
    {
        let msg = format!("Usage Bar cannot start: {why}.").replace(['\\', '"'], "");
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!("display alert \"Usage Bar\" message \"{msg}\""),
            ])
            .status();
    }
    std::process::exit(1)
}

fn test_mode() -> bool {
    env_var("USAGEBAR_TEST").as_deref() == Some("1")
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    let os = Os::current();
    AppInfo {
        platform: os.name(),
        data_dir: state.data_dir.display().to_string(),
        test_mode: test_mode(),
        tray_note: if os == Os::Linux {
            Some("Linux: tray icons cannot report clicks, so open Usage Bar from the tray icon's menu (Show Usage Bar). The window opens at the top right of the screen. On GNOME the AppIndicator extension is required.")
        } else {
            None
        },
    }
}

/// Runs a file operation on its own thread and gives up after `limit`, so nothing a file does can freeze the tray or the popup.
fn off_main_for<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit)
        .unwrap_or_else(|_| Err("the file did not answer in time".into()))
}

fn off_main<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    off_main_for(Duration::from_secs(5), f)
}

#[tauri::command]
async fn fs_read(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::read(&dir, &name))
}

#[tauri::command]
async fn fs_stat(state: State<'_, AppState>, name: String) -> Result<Option<files::Stamp>, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::stat(&dir, &name))
}

#[tauri::command]
async fn fs_write(
    state: State<'_, AppState>,
    name: String,
    text: String,
    check: bool,
    expected: Option<files::Stamp>,
) -> Result<(), String> {
    let dir = state.data_dir.clone();
    off_main(move || {
        files::write(
            &dir,
            &name,
            &text,
            if check { Some(expected) } else { None },
        )
    })
}

#[tauri::command]
async fn fs_move_aside(
    state: State<'_, AppState>,
    name: String,
    backup_name: String,
) -> Result<String, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::move_aside(&dir, &name, &backup_name))
}

/// `label` is "<menu bar text>\n<tooltip>" (or just a tooltip). The text is shown next to the icon on macOS; the tooltip on every OS.
#[tauri::command]
fn set_tray_label(state: State<AppState>, label: String) {
    let clean =
        |t: &str, n: usize| -> String { t.chars().filter(|c| !c.is_control()).take(n).collect() };
    let (text, tip) = match label.split_once('\n') {
        Some((a, b)) => (clean(a, 24), clean(b, 160)),
        None => (String::new(), clean(&label, 160)),
    };
    if test_mode() {
        eprintln!("usage-bar: tray-label text={text:?} tooltip={tip:?}"); // the verification run reads this
    }
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(&tip));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(&text));
        #[cfg(not(target_os = "macos"))]
        let _ = &text;
    }
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// The one command that touches the network. `provider` is "claude" or "codex"; the answer is a status and the provider's
/// response (a token is never part of it). Runs on a worker thread: the request can take up to 15 s.
#[tauri::command]
async fn fetch_usage(
    state: State<'_, AppState>,
    provider: String,
) -> Result<usage::FetchResult, String> {
    let data_dir = state.data_dir.clone();
    let p = Provider::parse(&provider).ok_or_else(|| "unknown provider".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings = appsettings::load(&data_dir);
        let cfg = usage::Config::from_env(Os::current(), &env_var, &settings);
        let http = http::UreqHttp::with_proxy(cfg.test_mode, cfg.use_system_proxy);
        let res = usage::fetch(p, &cfg, &http);
        if cfg.test_mode {
            // what crossed the IPC boundary, for the verification run to search for secrets
            eprintln!(
                "usage-bar: ipc fetch_usage -> {}",
                serde_json::to_string(&res).unwrap_or_default()
            );
        }
        res
    })
    .await
    .map_err(|_| "the usage request failed".to_string())
}

/// Shows one notification and says whether the OS accepted it (the page counts an alert as sent only on success).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let (title, body) = (
        notification_text(&title, 120),
        notification_text(&body, 240),
    );
    if test_mode() {
        eprintln!("usage-bar: notify {title:?} {body:?}");
        return Ok(());
    }
    let n = app.notification();
    if n.permission_state().map_err(|e| e.to_string())? != PermissionState::Granted
        && n.request_permission().map_err(|e| e.to_string())? != PermissionState::Granted
    {
        return Err("notifications are not allowed".into());
    }
    n.builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Text for a notification: no control characters, and none of `<`, `>`, `&` (some Linux notification daemons render markup).
pub fn notification_text(text: &str, max: usize) -> String {
    let kept: String = text
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '&'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    kept.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Opens the provider's usage page (a fixed address) in the browser. You press the button there yourself.
#[tauri::command]
fn open_usage_page(app: AppHandle, provider: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = match Provider::parse(&provider) {
        Some(Provider::Claude) => "https://claude.ai/settings/usage",
        Some(Provider::Codex) => "https://chatgpt.com/codex/settings/usage",
        None => return Err("unknown provider".into()),
    };
    if test_mode() {
        eprintln!("usage-bar: open-usage-page {provider}");
        return Ok(());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn to_rect(r: &TauriRect, scale: f64) -> Rect {
    let p = r.position.to_physical::<i32>(scale);
    let s = r.size.to_physical::<u32>(scale);
    Rect {
        x: p.x,
        y: p.y,
        w: s.width as i32,
        h: s.height as i32,
    }
}

/// Work area (screen minus menu bar and taskbar) of the monitor that holds the point, else the primary monitor.
fn work_area(app: &AppHandle, around: Option<Rect>) -> Rect {
    let monitor = around
        .and_then(|r| {
            app.monitor_from_point((r.x + r.w / 2) as f64, (r.y + r.h / 2) as f64)
                .ok()
                .flatten()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                w: a.size.width as i32,
                h: a.size.height as i32,
            }
        }
        None => Rect {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        },
    }
}

/// Sizes the popup for the screen it will be on (640 high, less on a short work area, never under 320) and puts it next to
/// the tray icon, or in the corner nearest the OS convention when the icon position is unknown or empty.
fn size_and_place(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    let icon = usable_icon(icon);
    let work = work_area(app, icon);
    let scale = win.scale_factor().unwrap_or(1.0);
    let (w, h) = (
        popup_width_logical(work.w, scale, MARGIN),
        popup_height_logical(work.h, scale, MARGIN),
    );
    let _ = win.set_size(LogicalSize::new(w as f64, h as f64));
    let requested = (
        (w as f64 * scale).round() as i32,
        (h as f64 * scale).round() as i32,
    );
    let size = settled_size(
        win.outer_size()
            .ok()
            .map(|s| (s.width as i32, s.height as i32)),
        requested,
    );
    let margin = (MARGIN as f64 * scale).round() as i32;
    let (x, y) = popup_position(
        icon,
        work,
        size.0,
        size.1,
        margin,
        fallback_corner(Os::current() == Os::Windows),
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn place_and_show(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    size_and_place(app, win, icon);
    let _ = win.show();
    let _ = win.set_focus();
    // mixed-DPI setups: the window may have moved to a screen with another scale factor, which changes its physical size
    size_and_place(app, win, icon);
    let _ = app.emit("popup-shown", ());
}

/// How long after the popup hid itself on blur a tray click is ignored. The click that caused the blur hides the popup on
/// mouse-DOWN and the toggle arrives on mouse-UP, so a click held longer than this would re-open it. 400 ms covers a slow click.
const BLUR_SUPPRESS_MS: u64 = 400;

fn blur_suppresses(since_blur: Duration) -> bool {
    since_blur < Duration::from_millis(BLUR_SUPPRESS_MS)
}

fn toggle_popup(app: &AppHandle, icon: Option<Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(t) = *state.blurred_at.lock().unwrap() {
        if blur_suppresses(t.elapsed()) {
            return; // this click is the one that made the popup lose focus and hide
        }
    }
    let icon = icon.or(*state.last_icon.lock().unwrap());
    place_and_show(app, &win, icon);
}

/// The tray icon for Windows and Linux: mid-grey, because the panel colour is unknown (tests check its contrast on white and near-black).
const TRAY_MID: &[u8] = include_bytes!("../icons/tray-mid.png");

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Usage Bar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let template = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    let mid = Image::from_bytes(TRAY_MID)?;
    let os = Os::current();
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Usage Bar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let state = app.state::<AppState>();
                let icon = *state.last_icon.lock().unwrap();
                if let Some(win) = app.get_webview_window("main") {
                    place_and_show(app, &win, icon);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = app
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let r = to_rect(&rect, scale);
                *app.state::<AppState>().last_icon.lock().unwrap() = Some(r);
                toggle_popup(app, Some(r));
            }
        });
    b = match os {
        // macOS wants a black template image that the system tints for light and dark menu bars
        Os::Mac => b.icon(template).icon_as_template(true),
        // Windows and Linux panels can be light or dark and the app cannot tell: a mid-grey glyph reads on both
        _ => b.icon(mid),
    };
    let tray = b.build(app)?;
    *app.state::<AppState>().tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn run() {
    // A panic message could quote data; print only where it happened.
    std::panic::set_hook(Box::new(|info| {
        if let Some(l) = info.location() {
            eprintln!("usage-bar: internal error at {}:{}", l.file(), l.line());
        }
    }));
    let os = Os::current();
    let data_dir = match datadir::default_data_dir(os, &env_var, home_dir().as_deref()) {
        Ok(d) => d,
        Err(why) => refuse_to_start(&why),
    };

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_popup(app, None);
        }));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            data_dir,
            blurred_at: Mutex::new(None),
            last_icon: Mutex::new(None),
            tray: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            fs_read,
            fs_stat,
            fs_write,
            fs_move_aside,
            set_tray_label,
            hide_popup,
            quit_app,
            fetch_usage,
            notify,
            open_usage_page
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon
            build_tray(app.handle())?;
            // a crash in the middle of a write leaves a temp file behind: remove the old ones
            let n = files::clean_stale_temp(
                &app.state::<AppState>().data_dir,
                std::time::SystemTime::now(),
                Duration::from_secs(60),
            );
            if n > 0 {
                eprintln!("usage-bar: removed {n} stale temp file(s)");
            }
            eprintln!(
                "usage-bar: tray icon created; data folder {}",
                app.state::<AppState>().data_dir.display()
            );
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        *handle.state::<AppState>().blurred_at.lock().unwrap() =
                            Some(Instant::now());
                        let _ = w.hide();
                    }
                });
            }
            // the page polls the files on this beat (cheap: one stat per file when nothing changed)
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let clocks = sleep::SystemClocks::new();
                let mut detector = sleep::SleepDetector::default();
                detector.observe(clocks.sample());
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    // the machine slept: tell the page when the last tick before it was, so the study timer stops there
                    if let Some(slept) = detector.observe(clocks.sample()) {
                        let _ = handle.emit("slept", slept);
                    }
                    let _ = handle.emit("tick", ());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Usage Bar")
        .run(|_app, event| {
            // a tray app keeps running with no window
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod log_guard {
    /// Why this exists: ureq, rustls and tauri write `log` records, and a Trace record of a request can include header values.
    /// The `log` crate is compiled with max_level_off, and no crate that installs or prints logs may enter the lock file.
    #[test]
    fn logging_is_compiled_out() {
        assert_eq!(
            log::STATIC_MAX_LEVEL,
            log::LevelFilter::Off,
            "keep `max_level_off` on the log dependency in Cargo.toml"
        );
    }

    #[test]
    fn no_logger_crate_is_in_the_lock_file() {
        let lock = include_str!("../Cargo.lock");
        let banned = [
            "tauri-plugin-log",
            "env_logger",
            "fern",
            "tracing-subscriber",
            "flexi_logger",
            "simplelog",
            "pretty_env_logger",
            "stderrlog",
        ];
        let found: Vec<&str> = banned
            .iter()
            .copied()
            .filter(|b| {
                lock.lines()
                    .any(|l| l.trim_end() == format!("name = \"{b}\""))
            })
            .collect();
        assert!(found.is_empty(), "logger crate(s) {found:?} in Cargo.lock: a logger could print request headers including the Authorization token. Remove them or review the guard on purpose.");
    }
}

#[cfg(test)]
mod shell_tests {
    use super::*;

    #[test]
    fn a_stuck_file_operation_does_not_block_the_caller() {
        let started = std::time::Instant::now();
        let r: Result<u8, String> = off_main_for(Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_secs(3)); // a lock wait, a slow disk
            Ok(1)
        });
        assert!(r.is_err(), "gave up instead of waiting");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the caller was released after the limit, not after the file"
        );
    }

    #[test]
    fn a_quick_file_operation_returns_its_value() {
        assert_eq!(
            off_main_for(Duration::from_secs(2), || Ok::<_, String>(7)),
            Ok(7)
        );
        assert_eq!(
            off_main_for::<u8>(Duration::from_secs(2), || Err("disk full".into())),
            Err("disk full".to_string())
        );
    }

    /// WCAG relative luminance of an sRGB channel triple.
    fn luminance(r: u8, g: u8, b: u8) -> f64 {
        let lin = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    #[test]
    fn the_windows_linux_tray_icon_is_visible_on_light_and_dark_panels() {
        let img = tauri::image::Image::from_bytes(TRAY_MID).expect("tray-mid.png decodes");
        let (mut n, mut worst_white, mut worst_dark) = (0, f64::MAX, f64::MAX);
        for px in img.rgba().chunks(4).filter(|p| p[3] >= 200) {
            let l = luminance(px[0], px[1], px[2]);
            n += 1;
            worst_white = worst_white.min((1.05) / (l + 0.05));
            worst_dark = worst_dark.min((l + 0.05) / (luminance(26, 26, 26) + 0.05));
        }
        assert!(n >= 100, "the glyph has opaque pixels (found {n})");
        assert!(
            worst_white >= 3.0,
            "contrast on a white panel is {worst_white:.2}"
        );
        assert!(
            worst_dark >= 3.0,
            "contrast on a near-black panel is {worst_dark:.2}"
        );
    }

    #[test]
    fn notification_text_has_no_markup_or_control_characters() {
        assert_eq!(
            notification_text("<b>Fix</b> & <a href=x>click</a>\n\u{7}done", 100),
            "bFix/b a href=xclick/a done"
        );
        assert_eq!(
            notification_text(&"x".repeat(500), 120).chars().count(),
            120
        );
        assert_eq!(notification_text("  a   b  ", 10), "a b");
    }
}

#[cfg(test)]
mod blur_tests {
    use super::*;

    #[test]
    fn a_click_held_300_ms_after_the_blur_is_still_the_same_click() {
        assert!(blur_suppresses(Duration::from_millis(0)));
        assert!(blur_suppresses(Duration::from_millis(300)));
        assert!(blur_suppresses(Duration::from_millis(399)));
    }

    #[test]
    fn a_later_click_opens_the_popup() {
        assert!(!blur_suppresses(Duration::from_millis(400)));
        assert!(!blur_suppresses(Duration::from_secs(5)));
    }
}
