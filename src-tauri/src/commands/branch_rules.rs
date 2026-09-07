//! Branch protection rules command handlers
//!
//! Allows users to configure local branch protection rules similar to
//! GitKraken and SourceTree. Rules are stored per-repository in
//! `.git/gitnado/branch_rules.json`.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::{GitnadoError, Result};

/// A branch protection rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRule {
    /// Branch name or glob pattern (e.g., "main", "release/*")
    pub pattern: String,
    /// Prevent the branch from being deleted
    pub prevent_deletion: bool,
    /// Prevent force-pushing to the branch
    pub prevent_force_push: bool,
    /// Require changes to go through a pull request
    pub require_pull_request: bool,
    /// Prevent direct commits/pushes to the branch
    pub prevent_direct_push: bool,
}

/// Get the path to the branch rules file for a repository
fn get_rules_path(repo_path: &Path) -> Result<std::path::PathBuf> {
    let repo = git2::Repository::open(repo_path)?;
    let gitnado_dir = crate::utils::app_paths::repo_dir(repo.path());
    Ok(gitnado_dir.join("branch_rules.json"))
}

/// Load branch rules from the repository config
pub(crate) fn load_rules(repo_path: &Path) -> Result<Vec<BranchRule>> {
    let rules_path = get_rules_path(repo_path)?;

    if !rules_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&rules_path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read branch rules file: {}", e))
    })?;

    serde_json::from_str(&content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse branch rules file: {}", e))
    })
}

/// Match a branch name against a rule pattern.
///
/// Supports a single `*` wildcard, e.g. `release/*` matches `release/v1`.
pub(crate) fn pattern_matches(pattern: &str, branch_name: &str) -> bool {
    if pattern.contains('*') {
        // Simple glob matching: "release/*" matches "release/v1"
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            return branch_name.starts_with(parts[0]) && branch_name.ends_with(parts[1]);
        }
    }
    pattern == branch_name
}

/// True when `branch_name` matches a rule that prevents deletion.
///
/// Shared by the cleanup dialog's candidate listing and by `delete_branch`
/// itself. Enforcing it in the command rather than only where candidates are
/// listed is what makes the rule real: the sidebar and the graph ref menu call
/// `delete_branch` directly and never load the rules, so a rule the UI shows as
/// "Protected" was previously inert on both of those surfaces.
pub(crate) fn is_deletion_prevented(rules: &[BranchRule], branch_name: &str) -> bool {
    rules
        .iter()
        .any(|rule| rule.prevent_deletion && pattern_matches(&rule.pattern, branch_name))
}

/// True when `branch_name` matches a rule that prevents force-pushing.
///
/// Same reasoning as `is_deletion_prevented`: enforcing a rule only where the
/// UI happens to list it leaves it inert everywhere else. Force push is the one
/// operation here that can discard commits belonging to other people, and it
/// has a one-click affordance on the push-rejection toast — so a rule the file
/// format has always accepted must actually stop it, not merely be stored.
pub(crate) fn is_force_push_prevented(rules: &[BranchRule], branch_name: &str) -> bool {
    rules
        .iter()
        .any(|rule| rule.prevent_force_push && pattern_matches(&rule.pattern, branch_name))
}

/// Save branch rules to the repository config
fn save_rules(repo_path: &Path, rules: &[BranchRule]) -> Result<()> {
    let rules_path = get_rules_path(repo_path)?;

    // Ensure the gitnado directory exists
    if let Some(parent) = rules_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            GitnadoError::OperationFailed(format!(
                "Failed to create gitnado config directory: {}",
                e
            ))
        })?;
    }

    let content = serde_json::to_string_pretty(rules).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to serialize branch rules: {}", e))
    })?;

    fs::write(&rules_path, content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write branch rules file: {}", e))
    })?;

    Ok(())
}

/// Get all branch protection rules for the repository
#[command]
pub async fn get_branch_rules(path: String) -> Result<Vec<BranchRule>> {
    load_rules(Path::new(&path))
}

/// Set (add or update) a branch protection rule
#[command]
pub async fn set_branch_rule(path: String, rule: BranchRule) -> Result<Vec<BranchRule>> {
    if rule.pattern.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "Branch rule pattern cannot be empty".to_string(),
        ));
    }

    let mut rules = load_rules(Path::new(&path))?;

    // Update existing rule or add a new one
    if let Some(pos) = rules.iter().position(|r| r.pattern == rule.pattern) {
        rules[pos] = rule;
    } else {
        rules.push(rule);
    }

    save_rules(Path::new(&path), &rules)?;
    Ok(rules)
}

