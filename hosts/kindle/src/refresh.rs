//! E-ink refresh policy and the external FBInk process adapter.
//!
//! FBInk is intentionally not linked into this MIT binary. The host writes
//! `/dev/fb0`; an independently installed FBInk CLI performs the model-
//! specific update ioctl. This matters on the PW5's MediaTek display stack,
//! where guessing an MXCFB structure is unsafe.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::damage::{Rect, merge_all};

const MOTION_WINDOW: Duration = Duration::from_millis(120);
const CLEANUP_QUIET: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waveform {
    Auto,
    Du,
    A2,
    Gc16,
}

impl Waveform {
    fn as_fbink(self) -> &'static str {
        match self {
            Self::Auto => "AUTO",
            Self::Du => "DU",
            Self::A2 => "A2",
            Self::Gc16 => "GC16",
        }
    }

    pub fn parse_motion(value: &str) -> Result<Self> {
        match value.to_ascii_uppercase().as_str() {
            "DU" => Ok(Self::Du),
            "A2" => Ok(Self::A2),
            _ => bail!("motion waveform must be DU or A2 (got {value:?})"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshKind {
    Initial,
    Motion,
    QuietCleanup,
    GhostCleanup,
    Forced,
    Static,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefreshRequest {
    pub rect: Rect,
    pub waveform: Waveform,
    pub flash: bool,
    pub kind: RefreshKind,
}

pub struct RefreshPolicy {
    panel: Rect,
    motion_waveform: Waveform,
    min_present_interval: Duration,
    ghost_update_limit: u32,
    ghost_area_limit: usize,
    started: bool,
    last_damage: Option<Duration>,
    last_present: Option<Duration>,
    cleanup_at: Option<Duration>,
    cleanup_region: Option<Rect>,
    fast_updates: u32,
    fast_area: usize,
}

impl RefreshPolicy {
    pub fn new(
        panel_width: usize,
        panel_height: usize,
        present_hz: u32,
        motion_waveform: Waveform,
        ghost_update_limit: u32,
    ) -> Result<Self> {
        if present_hz == 0 || present_hz > 60 {
            bail!("present rate must be in 1..=60 Hz");
        }
        let panel = Rect {
            x: 0,
            y: 0,
            w: panel_width,
            h: panel_height,
        };
        Ok(Self {
            panel,
            motion_waveform,
            min_present_interval: Duration::from_nanos(1_000_000_000 / present_hz as u64),
            ghost_update_limit: ghost_update_limit.max(1),
            ghost_area_limit: panel_width * panel_height * 6,
            started: false,
            last_damage: None,
            last_present: None,
            cleanup_at: None,
            cleanup_region: None,
            fast_updates: 0,
            fast_area: 0,
        })
    }

    /// Decide whether the latest framebuffer damage should be submitted now.
    /// The caller retains damage while this returns `None`, keeping simulation
    /// at 60Hz independently of the panel present rate.
    pub fn on_damage(
        &mut self,
        now: Duration,
        damage: &[Rect],
        force_full: bool,
    ) -> Option<RefreshRequest> {
        if force_full {
            return Some(self.full(RefreshKind::Forced));
        }
        let damage = merge_all(damage)?;

        if !self.started {
            self.started = true;
            self.last_damage = Some(now);
            self.last_present = Some(now);
            return Some(RefreshRequest {
                rect: damage,
                waveform: Waveform::Auto,
                flash: false,
                kind: RefreshKind::Initial,
            });
        }

        if self.fast_updates >= self.ghost_update_limit || self.fast_area >= self.ghost_area_limit {
            return Some(self.full(RefreshKind::GhostCleanup));
        }

        let moving = self
            .last_damage
            .is_some_and(|last| now.saturating_sub(last) <= MOTION_WINDOW);
        self.last_damage = Some(now);

        if moving {
            self.cleanup_region = Some(match self.cleanup_region {
                Some(previous) => previous.union(damage),
                None => damage,
            });
            self.cleanup_at = Some(now + CLEANUP_QUIET);
            if self
                .last_present
                .is_some_and(|last| now.saturating_sub(last) < self.min_present_interval)
            {
                return None;
            }
            self.last_present = Some(now);
            self.fast_updates += 1;
            self.fast_area = self.fast_area.saturating_add(damage.w * damage.h);
            Some(RefreshRequest {
                rect: damage,
                waveform: self.motion_waveform,
                flash: false,
                kind: RefreshKind::Motion,
            })
        } else {
            self.last_present = Some(now);
            Some(RefreshRequest {
                rect: damage,
                waveform: Waveform::Auto,
                flash: false,
                kind: RefreshKind::Static,
            })
        }
    }

    /// Emit the quiet high-quality pass after motion, even with no new pixels.
    pub fn on_idle(&mut self, now: Duration) -> Option<RefreshRequest> {
        let due = self.cleanup_at.is_some_and(|at| now >= at);
        if !due {
            return None;
        }
        self.cleanup_at = None;
        let rect = self.cleanup_region.take()?;
        self.last_present = Some(now);
        self.fast_updates = 0;
        self.fast_area = 0;
        Some(RefreshRequest {
            rect,
            waveform: Waveform::Gc16,
            flash: true,
            kind: RefreshKind::QuietCleanup,
        })
    }

    fn full(&mut self, kind: RefreshKind) -> RefreshRequest {
        self.started = true;
        self.last_damage = None;
        self.last_present = None;
        self.cleanup_at = None;
        self.cleanup_region = None;
        self.fast_updates = 0;
        self.fast_area = 0;
        RefreshRequest {
            rect: self.panel,
            waveform: Waveform::Gc16,
            flash: true,
            kind,
        }
    }
}

pub struct FbInk {
    path: PathBuf,
    child: Option<Child>,
}

impl FbInk {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if !path.is_file() {
            bail!("FBInk helper {} is missing", path.display());
        }
        Ok(Self { path, child: None })
    }

    /// Reap the preceding helper. A running helper applies backpressure to the
    /// physical present path without slowing PocketJS simulation ticks.
    pub fn ready(&mut self) -> Result<bool> {
        let Some(child) = self.child.as_mut() else {
            return Ok(true);
        };
        let Some(status) = child.try_wait().context("polling FBInk helper")? else {
            return Ok(false);
        };
        self.child = None;
        if !status.success() {
            bail!("FBInk helper exited with {status}");
        }
        Ok(true)
    }

    pub fn submit(&mut self, request: RefreshRequest) -> Result<()> {
        if !self.ready()? {
            bail!("attempted to submit an FBInk update while the previous one is running");
        }
        let Rect { x, y, w, h } = request.rect;
        let region = format!("top={y},left={x},width={w},height={h}");
        let mut command = Command::new(&self.path);
        command
            .arg("-q")
            .arg("-s")
            .arg(region)
            .arg("-W")
            .arg(request.waveform.as_fbink())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if request.flash {
            command.arg("-f");
        }
        log::debug!(
            "kindle refresh: {:?} {:?} {}x{}+{},{}",
            request.kind,
            request.waveform,
            w,
            h,
            x,
            y
        );
        self.child = Some(
            command
                .spawn()
                .with_context(|| format!("starting FBInk {}", self.path.display()))?,
        );
        Ok(())
    }

    /// Wait for the final refresh helper before the device wrapper resumes the
    /// Kindle UI and power management. A nonzero helper status remains a
    /// runtime error, while a wait error leaves the child owned by `Drop` so
    /// the fail-safe kill-and-reap path can still run.
    pub fn finish(&mut self) -> Result<()> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        let status = child.wait().context("waiting for final FBInk helper")?;
        self.child = None;
        if !status.success() {
            bail!("FBInk helper exited with {status}");
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FbInk {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };

        // Drop is the abnormal/early-return path. FBInk is a short-lived,
        // single-process helper, so terminate it and synchronously reap it
        // before control can return to the launcher.
        if let Err(error) = child.kill() {
            log::warn!("kindle refresh: failed to kill outstanding FBInk helper: {error}");
        }
        match child.wait() {
            Ok(status) if !status.success() => {
                log::warn!("kindle refresh: reaped FBInk helper with {status}")
            }
            Ok(_) => {}
            Err(error) => {
                log::error!("kindle refresh: failed to reap outstanding FBInk helper: {error}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: usize, y: usize, w: usize, h: usize) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn first_update_is_conservative_auto() {
        let mut policy = RefreshPolicy::new(100, 200, 30, Waveform::Du, 8).unwrap();
        let request = policy
            .on_damage(Duration::ZERO, &[rect(1, 2, 3, 4)], false)
            .unwrap();
        assert_eq!(request.waveform, Waveform::Auto);
        assert_eq!(request.kind, RefreshKind::Initial);
        assert!(!request.flash);
    }

    #[test]
    fn motion_is_throttled_then_gets_quiet_cleanup() {
        let mut policy = RefreshPolicy::new(100, 200, 30, Waveform::A2, 8).unwrap();
        policy.on_damage(Duration::ZERO, &[rect(0, 0, 5, 5)], false);
        assert!(
            policy
                .on_damage(Duration::from_millis(10), &[rect(5, 0, 5, 5)], false)
                .is_none()
        );
        let motion = policy
            .on_damage(Duration::from_millis(40), &[rect(5, 0, 5, 5)], false)
            .unwrap();
        assert_eq!(motion.waveform, Waveform::A2);
        assert_eq!(motion.kind, RefreshKind::Motion);
        assert!(!motion.flash);
        assert!(policy.on_idle(Duration::from_millis(239)).is_none());
        let cleanup = policy.on_idle(Duration::from_millis(240)).unwrap();
        assert_eq!(cleanup.kind, RefreshKind::QuietCleanup);
        assert_eq!(cleanup.waveform, Waveform::Gc16);
        assert!(cleanup.flash);
        assert_eq!(cleanup.rect, rect(5, 0, 5, 5));
    }

    #[test]
    fn ghost_budget_forces_full_flash() {
        let mut policy = RefreshPolicy::new(100, 200, 60, Waveform::Du, 1).unwrap();
        policy.on_damage(Duration::ZERO, &[rect(0, 0, 5, 5)], false);
        let fast = policy
            .on_damage(Duration::from_millis(20), &[rect(0, 0, 5, 5)], false)
            .unwrap();
        assert_eq!(fast.kind, RefreshKind::Motion);
        let full = policy
            .on_damage(Duration::from_millis(40), &[rect(0, 0, 5, 5)], false)
            .unwrap();
        assert_eq!(full.kind, RefreshKind::GhostCleanup);
        assert_eq!(full.rect, rect(0, 0, 100, 200));
        assert_eq!(full.waveform, Waveform::Gc16);
        assert!(full.flash);
    }

    #[test]
    fn explicit_reload_forces_full_cleanup() {
        let mut policy = RefreshPolicy::new(100, 200, 30, Waveform::Du, 8).unwrap();
        let full = policy
            .on_damage(Duration::ZERO, &[rect(1, 2, 3, 4)], true)
            .unwrap();
        assert_eq!(full.kind, RefreshKind::Forced);
        assert_eq!(full.waveform, Waveform::Gc16);
        assert!(full.flash);
    }

    #[cfg(unix)]
    #[test]
    fn finish_reaps_once_and_preserves_nonzero_status() {
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .spawn()
            .unwrap();
        let mut fbink = FbInk {
            path: PathBuf::from("/bin/sh"),
            child: Some(child),
        };

        let error = fbink.finish().unwrap_err().to_string();
        assert!(error.contains("FBInk helper exited with"));
        assert!(error.contains('7'));
        assert!(fbink.child.is_none());
        assert!(fbink.finish().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn drop_kills_and_reaps_an_active_helper() {
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        let fbink = FbInk {
            path: PathBuf::from("/bin/sleep"),
            child: Some(child),
        };

        drop(fbink);

        // SAFETY: signal 0 only checks whether the captured process id exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}
