//! Helpers for safely passing user-controlled values to `git` (or any other
//! CLI tool that uses GNU-style argument parsing).
//!
//! The pattern enforced here is: every user-controlled URL / path / ref that
//! is forwarded to a CLI as a positional argument must be (a) rejected if it
//! starts with `-` (so it can't be parsed as a flag like `--upload-pack=...`)
//! and (b) preceded by `--` in the argv so that even unforeseen GNU-parser
//! behaviour can't reinterpret it as a flag.

use crate::error::{GitnadoError, Result};

/// Reject values that could be parsed as a CLI flag.
///
/// A value starting with `-` is the classic argument-injection vector against
/// `git fetch`/`git clone`/`git rebase`/etc., where flags like `--upload-pack=`
/// or `--exec=` lead directly to remote code execution. Embedded CR/LF can
/// also confuse downstream parsers (notably `cmd.exe` on Windows), so we
/// reject those too.
pub fn reject_flag_like(value: &str, label: &str) -> Result<()> {
    if value.starts_with('-') {
        return Err(GitnadoError::OperationFailed(format!(
            "{} must not start with '-'",
            label
        )));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(GitnadoError::OperationFailed(format!(
            "{} must not contain newlines",
            label
        )));
    }
    Ok(())
}
