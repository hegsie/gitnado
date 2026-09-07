//! External merge tool configuration and launch
//!
//! Provides commands for configuring and launching external merge tools
//! such as kdiff3, meld, Beyond Compare, vimdiff, etc.

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Merge tool configuration
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeToolConfig {
    /// Name of the configured merge tool (e.g., "kdiff3", "meld")
    pub tool_name: Option<String>,
    /// Custom command for the merge tool
    pub tool_cmd: Option<String>,
}

/// Information about a known merge tool
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeToolInfo {
    /// Tool identifier name
    pub name: String,
    /// Human-readable display name
    pub display_name: String,
    /// Command used to launch the tool
    pub command: String,
    /// Whether the tool is available on the system
    pub available: bool,
}

/// Result of launching a merge tool
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeToolResult {
    /// Whether the merge tool exited successfully
    pub success: bool,
    /// Output or error message from the merge tool
    pub message: String,
}

/// Run git config command (local helper)
fn run_git_config(repo_path: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    cmd.arg("config");
    cmd.args(args);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git config: {}", e)))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        // Exit code 1 with no output means "key not found", which is not an error
        if output.status.code() == Some(1) && stderr.is_empty() && stdout.is_empty() {
            Ok(String::new())
        } else {
            Err(GitnadoError::OperationFailed(if stderr.is_empty() {
                stdout
            } else {
                stderr
            }))
        }
    }
}

/// Get the current merge tool configuration
#[command]
pub async fn get_merge_tool_config(path: String) -> Result<MergeToolConfig> {
    let repo_path = Path::new(&path);

    let tool_name = run_git_config(repo_path, &["--get", "merge.tool"])
        .ok()
        .filter(|s| !s.is_empty());

    let tool_cmd = if let Some(ref name) = tool_name {
        let key = format!("mergetool.{}.cmd", name);
        run_git_config(repo_path, &["--get", &key])
            .ok()
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok(MergeToolConfig {
        tool_name,
        tool_cmd,
    })
}

/// Set the merge tool configuration
#[command]
pub async fn set_merge_tool_config(
    path: String,
    tool_name: String,
    tool_cmd: Option<String>,
) -> Result<()> {
    let repo_path = Path::new(&path);

    run_git_config(repo_path, &["merge.tool", &tool_name])?;

    if let Some(ref cmd) = tool_cmd {
        let key = format!("mergetool.{}.cmd", tool_name);
        run_git_config(repo_path, &[&key, cmd])?;
    }

    Ok(())
}

/// Launch the configured merge tool for a specific file
#[command]
pub async fn launch_merge_tool(path: String, file_path: String) -> Result<MergeToolResult> {
    let repo_path = Path::new(&path);

    // First, get the configured merge tool name
    let tool_name = run_git_config(repo_path, &["--get", "merge.tool"])
        .ok()
        .filter(|s| !s.is_empty());

    let mut cmd = create_command("git");
    cmd.current_dir(repo_path);
    cmd.arg("mergetool");
    cmd.arg("--no-prompt");

    if let Some(ref name) = tool_name {
        cmd.arg(format!("--tool={}", name));
    }

    cmd.arg(&file_path);

    let output = cmd.output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to launch merge tool: {}", e))
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(MergeToolResult {
            success: true,
            message: if stdout.is_empty() {
                "Merge tool completed successfully".to_string()
            } else {
                stdout
            },
        })
    } else {
        Ok(MergeToolResult {
            success: false,
            message: if stderr.is_empty() { stdout } else { stderr },
        })
    }
}

/// Check if a command is available on the system
fn is_command_available(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let output = create_command("where").arg(command).output();
        output.map(|o| o.status.success()).unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = create_command("which").arg(command).output();
        output.map(|o| o.status.success()).unwrap_or(false)
    }
}

