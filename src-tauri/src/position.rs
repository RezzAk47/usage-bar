//! Where the popup goes. Pure maths on physical pixels, so it is tested without any window.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Where the popup goes when the OS does not say where the tray icon is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    TopRight,
    BottomRight,
}

/// The corner nearest the OS convention for the notification area: bottom right on Windows, top right elsewhere.
pub fn fallback_corner(windows: bool) -> Corner {
    if windows {
        Corner::BottomRight
    } else {
        Corner::TopRight
    }
}

/// A tray rectangle of zero size (Windows 11 overflow flyout, some Linux trays) tells nothing: treat it as unknown.
pub fn usable_icon(r: Option<Rect>) -> Option<Rect> {
    r.filter(|r| r.w > 0 && r.h > 0)
}

pub const POPUP_W: i32 = 420;
pub const POPUP_MAX_H: i32 = 640;
pub const POPUP_MIN_H: i32 = 320;

/// Logical height of the popup: 640, or less on a short screen (never under 320), leaving the margin above and below.
/// `work_h_physical` is the height of the work area in physical pixels.
pub fn popup_height_logical(work_h_physical: i32, scale: f64, margin_logical: i32) -> i32 {
    let avail = (work_h_physical as f64 / scale.max(0.5)).floor() as i32 - 2 * margin_logical;
    avail.clamp(POPUP_MIN_H, POPUP_MAX_H)
}

/// Logical width: 420, or less when the work area is narrower than that.
pub fn popup_width_logical(work_w_physical: i32, scale: f64, margin_logical: i32) -> i32 {
    let avail = (work_w_physical as f64 / scale.max(0.5)).floor() as i32 - 2 * margin_logical;
    avail.clamp(280, POPUP_W)
}

