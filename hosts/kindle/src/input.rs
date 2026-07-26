//! Minimal generic Linux evdev multitouch reader. It deliberately consumes
//! the stable kernel event ABI directly, avoiding assumptions about Kindle
//! event node numbers or a vendor input library.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::fs::File;

#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::{Result, bail};

use crate::geometry::Geometry;

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const EV_ABS: u16 = 0x03;
const SYN_REPORT: u16 = 0;
const SYN_DROPPED: u16 = 3;
const BTN_TOUCH: u16 = 0x14a;
const ABS_X: u16 = 0x00;
const ABS_Y: u16 = 0x01;
const ABS_MT_SLOT: u16 = 0x2f;
const ABS_MT_POSITION_X: u16 = 0x35;
const ABS_MT_POSITION_Y: u16 = 0x36;
const ABS_MT_TRACKING_ID: u16 = 0x39;
const MAX_CONTACTS: usize = 8;
const TOUCH_ID_MASK: u32 = 0xff;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AxisRange {
    min: i32,
    max: i32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Contact {
    active: bool,
    id: u32,
    x: i32,
    y: i32,
}

#[derive(Clone, Debug)]
struct TouchState {
    contacts: [Contact; MAX_CONTACTS],
    current_slot: Option<usize>,
    mt: bool,
    sync_lost: bool,
}

impl TouchState {
    fn new(mt: bool) -> Self {
        Self {
            contacts: [Contact::default(); MAX_CONTACTS],
            current_slot: Some(0),
            mt,
            sync_lost: false,
        }
    }

    fn apply(&mut self, type_: u16, code: u16, value: i32) -> bool {
        if type_ == EV_SYN && code == SYN_DROPPED {
            self.contacts.fill(Contact::default());
            self.current_slot = if self.mt { None } else { Some(0) };
            self.sync_lost = true;
            return true;
        }
        if self.sync_lost {
            if type_ == EV_SYN && code == SYN_REPORT {
                self.sync_lost = false;
            }
            return false;
        }

        match (type_, code) {
            (EV_ABS, ABS_MT_SLOT) if self.mt => {
                self.current_slot = usize::try_from(value)
                    .ok()
                    .filter(|slot| *slot < MAX_CONTACTS);
            }
            (EV_ABS, ABS_MT_TRACKING_ID) if self.mt => {
                if let Some(contact) = self
                    .current_slot
                    .and_then(|slot| self.contacts.get_mut(slot))
                {
                    contact.active = value >= 0;
                    if value >= 0 {
                        contact.id = value as u32;
                    }
                }
            }
            (EV_ABS, ABS_MT_POSITION_X) if self.mt => {
                if let Some(contact) = self
                    .current_slot
                    .and_then(|slot| self.contacts.get_mut(slot))
                {
                    contact.x = value;
                }
            }
            (EV_ABS, ABS_MT_POSITION_Y) if self.mt => {
                if let Some(contact) = self
                    .current_slot
                    .and_then(|slot| self.contacts.get_mut(slot))
                {
                    contact.y = value;
                }
            }
            (EV_ABS, ABS_X) if !self.mt => self.contacts[0].x = value,
            (EV_ABS, ABS_Y) if !self.mt => self.contacts[0].y = value,
            (EV_KEY, BTN_TOUCH) if !self.mt => {
                self.contacts[0].active = value != 0;
                self.contacts[0].id = 0;
            }
            (EV_SYN, SYN_REPORT) => {}
            _ => {}
        }
        false
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Calibration {
    swap_xy: bool,
    flip_x: bool,
    flip_y: bool,
}

impl Calibration {
    fn from_env() -> Self {
        let enabled = |name: &str| {
            std::env::var(name)
                .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
                .unwrap_or(false)
        };
        Self {
            swap_xy: enabled("POCKETJS_TOUCH_SWAP_XY"),
            flip_x: enabled("POCKETJS_TOUCH_FLIP_X"),
            flip_y: enabled("POCKETJS_TOUCH_FLIP_Y"),
        }
    }
}

struct Device {
    #[allow(dead_code)]
    path: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    file: File,
    grabbed: bool,
    x_range: AxisRange,
    y_range: AxisRange,
    state: TouchState,
}

impl Device {
    #[cfg(target_os = "linux")]
    fn grab(&mut self) -> Result<()> {
        use std::os::fd::AsRawFd;

        if self.grabbed {
            return Ok(());
        }
        set_evdev_grab(self.file.as_raw_fd(), true)
            .with_context(|| format!("taking exclusive ownership of {}", self.path))?;
        self.grabbed = true;
        log::info!("kindle input: grabbed {} exclusively", self.path);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn grab(&mut self) -> Result<()> {
        bail!("exclusive evdev ownership is only supported on Linux")
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        if !self.grabbed {
            return;
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;

            match set_evdev_grab(self.file.as_raw_fd(), false) {
                Ok(()) => log::info!("kindle input: released exclusive grab on {}", self.path),
                Err(error) => {
                    log::error!(
                        "kindle input: failed to release grab on {}: {error}",
                        self.path
                    )
                }
            }
        }
        self.grabbed = false;
    }
}

pub struct Input {
    devices: Vec<Device>,
    calibration: Calibration,
}

impl Input {
    pub fn discover() -> Result<Self> {
        Ok(Self {
            devices: discover_devices()?,
            calibration: Calibration::from_env(),
        })
    }

    /// Take exclusive ownership of the touchscreen selected by capability
    /// discovery. Probe mode deliberately does not call this method.
    pub fn grab_selected(&mut self) -> Result<()> {
        let Some(device) = self.devices.first_mut() else {
            bail!(
                "PocketJS Kindle PW5 runtime requires a discoverable evdev touchscreen; \
                 no device exposed multitouch X/Y axes or BTN_TOUCH with ABS_X/ABS_Y"
            );
        };
        device.grab()
    }

    pub fn poll_touches(&mut self, geometry: &Geometry) -> Result<Vec<u32>> {
        for device in &mut self.devices {
            read_events(device)?;
        }
        // A Kindle normally has one touchscreen. If firmware exposes the same
        // panel through multiple nodes, using the first capable node avoids
        // duplicate contacts.
        let Some(device) = self.devices.first() else {
            return Ok(Vec::new());
        };
        let mut touches = Vec::new();
        for (slot, contact) in device
            .state
            .contacts
            .iter()
            .enumerate()
            .filter(|(_, contact)| contact.active)
        {
            let (mut panel_x, mut panel_y) = if self.calibration.swap_xy {
                (
                    normalize(contact.y, device.y_range, geometry.panel_w),
                    normalize(contact.x, device.x_range, geometry.panel_h),
                )
            } else {
                (
                    normalize(contact.x, device.x_range, geometry.panel_w),
                    normalize(contact.y, device.y_range, geometry.panel_h),
                )
            };
            if self.calibration.flip_x {
                panel_x = geometry.panel_w - 1 - panel_x;
            }
            if self.calibration.flip_y {
                panel_y = geometry.panel_h - 1 - panel_y;
            }
            let (logical_x, logical_y) = geometry.panel_to_logical(panel_x, panel_y);
            // The framework wire reserves eight bits for contact identity.
            // Linux MT slots are already stable for a contact's lifetime and
            // this host caps them at eight, so they cannot collide the way a
            // truncated kernel tracking id could.
            touches.push(pack_touch(slot as u32, logical_x, logical_y));
        }
        Ok(touches)
    }

    pub fn device_count(&self) -> usize {
        self.devices.len()
    }
}

fn normalize(value: i32, range: AxisRange, extent: usize) -> usize {
    if extent <= 1 || range.max <= range.min {
        return 0;
    }
    let value = value.clamp(range.min, range.max) - range.min;
    let denominator = (range.max - range.min) as i64;
    ((value as i64 * (extent - 1) as i64 + denominator / 2) / denominator) as usize
}

/// framework/src/touch.ts legacy form: `(id:8 << 18) | (y:9 << 9) | x:9`.
fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    debug_assert!(x <= 511 && y <= 511);
    ((id & TOUCH_ID_MASK) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

#[cfg(target_os = "linux")]
fn discover_devices() -> Result<Vec<Device>> {
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let mut paths = std::fs::read_dir("/dev/input")
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("event"))
        })
        .collect::<Vec<_>>();
    paths.sort();

    let mut devices = Vec::new();
    for path in paths {
        let Ok(file) = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)
        else {
            continue;
        };
        let fd = file.as_raw_fd();
        let mt_x = read_abs_range(fd, ABS_MT_POSITION_X);
        let mt_y = read_abs_range(fd, ABS_MT_POSITION_Y);
        let single_x = read_abs_range(fd, ABS_X);
        let single_y = read_abs_range(fd, ABS_Y);
        let (x_range, y_range, mt) = match (mt_x, mt_y, single_x, single_y) {
            (Some(x), Some(y), _, _) => (x, y, true),
            (_, _, Some(x), Some(y)) if has_event_code(fd, EV_KEY, BTN_TOUCH) => (x, y, false),
            _ => continue,
        };
        let path = path.display().to_string();
        log::info!(
            "kindle input: {path}, {}-touch axes x={}..{}, y={}..{}",
            if mt { "multi" } else { "single" },
            x_range.min,
            x_range.max,
            y_range.min,
            y_range.max
        );
        devices.push(Device {
            path,
            file,
            grabbed: false,
            x_range,
            y_range,
            state: TouchState::new(mt),
        });
    }
    // Prefer a true MT touchscreen over single-axis fallback devices,
    // regardless of firmware-specific /dev/input/event numbering.
    devices.sort_by_key(|device| !device.state.mt);
    Ok(devices)
}

#[cfg(not(target_os = "linux"))]
fn discover_devices() -> Result<Vec<Device>> {
    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
fn read_abs_range(fd: libc::c_int, axis: u16) -> Option<AxisRange> {
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct InputAbsInfo {
        value: i32,
        minimum: i32,
        maximum: i32,
        fuzz: i32,
        flat: i32,
        resolution: i32,
    }

    // Linux _IOR('E', 0x40 + axis, struct input_absinfo).
    let request = ((2u32 << 30)
        | ((b'E' as u32) << 8)
        | (0x40 + axis as u32)
        | ((std::mem::size_of::<InputAbsInfo>() as u32) << 16)) as libc::c_ulong;
    let mut info = InputAbsInfo::default();
    // SAFETY: request writes one InputAbsInfo into a valid pointer.
    if unsafe { libc::ioctl(fd, request as _, &mut info) } < 0 || info.maximum <= info.minimum {
        return None;
    }
    Some(AxisRange {
        min: info.minimum,
        max: info.maximum,
    })
}

#[cfg(target_os = "linux")]
fn has_event_code(fd: libc::c_int, event_type: u16, code: u16) -> bool {
    let mut bits = [0u8; 96];
    // Linux EVIOCGBIT(event_type, len).
    let request = ((2u32 << 30)
        | ((b'E' as u32) << 8)
        | (0x20 + event_type as u32)
        | ((bits.len() as u32) << 16)) as libc::c_ulong;
    // SAFETY: ioctl writes at most the encoded byte length into `bits`.
    let written = unsafe { libc::ioctl(fd, request as _, bits.as_mut_ptr()) };
    if written < 0 {
        return false;
    }
    let byte = code as usize / 8;
    byte < written as usize && bits[byte] & (1 << (code % 8)) != 0
}

#[cfg(target_os = "linux")]
fn set_evdev_grab(fd: libc::c_int, grab: bool) -> Result<()> {
    // Linux _IOW('E', 0x90, int). EVIOCGRAB takes 1 to exclude every other
    // reader and 0 to release ownership.
    let request = ((1u32 << 30)
        | ((b'E' as u32) << 8)
        | 0x90
        | ((std::mem::size_of::<libc::c_int>() as u32) << 16)) as libc::c_ulong;
    let value: libc::c_int = i32::from(grab);
    // SAFETY: fd is an open evdev descriptor and EVIOCGRAB consumes the
    // immediate integer value without dereferencing a userspace pointer.
    if unsafe { libc::ioctl(fd, request as _, value) } < 0 {
        return Err(std::io::Error::last_os_error()).context(if grab {
            "EVIOCGRAB(1) failed"
        } else {
            "EVIOCGRAB(0) failed"
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_events(device: &mut Device) -> Result<()> {
    use std::mem::size_of;
    use std::os::fd::AsRawFd;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputEvent {
        time: libc::timeval,
        type_: u16,
        code: u16,
        value: i32,
    }

    let event_size = size_of::<InputEvent>();
    let mut bytes = [0u8; 64 * 24];
    loop {
        // SAFETY: `bytes` is writable for its full declared length and fd is
        // nonblocking. The kernel writes a sequence of input_event records.
        let count = unsafe {
            libc::read(
                device.file.as_raw_fd(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                break;
            }
            return Err(error.into());
        }
        if count == 0 {
            break;
        }
        let count = count as usize;
        if count % event_size != 0 {
            log::warn!(
                "kindle input: ignored partial event read of {count} bytes (record {event_size})"
            );
        }
        for chunk in bytes[..count - count % event_size].chunks_exact(event_size) {
            // SAFETY: chunk has exactly InputEvent bytes; read_unaligned avoids
            // imposing alignment on the byte buffer.
            let event = unsafe { chunk.as_ptr().cast::<InputEvent>().read_unaligned() };
            log::debug!(
                "kindle input event: type={} code={} value={} record_size={event_size}",
                event.type_,
                event.code,
                event.value
            );
            if device.state.apply(event.type_, event.code, event.value) {
                log::warn!(
                    "kindle input: event stream dropped; cleared contacts and resynchronizing"
                );
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn read_events(_device: &mut Device) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_clamps_and_rounds_endpoints() {
        let range = AxisRange {
            min: 100,
            max: 1100,
        };
        assert_eq!(normalize(0, range, 1236), 0);
        assert_eq!(normalize(600, range, 1236), 618);
        assert_eq!(normalize(2000, range, 1236), 1235);
    }

    #[test]
    fn multitouch_slots_pack_wire_contacts() {
        let mut state = TouchState::new(true);
        state.apply(EV_ABS, ABS_MT_SLOT, 2);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 0x1234);
        state.apply(EV_ABS, ABS_MT_POSITION_X, 511);
        state.apply(EV_ABS, ABS_MT_POSITION_Y, 412);
        let contact = state.contacts[2];
        assert!(contact.active);
        assert_eq!(pack_touch(2, 511, 412), (2 << 18) | (412 << 9) | 511);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, -1);
        assert!(!state.contacts[2].active);
    }

    #[test]
    fn invalid_multitouch_slots_are_ignored_instead_of_aliased() {
        let mut state = TouchState::new(true);
        state.apply(EV_ABS, ABS_MT_SLOT, 2);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 12);
        state.apply(EV_ABS, ABS_MT_POSITION_X, 10);
        state.apply(EV_ABS, ABS_MT_SLOT, MAX_CONTACTS as i32 + 2);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 99);
        state.apply(EV_ABS, ABS_MT_POSITION_X, 200);
        assert!(state.contacts[2].active);
        assert_eq!(state.contacts[2].id, 12);
        assert_eq!(state.contacts[2].x, 10);
        assert_eq!(
            state
                .contacts
                .iter()
                .filter(|contact| contact.active)
                .count(),
            1
        );
    }

    #[test]
    fn syn_dropped_clears_contacts_and_discards_until_report() {
        let mut state = TouchState::new(true);
        state.apply(EV_ABS, ABS_MT_SLOT, 1);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 42);
        assert!(state.contacts[1].active);

        assert!(state.apply(EV_SYN, SYN_DROPPED, 0));
        assert!(state.contacts.iter().all(|contact| !contact.active));
        state.apply(EV_ABS, ABS_MT_SLOT, 1);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 77);
        state.apply(EV_SYN, SYN_REPORT, 0);
        assert!(state.contacts.iter().all(|contact| !contact.active));

        state.apply(EV_ABS, ABS_MT_SLOT, 1);
        state.apply(EV_ABS, ABS_MT_TRACKING_ID, 77);
        assert!(state.contacts[1].active);
        assert_eq!(state.contacts[1].id, 77);
    }

    #[test]
    fn single_touch_down_and_up_are_stateful() {
        let mut state = TouchState::new(false);
        state.apply(EV_ABS, ABS_X, 10);
        state.apply(EV_ABS, ABS_Y, 20);
        state.apply(EV_KEY, BTN_TOUCH, 1);
        assert!(state.contacts[0].active);
        state.apply(EV_KEY, BTN_TOUCH, 0);
        assert!(!state.contacts[0].active);
    }

    #[test]
    fn runtime_requires_a_discoverable_touchscreen() {
        let mut input = Input {
            devices: Vec::new(),
            calibration: Calibration::default(),
        };
        let error = input.grab_selected().unwrap_err().to_string();
        assert!(error.contains("PW5 runtime requires a discoverable evdev touchscreen"));
    }
}
