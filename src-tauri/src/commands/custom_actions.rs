//! Custom Actions command handlers
//! Allow users to define and run custom scripts/commands from the UI

use std::path::Path;
use std::process::Command;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// A user-defined custom action
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomAction {
    pub id: String,
    pub name: String,
    pub command: String,
    pub arguments: Option<String>,
    pub working_directory: Option<String>,
    pub shortcut: Option<String>,
    pub show_in_toolbar: bool,
    pub open_in_terminal: bool,
    pub confirm_before_run: bool,
}

/// Result of executing a custom action
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Path to the custom actions config file within the repo
fn actions_file_path(repo_path: &Path) -> std::path::PathBuf {
    crate::utils::app_paths::repo_dir(&repo_path.join(".git")).join("custom_actions.json")
}

/// Read custom actions from disk
fn read_actions(repo_path: &Path) -> Result<Vec<CustomAction>> {
    let file_path = actions_file_path(repo_path);
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&file_path)?;
    let actions: Vec<CustomAction> = serde_json::from_str(&content)?;
    Ok(actions)
}

/// Write custom actions to disk
fn write_actions(repo_path: &Path, actions: &[CustomAction]) -> Result<()> {
    let file_path = actions_file_path(repo_path);
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(actions)?;
    std::fs::write(&file_path, content)?;
    Ok(())
}

/// Get the current branch name for variable substitution
fn get_current_branch(repo_path: &Path) -> String {
    let repo = match git2::Repository::open(repo_path) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return String::new(),
    };
    head.shorthand().unwrap_or("").to_string()
}

/// Quote a value for safe interpolation into a POSIX `sh -c` command line.
/// Single-quote everything; the only character that can't appear inside single
/// quotes is `'` itself, which we close-escape-reopen as `'\''`.
fn shell_quote_posix(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Quote a value for safe interpolation into a Windows `cmd /C` command line.
/// `cmd.exe` quoting is fundamentally unsound for hostile input: even inside
/// double-quotes, `%VAR%` is expanded and `^`/`&`/`|`/`<`/`>`/`(`/`)`/`!`/`"`
/// retain meta-character roles in various parsing paths. Rather than try to
/// quote our way out, we reject any value containing one of these characters.
/// We also reject ASCII control characters (CR/LF/NUL etc.) since CRLF can
/// terminate cmd's command-line parser and let bytes after the newline be
/// interpreted as a new command. The caller's `Result` propagation surfaces
/// the rejection as an error.
fn shell_quote_windows(value: &str) -> Result<String> {
    const FORBIDDEN: &[char] = &['%', '^', '&', '<', '>', '|', '(', ')', '!', '"'];
    if let Some(c) = value
        .chars()
        .find(|c| FORBIDDEN.contains(c) || c.is_ascii_control())
    {
        let label = if c.is_ascii_control() {
            format!("control character (0x{:02X})", c as u32)
        } else {
            format!("metacharacter '{}'", c)
        };
        return Err(GitnadoError::OperationFailed(format!(
            "Refusing to substitute value containing shell {} on Windows",
            label
        )));
    }
    Ok(format!("\"{}\"", value))
}

/// Replace template variables in a string. Substituted values are shell-quoted
/// for the target shell so that branch names containing metacharacters
/// (e.g. `` `;rm -rf ~;# ``) cannot break out of the surrounding command.
/// Returns Err on Windows if a substituted value contains a metacharacter
/// that cmd.exe quoting cannot safely handle.
fn substitute_variables(
    input: &str,
    repo_path: &str,
    branch: &str,
    for_shell: bool,
) -> Result<String> {
    if for_shell {
        let (repo_q, branch_q) = if cfg!(target_os = "windows") {
            (
                shell_quote_windows(repo_path)?,
                shell_quote_windows(branch)?,
            )
        } else {
            (shell_quote_posix(repo_path), shell_quote_posix(branch))
        };
        Ok(input
            .replace("$REPO", &repo_q)
            .replace("$BRANCH", &branch_q))
    } else {
        Ok(input.replace("$REPO", repo_path).replace("$BRANCH", branch))
    }
}

/// Get all custom actions for a repository
#[command]
pub async fn get_custom_actions(path: String) -> Result<Vec<CustomAction>> {
    let repo_path = Path::new(&path);
    if !repo_path.join(".git").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }
    read_actions(repo_path)
}

/// Save or update a custom action
#[command]
pub async fn save_custom_action(path: String, action: CustomAction) -> Result<Vec<CustomAction>> {
    let repo_path = Path::new(&path);
    if !repo_path.join(".git").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    let mut actions = read_actions(repo_path)?;

    // Update existing or add new
    if let Some(existing) = actions.iter_mut().find(|a| a.id == action.id) {
        *existing = action;
    } else {
        actions.push(action);
    }

    write_actions(repo_path, &actions)?;
    Ok(actions)
}