/// Next to the tray icon (below it when the icon is in the top half of the work area, above it otherwise), centred on the
/// icon, then clamped into the work area. `icon = None` (Linux trays do not report where they are) puts the window at the
/// corner given by `fallback` (bottom right on Windows, top right elsewhere).
pub fn popup_position(icon: Option<Rect>, work: Rect, win_w: i32, win_h: i32, margin: i32, fallback: Corner) -> (i32, i32) {
    let min_x = work.x + margin;
    let max_x = (work.x + work.w - win_w - margin).max(min_x);
    let min_y = work.y + margin;
    let max_y = (work.y + work.h - win_h - margin).max(min_y);
    match icon {
        None => (max_x, if fallback == Corner::BottomRight { max_y } else { min_y }),
        Some(i) => {
            let x = i.x + i.w / 2 - win_w / 2;
            let center_y = i.y + i.h / 2;
            let y = if center_y < work.y + work.h / 2 { i.y + i.h + margin } else { i.y - win_h - margin };
            (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORK: Rect = Rect { x: 0, y: 25, w: 1920, h: 1055 }; // a Mac menu bar 25 px high

    #[test]
    fn mac_style_icon_at_the_top_puts_the_window_below() {
        let icon = Rect { x: 1500, y: 0, w: 30, h: 24 };
        let (x, y) = popup_position(Some(icon), WORK, 420, 640, 8, Corner::TopRight);
        assert_eq!(x, 1500 + 15 - 210);
        assert_eq!(y, 25 + 8, "below the icon, but never inside the menu bar (work area starts at 25)");
    }

    #[test]
    fn windows_style_icon_at_the_bottom_puts_the_window_above() {
        let work = Rect { x: 0, y: 0, w: 1920, h: 1040 }; // taskbar 40 px at the bottom
        let icon = Rect { x: 1500, y: 1042, w: 24, h: 36 };
        let (x, y) = popup_position(Some(icon), work, 420, 640, 8, Corner::TopRight);
        assert_eq!(x, 1500 + 12 - 210);
        assert_eq!(y, 1040 - 640 - 8, "above the taskbar: the bottom of the window stays inside the work area");
    }

    #[test]
    fn clamped_to_the_right_edge_and_to_the_left_edge() {
        let (x, _) = popup_position(Some(Rect { x: 1900, y: 0, w: 20, h: 24 }), WORK, 420, 640, 8, Corner::TopRight);
        assert_eq!(x, 1920 - 420 - 8);
        let (x, _) = popup_position(Some(Rect { x: 0, y: 0, w: 20, h: 24 }), WORK, 420, 640, 8, Corner::TopRight);
        assert_eq!(x, 8);
    }

    #[test]
    fn a_short_screen_keeps_the_window_inside_the_work_area() {
        let work = Rect { x: 0, y: 0, w: 1366, h: 560 };
        let (_, y) = popup_position(Some(Rect { x: 1300, y: 570, w: 20, h: 30 }), work, 420, 640, 8, Corner::TopRight);
        assert_eq!(y, 8, "taller than the screen: top aligned, never off the top");
    }

    #[test]
    fn a_second_monitor_with_a_negative_origin() {
        let work = Rect { x: -1920, y: 0, w: 1920, h: 1040 };
        let (x, y) = popup_position(Some(Rect { x: -100, y: 1042, w: 24, h: 36 }), work, 420, 640, 8, Corner::TopRight);
        assert!(x >= -1920 + 8 && x + 420 <= 0 - 8, "x = {x}");
        assert_eq!(y, 1040 - 640 - 8);
    }

    #[test]
    fn unknown_icon_position_falls_back_to_the_top_right() {
        assert_eq!(popup_position(None, WORK, 420, 640, 8, Corner::TopRight), (1920 - 420 - 8, 25 + 8));
    }

    #[test]
    fn a_window_wider_than_the_work_area_does_not_panic() {
        let work = Rect { x: 0, y: 0, w: 300, h: 300 };
        assert_eq!(popup_position(None, work, 420, 640, 8, Corner::TopRight), (8, 8));
    }

    #[test]
    fn height_fits_short_screens_and_scaling() {
        // a 1920x1080 screen at 100%: the full 640
        assert_eq!(popup_height_logical(1040, 1.0, 8), 640);
        // 1366x768 logical at 125% (physical 1707x960, taskbar ~50 px): 910 / 1.25 = 728 logical -> still 640
        assert_eq!(popup_height_logical(910, 1.25, 8), 640);
        // a 1366x768 PHYSICAL panel at 125% (logical 1093x614): work area 728 px high = 582 logical -> 582 - 16 = 566
        assert_eq!(popup_height_logical(728, 1.25, 8), 566);
        // 1280x720 at 150%: 680 physical = 453 logical -> 437
        assert_eq!(popup_height_logical(680, 1.5, 8), 437);
        // never under 320, even on a tiny or odd scale
        assert_eq!(popup_height_logical(400, 1.0, 8), 384);
        assert_eq!(popup_height_logical(300, 1.0, 8), 320);
        assert_eq!(popup_height_logical(0, 1.0, 8), 320);
        assert_eq!(popup_height_logical(1000, 0.0, 8), 640, "a bad scale factor does not divide by zero");
        // width
        assert_eq!(popup_width_logical(1920, 1.0, 8), 420);
        assert_eq!(popup_width_logical(300, 1.0, 8), 284);
        assert_eq!(popup_width_logical(100, 1.0, 8), 280);
    }

    #[test]
    fn the_window_lands_inside_the_work_area_for_the_short_screen() {
        let work = Rect { x: 0, y: 0, w: 1366, h: 728 }; // physical
        let h = (popup_height_logical(work.h, 1.25, 8) as f64 * 1.25).round() as i32; // physical window height
        let w = (420.0f64 * 1.25).round() as i32;
        let (x, y) = popup_position(Some(Rect { x: 1300, y: 730, w: 30, h: 38 }), work, w, h, 10, Corner::BottomRight);
        assert!(x >= 10 && x + w <= 1366 - 10, "x={x}");
        assert!(y >= 10 && y + h <= 728 - 10, "y={y} h={h}");
    }

    #[test]
    fn an_empty_tray_rectangle_falls_back_to_the_corner_of_the_os_convention() {
        assert_eq!(usable_icon(Some(Rect { x: 0, y: 0, w: 0, h: 0 })), None);
        assert_eq!(usable_icon(Some(Rect { x: 10, y: 10, w: 0, h: 20 })), None);
        assert_eq!(usable_icon(None), None);
        assert!(usable_icon(Some(Rect { x: 0, y: 0, w: 24, h: 24 })).is_some());
        let work = Rect { x: 0, y: 0, w: 1920, h: 1040 };
        assert_eq!(popup_position(None, work, 420, 640, 8, fallback_corner(true)), (1920 - 420 - 8, 1040 - 640 - 8), "Windows: bottom right");
        assert_eq!(popup_position(None, work, 420, 640, 8, fallback_corner(false)), (1920 - 420 - 8, 8), "macOS and Linux: top right");
    }
}
