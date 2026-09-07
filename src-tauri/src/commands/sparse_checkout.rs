//! Sparse checkout command handlers
//! Manage sparse checkout configuration via git CLI

use std::process::Command;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Sparse checkout configuration
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseCheckoutConfig {
    pub enabled: bool,
    pub cone_mode: bool,
    pub patterns: Vec<String>,
}

/// Helper to run a git command and return stdout as a String
fn run_git(path: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git: {}", e)))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(GitnadoError::OperationFailed(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr
        )))
    }
}

/// Helper to run a git command, tolerating non-zero exit codes (returns empty string)
fn run_git_optional(path: &str, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Build the current sparse checkout config by querying git
fn build_config(path: &str) -> SparseCheckoutConfig {
    let sparse_val = run_git_optional(path, &["config", "--get", "core.sparseCheckout"]);
    let enabled = sparse_val.eq_ignore_ascii_case("true");

    let cone_val = run_git_optional(path, &["config", "--get", "core.sparseCheckoutCone"]);
    let cone_mode = cone_val.eq_ignore_ascii_case("true");

    let patterns = if enabled {
        let list_output = run_git_optional(path, &["sparse-checkout", "list"]);
        if list_output.is_empty() {
            Vec::new()
        } else {
            list_output.lines().map(|l| l.to_string()).collect()
        }
    } else {
        Vec::new()
    };

    SparseCheckoutConfig {
        enabled,
        cone_mode,
        patterns,
    }
}

/// Get the current sparse checkout configuration
#[command]
pub async fn get_sparse_checkout_config(path: String) -> Result<SparseCheckoutConfig> {
    Ok(build_config(&path))
}

/// Enable sparse checkout
#[command]
pub async fn enable_sparse_checkout(path: String, cone_mode: bool) -> Result<SparseCheckoutConfig> {
    // git >= 2.37 enables cone mode by default for `sparse-checkout init`.
    // To honor a caller's request for non-cone (glob/pattern) mode we must
    // pass `--no-cone` explicitly; otherwise git silently enables cone mode
    // and later glob patterns are rejected with "specify directories rather
    // than patterns".
    let mut args = vec!["sparse-checkout", "init"];
    if cone_mode {
        args.push("--cone");
    } else {
        args.push("--no-cone");
    }
    run_git(&path, &args)?;
    Ok(build_config(&path))
}

/// Disable sparse checkout
#[command]
pub async fn disable_sparse_checkout(path: String) -> Result<SparseCheckoutConfig> {
    run_git(&path, &["sparse-checkout", "disable"])?;
    Ok(build_config(&path))
}

/// Set sparse checkout patterns (replaces existing patterns)
#[command]
pub async fn set_sparse_checkout_patterns(
    path: String,
    patterns: Vec<String>,
) -> Result<SparseCheckoutConfig> {
    if patterns.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "At least one pattern is required".to_string(),
        ));
    }

    let mut args: Vec<&str> = vec!["sparse-checkout", "set", "--"];
    for p in &patterns {
        args.push(p.as_str());
    }
    run_git(&path, &args)?;
    Ok(build_config(&path))
}

