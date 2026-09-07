//! Terminal integration command handlers
//! Open system terminal in repository directory

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Escape cmd.exe metacharacters to prevent command injection (Windows only).
/// Characters like & | < > ^ ( ) % ! are prefixed with ^ to be treated literally.
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

/// Open a terminal in the specified directory
#[command]
pub async fn open_terminal(path: String) -> Result<()> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(GitnadoError::InvalidPath(path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd"])
            .current_dir(dir)
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to open terminal: {}", e))
            })?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", dir.to_str().unwrap_or(".")])
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to open terminal: {}", e))
            })?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators in order of preference
        let terminals = [
            ("x-terminal-emulator", vec![]),
            (
                "gnome-terminal",
                vec!["--working-directory".to_string(), path.clone()],
            ),
            ("konsole", vec!["--workdir".to_string(), path.clone()]),
            (
                "xfce4-terminal",
                vec!["--working-directory".to_string(), path.clone()],
            ),
            ("xterm", vec![]),
        ];

        let mut opened = false;
        for (term, args) in &terminals {
            if let Ok(_cmd) = std::process::Command::new(term)
                .args(args)
                .current_dir(dir)
                .spawn()
            {
                opened = true;
                break;
            }
        }

        if !opened {
            return Err(GitnadoError::OperationFailed(
                "No terminal emulator found".to_string(),
            ));
        }
    }

    Ok(())
}

/// Open a file manager in the specified directory
#[command]
pub async fn open_file_manager(path: String) -> Result<()> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(GitnadoError::InvalidPath(path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to open file manager: {}", e))
            })?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to open file manager: {}", e))
            })?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to open file manager: {}", e))
            })?;
    }

    Ok(())
}

/// Open a file in the default external editor
#[command]
pub async fn open_in_editor(file_path: String) -> Result<()> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(GitnadoError::InvalidPath(file_path));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &escape_cmd_meta(&file_path)])
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open editor: {}", e)))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open editor: {}", e)))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| GitnadoError::OperationFailed(format!("Failed to open editor: {}", e)))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_open_terminal_invalid_path() {
        let result = open_terminal("/nonexistent/path/that/does/not/exist".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_open_file_manager_invalid_path() {
        let result = open_file_manager("/nonexistent/path/that/does/not/exist".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_open_in_editor_invalid_path() {
        let result =
            open_in_editor("/nonexistent/path/that/does/not/exist/file.txt".to_string()).await;
        assert!(result.is_err());
    }

    // Note: We can't easily test successful opening in CI since there may be
    // no terminal/file manager available, but we verify error handling.
}