/// Delete a custom action by ID
#[command]
pub async fn delete_custom_action(path: String, action_id: String) -> Result<Vec<CustomAction>> {
    let repo_path = Path::new(&path);
    if !repo_path.join(".git").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    let mut actions = read_actions(repo_path)?;
    actions.retain(|a| a.id != action_id);
    write_actions(repo_path, &actions)?;
    Ok(actions)
}

/// Execute a custom action
///
/// # Security
///
/// This command executes arbitrary shell commands defined by the user in
/// `.git/gitnado/custom_actions.json`. Because the action definitions live
/// inside the repository's `.git/` directory (not tracked by Git) and the
/// user must explicitly create them through the UI, the trust boundary is
/// equivalent to the user running commands in their own terminal.
///
/// Safety measures in place:
/// - The `action_id` is validated against the persisted action list before
///   execution — only previously saved actions can be run.
/// - The resolved command and working directory are logged at INFO level so
///   unexpected executions are auditable.
/// - Actions with `confirm_before_run` set to `true` are gated by a
///   confirmation dialog in the frontend before this command is invoked.
/// - Variable substitution (`$REPO`, `$BRANCH`) is limited to known tokens.
#[command]
pub async fn run_custom_action(path: String, action_id: String) -> Result<ActionResult> {
    let repo_path = Path::new(&path);
    if !repo_path.join(".git").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    let actions = read_actions(repo_path)?;
    let action = actions
        .iter()
        .find(|a| a.id == action_id)
        .ok_or_else(|| GitnadoError::OperationFailed(format!("Action not found: {}", action_id)))?
        .clone();

    let branch = get_current_branch(repo_path);
    // Command and arguments are passed to `sh -c` / `cmd /C`, so substituted
    // values must be shell-quoted to prevent injection via branch names like
    // `` `;rm -rf ~;# ``. On Windows, values with `cmd.exe` metacharacters
    // are rejected outright (see shell_quote_windows).
    let command_str = substitute_variables(&action.command, &path, &branch, true)?;
    let arguments_str = match action.arguments.as_deref() {
        Some(args) => substitute_variables(args, &path, &branch, true)?,
        None => String::new(),
    };

    // Working directory is passed via `current_dir`, not interpolated into a
    // shell command, so plain substitution is correct here.
    let working_dir = match action.working_directory.as_deref() {
        Some("repo_root") | None => path.clone(),
        Some(custom_path) => substitute_variables(custom_path, &path, &branch, false)?,
    };

    // Log the command being executed for auditability
    tracing::info!(
        action_id = %action_id,
        action_name = %action.name,
        command = %command_str,
        arguments = %arguments_str,
        working_dir = %working_dir,
        "Executing custom action"
    );

    // Build the command
    let output = if cfg!(target_os = "windows") {
        let mut full_command = command_str.clone();
        if !arguments_str.is_empty() {
            full_command.push(' ');
            full_command.push_str(&arguments_str);
        }
        Command::new("cmd")
            .args(["/C", &full_command])
            .current_dir(&working_dir)
            .output()
    } else {
        let mut full_command = command_str.clone();
        if !arguments_str.is_empty() {
            full_command.push(' ');
            full_command.push_str(&arguments_str);
        }
        Command::new("sh")
            .args(["-c", &full_command])
            .current_dir(&working_dir)
            .output()
    };

    match output {
        Ok(output) => {
            let exit_code = output.status.code().unwrap_or(-1);
            Ok(ActionResult {
                exit_code,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                success: output.status.success(),
            })
        }
        Err(e) => Err(GitnadoError::OperationFailed(format!(
            "Failed to execute command: {}",
            e
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn make_action(id: &str, name: &str, command: &str) -> CustomAction {
        CustomAction {
            id: id.to_string(),
            name: name.to_string(),
            command: command.to_string(),
            arguments: None,
            working_directory: None,
            shortcut: None,
            show_in_toolbar: false,
            open_in_terminal: false,
            confirm_before_run: false,
        }
    }

    #[tokio::test]
    async fn test_get_custom_actions_empty() {
        let repo = TestRepo::with_initial_commit();
        let result = get_custom_actions(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_save_custom_action() {
        let repo = TestRepo::with_initial_commit();
        let action = make_action("1", "Build", "cargo build");

        let result = save_custom_action(repo.path_str(), action).await;
        assert!(result.is_ok());
        let actions = result.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name, "Build");
        assert_eq!(actions[0].command, "cargo build");
    }

    #[tokio::test]
    async fn test_save_custom_action_update() {
        let repo = TestRepo::with_initial_commit();
        let action1 = make_action("1", "Build", "cargo build");
        save_custom_action(repo.path_str(), action1).await.unwrap();

        let action_updated = make_action("1", "Build Release", "cargo build --release");
        let result = save_custom_action(repo.path_str(), action_updated).await;
        assert!(result.is_ok());
        let actions = result.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name, "Build Release");
        assert_eq!(actions[0].command, "cargo build --release");
    }

    #[tokio::test]
    async fn test_save_multiple_actions() {
        let repo = TestRepo::with_initial_commit();
        save_custom_action(repo.path_str(), make_action("1", "Build", "cargo build"))
            .await
            .unwrap();
        let result =
            save_custom_action(repo.path_str(), make_action("2", "Test", "cargo test")).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_delete_custom_action() {
        let repo = TestRepo::with_initial_commit();
        save_custom_action(repo.path_str(), make_action("1", "Build", "cargo build"))
            .await
            .unwrap();
        save_custom_action(repo.path_str(), make_action("2", "Test", "cargo test"))
            .await
            .unwrap();

        let result = delete_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let actions = result.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "2");
    }

    #[tokio::test]
    async fn test_delete_nonexistent_action() {
        let repo = TestRepo::with_initial_commit();
        let result = delete_custom_action(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_run_custom_action() {
        let repo = TestRepo::with_initial_commit();
        // `echo hello` is valid on every supported platform, so this needs no
        // cfg! split; both arms were identical.
        let action = make_action("1", "Echo", "echo hello");
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.success);
        assert_eq!(action_result.exit_code, 0);
        assert!(action_result.stdout.contains("hello"));
    }

    #[tokio::test]
    async fn test_run_custom_action_with_arguments() {
        let repo = TestRepo::with_initial_commit();
        let mut action = make_action("1", "Echo Args", "echo");
        action.arguments = Some("hello world".to_string());
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.success);
        assert!(action_result.stdout.contains("hello world"));
    }

    #[tokio::test]
    async fn test_run_custom_action_not_found() {
        let repo = TestRepo::with_initial_commit();
        let result = run_custom_action(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_run_custom_action_variable_substitution() {
        let repo = TestRepo::with_initial_commit();
        let mut action = make_action("1", "Show Repo", "echo $REPO");
        action.arguments = Some("$BRANCH".to_string());
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.success);
        // The repo path should appear in the output
        assert!(!action_result.stdout.contains("$REPO"));
    }

    #[tokio::test]
    async fn test_run_custom_action_failing_command() {
        let repo = TestRepo::with_initial_commit();
        let action = if cfg!(target_os = "windows") {
            make_action("1", "Fail", "exit /b 1")
        } else {
            make_action("1", "Fail", "exit 1")
        };
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(!action_result.success);
        assert_eq!(action_result.exit_code, 1);
    }

    #[test]
    fn test_substitute_variables() {
        let result = substitute_variables("echo $REPO on $BRANCH", "/my/repo", "main", false)
            .expect("substitution should succeed");
        assert_eq!(result, "echo /my/repo on main");
    }

    #[test]
    fn test_substitute_variables_no_placeholders() {
        let result = substitute_variables("echo hello", "/my/repo", "main", false)
            .expect("substitution should succeed");
        assert_eq!(result, "echo hello");
    }

    #[test]
    fn test_substitute_variables_shell_quotes_metacharacters() {
        // Must defeat shell injection via branch name (POSIX path).
        if !cfg!(target_os = "windows") {
            let result = substitute_variables("git log $BRANCH", "/repo", "`;rm -rf ~;#", true)
                .expect("POSIX quoting should succeed");
            assert_eq!(result, "git log '`;rm -rf ~;#'");
        }
    }

    #[test]
    fn test_substitute_variables_rejects_windows_metachars() {
        // Windows path: substitution must be rejected when value contains
        // characters cmd.exe quoting cannot handle.
        if cfg!(target_os = "windows") {
            let err = substitute_variables("git log $BRANCH", "/repo", "%USERPROFILE%", true);
            assert!(err.is_err(), "expected rejection of % in branch name");
        }
    }

    #[test]
    fn test_substitute_variables_quotes_apostrophe_branch() {
        // POSIX-only check; ensures embedded single quote is escaped properly
        if !cfg!(target_os = "windows") {
            let result = substitute_variables("echo $BRANCH", "/repo", "it's", true)
                .expect("POSIX quoting should succeed");
            assert_eq!(result, "echo 'it'\\''s'");
        }
    }

    #[tokio::test]
    async fn test_get_custom_actions_invalid_repo() {
        let result = get_custom_actions("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_custom_action_persists() {
        let repo = TestRepo::with_initial_commit();
        save_custom_action(repo.path_str(), make_action("1", "Build", "cargo build"))
            .await
            .unwrap();

        // Read again to verify persistence
        let result = get_custom_actions(repo.path_str()).await;
        assert!(result.is_ok());
        let actions = result.unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "1");
    }

    #[tokio::test]
    async fn test_custom_action_with_working_directory() {
        let repo = TestRepo::with_initial_commit();
        let mut action = make_action("1", "Echo", "echo hello");
        action.working_directory = Some("repo_root".to_string());
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().success);
    }

    #[test]
    fn test_substitute_variables_both_placeholders() {
        let result = substitute_variables(
            "$REPO is on $BRANCH and $REPO again",
            "/my/repo",
            "develop",
            false,
        )
        .expect("substitution should succeed");
        assert_eq!(result, "/my/repo is on develop and /my/repo again");
    }

    #[test]
    fn test_substitute_variables_empty_input() {
        let result =
            substitute_variables("", "/repo", "main", false).expect("substitution should succeed");
        assert_eq!(result, "");
    }

    #[test]
    fn test_substitute_variables_empty_branch() {
        let result = substitute_variables("branch is $BRANCH", "/repo", "", false)
            .expect("substitution should succeed");
        assert_eq!(result, "branch is ");
    }

    #[tokio::test]
    async fn test_action_result_serialization() {
        let result = ActionResult {
            exit_code: 0,
            stdout: "output".to_string(),
            stderr: "".to_string(),
            success: true,
        };

        let json = serde_json::to_string(&result).unwrap();
        // Verify camelCase serialization
        assert!(json.contains("exitCode"));
        assert!(json.contains("stdout"));
        assert!(json.contains("stderr"));
        assert!(json.contains("success"));
    }

    #[tokio::test]
    async fn test_custom_action_serialization_camel_case() {
        let action = CustomAction {
            id: "1".to_string(),
            name: "Test".to_string(),
            command: "echo".to_string(),
            arguments: Some("hello".to_string()),
            working_directory: Some("repo_root".to_string()),
            shortcut: Some("Ctrl+Shift+T".to_string()),
            show_in_toolbar: true,
            open_in_terminal: false,
            confirm_before_run: true,
        };

        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("showInToolbar"));
        assert!(json.contains("openInTerminal"));
        assert!(json.contains("confirmBeforeRun"));
        assert!(json.contains("workingDirectory"));
    }

    #[tokio::test]
    async fn test_run_custom_action_with_custom_working_directory() {
        let repo = TestRepo::with_initial_commit();

        // Create a subdirectory
        std::fs::create_dir_all(repo.path.join("subdir")).unwrap();

        let mut action = make_action("1", "Pwd", "pwd");
        action.working_directory = Some(format!("{}/subdir", repo.path_str()));
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        let action_result = result.unwrap();
        assert!(action_result.success);
        assert!(action_result.stdout.contains("subdir"));
    }

    #[tokio::test]
    async fn test_run_custom_action_with_repo_variable_in_working_dir() {
        let repo = TestRepo::with_initial_commit();
        let mut action = make_action("1", "Echo", "echo ok");
        action.working_directory = Some("$REPO".to_string());
        save_custom_action(repo.path_str(), action).await.unwrap();

        let result = run_custom_action(repo.path_str(), "1".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().success);
    }

    #[tokio::test]
    async fn test_save_custom_action_without_git_repo() {
        let result = save_custom_action(
            "/nonexistent/path".to_string(),
            make_action("1", "Build", "cargo build"),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_custom_action_without_git_repo() {
        let result = delete_custom_action("/nonexistent/path".to_string(), "1".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_run_custom_action_without_git_repo() {
        let result = run_custom_action("/nonexistent/path".to_string(), "1".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_read_actions_malformed_json() {
        let repo = TestRepo::with_initial_commit();

        // Write malformed JSON to the actions file
        let actions_dir = repo.path.join(".git").join("gitnado");
        std::fs::create_dir_all(&actions_dir).unwrap();
        std::fs::write(actions_dir.join("custom_actions.json"), "not valid json").unwrap();

        let result = get_custom_actions(repo.path_str()).await;
        assert!(result.is_err(), "Malformed JSON should return an error");
    }

    #[test]
    fn test_actions_file_path() {
        let path = Path::new("/my/repo");
        let result = actions_file_path(path);
        assert_eq!(
            result,
            Path::new("/my/repo/.git/gitnado/custom_actions.json")
        );
    }

    #[test]
    fn test_get_current_branch_invalid_path() {
        let branch = get_current_branch(Path::new("/nonexistent/repo"));
        assert_eq!(branch, "");
    }

    #[test]
    fn test_get_current_branch_valid_repo() {
        let repo = TestRepo::with_initial_commit();
        let branch = get_current_branch(&repo.path);
        assert_eq!(branch, "main");
    }
}
