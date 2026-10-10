//! "The computer slept" from the Rust tick thread, which (unlike a hidden webview) is not throttled.
//!
//! Two clocks are read on every tick: one that PAUSES while the machine sleeps ("awake") and one that keeps running
//! ("real": CLOCK_BOOTTIME on Linux, CLOCK_MONOTONIC on macOS, which counts sleep). While the machine sleeps the real clock
//! moves on and the awake clock does not, so their difference jumps; a wall-clock step (the user or NTP moving the clock)
//! changes neither of them, so it is NOT mistaken for sleep. Where only one monotonic clock is available (Windows here), a
//! gap of more than 30 s between two ticks of an unthrottled thread is taken as a suspend.
//! tao/Tauri expose no suspend notification, so this is the detection; it is checked with an injectable clock below.

use serde::Serialize;

pub const DRIFT_MS: u64 = 10_000;
pub const STALL_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Milliseconds of a clock that stops while the machine sleeps.
    pub awake_ms: u64,
    /// Milliseconds of a clock that keeps running while the machine sleeps.
    pub real_ms: u64,
    /// Wall clock, ms since the Unix epoch (only reported, never used to decide).
    pub wall_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slept {
    /// The wall-clock time of the last tick before the sleep: the study session ends there.
    pub at: i64,
    pub slept_ms: u64,
}

#[derive(Default)]
pub struct SleepDetector {
    last: Option<Sample>,
}

impl SleepDetector {
    pub fn observe(&mut self, s: Sample) -> Option<Slept> {
        let prev = self.last.replace(s)?;
        let d_real = s.real_ms.saturating_sub(prev.real_ms);
        let d_awake = s.awake_ms.saturating_sub(prev.awake_ms);
        let drift = d_real.saturating_sub(d_awake);
        if drift > DRIFT_MS {
            Some(Slept { at: prev.wall_ms, slept_ms: drift })
        } else if d_real > STALL_MS {
            Some(Slept { at: prev.wall_ms, slept_ms: d_real })
        } else {
            None
        }
    }
}

#[cfg(unix)]
fn clock_ms(id: libc::clockid_t) -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a valid, writable timespec and `id` is a clock id defined by libc for this platform.
    let ok = unsafe { libc::clock_gettime(id, &mut ts) } == 0;
    if ok {
        (ts.tv_sec as u64) * 1000 + (ts.tv_nsec as u64) / 1_000_000
    } else {
        0
    }
}

/// The real clocks of this machine.
pub struct SystemClocks {
    #[cfg(not(unix))]
    start: std::time::Instant,
}

impl SystemClocks {
    pub fn new() -> Self {
        SystemClocks {
            #[cfg(not(unix))]
            start: std::time::Instant::now(),
        }
    }

    pub fn sample(&self) -> Sample {
        let wall_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        #[cfg(target_os = "macos")]
        let (awake_ms, real_ms) = (clock_ms(libc::CLOCK_UPTIME_RAW), clock_ms(libc::CLOCK_MONOTONIC));
        #[cfg(all(unix, not(target_os = "macos")))]
        let (awake_ms, real_ms) = (clock_ms(libc::CLOCK_MONOTONIC), {
            #[cfg(any(target_os = "linux", target_os = "android"))]
            {
                clock_ms(libc::CLOCK_BOOTTIME)
            }
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            {
                clock_ms(libc::CLOCK_MONOTONIC)
            }
        });
        #[cfg(not(unix))]
        let (awake_ms, real_ms) = {
            let e = self.start.elapsed().as_millis() as u64;
            (e, e)
        };
        Sample { awake_ms, real_ms, wall_ms }
    }
}

impl Default for SystemClocks {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(awake: u64, real: u64, wall: i64) -> Sample {
        Sample { awake_ms: awake, real_ms: real, wall_ms: wall }
    }

    #[test]
    fn normal_ticks_are_quiet() {
        let mut d = SleepDetector::default();
        assert_eq!(d.observe(s(0, 0, 1_000_000)), None);
        for i in 1..50u64 {
            assert_eq!(d.observe(s(i * 2000, i * 2000, 1_000_000 + (i * 2000) as i64)), None);
        }
    }

    #[test]
    fn sleep_is_the_real_clock_running_ahead_of_the_awake_clock() {
        let mut d = SleepDetector::default();
        d.observe(s(10_000, 10_000, 5_000_000));
        // slept for one hour: awake advanced 2 s, real advanced 3602 s, wall advanced 3602 s
        let e = d.observe(s(12_000, 3_612_000, 5_000_000 + 3_602_000)).unwrap();
        assert_eq!(e.at, 5_000_000, "the session ends at the last tick before the sleep");
        assert_eq!(e.slept_ms, 3_600_000);
        assert_eq!(d.observe(s(14_000, 3_614_000, 5_000_000 + 3_604_000)), None, "quiet again afterwards");
    }

    #[test]
    fn a_forward_clock_step_is_not_a_sleep() {
        let mut d = SleepDetector::default();
        d.observe(s(0, 0, 1_000));
        // the user (or NTP) moved the wall clock forward a day; both monotonic clocks advanced 2 s
        assert_eq!(d.observe(s(2_000, 2_000, 1_000 + 86_400_000)), None);
        assert_eq!(d.observe(s(4_000, 4_000, 1_000 + 86_400_000 + 2_000)), None);
    }

    #[test]
    fn a_backward_clock_step_is_not_a_sleep() {
        let mut d = SleepDetector::default();
        d.observe(s(0, 0, 10_000_000));
        assert_eq!(d.observe(s(2_000, 2_000, 1_000)), None);
    }

    #[test]
    fn without_a_second_clock_a_long_stall_counts_as_a_suspend() {
        let mut d = SleepDetector::default();
        d.observe(s(0, 0, 7_000));
        let e = d.observe(s(120_000, 120_000, 127_000)).unwrap();
        assert_eq!((e.at, e.slept_ms), (7_000, 120_000));
    }

    #[test]
    fn small_jitter_and_brief_stalls_are_ignored() {
        let mut d = SleepDetector::default();
        d.observe(s(0, 0, 0));
        assert_eq!(d.observe(s(9_000, 9_500, 9_500)), None, "a 0.5 s difference");
        assert_eq!(d.observe(s(9_000 + 25_000, 9_500 + 25_000, 34_500)), None, "a 25 s stall is under the limit");
    }

    #[test]
    fn the_system_clocks_run_forward() {
        let c = SystemClocks::new();
        let a = c.sample();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let b = c.sample();
        assert!(b.awake_ms >= a.awake_ms && b.real_ms >= a.real_ms && b.real_ms > a.real_ms.saturating_sub(1));
        let mut d = SleepDetector::default();
        d.observe(a);
        assert_eq!(d.observe(b), None);
    }
}
