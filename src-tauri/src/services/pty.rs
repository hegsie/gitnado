//! Embedded pseudo-terminal sessions.
//!
//! Backs the in-app terminal panel (roadmap 4.6) and, later, agent sessions
//! launched from Gitnado (roadmap 4.1). Each session is a shell (or an explicit
//! program) running on a native PTY in a repository or worktree directory.
//!
//! Output is streamed through a [`PtySink`] rather than straight to Tauri so
//! the session lifecycle can be tested without an `AppHandle`.
//!
//! Lifecycle: one reader thread per session reads the PTY master until EOF
//! (which happens once the child and every copy of the slave side are gone),
//! then reaps the child, reports its exit status, and removes the session from
//! the registry. Killing a session only signals the child; the reader thread
//! still performs the cleanup, so exit is reported exactly once on every path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::error::{GitnadoError, Result};

/// Event name for streamed terminal output.
pub const PTY_OUTPUT_EVENT: &str = "pty-output";
/// Event name for a session whose process has exited.
pub const PTY_EXIT_EVENT: &str = "pty-exit";

const MIN_DIMENSION: u16 = 2;
const MAX_DIMENSION: u16 = 1000;

/// Receives output and exit notifications for PTY sessions.
pub trait PtySink: Send + Sync + 'static {
    fn output(&self, id: u32, data: String);
    fn exit(&self, id: u32, exit_code: Option<i32>);
}

/// Payload of [`PTY_OUTPUT_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub id: u32,
    pub data: String,
}

/// Payload of [`PTY_EXIT_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    pub id: u32,
    /// Exit code, or `None` when the process was terminated by a signal or
    /// its status could not be read.
    pub exit_code: Option<i32>,
}

/// Options for starting a session.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnOptions {
    /// Working directory; must be an existing directory.
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Program and arguments to run instead of the user's login shell.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Extra environment variables for the session. Used to hand text (an
    /// agent's task prompt) to the shell without quoting it into a command
    /// line. Names must be plain identifiers.
    #[serde(default)]
    pub env: Option<std::collections::BTreeMap<String, String>>,
}

/// Public description of a running session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub id: u32,
    pub cwd: String,
    /// The program that was started (shell path or the first command word).
    pub program: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// Unix timestamp (seconds) when the session started.
    pub started_at: i64,
}

struct Session {
    info: PtySessionInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

/// Registry of live PTY sessions, held in Tauri managed state.
#[derive(Clone, Default)]
pub struct PtyRegistry {
    inner: Arc<Inner>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Never leave orphaned shells behind when the app shuts down.
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

fn clamp_dimension(value: u16) -> u16 {
    value.clamp(MIN_DIMENSION, MAX_DIMENSION)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn op_failed(context: &str, err: impl std::fmt::Display) -> GitnadoError {
    GitnadoError::OperationFailed(format!("{context}: {err}"))
}

/// Decode a chunk of PTY output as UTF-8, carrying an incomplete trailing
/// multi-byte sequence over to the next chunk instead of mangling it.
/// Genuinely invalid bytes are replaced with U+FFFD.
pub fn decode_utf8_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // from_utf8 just validated this prefix, so this cannot fail.
                out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + bad..];
                    }
                    None => {
                        // Incomplete sequence at the end: keep it for later.
                        rest = &rest[valid..];
                        break;
                    }
                }
            }
        }
    }
    let leftover = rest.to_vec();
    *carry = leftover;
    out
}