/// Add patterns to sparse checkout (keeps existing patterns)
#[command]
pub async fn add_sparse_checkout_patterns(
    path: String,
    patterns: Vec<String>,
) -> Result<SparseCheckoutConfig> {
    if patterns.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "At least one pattern is required".to_string(),
        ));
    }

    let mut args: Vec<&str> = vec!["sparse-checkout", "add", "--"];
    for p in &patterns {
        args.push(p.as_str());
    }
    run_git(&path, &args)?;
    Ok(build_config(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// Check if git supports sparse-checkout (requires git >= 2.25).
    /// Detect by parsing `git --version` rather than probing `--help`
    /// (which can invoke a man pager and give a misleading non-zero exit,
    /// causing these tests to silently skip on a fully capable git).
    fn git_supports_sparse_checkout() -> bool {
        let out = match Command::new("git").arg("--version").output() {
            Ok(o) if o.status.success() => o,
            _ => return false,
        };
        let text = String::from_utf8_lossy(&out.stdout);
        // Expected form: "git version 2.43.0"
        let version = text.split_whitespace().nth(2).unwrap_or("");
        let mut parts = version.split('.');
        let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        major > 2 || (major == 2 && minor >= 25)
    }

    #[tokio::test]
    async fn test_get_sparse_checkout_config_default() {
        let repo = TestRepo::with_initial_commit();
        let result = get_sparse_checkout_config(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(!config.enabled);
        assert!(!config.cone_mode);
        assert!(config.patterns.is_empty());
    }

    #[tokio::test]
    async fn test_enable_sparse_checkout_cone_mode() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();
        let result = enable_sparse_checkout(repo.path_str(), true).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.enabled);
        assert!(config.cone_mode);
    }

    #[tokio::test]
    async fn test_enable_sparse_checkout_no_cone() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();
        let result = enable_sparse_checkout(repo.path_str(), false).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.enabled);
    }

    #[tokio::test]
    async fn test_enable_sparse_checkout_no_cone_allows_glob_patterns() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add docs", &[("docs/readme.md", "# Docs")]);

        // Requesting non-cone mode must actually produce non-cone mode.
        let config = enable_sparse_checkout(repo.path_str(), false)
            .await
            .unwrap();
        assert!(config.enabled);
        assert!(
            !config.cone_mode,
            "requesting cone_mode=false must yield non-cone mode, got cone_mode=true"
        );

        // In non-cone mode a glob pattern must be accepted (cone mode rejects
        // it with 'specify directories rather than patterns').
        let result = set_sparse_checkout_patterns(repo.path_str(), vec!["*.md".to_string()]).await;
        assert!(
            result.is_ok(),
            "glob pattern should be accepted in non-cone mode: {:?}",
            result.err()
        );
        let config = result.unwrap();
        assert!(config.patterns.iter().any(|p| p.contains("*.md")));
    }

    #[tokio::test]
    async fn test_disable_sparse_checkout() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();

        // Enable first
        enable_sparse_checkout(repo.path_str(), true).await.unwrap();

        // Now disable
        let result = disable_sparse_checkout(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(!config.enabled);
    }

    #[tokio::test]
    async fn test_set_sparse_checkout_patterns() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();

        // Create some directories and files for sparse checkout
        repo.create_file("src/main.rs", "fn main() {}");
        repo.create_file("docs/readme.md", "# Docs");
        repo.create_file("tests/test.rs", "#[test] fn t() {}");
        repo.create_commit(
            "Add files",
            &[
                ("src/main.rs", "fn main() {}"),
                ("docs/readme.md", "# Docs"),
                ("tests/test.rs", "#[test] fn t() {}"),
            ],
        );

        // Enable cone mode first
        enable_sparse_checkout(repo.path_str(), true).await.unwrap();

        // Set patterns
        let result = set_sparse_checkout_patterns(
            repo.path_str(),
            vec!["src".to_string(), "docs".to_string()],
        )
        .await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.enabled);
        assert!(!config.patterns.is_empty());
    }

    #[tokio::test]
    async fn test_set_sparse_checkout_patterns_empty() {
        let repo = TestRepo::with_initial_commit();

        let result = set_sparse_checkout_patterns(repo.path_str(), vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_sparse_checkout_patterns() {
        if !git_supports_sparse_checkout() {
            eprintln!("Skipping: git sparse-checkout not supported");
            return;
        }

        let repo = TestRepo::with_initial_commit();

        repo.create_file("src/main.rs", "fn main() {}");
        repo.create_file("docs/readme.md", "# Docs");
        repo.create_file("tests/test.rs", "#[test] fn t() {}");
        repo.create_commit(
            "Add files",
            &[
                ("src/main.rs", "fn main() {}"),
                ("docs/readme.md", "# Docs"),
                ("tests/test.rs", "#[test] fn t() {}"),
            ],
        );

        // Enable cone mode and set initial pattern
        enable_sparse_checkout(repo.path_str(), true).await.unwrap();
        set_sparse_checkout_patterns(repo.path_str(), vec!["src".to_string()])
            .await
            .unwrap();

        // Add another pattern
        let result = add_sparse_checkout_patterns(repo.path_str(), vec!["docs".to_string()]).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.enabled);
    }

    #[tokio::test]
    async fn test_add_sparse_checkout_patterns_empty() {
        let repo = TestRepo::with_initial_commit();

        let result = add_sparse_checkout_patterns(repo.path_str(), vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_build_config_helper() {
        let repo = TestRepo::with_initial_commit();
        let config = build_config(&repo.path_str());
        assert!(!config.enabled);
        assert!(!config.cone_mode);
        assert!(config.patterns.is_empty());
    }

    #[tokio::test]
    async fn test_run_git_invalid_path() {
        let result = run_git("/nonexistent/path/that/does/not/exist", &["status"]);
        assert!(result.is_err());
    }
}
