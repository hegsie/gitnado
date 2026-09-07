/**
 * Push the security settings the BACKEND enforces for itself.
 *
 * Offline mode and the remote allowlist are checked in two places. The
 * frontend gate (`checkNetworkAllowed` in git.service.ts) runs first and is the
 * half that can explain a refusal in a toast before any work starts. The Rust
 * guard (`src-tauri/src/services/security.rs`) is the backstop for a call site
 * that forgets to ask — twice now one has, and both times the request went out.
 *
 * The backend cannot read the frontend's persisted settings (they live in
 * `localStorage`), so it has to be told. It keeps its own mirror on disk and
 * reads it at startup, which covers the window before this push arrives; this
 * push is what makes it agree with what Settings shows.
 *
 * Shape follows the existing `update-tray-settings` precedent: a Tauri event
 * with a camelCase payload, emitted once at startup and again on every change.
 */

import { emit } from '@tauri-apps/api/event';
import { showToast } from './notification.service.ts';

/**
 * Whether the last push failed and has already been reported.
 *
 * This runs on every settings write — theme, font size, anything — so an
 * un-deduped toast would stack one message per keystroke in Settings for as
 * long as the IPC stays broken. Report the outage once, and again only after
 * it has recovered and broken a second time.
 */
let failureReported = false;

/** Event name the Rust listener in `src-tauri/src/lib.rs` is registered on. */
export const SECURITY_SETTINGS_EVENT = 'update-security-settings';

/** The two settings the backend guard reads. */
export interface BackendSecuritySettings {
  offlineMode: boolean;
  remoteAllowlist: string[];
}

/**
 * Send the current values to the backend.
 *
 * Never throws — the callers are a startup hook and a store subscription, and
 * neither has anywhere to put an exception. A failure IS reported to the user
 * though: it means the setting they just changed in Settings > Security is not
 * the one the backend is enforcing, and silently leaving that mismatch in place
 * is exactly the kind of quiet gap this whole change exists to close.
 */
export async function emitSecuritySettings(
  settings: BackendSecuritySettings,
): Promise<void> {
  try {
    await emit(SECURITY_SETTINGS_EVENT, {
      offlineMode: settings.offlineMode,
      // A copy, not the store's array: the payload is serialized asynchronously.
      remoteAllowlist: [...settings.remoteAllowlist],
    });
    failureReported = false;
  } catch (err) {
    console.error('Failed to send security settings to the backend:', err);
    if (!failureReported) {
      failureReported = true;
      showToast(
        'Could not apply your security settings to the backend. Restart Gitnado to be sure they take effect.',
        'error',
      );
    }
  }
}
