//! File operations command handlers
//! Reveal files in file manager, open in default apps, and editor integration

use std::path::Path;
use tauri::command;

use super::path_utils::validate_path_within_repo;
use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Escape cmd.exe metacharacters to prevent command injection (Windows only).
#[cfg(target_os = "windows")]
fn escape_cmd_meta(s: &str) -> String {
    s.chars()
        .map(|c| {
            if "&|<>^()%!".contains(c) {
                format!("^{}", c)
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Result of an open/reveal operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub success: bool,
    pub message: Option<String>,
}

/// Editor configuration from git config
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    /// core.editor setting
    pub editor: Option<String>,
    /// GIT_VISUAL or core.visual setting
    pub visual: Option<String>,
}

#[cfg(target_os = "windows")]
fn windows_reveal_argument(target: &Path) -> std::ffi::OsString {
    use std::ffi::OsString;

    // Explorer parses its own command line and requires the switch outside
    // quotes with only the path quoted.
    let mut select_arg = OsString::from("/select,\"");
    select_arg.push(target.as_os_str());
    select_arg.push("\"");
    select_arg
}

#[cfg(target_os = "windows")]
fn windows_reveal_command(target: &Path) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    let mut command = create_command("explorer.exe");
    command.raw_arg(windows_reveal_argument(target));
    command
}

/// Run git config command to get a value
fn get_git_config_value(repo_path: Option<&Path>, key: &str, global: bool) -> Option<String> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

    cmd.arg("config");
    if global {
        cmd.arg("--global");
    }
    cmd.arg("--get");
    cmd.arg(key);

    let output = cmd.output().ok()?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    }
}

/// Run git config command to set a value
fn set_git_config_value(
    repo_path: Option<&Path>,
    key: &str,
    value: &str,
    global: bool,
) -> Result<()> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

    cmd.arg("config");
    if global {
        cmd.arg("--global");
    } else {
        cmd.arg("--local");
    }
    cmd.arg(key);
    cmd.arg(value);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git config: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(GitnadoError::OperationFailed(format!(
            "Failed to set config: {}",
            stderr
        )))
    }
}

/// Reveal a file or folder in the system file manager
/// Unlike open_file_manager which opens a directory, this reveals a specific file
#[command]
pub async fn reveal_in_file_manager(path: String) -> Result<OpenResult> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(GitnadoError::InvalidPath(path));
    }

    #[cfg(target_os = "windows")]
    {
        windows_reveal_command(target).spawn().map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to reveal in explorer: {}", e))
        })?;
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, use open -R to reveal in Finder
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to reveal in Finder: {}", e))
            })?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, try dbus first for better integration, fall back to xdg-open for parent dir
        let revealed = try_dbus_reveal(target);
        if !revealed {
            // Fall back to opening the parent directory
            let parent = target.parent().unwrap_or(target);
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| {
                    GitnadoError::OperationFailed(format!(
                        "Failed to reveal in file manager: {}",
                        e
                    ))
                })?;
        }
    }

    Ok(OpenResult {
        success: true,
        message: None,
    })
}

/// Build the percent-encoded `file://` URI handed to FileManager1.ShowItems.
/// Returns `None` for paths that cannot be expressed as a file URL (for
/// example a relative path), so the caller can fall back to `xdg-open`.
#[cfg(target_os = "linux")]
fn dbus_reveal_uri(path: &Path) -> Option<String> {
    url::Url::from_file_path(path)
        .ok()
        .map(|url| url.to_string())
}

#[cfg(target_os = "linux")]
fn try_dbus_reveal(path: &Path) -> bool {
    // Try to use dbus to reveal file in file manager
    // This works with Nautilus, Dolphin, and other modern file managers
    let Some(uri) = dbus_reveal_uri(path) else {
        return false;
    };
    std::process::Command::new("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{}", uri),
            "string:",
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Open a file with the system's default application
#[command]
pub async fn open_in_default_app(path: String) -> Result<OpenResult> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(GitnadoError::InvalidPath(path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &escape_cmd_meta(&path)])
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open file: {}", e)))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open file: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open file: {}", e)))?;
    }

    Ok(OpenResult {
        success: true,
        message: None,
    })
}

