//! SVC WIRE (PKNT) client for the desktop host — the companion channel over
//! TCP (contracts/spec/spec.ts "SVC WIRE protocol").
//!
//! `hosts/desktop` already answers `svcOpen` from an allowlist and moves
//! lines through two in-process queues, which is all the note editor needs
//! because its companion IS the host. An app whose companion is a separate
//! program — apps/term, whose daemon holds the PTYs — needs those queues fed
//! from a socket instead. That is this module: the same wire the console
//! speaks (`hosts/3ds/src/svcwire.c`), the same codec
//! (`pocketjs_core::wire`), so one companion serves a 3DS and a desktop
//! window without knowing which is which.
//!
//! Threading follows `hosts/vita/src/net.rs`: a supervisor thread owns
//! connect/handshake/read and a writer thread owns the socket's send side,
//! so the fixed-step tick on the main thread only ever moves queues. The
//! address is given (`--svc-connect host:port`) rather than discovered — a
//! window opened by the companion already knows where it came from, and UDP
//! discovery is for consoles that do not.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::Duration;

use pocketjs_core::spec::wire;
use pocketjs_core::wire as codec;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(250);
const BACKOFF: Duration = Duration::from_secs(1);
/// Inbound lines held for the guest between ticks. The companion paces its
/// own bulk (font atlases arrive as chunks), so this only has to absorb a
/// burst, not a stream.
const LINE_QUEUE_CAP: usize = 512;

pub struct SvcWire {
    lines: Receiver<String>,
    outbox: Sender<String>,
    shutdown: Arc<AtomicBool>,
    pending: Vec<String>,
}

impl SvcWire {
    /// Start connecting to `addr` as `app`. Returns immediately; the guest's
    /// `svcOpen` probe is answered from the allowlist as before, and the
    /// app's own connect screen covers the time before the first line lands.
    pub fn spawn(addr: String, app: String) -> Self {
        let (line_tx, line_rx) = channel::<String>();
        let (out_tx, out_rx) = channel::<String>();
        let connected = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::new(AtomicBool::new(false));
        {
            let connected = connected.clone();
            let shutdown = shutdown.clone();
            std::thread::Builder::new()
                .name("pjs-svc-wire".into())
                .spawn(move || supervisor(&addr, &app, &line_tx, &out_rx, &connected, &shutdown))
                .expect("spawn svc wire thread");
        }
        Self { lines: line_rx, outbox: out_tx, shutdown, pending: Vec::new() }
    }

    /// Take everything the companion has said since the last tick. The app
    /// reads the channel's state from its own protocol — a replica is "live"
    /// once a grid has arrived, not when a socket happens to be open.
    pub fn drain(&mut self) -> Vec<String> {
        let mut out = std::mem::take(&mut self.pending);
        loop {
            match self.lines.try_recv() {
                Ok(line) => out.push(line),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        out
    }

    pub fn send(&self, line: String) {
        let _ = self.outbox.send(line);
    }
}

impl Drop for SvcWire {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

fn supervisor(
    addr: &str,
    app: &str,
    lines: &Sender<String>,
    outbox: &Receiver<String>,
    connected: &Arc<AtomicBool>,
    shutdown: &Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        match connect(addr, app) {
            Ok(stream) => {
                log::info!("pocket-desktop-host: svc wire connected to {addr}");
                connected.store(true, Ordering::Release);
                let why = serve(stream, lines, outbox, shutdown);
                connected.store(false, Ordering::Release);
                log::info!("pocket-desktop-host: svc wire disconnected: {why}");
            }
            Err(error) => log::debug!("pocket-desktop-host: svc wire connect {addr}: {error}"),
        }
        std::thread::sleep(BACKOFF);
    }
}

fn connect(addr: &str, app: &str) -> std::io::Result<TcpStream> {
    let target = addr
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "host:port"))?;
    let stream = TcpStream::connect_timeout(&target, CONNECT_TIMEOUT)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut hello = [0u8; 80];
    let n = codec::encode_hello(app, &mut hello)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "app id"))?;
    (&stream).write_all(&hello[..n])?;
    let mut ack = [0u8; 8];
    read_full(&stream, &mut ack, &AtomicBool::new(false))?;
    if codec::parse_hello_ack(&ack) != Some(wire::VERSION) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "handshake"));
    }
    Ok(stream)
}

