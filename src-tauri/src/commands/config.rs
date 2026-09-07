//! Git configuration command handlers
//! Manage global and repository-level git settings

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Git configuration entry
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    /// Configuration key (e.g., "user.name")
    pub key: String,
    /// Configuration value
    pub value: String,
    /// Scope of the configuration (global, local, system)
    pub scope: String,
}

/// Git alias
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAlias {
    /// Alias name (without "alias." prefix)
    pub name: String,
    /// Command the alias expands to
    pub command: String,
    /// Whether this is a global alias
    pub is_global: bool,
}

/// User identity configuration
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentity {
    /// User name
    pub name: Option<String>,
    /// User email
    pub email: Option<String>,
    /// Whether the name is globally configured
    pub name_is_global: bool,
    /// Whether the email is globally configured
    pub email_is_global: bool,
}

/// Run git config command
fn run_git_config(repo_path: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

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

/// Run git config and return raw, *untrimmed* stdout.
///
/// Unlike [`run_git_config`], this does not trim the output — it is used for
/// NUL-terminated (`--null`) parsing where records and values are delimited
/// explicitly, so trimming would corrupt values with leading/trailing
/// whitespace or newlines (e.g. multi-line shell aliases).
pub(crate) fn run_git_config_raw(repo_path: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

    cmd.arg("config");
    cmd.args(args);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git config: {}", e)))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Exit code 1 with no output means "key/section not found" — a benign
        // empty result for --get / --get-regexp / --list.
        if output.status.code() == Some(1) && stderr.is_empty() {
            Ok(String::new())
        } else {
            Err(GitnadoError::OperationFailed(if stderr.is_empty() {
                "Failed to read git configuration".to_string()
            } else {
                stderr
            }))
        }
    }
}

/// Run `git config ... --unset ...`, refusing when git reports a real failure.
///
/// A missing key (git exits 5 with no stderr) is treated as a benign no-op —
/// clearing an already-empty field should succeed. Every other failure
/// (multi-valued key, locked config, read-only file) is surfaced so the UI can
/// show it, exactly as the git CLI refuses these operations instead of silently
/// doing nothing.
pub(crate) fn run_git_config_unset(repo_path: Option<&Path>, args: &[&str]) -> Result<()> {
    let mut cmd = create_command("git");

    if let Some(path) = repo_path {
        cmd.current_dir(path);
    }

    cmd.arg("config");
    cmd.args(args);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git config: {}", e)))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // Exit code 5 with empty stderr => the key does not exist; unsetting it is a
    // no-op. A multi-valued key also exits 5, but with a warning on stderr.
    if output.status.code() == Some(5) && stderr.is_empty() {
        return Ok(());
    }

    Err(GitnadoError::OperationFailed(if stderr.is_empty() {
        "Failed to unset git configuration value".to_string()
    } else {
        stderr
    }))
}

/// Get a single config value
#[command]
pub async fn get_config_value(
    path: Option<String>,
    key: String,
    global: Option<bool>,
) -> Result<Option<String>> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let mut args = vec!["--get"];
    if global.unwrap_or(false) {
        args.insert(0, "--global");
    }
    args.push(&key);

    let result = run_git_config(repo_path, &args)?;
    if result.is_empty() {
        Ok(None)
    } else {
        Ok(Some(result))
    }
}

/// Set a config value
#[command]
pub async fn set_config_value(
    path: Option<String>,
    key: String,
    value: String,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    run_git_config(repo_path, &[scope, &key, &value])?;
    Ok(())
}

/// Unset a config value
#[command]
pub async fn unset_config_value(
    path: Option<String>,
    key: String,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    // A missing key is a benign no-op; any other failure (e.g. a multi-valued
    // key) is surfaced to the user instead of being silently swallowed.
    run_git_config_unset(repo_path, &[scope, "--unset", &key])
}

