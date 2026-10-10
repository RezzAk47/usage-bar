fn main() {
    // Only these commands exist for the webview; each one needs an explicit permission in capabilities/default.json.
    let app = tauri_build::AppManifest::new().commands(&[
        "app_info",
        "fs_read",
        "fs_stat",
        "fs_write",
        "fs_move_aside",
        "set_tray_label",
        "hide_popup",
        "quit_app",
        "fetch_usage",
        "notify",
        "open_usage_page",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app)).expect("tauri build failed");
}