impl PtyRegistry {
    /// Start a new session and begin streaming its output to `sink`.
    pub fn spawn(&self, opts: PtySpawnOptions, sink: Arc<dyn PtySink>) -> Result<PtySessionInfo> {
        let cwd = Path::new(&opts.cwd);
        if !cwd.is_dir() {
            return Err(GitnadoError::InvalidPath(opts.cwd));
        }

        let size = PtySize {
            rows: clamp_dimension(opts.rows),
            cols: clamp_dimension(opts.cols),
            pixel_width: 0,
            pixel_height: 0,
        };

        let mut cmd = match opts.command.as_deref() {
            Some([program, args @ ..]) if !program.trim().is_empty() => {
                let mut cmd = CommandBuilder::new(program);
                cmd.args(args);
                cmd
            }
            Some(_) => {
                return Err(GitnadoError::OperationFailed(
                    "Terminal command must not be empty".to_string(),
                ))
            }
            None => CommandBuilder::new_default_prog(),
        };
        cmd.cwd(cwd);
        if let Some(env) = &opts.env {
            for (key, value) in env {
                let valid = !key.is_empty()
                    && !key.starts_with(|c: char| c.is_ascii_digit())
                    && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if !valid {
                    return Err(GitnadoError::OperationFailed(format!(
                        "Invalid environment variable name: {key}"
                    )));
                }
                cmd.env(key, value);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "gitnado");

        let program = match opts.command.as_deref() {
            Some([program, ..]) => program.clone(),
            _ => cmd.get_shell(),
        };

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| op_failed("Failed to open terminal", e))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| op_failed(&format!("Failed to start {program}"), e))?;
        // The child holds its own copy of the slave. Dropping ours is what lets
        // the master read EOF once the child exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| op_failed("Failed to read terminal", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| op_failed("Failed to write terminal", e))?;

        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let info = PtySessionInfo {
            id,
            cwd: opts.cwd.clone(),
            program,
            pid: child.process_id(),
            cols: size.cols,
            rows: size.rows,
            started_at: now_secs(),
        };

        let session = Session {
            info: info.clone(),
            master: pair.master,
            writer,
            killer: child.clone_killer(),
        };
        self.inner
            .sessions
            .lock()
            .map_err(|_| op_failed("Terminal registry", "lock poisoned"))?
            .insert(id, session);

        let inner = Arc::downgrade(&self.inner);
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut reader = reader;
                let mut buf = [0u8; 8192];
                let mut carry = Vec::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = decode_utf8_chunk(&mut carry, &buf[..n]);
                            if !text.is_empty() {
                                sink.output(id, text);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        // EIO is how Linux reports "slave closed".
                        Err(_) => break,
                    }
                }
                if !carry.is_empty() {
                    sink.output(id, String::from_utf8_lossy(&carry).into_owned());
                }
                let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
                if let Some(inner) = inner.upgrade() {
                    if let Ok(mut sessions) = inner.sessions.lock() {
                        sessions.remove(&id);
                    }
                }
                sink.exit(id, exit_code);
            })
            .map_err(|e| op_failed("Failed to start terminal reader", e))?;

        Ok(info)
    }

    /// Send input (keystrokes or pasted text) to a session.
    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| op_failed("Terminal registry", "lock poisoned"))?;
        let session = sessions.get_mut(&id).ok_or_else(|| not_found(id))?;
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|e| op_failed("Failed to write to terminal", e))
    }

    /// Resize a session's PTY (cols x rows, clamped to a sane range).
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| op_failed("Terminal registry", "lock poisoned"))?;
        let session = sessions.get_mut(&id).ok_or_else(|| not_found(id))?;
        let size = PtySize {
            rows: clamp_dimension(rows),
            cols: clamp_dimension(cols),
            pixel_width: 0,
            pixel_height: 0,
        };
        session
            .master
            .resize(size)
            .map_err(|e| op_failed("Failed to resize terminal", e))?;
        session.info.cols = size.cols;
        session.info.rows = size.rows;
        Ok(())
    }

    /// Terminate a session's process. Exit is reported through the sink once
    /// the process is gone. Killing an already-finished session is a no-op.
    pub fn kill(&self, id: u32) -> Result<()> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| op_failed("Terminal registry", "lock poisoned"))?;
        if let Some(session) = sessions.get_mut(&id) {
            // The process may already be exiting; the reader thread reports
            // the outcome either way.
            let _ = session.killer.kill();
        }
        Ok(())
    }

    /// All live sessions, oldest first.
    pub fn list(&self) -> Vec<PtySessionInfo> {
        let mut infos: Vec<PtySessionInfo> = self
            .inner
            .sessions
            .lock()
            .map(|s| s.values().map(|s| s.info.clone()).collect())
            .unwrap_or_default();
        infos.sort_by_key(|i| i.id);
        infos
    }
}