/// Get all config entries from a specific scope
#[command]
pub async fn get_config_list(
    path: Option<String>,
    global: Option<bool>,
) -> Result<Vec<ConfigEntry>> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope_arg = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    let scope_name = if global.unwrap_or(false) {
        "global"
    } else {
        "local"
    };

    // Use NUL-terminated output so multi-line values (e.g. shell aliases) are
    // preserved intact. Each record is `key\nvalue`, records separated by NUL.
    let result = run_git_config_raw(repo_path, &[scope_arg, "--null", "--list"])?;

    let entries: Vec<ConfigEntry> = result
        .split('\0')
        .filter(|record| !record.is_empty())
        .map(|record| {
            let (key, value) = match record.split_once('\n') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (record.to_string(), String::new()),
            };
            ConfigEntry {
                key,
                value,
                scope: scope_name.to_string(),
            }
        })
        .collect();

    Ok(entries)
}

/// Resolve the *effective* value of a config key with repository context,
/// returning the value and whether it resolves from the global scope.
///
/// Runs `git config --show-scope --null --get <key>` with the repo as the
/// working directory, so the result matches what commits actually use:
/// libgit2's `repo.signature()` honours the file precedence
/// (system → global → local → worktree) and conditional includes
/// (`includeIf gitdir:`) that a bare `--global --get` (run without a working
/// directory) silently ignores.
fn read_effective_config(repo_path: &Path, key: &str) -> (Option<String>, String) {
    let raw = run_git_config_raw(Some(repo_path), &["--show-scope", "--null", "--get", key])
        .unwrap_or_default();
    // Output format: `scope\0value` (with a trailing NUL).
    let trimmed = raw.strip_suffix('\0').unwrap_or(raw.as_str());
    match trimmed.split_once('\0') {
        Some((scope, value)) if !value.is_empty() => (Some(value.to_string()), scope.to_string()),
        _ => (None, String::new()),
    }
}

/// Get user identity (name and email)
#[command]
pub async fn get_user_identity(path: String) -> Result<UserIdentity> {
    let repo_path = Path::new(&path);

    // Resolve the effective identity the way libgit2 does when it signs a
    // commit: with repository context, honouring system scope and conditional
    // includes. This keeps the displayed identity in sync with the recorded
    // commit author.
    let (name, name_scope) = read_effective_config(repo_path, "user.name");
    let (email, email_scope) = read_effective_config(repo_path, "user.email");

    Ok(UserIdentity {
        name,
        email,
        name_is_global: name_scope == "global",
        email_is_global: email_scope == "global",
    })
}

/// Set user identity
#[command]
pub async fn set_user_identity(
    path: Option<String>,
    name: Option<String>,
    email: Option<String>,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    if let Some(n) = name {
        if n.is_empty() {
            run_git_config_unset(repo_path, &[scope, "--unset", "user.name"])?;
        } else {
            run_git_config(repo_path, &[scope, "user.name", &n])?;
        }
    }

    if let Some(e) = email {
        if e.is_empty() {
            run_git_config_unset(repo_path, &[scope, "--unset", "user.email"])?;
        } else {
            run_git_config(repo_path, &[scope, "user.email", &e])?;
        }
    }

    Ok(())
}

/// Get all git aliases
#[command]
pub async fn get_aliases(path: Option<String>) -> Result<Vec<GitAlias>> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    // Resolve every alias across all scopes in one pass, with repository
    // context so system-scope and conditional-include aliases are visible.
    // `--show-scope --null` emits `scope\0key\nvalue` records in increasing
    // precedence (system → global → local → worktree), so a later record for
    // the same alias name overrides an earlier one — matching git's own
    // effective resolution. NUL termination keeps multi-line alias bodies
    // intact.
    let raw = run_git_config_raw(
        repo_path,
        &["--show-scope", "--null", "--get-regexp", "^alias\\."],
    )?;

    let mut all_aliases: Vec<GitAlias> = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(scope) = fields.next() {
        if scope.is_empty() {
            continue;
        }
        let Some(record) = fields.next() else {
            break;
        };
        let (key, command) = match record.split_once('\n') {
            Some((k, v)) => (k, v),
            None => (record, ""),
        };
        let Some(name) = key.strip_prefix("alias.") else {
            continue;
        };
        let alias = GitAlias {
            name: name.to_string(),
            command: command.to_string(),
            is_global: scope == "global",
        };
        // Later (higher-precedence) scope wins for a duplicate alias name.
        if let Some(idx) = all_aliases.iter().position(|a| a.name == alias.name) {
            all_aliases[idx] = alias;
        } else {
            all_aliases.push(alias);
        }
    }

    // Sort by name
    all_aliases.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(all_aliases)
}