/// Open a file in the configured editor with optional line number
#[command]
pub async fn open_in_configured_editor(
    path: String,
    #[allow(non_snake_case)] filePath: String,
    line: Option<u32>,
) -> Result<OpenResult> {
    let repo_path = Path::new(&path);
    let target_file = if Path::new(&filePath).is_absolute() {
        filePath.clone()
    } else {
        validate_path_within_repo(repo_path, &filePath)?
            .to_string_lossy()
            .to_string()
    };

    let target = Path::new(&target_file);
    if !target.exists() {
        return Err(GitnadoError::InvalidPath(target_file));
    }

    // Get editor from git config (local first, then global)
    let editor = get_git_config_value(Some(repo_path), "core.editor", false)
        .or_else(|| get_git_config_value(None, "core.editor", true))
        .or_else(|| std::env::var("GIT_EDITOR").ok())
        .or_else(|| std::env::var("VISUAL").ok())
        .or_else(|| std::env::var("EDITOR").ok());

    match editor {
        Some(editor_cmd) => {
            // Parse the editor command and add line number support
            let (cmd, args) = parse_editor_command(&editor_cmd, &target_file, line);

            std::process::Command::new(&cmd)
                .args(&args)
                .current_dir(repo_path)
                .spawn()
                .map_err(|e| {
                    GitnadoError::OperationFailed(format!(
                        "Failed to open editor '{}': {}",
                        editor_cmd, e
                    ))
                })?;

            Ok(OpenResult {
                success: true,
                message: Some(format!("Opened in {}", cmd)),
            })
        }
        None => {
            // No editor configured, fall back to system default
            open_in_default_app(target_file).await
        }
    }
}

