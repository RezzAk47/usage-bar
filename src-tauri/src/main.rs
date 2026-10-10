// Usage Bar: tray app. No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    usage_bar_lib::run();
}