fn not_found(id: u32) -> GitnadoError {
    GitnadoError::OperationFailed(format!("Terminal session {id} is not running"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[derive(Debug)]
    enum Event {
        Output(u32, String),
        Exit(u32, Option<i32>),
    }

    struct ChannelSink(Mutex<mpsc::Sender<Event>>);

    impl PtySink for ChannelSink {
        fn output(&self, id: u32, data: String) {
            let _ = self.0.lock().unwrap().send(Event::Output(id, data));
        }
        fn exit(&self, id: u32, exit_code: Option<i32>) {
            let _ = self.0.lock().unwrap().send(Event::Exit(id, exit_code));
        }
    }

    fn sink() -> (Arc<dyn PtySink>, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        (Arc::new(ChannelSink(Mutex::new(tx))), rx)
    }

    /// Collect output until exit; returns (all output, exit code).
    fn drain(rx: &mpsc::Receiver<Event>, id: u32) -> (String, Option<i32>) {
        let mut out = String::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(20)) {
                Ok(Event::Output(i, data)) if i == id => out.push_str(&data),
                Ok(Event::Exit(i, code)) if i == id => return (out, code),
                Ok(_) => {}
                Err(e) => panic!("timed out waiting for session {id}: {e}; output so far: {out:?}"),
            }
        }
    }

    fn opts(cwd: &Path, command: &[&str]) -> PtySpawnOptions {
        PtySpawnOptions {
            cwd: cwd.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            command: Some(command.iter().map(|s| s.to_string()).collect()),
            env: None,
        }
    }

    #[test]
    fn runs_command_in_cwd_and_reports_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (sink, rx) = sink();
        let info = registry
            .spawn(opts(dir.path(), &["/bin/sh", "-c", "pwd; exit 3"]), sink)
            .unwrap();
        assert!(info.pid.is_some());
        assert_eq!(info.program, "/bin/sh");

        let (out, code) = drain(&rx, info.id);
        let canonical = dir.path().canonicalize().unwrap();
        let name = canonical
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(out.contains(&name), "pwd output {out:?} should name {name}");
        assert_eq!(code, Some(3));
        assert!(registry.list().is_empty(), "exited session is removed");
    }

    #[test]
    fn write_reaches_the_process() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (sink, rx) = sink();
        let info = registry
            .spawn(
                opts(dir.path(), &["/bin/sh", "-c", "read line; echo got:$line"]),
                sink,
            )
            .unwrap();
        registry.write(info.id, "hello\n").unwrap();
        let (out, code) = drain(&rx, info.id);
        assert!(out.contains("got:hello"), "output: {out:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn resize_is_visible_to_the_process() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (sink, rx) = sink();
        let info = registry
            .spawn(
                opts(dir.path(), &["/bin/sh", "-c", "read x; stty size"]),
                sink,
            )
            .unwrap();
        registry.resize(info.id, 120, 40).unwrap();
        assert_eq!(registry.list()[0].cols, 120);
        registry.write(info.id, "\n").unwrap();
        let (out, _) = drain(&rx, info.id);
        assert!(out.contains("40 120"), "stty size output: {out:?}");
    }

    #[test]
    fn kill_terminates_and_reports_exit_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (sink, rx) = sink();
        let info = registry
            .spawn(opts(dir.path(), &["/bin/sh", "-c", "sleep 60"]), sink)
            .unwrap();
        assert_eq!(registry.list().len(), 1);
        registry.kill(info.id).unwrap();
        let (_, code) = drain(&rx, info.id);
        assert_ne!(code, Some(0));
        assert!(registry.list().is_empty());
        // No second exit event, and killing again is harmless.
        registry.kill(info.id).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn operations_on_unknown_session_fail_clearly() {
        let registry = PtyRegistry::default();
        let err = registry.write(42, "x").unwrap_err().to_string();
        assert!(err.contains("not running"), "{err}");
        assert!(registry.resize(42, 80, 24).is_err());
        assert!(registry.kill(42).is_ok());
    }

    #[test]
    fn rejects_missing_cwd_and_empty_command() {
        let registry = PtyRegistry::default();
        let (s, _rx) = sink();
        let missing = PtySpawnOptions {
            cwd: "/definitely/not/here".into(),
            cols: 80,
            rows: 24,
            command: None,
            env: None,
        };
        assert!(matches!(
            registry.spawn(missing, s.clone()),
            Err(GitnadoError::InvalidPath(_))
        ));

        let dir = tempfile::TempDir::new().unwrap();
        let mut empty = opts(dir.path(), &[]);
        empty.command = Some(vec![]);
        assert!(registry.spawn(empty, s).is_err());
    }

    #[test]
    fn missing_program_reports_an_error_not_a_hang() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (s, rx) = sink();
        match registry.spawn(opts(dir.path(), &["/no/such/program-xyz"]), s) {
            Err(e) => assert!(e.to_string().contains("program-xyz"), "{e}"),
            // Some platforms report exec failure via the child instead.
            Ok(info) => {
                let (_, code) = drain(&rx, info.id);
                assert_ne!(code, Some(0));
            }
        }
    }

    #[test]
    fn env_reaches_the_process_without_shell_quoting() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (sink, rx) = sink();
        let mut o = opts(
            dir.path(),
            &["/bin/sh", "-c", "printf '[%s]' \"$GITNADO_TASK_PROMPT\""],
        );
        let tricky = "fix it; rm -rf / $(whoami) \"quoted\" 'single'";
        o.env = Some([("GITNADO_TASK_PROMPT".to_string(), tricky.to_string())].into());
        let info = registry.spawn(o, sink).unwrap();
        let (out, _) = drain(&rx, info.id);
        assert!(out.contains(&format!("[{tricky}]")), "output: {out:?}");
    }

    #[test]
    fn rejects_invalid_env_names() {
        let dir = tempfile::TempDir::new().unwrap();
        let registry = PtyRegistry::default();
        let (s, _rx) = sink();
        for bad in ["", "A=B", "1X", "X Y"] {
            let mut o = opts(dir.path(), &["/bin/true"]);
            o.env = Some([(bad.to_string(), "v".to_string())].into());
            assert!(registry.spawn(o, s.clone()).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn decode_carries_split_multibyte_sequences() {
        let mut carry = Vec::new();
        let bytes = "héllo ✓".as_bytes();
        // Split inside the 3-byte check mark.
        let split = bytes.len() - 1;
        let a = decode_utf8_chunk(&mut carry, &bytes[..split]);
        assert_eq!(a, "héllo ");
        assert_eq!(carry.len(), 2);
        let b = decode_utf8_chunk(&mut carry, &bytes[split..]);
        assert_eq!(b, "✓");
        assert!(carry.is_empty());
    }

    #[test]
    fn decode_replaces_invalid_bytes() {
        let mut carry = Vec::new();
        let out = decode_utf8_chunk(&mut carry, &[b'a', 0xff, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn payloads_serialize_camel_case() {
        let json = serde_json::to_string(&PtyExitPayload {
            id: 1,
            exit_code: Some(0),
        })
        .unwrap();
        assert!(json.contains("\"exitCode\":0"));
        let info = PtySessionInfo {
            id: 1,
            cwd: "/x".into(),
            program: "sh".into(),
            pid: None,
            cols: 80,
            rows: 24,
            started_at: 5,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"startedAt\":5"));
        let opts: PtySpawnOptions =
            serde_json::from_str(r#"{"cwd":"/x","cols":80,"rows":24}"#).unwrap();
        assert!(opts.command.is_none());
        assert!(opts.env.is_none());
    }
}