/// Split a command string respecting quoted arguments.
/// Handles double-quoted and single-quoted strings (e.g., `"C:\Program Files\Code\Code.exe" --wait`).
fn split_command(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_double_quote = false;
    let mut in_single_quote = false;

    for ch in input.chars() {
        match ch {
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
            }
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
            }
            c if c.is_whitespace() && !in_double_quote && !in_single_quote => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            c => {
                current.push(c);
            }
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Parse editor command and add line number argument based on editor type
fn parse_editor_command(
    editor_cmd: &str,
    file_path: &str,
    line: Option<u32>,
) -> (String, Vec<String>) {
    let parts = split_command(editor_cmd);
    if parts.is_empty() {
        return (editor_cmd.to_string(), vec![file_path.to_string()]);
    }

    let cmd = parts[0].clone();
    let mut args: Vec<String> = parts[1..].to_vec();

    // Detect editor type and add line number support
    let cmd_lower = cmd.to_lowercase();
    let cmd_name = Path::new(&cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&cmd_lower)
        .to_lowercase();

    if let Some(line_num) = line {
        match cmd_name.as_str() {
            // VS Code, Cursor, and similar
            "code" | "cursor" | "code-insiders" | "codium" | "vscodium" => {
                args.push("--goto".to_string());
                args.push(format!("{}:{}", file_path, line_num));
                return (cmd, args);
            }
            // Vim-based editors
            "vim" | "nvim" | "neovim" | "vi" | "gvim" | "mvim" => {
                args.push(format!("+{}", line_num));
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Emacs
            "emacs" | "emacsclient" => {
                args.push(format!("+{}", line_num));
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Sublime Text
            "subl" | "sublime_text" | "sublime" => {
                args.push(format!("{}:{}", file_path, line_num));
                return (cmd, args);
            }
            // Atom (deprecated but still used)
            "atom" => {
                args.push(format!("{}:{}", file_path, line_num));
                return (cmd, args);
            }
            // JetBrains IDEs
            "idea" | "idea64" | "pycharm" | "webstorm" | "phpstorm" | "goland" | "clion"
            | "rider" | "rubymine" | "datagrip" => {
                args.push("--line".to_string());
                args.push(line_num.to_string());
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Notepad++ (Windows)
            "notepad++" => {
                args.push(format!("-n{}", line_num));
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Kate (KDE)
            "kate" => {
                args.push("--line".to_string());
                args.push(line_num.to_string());
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Gedit (GNOME)
            "gedit" => {
                args.push(format!("+{}", line_num));
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Nano
            "nano" => {
                args.push(format!("+{}", line_num));
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // TextMate
            "mate" => {
                args.push("--line".to_string());
                args.push(line_num.to_string());
                args.push(file_path.to_string());
                return (cmd, args);
            }
            // Helix
            "hx" | "helix" => {
                args.push(format!("{}:{}", file_path, line_num));
                return (cmd, args);
            }
            // Zed
            "zed" => {
                args.push(format!("{}:{}", file_path, line_num));
                return (cmd, args);
            }
            _ => {
                // Unknown editor, just pass the file
                args.push(file_path.to_string());
            }
        }
    } else {
        args.push(file_path.to_string());
    }

    (cmd, args)
}

/// Get the configured editor settings
#[command]
pub async fn get_editor_config(path: String, global: bool) -> Result<EditorConfig> {
    let repo_path = Path::new(&path);

    let editor = if global {
        get_git_config_value(None, "core.editor", true)
    } else {
        // Try local first, then global as fallback
        get_git_config_value(Some(repo_path), "core.editor", false)
            .or_else(|| get_git_config_value(None, "core.editor", true))
    };

    let visual = std::env::var("VISUAL")
        .ok()
        .or_else(|| std::env::var("GIT_VISUAL").ok());

    Ok(EditorConfig { editor, visual })
}

/// Set the configured editor
#[command]
pub async fn set_editor_config(path: String, editor: String, global: bool) -> Result<OpenResult> {
    let repo_path = Path::new(&path);

    if !global && !repo_path.join(".git").exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    set_git_config_value(
        if global { None } else { Some(repo_path) },
        "core.editor",
        &editor,
        global,
    )?;

    Ok(OpenResult {
        success: true,
        message: Some(format!(
            "Editor set to '{}' ({})",
            editor,
            if global { "global" } else { "local" }
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_split_command_simple() {
        let parts = split_command("code --wait");
        assert_eq!(parts, vec!["code", "--wait"]);
    }

    #[test]
    fn test_split_command_double_quoted_path() {
        let parts = split_command(r#""C:\Program Files\VS Code\Code.exe" --wait"#);
        assert_eq!(parts, vec![r"C:\Program Files\VS Code\Code.exe", "--wait"]);
    }

    #[test]
    fn test_split_command_single_quoted_path() {
        let parts = split_command("'/usr/local/bin/my editor' --line 5");
        assert_eq!(parts, vec!["/usr/local/bin/my editor", "--line", "5"]);
    }

    #[test]
    fn test_parse_editor_command_quoted_path() {
        let (cmd, args) = parse_editor_command(
            r#""C:\Program Files\VS Code\Code.exe" --wait"#,
            "/path/to/file.rs",
            Some(42),
        );
        assert_eq!(cmd, r"C:\Program Files\VS Code\Code.exe");
        assert!(args.contains(&"--wait".to_string()));
    }

    #[test]
    fn test_parse_editor_command_vscode() {
        let (cmd, args) = parse_editor_command("code", "/path/to/file.rs", Some(42));
        assert_eq!(cmd, "code");
        assert!(args.contains(&"--goto".to_string()));
        assert!(args.contains(&"/path/to/file.rs:42".to_string()));
    }

    #[test]
    fn test_parse_editor_command_vim() {
        let (cmd, args) = parse_editor_command("vim", "/path/to/file.rs", Some(42));
        assert_eq!(cmd, "vim");
        assert!(args.contains(&"+42".to_string()));
        assert!(args.contains(&"/path/to/file.rs".to_string()));
    }

    #[test]
    fn test_parse_editor_command_sublime() {
        let (cmd, args) = parse_editor_command("subl", "/path/to/file.rs", Some(42));
        assert_eq!(cmd, "subl");
        assert!(args.contains(&"/path/to/file.rs:42".to_string()));
    }

    #[test]
    fn test_parse_editor_command_with_args() {
        let (cmd, args) = parse_editor_command("code --wait", "/path/to/file.rs", Some(42));
        assert_eq!(cmd, "code");
        assert!(args.contains(&"--wait".to_string()));
        assert!(args.contains(&"--goto".to_string()));
    }

    #[test]
    fn test_parse_editor_command_no_line() {
        let (cmd, args) = parse_editor_command("code", "/path/to/file.rs", None);
        assert_eq!(cmd, "code");
        assert!(args.contains(&"/path/to/file.rs".to_string()));
        assert!(!args.contains(&"--goto".to_string()));
    }

    #[test]
    fn test_parse_editor_command_unknown_editor() {
        let (cmd, args) = parse_editor_command("myeditor", "/path/to/file.rs", Some(42));
        assert_eq!(cmd, "myeditor");
        assert!(args.contains(&"/path/to/file.rs".to_string()));
    }

    #[tokio::test]
    async fn test_reveal_in_file_manager_invalid_path() {
        let result =
            reveal_in_file_manager("/nonexistent/path/that/does/not/exist".to_string()).await;
        assert!(result.is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_reveal_uses_single_select_argument() {
        let target = Path::new(r"C:\repo with spaces\src\main.rs");
        let argument = windows_reveal_argument(target);

        assert_eq!(argument, r#"/select,"C:\repo with spaces\src\main.rs""#);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_dbus_reveal_uri_percent_encodes_reserved_characters() {
        assert_eq!(
            dbus_reveal_uri(Path::new("/home/u/my repo/a b.txt")).as_deref(),
            Some("file:///home/u/my%20repo/a%20b.txt")
        );
        assert_eq!(
            dbus_reveal_uri(Path::new("/home/u/repo/a#b?c.txt")).as_deref(),
            Some("file:///home/u/repo/a%23b%3Fc.txt")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_dbus_reveal_uri_rejects_relative_path() {
        assert!(dbus_reveal_uri(Path::new("relative/a.txt")).is_none());
    }

    #[tokio::test]
    async fn test_open_in_default_app_invalid_path() {
        let result = open_in_default_app("/nonexistent/path/that/does/not/exist".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_open_in_configured_editor_invalid_path() {
        let repo = TestRepo::with_initial_commit();
        let result =
            open_in_configured_editor(repo.path_str(), "nonexistent_file.txt".to_string(), None)
                .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_editor_config() {
        let repo = TestRepo::with_initial_commit();
        let result = get_editor_config(repo.path_str(), false).await;
        assert!(result.is_ok());
        // Config may or may not have editor set
    }

    #[tokio::test]
    async fn test_set_editor_config() {
        let repo = TestRepo::with_initial_commit();

        // Set editor locally
        let result = set_editor_config(repo.path_str(), "code --wait".to_string(), false).await;
        assert!(result.is_ok());

        // Verify it was set
        let config = get_editor_config(repo.path_str(), false).await.unwrap();
        assert_eq!(config.editor, Some("code --wait".to_string()));
    }

    #[tokio::test]
    async fn test_set_editor_config_nonexistent_repo() {
        let result =
            set_editor_config("/nonexistent/repo".to_string(), "code".to_string(), false).await;
        assert!(result.is_err());
    }
}