/// read_exact across read-timeout ticks, re-checking shutdown between them.
fn read_full(mut stream: &TcpStream, buf: &mut [u8], shutdown: &AtomicBool) -> std::io::Result<()> {
    let mut got = 0usize;
    while got < buf.len() {
        if shutdown.load(Ordering::Acquire) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "shutdown"));
        }
        match stream.read(&mut buf[got..]) {
            Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof")),
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn serve(
    stream: TcpStream,
    lines: &Sender<String>,
    outbox: &Receiver<String>,
    shutdown: &Arc<AtomicBool>,
) -> String {
    let (frame_tx, frame_rx) = channel::<Vec<u8>>();
    let writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(e) => return format!("clone: {e}"),
    };
    let tx_thread = std::thread::Builder::new()
        .name("pjs-svc-wire-tx".into())
        .spawn(move || {
            let mut writer = writer;
            while let Ok(frame) = frame_rx.recv() {
                if writer.write_all(&frame).is_err() {
                    break;
                }
            }
        });

    let why = rx_loop(&stream, lines, outbox, &frame_tx, shutdown);
    drop(frame_tx);
    if let Ok(handle) = tx_thread {
        let _ = handle.join();
    }
    why
}

fn ctrl_frame(kind: u8, payload: &[u8]) -> Option<Vec<u8>> {
    let mut frame = vec![0u8; wire::HEADER_SIZE + payload.len()];
    if !codec::encode_frame_header(kind, 0, payload.len() as u32, &mut frame) {
        return None;
    }
    frame[wire::HEADER_SIZE..].copy_from_slice(payload);
    Some(frame)
}

fn rx_loop(
    stream: &TcpStream,
    lines: &Sender<String>,
    outbox: &Receiver<String>,
    frames: &Sender<Vec<u8>>,
    shutdown: &Arc<AtomicBool>,
) -> String {
    let mut header = [0u8; wire::HEADER_SIZE];
    let mut payload: Vec<u8> = Vec::new();
    let mut queued = 0usize;
    loop {
        // Anything the guest produced since the last pass goes out first, so
        // a keystroke never waits on the read timeout.
        while let Ok(line) = outbox.try_recv() {
            if let Some(frame) = ctrl_frame(wire::MSG_CTRL, line.as_bytes()) {
                let _ = frames.send(frame);
            }
        }
        match read_header(stream, &mut header, shutdown) {
            Ok(false) => continue, // timed out with nothing pending; poll again
            Ok(true) => {}
            Err(e) => return format!("header: {e}"),
        }
        let Some(frame) = codec::parse_frame_header(&header) else {
            return "bad frame header".into();
        };
        payload.resize(frame.len as usize, 0);
        if let Err(e) = read_full(stream, &mut payload, shutdown) {
            return format!("payload: {e}");
        }
        match frame.kind {
            wire::MSG_PING => {
                if let Some(pong) = ctrl_frame(wire::MSG_PONG, &payload) {
                    let _ = frames.send(pong);
                }
            }
            wire::MSG_CTRL => {
                if let Ok(line) = core::str::from_utf8(&payload) {
                    if queued < LINE_QUEUE_CAP {
                        queued += 1;
                        if lines.send(line.to_owned()).is_err() {
                            return "guest gone".into();
                        }
                    }
                }
                // The tick drains everything each frame; the cap only guards
                // a stalled main thread, and it re-arms as soon as one lands.
                queued = queued.saturating_sub(1);
            }
            _ => {} // forward-compatible: file/stream types are not used here
        }
    }
}

/// One header read that tolerates the read timeout: `Ok(false)` means the
/// socket was merely idle, which is the loop's chance to flush the outbox.
fn read_header(
    mut stream: &TcpStream,
    header: &mut [u8; wire::HEADER_SIZE],
    shutdown: &Arc<AtomicBool>,
) -> std::io::Result<bool> {
    let mut got = 0usize;
    while got < header.len() {
        if shutdown.load(Ordering::Acquire) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "shutdown"));
        }
        match stream.read(&mut header[got..]) {
            Ok(0) => return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof")),
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if got == 0 {
                    return Ok(false);
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
