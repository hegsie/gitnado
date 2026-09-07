//! Utility modules

pub mod app_paths;
pub mod cli_safety;
mod command;
mod editor_command;

pub use cli_safety::reject_flag_like;
pub use command::{apply_token_credential_helper, create_command};
pub use editor_command::{copy_file_editor_command, todo_action_editor_command, TODO_FORMAT_ARGS};

/// True once `deadline` has passed. `None` means no deadline.
///
/// The outer `tokio::time::timeout` on a command only DROPS its future; a
/// `tokio::task::spawn_blocking` task is never cancelled by that drop. Every
/// blocking git operation that can be given up on therefore carries its own
/// deadline and checks it here — the same way `clone_repository` does.
pub fn deadline_passed(deadline: Option<std::time::Instant>) -> bool {
    deadline.is_some_and(|d| std::time::Instant::now() >= d)
}

/// True when `dir`, or ANY directory beneath it, holds a `.git` entry.
///
/// `git clean -fd` skips a nested repository at any depth — it needs a second
/// `-f` to cross that line. Checking only `dir/.git` matched the selected
/// directory alone, so an untracked `build/` containing `build/vendor/lib/.git`
/// was reported as an ordinary directory, included in Select-all, and
/// `remove_dir_all`'d — destroying a repository's objects, refs and unpushed
/// commits with no confirmation naming it and nothing recoverable anywhere.
///
/// Does not descend INTO a nested repo once found, and stops at the first hit.
pub fn contains_nested_repo(dir: &std::path::Path) -> bool {
    if dir.join(".git").exists() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        // symlink_metadata: never follow a symlink out of the tree.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if meta.is_dir() && contains_nested_repo(&entry.path()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::deadline_passed;
    use std::time::{Duration, Instant};

    /// No timeout configured means the operation is never cut short.
    #[test]
    fn deadline_passed_is_false_without_a_deadline() {
        assert!(!deadline_passed(None));
    }

    #[test]
    fn deadline_passed_is_true_once_the_instant_is_behind_us() {
        assert!(deadline_passed(Some(
            Instant::now() - Duration::from_secs(1)
        )));
    }

    #[test]
    fn deadline_passed_is_false_for_a_future_instant() {
        assert!(!deadline_passed(Some(
            Instant::now() + Duration::from_secs(60)
        )));
    }
}