/// Set a git alias
#[command]
pub async fn set_alias(
    path: Option<String>,
    name: String,
    command: String,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    let alias_key = format!("alias.{}", name);
    run_git_config(repo_path, &[scope, &alias_key, &command])?;

    Ok(())
}

/// Delete a git alias
#[command]
pub async fn delete_alias(path: Option<String>, name: String, global: Option<bool>) -> Result<()> {
    let repo_path = path.as_ref().map(|p| Path::new(p.as_str()));

    let scope = if global.unwrap_or(false) {
        "--global"
    } else {
        "--local"
    };

    let alias_key = format!("alias.{}", name);
    run_git_config(repo_path, &[scope, "--unset", &alias_key])?;

    Ok(())
}

/// Get common git configuration settings with their current values
#[command]
pub async fn get_common_settings(path: String) -> Result<Vec<ConfigEntry>> {
    let repo_path = Path::new(&path);

    // List of common settings to check
    let common_keys = [
        "core.autocrlf",
        "core.filemode",
        "core.ignorecase",
        "core.editor",
        "core.pager",
        "pull.rebase",
        "push.default",
        "push.autoSetupRemote",
        "fetch.prune",
        "merge.ff",
        "merge.conflictstyle",
        "rebase.autoStash",
        "diff.colorMoved",
        "init.defaultBranch",
        "credential.helper",
    ];

    let mut settings = Vec::new();

    for key in common_keys {
        // Resolve the effective value with repository context so system-scope
        // settings (e.g. core.autocrlf set by the Windows Git installer) and
        // conditional includes are reflected, with their true scope.
        let (value, scope) = read_effective_config(repo_path, key);
        // Keys with no value are reported too, as an empty value with the
        // "unset" scope. The Settings tab renders one editor per entry, so
        // dropping them here left a freshly cloned repository with nothing it
        // could configure — the very settings the tab exists to manage.
        settings.push(ConfigEntry {
            key: key.to_string(),
            value: value.unwrap_or_default(),
            scope: if scope.is_empty() {
                "unset".to_string()
            } else {
                scope
            },
        });
    }

    Ok(settings)
}

/// Line ending configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEndingConfig {
    /// core.autocrlf setting: "true", "false", "input"
    pub core_autocrlf: Option<String>,
    /// core.eol setting: "lf", "crlf", "native"
    pub core_eol: Option<String>,
    /// core.safecrlf setting: "true", "false", "warn"
    pub core_safecrlf: Option<String>,
}

/// Git config entry with scope information
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConfig {
    pub key: String,
    pub value: String,
    pub scope: String,
}

/// Get line ending configuration for a repository
#[command]
pub async fn get_line_ending_config(path: String) -> Result<LineEndingConfig> {
    let repo_path = Path::new(&path);

    let core_autocrlf = run_git_config(Some(repo_path), &["--get", "core.autocrlf"])
        .ok()
        .filter(|s| !s.is_empty());
    let core_eol = run_git_config(Some(repo_path), &["--get", "core.eol"])
        .ok()
        .filter(|s| !s.is_empty());
    let core_safecrlf = run_git_config(Some(repo_path), &["--get", "core.safecrlf"])
        .ok()
        .filter(|s| !s.is_empty());

    Ok(LineEndingConfig {
        core_autocrlf,
        core_eol,
        core_safecrlf,
    })
}

/// Set line ending configuration for a repository
#[command]
pub async fn set_line_ending_config(
    path: String,
    autocrlf: Option<String>,
    eol: Option<String>,
    safecrlf: Option<String>,
) -> Result<LineEndingConfig> {
    let repo_path = Path::new(&path);

    if let Some(ref val) = autocrlf {
        run_git_config(Some(repo_path), &["core.autocrlf", val])?;
    }
    if let Some(ref val) = eol {
        run_git_config(Some(repo_path), &["core.eol", val])?;
    }
    if let Some(ref val) = safecrlf {
        run_git_config(Some(repo_path), &["core.safecrlf", val])?;
    }

    // Return the updated config
    get_line_ending_config(path).await
}

/// Get a single git config value (generic)
#[command]
pub async fn get_git_config(path: String, key: String) -> Result<Option<String>> {
    let repo_path = Path::new(&path);
    let result = run_git_config(Some(repo_path), &["--get", &key])?;
    if result.is_empty() {
        Ok(None)
    } else {
        Ok(Some(result))
    }
}

