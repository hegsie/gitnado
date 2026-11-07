//! Embedded terminal (PTY) command handlers.
//!
//! Thin Tauri wrappers over [`crate::services::pty::PtyRegistry`]; output and
//! exit are delivered as `pty-output` / `pty-exit` events.

use std::sync::Arc;

use tauri::{command, AppHandle, Emitter, State};

use crate::error::Result;
use crate::services::pty::{
    PtyExitPayload, PtyOutputPayload, PtyRegistry, PtySessionInfo, PtySink, PtySpawnOptions,
    PTY_EXIT_EVENT, PTY_OUTPUT_EVENT,
};

/// Forwards PTY output and exit notifications to the frontend.
struct TauriPtySink(AppHandle);

impl PtySink for TauriPtySink {
    fn output(&self, id: u32, data: String) {
        let _ = self.0.emit(PTY_OUTPUT_EVENT, PtyOutputPayload { id, data });
    }

    fn exit(&self, id: u32, exit_code: Option<i32>) {
        let _ = self
            .0
            .emit(PTY_EXIT_EVENT, PtyExitPayload { id, exit_code });
    }
}

/// Start a terminal session in `options.cwd` (the user's shell unless
/// `options.command` is given).
#[command]
pub async fn pty_spawn(
    app_handle: AppHandle,
    registry: State<'_, PtyRegistry>,
    options: PtySpawnOptions,
) -> Result<PtySessionInfo> {
    let registry = registry.inner().clone();
    let sink: Arc<dyn PtySink> = Arc::new(TauriPtySink(app_handle));
    tokio::task::spawn_blocking(move || registry.spawn(options, sink))
        .await
        .map_err(|e| crate::error::GitnadoError::OperationFailed(e.to_string()))?
}

/// Send input to a terminal session.
#[command]
pub async fn pty_write(registry: State<'_, PtyRegistry>, id: u32, data: String) -> Result<()> {
    registry.write(id, &data)
}

/// Resize a terminal session.
#[command]
pub async fn pty_resize(
    registry: State<'_, PtyRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<()> {
    registry.resize(id, cols, rows)
}

/// Terminate a terminal session's process.
#[command]
pub async fn pty_kill(registry: State<'_, PtyRegistry>, id: u32) -> Result<()> {
    registry.kill(id)
}

/// List running terminal sessions.
#[command]
pub async fn pty_list(registry: State<'_, PtyRegistry>) -> Result<Vec<PtySessionInfo>> {
    Ok(registry.list())
}