/// Get a list of commonly available merge tools with availability status
#[command]
pub async fn get_available_merge_tools() -> Result<Vec<MergeToolInfo>> {
    let tools = vec![
        ("kdiff3", "KDiff3", "kdiff3", "kdiff3"),
        (
            "meld",
            "Meld",
            "meld $LOCAL $BASE $REMOTE -o $MERGED",
            "meld",
        ),
        (
            "bc",
            "Beyond Compare",
            "bcomp $LOCAL $REMOTE $BASE $MERGED",
            "bcomp",
        ),
        (
            "vimdiff",
            "Vimdiff",
            "vimdiff $LOCAL $BASE $REMOTE $MERGED",
            "vimdiff",
        ),
        (
            "opendiff",
            "FileMerge (macOS)",
            "opendiff $LOCAL $REMOTE -ancestor $BASE -merge $MERGED",
            "opendiff",
        ),
        (
            "p4merge",
            "P4Merge (Perforce)",
            "p4merge $BASE $LOCAL $REMOTE $MERGED",
            "p4merge",
        ),
        (
            "tortoisemerge",
            "TortoiseMerge",
            "TortoiseMerge /base:$BASE /theirs:$REMOTE /mine:$LOCAL /merged:$MERGED",
            "TortoiseMerge",
        ),
        (
            "winmerge",
            "WinMerge",
            "WinMergeU $LOCAL $REMOTE $MERGED",
            "WinMergeU",
        ),
        (
            "vscode",
            "Visual Studio Code",
            "code --wait --merge $LOCAL $REMOTE $BASE $MERGED",
            "code",
        ),
        (
            "smerge",
            "Sublime Merge",
            "smerge mergetool $BASE $LOCAL $REMOTE -o $MERGED",
            "smerge",
        ),
    ];

    let result: Vec<MergeToolInfo> = tools
        .into_iter()
        .map(|(name, display_name, command, executable)| {
            let available = is_command_available(executable);
            MergeToolInfo {
                name: name.to_string(),
                display_name: display_name.to_string(),
                command: command.to_string(),
                available,
            }
        })
        .collect();

    Ok(result)
}

/// Auto-detect the first available merge tool on the system
#[command]
pub async fn auto_detect_merge_tool() -> Result<Option<MergeToolInfo>> {
    let tools = get_available_merge_tools().await?;
    Ok(tools.into_iter().find(|t| t.available))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_merge_tool_config_default() {
        let repo = TestRepo::with_initial_commit();
        let result = get_merge_tool_config(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        // Fresh repo should not have a merge tool configured
        assert!(config.tool_name.is_none());
        assert!(config.tool_cmd.is_none());
    }

    #[tokio::test]
    async fn test_set_and_get_merge_tool_config() {
        let repo = TestRepo::with_initial_commit();

        let result = set_merge_tool_config(repo.path_str(), "kdiff3".to_string(), None).await;
        assert!(result.is_ok());

        let config = get_merge_tool_config(repo.path_str()).await.unwrap();
        assert_eq!(config.tool_name.as_deref(), Some("kdiff3"));
    }

    #[tokio::test]
    async fn test_set_merge_tool_config_with_cmd() {
        let repo = TestRepo::with_initial_commit();

        let result = set_merge_tool_config(
            repo.path_str(),
            "custom".to_string(),
            Some("/usr/bin/custom-merge $LOCAL $REMOTE $MERGED".to_string()),
        )
        .await;
        assert!(result.is_ok());

        let config = get_merge_tool_config(repo.path_str()).await.unwrap();
        assert_eq!(config.tool_name.as_deref(), Some("custom"));
        assert_eq!(
            config.tool_cmd.as_deref(),
            Some("/usr/bin/custom-merge $LOCAL $REMOTE $MERGED")
        );
    }

    #[tokio::test]
    async fn test_get_available_merge_tools() {
        let result = get_available_merge_tools().await;
        assert!(result.is_ok());
        let tools = result.unwrap();
        assert!(!tools.is_empty());
        assert!(tools.iter().any(|t| t.name == "kdiff3"));
        assert!(tools.iter().any(|t| t.name == "meld"));
        assert!(tools.iter().any(|t| t.name == "bc"));
        assert!(tools.iter().any(|t| t.name == "vimdiff"));
        // Verify new fields exist
        for tool in &tools {
            assert!(!tool.command.is_empty());
            // available is a bool, just verify it's accessible
            let _ = tool.available;
        }
    }

    #[tokio::test]
    async fn test_auto_detect_merge_tool() {
        let result = auto_detect_merge_tool().await;
        assert!(result.is_ok());
        // Result may or may not find a tool depending on the system
        if let Some(tool) = result.unwrap() {
            assert!(tool.available);
            assert!(!tool.name.is_empty());
            assert!(!tool.command.is_empty());
        }
    }
}