/// Set a single git config value (generic)
#[command]
pub async fn set_git_config(
    path: String,
    key: String,
    value: String,
    global: Option<bool>,
) -> Result<()> {
    let repo_path = Path::new(&path);

    if global.unwrap_or(false) {
        run_git_config(Some(repo_path), &["--global", &key, &value])?;
    } else {
        run_git_config(Some(repo_path), &[&key, &value])?;
    }

    Ok(())
}

/// Get all git config entries with scope information
#[command]
pub async fn get_all_git_config(path: String) -> Result<Vec<GitConfig>> {
    let repo_path = Path::new(&path);
    // NUL-terminated output: `scope\0key\nvalue` records, so multi-line values
    // (e.g. shell aliases) are preserved instead of spawning phantom entries.
    let raw = run_git_config_raw(Some(repo_path), &["--show-scope", "--null", "--list"])?;

    let mut entries: Vec<GitConfig> = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(scope) = fields.next() {
        if scope.is_empty() {
            continue;
        }
        let Some(record) = fields.next() else {
            break;
        };
        let (key, value) = match record.split_once('\n') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (record.to_string(), String::new()),
        };
        entries.push(GitConfig {
            key,
            value,
            scope: scope.to_string(),
        });
    }

    Ok(entries)
}

/// Unset a git config value
#[command]
pub async fn unset_git_config(path: String, key: String, global: Option<bool>) -> Result<()> {
    let repo_path = Path::new(&path);

    // A missing key is a benign no-op; any other failure (e.g. a multi-valued
    // key) is surfaced to the user rather than silently swallowed.
    if global.unwrap_or(false) {
        run_git_config_unset(Some(repo_path), &["--global", "--unset", &key])
    } else {
        run_git_config_unset(Some(repo_path), &["--unset", &key])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_line_ending_config() {
        let repo = TestRepo::with_initial_commit();
        let result = get_line_ending_config(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        // Fresh repo may not have these set
        // Just verify we got a valid response
        assert!(
            config.core_autocrlf.is_none()
                || config.core_autocrlf.as_deref() == Some("true")
                || config.core_autocrlf.as_deref() == Some("false")
                || config.core_autocrlf.as_deref() == Some("input")
        );
    }

    #[tokio::test]
    async fn test_set_line_ending_config() {
        let repo = TestRepo::with_initial_commit();

        let result = set_line_ending_config(
            repo.path_str(),
            Some("input".to_string()),
            Some("lf".to_string()),
            Some("warn".to_string()),
        )
        .await;
        assert!(result.is_ok());

        let config = result.unwrap();
        assert_eq!(config.core_autocrlf.as_deref(), Some("input"));
        assert_eq!(config.core_eol.as_deref(), Some("lf"));
        assert_eq!(config.core_safecrlf.as_deref(), Some("warn"));
    }

    #[tokio::test]
    async fn test_set_line_ending_config_partial() {
        let repo = TestRepo::with_initial_commit();

        // Only set autocrlf
        let result =
            set_line_ending_config(repo.path_str(), Some("true".to_string()), None, None).await;
        assert!(result.is_ok());

        let config = result.unwrap();
        assert_eq!(config.core_autocrlf.as_deref(), Some("true"));
    }

    #[tokio::test]
    async fn test_get_git_config() {
        let repo = TestRepo::with_initial_commit();

        // user.name should be set by TestRepo
        let result = get_git_config(repo.path_str(), "user.name".to_string()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some("Test User".to_string()));
    }

    #[tokio::test]
    async fn test_get_git_config_missing_key() {
        let repo = TestRepo::with_initial_commit();

        let result = get_git_config(repo.path_str(), "nonexistent.key".to_string()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    #[tokio::test]
    async fn test_set_git_config() {
        let repo = TestRepo::with_initial_commit();

        let result = set_git_config(
            repo.path_str(),
            "test.key".to_string(),
            "test-value".to_string(),
            None,
        )
        .await;
        assert!(result.is_ok());

        // Verify it was set
        let get_result = get_git_config(repo.path_str(), "test.key".to_string()).await;
        assert!(get_result.is_ok());
        assert_eq!(get_result.unwrap(), Some("test-value".to_string()));
    }

    #[tokio::test]
    async fn test_get_all_git_config() {
        let repo = TestRepo::with_initial_commit();

        let result = get_all_git_config(repo.path_str()).await;
        assert!(result.is_ok());
        let entries = result.unwrap();
        assert!(!entries.is_empty());
        // Should contain user.name that was set during repo init
        assert!(entries.iter().any(|e| e.key == "user.name"));
    }

    #[tokio::test]
    async fn test_unset_git_config() {
        let repo = TestRepo::with_initial_commit();

        // Set a value first
        set_git_config(
            repo.path_str(),
            "test.toremove".to_string(),
            "value".to_string(),
            None,
        )
        .await
        .unwrap();

        // Verify it exists
        let val = get_git_config(repo.path_str(), "test.toremove".to_string())
            .await
            .unwrap();
        assert_eq!(val, Some("value".to_string()));

        // Unset it
        let result = unset_git_config(repo.path_str(), "test.toremove".to_string(), None).await;
        assert!(result.is_ok());

        // Verify it's gone
        let val2 = get_git_config(repo.path_str(), "test.toremove".to_string())
            .await
            .unwrap();
        assert_eq!(val2, None);
    }

    // --- Finding 3: multi-line config values must be preserved ---

    const MULTILINE_ALIAS: &str = "!f() {\n  git push -u origin HEAD\n}\nf";

    fn set_local_config(repo: &TestRepo, key: &str, value: &str) {
        let r = repo.repo();
        let mut cfg = r.config().expect("config");
        cfg.set_str(key, value).expect("set config value");
    }

    #[tokio::test]
    async fn test_get_aliases_preserves_multiline_value() {
        let repo = TestRepo::with_initial_commit();
        set_local_config(&repo, "alias.publish", MULTILINE_ALIAS);

        let aliases = get_aliases(Some(repo.path_str())).await.unwrap();
        let publish = aliases
            .iter()
            .find(|a| a.name == "publish")
            .expect("publish alias present");
        assert_eq!(publish.command, MULTILINE_ALIAS);
        assert!(!publish.is_global);
    }

    #[tokio::test]
    async fn test_get_all_git_config_preserves_multiline_value() {
        let repo = TestRepo::with_initial_commit();
        set_local_config(&repo, "alias.publish", MULTILINE_ALIAS);

        let entries = get_all_git_config(repo.path_str()).await.unwrap();
        let entry = entries
            .iter()
            .find(|e| e.key == "alias.publish")
            .expect("alias.publish present");
        assert_eq!(entry.value, MULTILINE_ALIAS);
        assert_eq!(entry.scope, "local");
        // No phantom entries: only the real alias carries the multi-line body.
        assert!(entries
            .iter()
            .all(|e| e.key == "alias.publish" || !e.value.contains('\n')));
    }

    #[tokio::test]
    async fn test_get_config_list_preserves_multiline_value() {
        let repo = TestRepo::with_initial_commit();
        set_local_config(&repo, "alias.publish", MULTILINE_ALIAS);

        let entries = get_config_list(Some(repo.path_str()), Some(false))
            .await
            .unwrap();
        let entry = entries
            .iter()
            .find(|e| e.key == "alias.publish")
            .expect("alias.publish present");
        assert_eq!(entry.value, MULTILINE_ALIAS);
    }

    // --- Finding 1: identity/settings must reflect the effective value ---

    #[tokio::test]
    async fn test_get_user_identity_follows_includes() {
        // The effective identity libgit2 uses for commits honours included
        // config files; a bare `--local --get` does not. get_user_identity must
        // report the value commits are actually recorded with.
        let repo = TestRepo::new();
        let extra = repo.path.join("extra.cfg");
        std::fs::write(&extra, "[user]\n\temail = included@example.com\n").unwrap();
        {
            let r = repo.repo();
            let mut cfg = r.config().unwrap();
            // Drop the direct email so the effective value comes from the include.
            let _ = cfg.remove("user.email");
            cfg.set_str("include.path", extra.to_str().unwrap())
                .unwrap();
        }

        let identity = get_user_identity(repo.path_str()).await.unwrap();
        assert_eq!(identity.email.as_deref(), Some("included@example.com"));
    }

    #[tokio::test]
    async fn test_get_common_settings_reads_included_value() {
        let repo = TestRepo::new();
        let extra = repo.path.join("extra.cfg");
        std::fs::write(&extra, "[core]\n\tautocrlf = input\n").unwrap();
        set_local_config(&repo, "include.path", extra.to_str().unwrap());

        let settings = get_common_settings(repo.path_str()).await.unwrap();
        let autocrlf = settings
            .iter()
            .find(|e| e.key == "core.autocrlf")
            .expect("core.autocrlf present via include");
        assert_eq!(autocrlf.value, "input");
    }

    // --- Settings tab: every common key must be reportable, set or not ---

    #[tokio::test]
    async fn test_get_common_settings_includes_unset_keys() {
        // The Settings tab renders one editor per returned entry, so a key that
        // is omitted here cannot be configured from the app at all.
        let repo = TestRepo::new();

        let settings = get_common_settings(repo.path_str()).await.unwrap();

        assert_eq!(
            settings.len(),
            15,
            "every common key must be reported, configured or not: {:?}",
            settings.iter().map(|e| &e.key).collect::<Vec<_>>()
        );

        let rebase = settings
            .iter()
            .find(|e| e.key == "pull.rebase")
            .expect("pull.rebase reported even though it is not set");
        assert_eq!(rebase.value, "");
        assert_eq!(rebase.scope, "unset");
    }

    #[tokio::test]
    async fn test_get_common_settings_marks_configured_scope() {
        let repo = TestRepo::new();
        set_local_config(&repo, "push.default", "current");

        let settings = get_common_settings(repo.path_str()).await.unwrap();

        let push_default = settings
            .iter()
            .find(|e| e.key == "push.default")
            .expect("push.default reported");
        assert_eq!(push_default.value, "current");
        assert_eq!(push_default.scope, "local");

        // A configured key must not crowd out the unconfigured ones.
        let conflictstyle = settings
            .iter()
            .find(|e| e.key == "merge.conflictstyle")
            .expect("merge.conflictstyle reported even though it is not set");
        assert_eq!(conflictstyle.value, "");
        assert_eq!(conflictstyle.scope, "unset");
    }

    // --- Finding 5: unset must refuse on real failures, not report success ---

    #[tokio::test]
    async fn test_unset_config_value_multivalue_errors() {
        let repo = TestRepo::new();
        {
            let r = repo.repo();
            let mut cfg = r.config().unwrap();
            // Add two values for the same key.
            cfg.set_multivar("test.multi", "^nomatch$", "one").unwrap();
            cfg.set_multivar("test.multi", "^nomatch$", "two").unwrap();
        }

        let result =
            unset_config_value(Some(repo.path_str()), "test.multi".to_string(), Some(false)).await;
        assert!(
            result.is_err(),
            "unsetting a multi-valued key must fail like git, not silently succeed"
        );

        // Both values are still present — nothing was destroyed.
        let raw = run_git_config_raw(Some(&repo.path), &["--get-all", "test.multi"]).unwrap();
        assert!(raw.contains("one") && raw.contains("two"));
    }

    #[tokio::test]
    async fn test_set_user_identity_clear_multivalue_email_errors() {
        let repo = TestRepo::new();
        {
            let r = repo.repo();
            let mut cfg = r.config().unwrap();
            cfg.set_multivar("user.email", "^nomatch$", "second@example.com")
                .unwrap();
        }

        // Clearing the email field must refuse when the key is multi-valued.
        let result = set_user_identity(
            Some(repo.path_str()),
            None,
            Some(String::new()),
            Some(false),
        )
        .await;
        assert!(
            result.is_err(),
            "clearing a multi-valued user.email must fail, matching git"
        );

        let raw = run_git_config_raw(Some(&repo.path), &["--get-all", "user.email"]).unwrap();
        assert!(raw.contains("second@example.com"));
    }

    #[tokio::test]
    async fn test_unset_config_value_missing_key_is_noop() {
        let repo = TestRepo::with_initial_commit();
        let result = unset_config_value(
            Some(repo.path_str()),
            "nonexistent.key".to_string(),
            Some(false),
        )
        .await;
        assert!(result.is_ok(), "clearing an absent key is a benign no-op");
    }
}