/// Delete a branch protection rule by pattern
#[command]
pub async fn delete_branch_rule(path: String, pattern: String) -> Result<Vec<BranchRule>> {
    let mut rules = load_rules(Path::new(&path))?;
    let initial_len = rules.len();

    rules.retain(|r| r.pattern != pattern);

    if rules.len() == initial_len {
        return Err(GitnadoError::OperationFailed(format!(
            "No branch rule found for pattern: {}",
            pattern
        )));
    }

    save_rules(Path::new(&path), &rules)?;
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn sample_rule(pattern: &str) -> BranchRule {
        BranchRule {
            pattern: pattern.to_string(),
            prevent_deletion: true,
            prevent_force_push: true,
            require_pull_request: false,
            prevent_direct_push: false,
        }
    }

    #[test]
    fn force_push_prevention_matches_the_same_patterns_as_deletion() {
        // The field was stored and read by nothing: only prevent_deletion was
        // ever enforced, so a rule protecting `main` still allowed the
        // one-click Force Push on the push-rejection toast to rewrite it.
        let rules = vec![sample_rule("main"), sample_rule("release/*")];
        assert!(is_force_push_prevented(&rules, "main"));
        assert!(is_force_push_prevented(&rules, "release/1.2"));
        assert!(!is_force_push_prevented(&rules, "feature/x"));
    }

    #[test]
    fn a_rule_that_only_prevents_deletion_does_not_block_force_push() {
        let rules = vec![BranchRule {
            pattern: "main".to_string(),
            prevent_deletion: true,
            prevent_force_push: false,
            require_pull_request: false,
            prevent_direct_push: false,
        }];
        assert!(is_deletion_prevented(&rules, "main"));
        assert!(!is_force_push_prevented(&rules, "main"));
    }

    // --- Unit tests for serialization ---

    #[test]
    fn test_branch_rule_serialization() {
        let rule = BranchRule {
            pattern: "main".to_string(),
            prevent_deletion: true,
            prevent_force_push: true,
            require_pull_request: true,
            prevent_direct_push: false,
        };

        let json = serde_json::to_string(&rule).expect("Failed to serialize");
        let deserialized: BranchRule = serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(deserialized.pattern, "main");
        assert!(deserialized.prevent_deletion);
        assert!(deserialized.prevent_force_push);
        assert!(deserialized.require_pull_request);
        assert!(!deserialized.prevent_direct_push);
    }

    #[test]
    fn test_branch_rule_camel_case_serialization() {
        let rule = BranchRule {
            pattern: "main".to_string(),
            prevent_deletion: true,
            prevent_force_push: false,
            require_pull_request: false,
            prevent_direct_push: true,
        };

        let json = serde_json::to_string(&rule).expect("Failed to serialize");
        assert!(json.contains("preventDeletion"));
        assert!(json.contains("preventForcePush"));
        assert!(json.contains("requirePullRequest"));
        assert!(json.contains("preventDirectPush"));
        assert!(!json.contains("prevent_deletion"));
        assert!(!json.contains("prevent_force_push"));
    }

    #[test]
    fn test_branch_rule_deserialization_from_camel_case() {
        let json = r#"{
            "pattern": "release/*",
            "preventDeletion": true,
            "preventForcePush": false,
            "requirePullRequest": true,
            "preventDirectPush": false
        }"#;
        let rule: BranchRule = serde_json::from_str(json).expect("Failed to deserialize");
        assert_eq!(rule.pattern, "release/*");
        assert!(rule.prevent_deletion);
        assert!(!rule.prevent_force_push);
        assert!(rule.require_pull_request);
        assert!(!rule.prevent_direct_push);
    }

    // --- Integration tests using TestRepo ---

    #[tokio::test]
    async fn test_get_branch_rules_empty() {
        let repo = TestRepo::new();
        let result = get_branch_rules(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_set_branch_rule_creates_new() {
        let repo = TestRepo::new();
        let rule = sample_rule("main");

        let result = set_branch_rule(repo.path_str(), rule).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "main");
        assert!(rules[0].prevent_deletion);
        assert!(rules[0].prevent_force_push);
    }

    #[tokio::test]
    async fn test_set_branch_rule_updates_existing() {
        let repo = TestRepo::new();

        // Create initial rule
        set_branch_rule(repo.path_str(), sample_rule("main"))
            .await
            .unwrap();

        // Update the rule
        let updated = BranchRule {
            pattern: "main".to_string(),
            prevent_deletion: false,
            prevent_force_push: false,
            require_pull_request: true,
            prevent_direct_push: true,
        };

        let result = set_branch_rule(repo.path_str(), updated).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "main");
        assert!(!rules[0].prevent_deletion);
        assert!(!rules[0].prevent_force_push);
        assert!(rules[0].require_pull_request);
        assert!(rules[0].prevent_direct_push);
    }

    #[tokio::test]
    async fn test_set_multiple_branch_rules() {
        let repo = TestRepo::new();

        set_branch_rule(repo.path_str(), sample_rule("main"))
            .await
            .unwrap();
        let result = set_branch_rule(repo.path_str(), sample_rule("release/*")).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].pattern, "main");
        assert_eq!(rules[1].pattern, "release/*");
    }

    #[tokio::test]
    async fn test_set_branch_rule_empty_pattern_fails() {
        let repo = TestRepo::new();
        let rule = BranchRule {
            pattern: "".to_string(),
            prevent_deletion: true,
            prevent_force_push: false,
            require_pull_request: false,
            prevent_direct_push: false,
        };

        let result = set_branch_rule(repo.path_str(), rule).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_branch_rule() {
        let repo = TestRepo::new();

        // Create two rules
        set_branch_rule(repo.path_str(), sample_rule("main"))
            .await
            .unwrap();
        set_branch_rule(repo.path_str(), sample_rule("develop"))
            .await
            .unwrap();

        // Delete one
        let result = delete_branch_rule(repo.path_str(), "main".to_string()).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "develop");
    }

    #[tokio::test]
    async fn test_delete_branch_rule_not_found() {
        let repo = TestRepo::new();

        let result = delete_branch_rule(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_branch_rules_after_set() {
        let repo = TestRepo::new();

        set_branch_rule(repo.path_str(), sample_rule("main"))
            .await
            .unwrap();

        let result = get_branch_rules(repo.path_str()).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].pattern, "main");
    }

    #[tokio::test]
    async fn test_branch_rules_invalid_repo_path() {
        let result = get_branch_rules("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_branch_rule_with_glob_pattern() {
        let repo = TestRepo::new();

        let rule = BranchRule {
            pattern: "release/*".to_string(),
            prevent_deletion: true,
            prevent_force_push: true,
            require_pull_request: true,
            prevent_direct_push: true,
        };

        let result = set_branch_rule(repo.path_str(), rule).await;
        assert!(result.is_ok());

        let rules = result.unwrap();
        assert_eq!(rules[0].pattern, "release/*");
        assert!(rules[0].prevent_deletion);
        assert!(rules[0].prevent_force_push);
        assert!(rules[0].require_pull_request);
        assert!(rules[0].prevent_direct_push);
    }

    #[tokio::test]
    async fn test_rules_persist_across_loads() {
        let repo = TestRepo::new();

        // Set rules
        set_branch_rule(repo.path_str(), sample_rule("main"))
            .await
            .unwrap();
        set_branch_rule(repo.path_str(), sample_rule("develop"))
            .await
            .unwrap();

        // Load rules fresh
        let loaded = get_branch_rules(repo.path_str()).await.unwrap();
        assert_eq!(loaded.len(), 2);

        // Delete one and verify
        delete_branch_rule(repo.path_str(), "main".to_string())
            .await
            .unwrap();

        let loaded_after_delete = get_branch_rules(repo.path_str()).await.unwrap();
        assert_eq!(loaded_after_delete.len(), 1);
        assert_eq!(loaded_after_delete[0].pattern, "develop");
    }

    #[test]
    fn test_rules_file_location() {
        let repo = TestRepo::new();
        let rules_path = get_rules_path(Path::new(&repo.path_str())).unwrap();
        assert!(
            rules_path
                .to_string_lossy()
                .contains("gitnado/branch_rules.json")
                || rules_path
                    .to_string_lossy()
                    .contains("gitnado\\branch_rules.json")
        );
    }
}
