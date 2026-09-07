//! Commit message validation command handlers
//!
//! Allows users to validate commit messages against configurable rules.
//! Rules are stored per-repository in `.git/gitnado/commit_rules.json`.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Rules for validating commit messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageRules {
    /// Maximum length of the subject line (e.g., 72)
    pub max_subject_length: Option<u32>,
    /// Maximum length of each body line (e.g., 100)
    pub max_body_line_length: Option<u32>,
    /// Require a blank line between subject and body
    pub require_blank_line_before_body: bool,
    /// Require conventional commit format: type(scope): description
    pub require_conventional_format: bool,
    /// Allowed conventional commit types (e.g., feat, fix, chore)
    pub allowed_types: Vec<String>,
    /// Require a scope in conventional commits
    pub require_scope: bool,
    /// Require a body in the commit message
    pub require_body: bool,
    /// Phrases that are not allowed in commit messages (e.g., "WIP", "TODO")
    pub forbidden_phrases: Vec<String>,
}

impl Default for CommitMessageRules {
    fn default() -> Self {
        Self {
            max_subject_length: Some(72),
            max_body_line_length: Some(100),
            require_blank_line_before_body: true,
            require_conventional_format: false,
            allowed_types: vec![
                "feat".to_string(),
                "fix".to_string(),
                "docs".to_string(),
                "style".to_string(),
                "refactor".to_string(),
                "perf".to_string(),
                "test".to_string(),
                "build".to_string(),
                "ci".to_string(),
                "chore".to_string(),
                "revert".to_string(),
            ],
            require_scope: false,
            require_body: false,
            forbidden_phrases: Vec::new(),
        }
    }
}

/// Result of validating a commit message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    /// Whether the message passes all rules
    pub is_valid: bool,
    /// Errors that must be fixed
    pub errors: Vec<ValidationError>,
    /// Warnings that are advisory
    pub warnings: Vec<ValidationError>,
}

/// A single validation error or warning
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    /// The rule that was violated
    pub rule: String,
    /// Human-readable description of the violation
    pub message: String,
    /// The line number where the violation occurred (1-based), if applicable
    pub line: Option<u32>,
}

/// Get the path to the commit rules file for a repository
fn get_rules_path(repo_path: &Path) -> Result<std::path::PathBuf> {
    let repo = git2::Repository::open(repo_path)?;
    let gitnado_dir = crate::utils::app_paths::repo_dir(repo.path());
    Ok(gitnado_dir.join("commit_rules.json"))
}

/// Load commit message rules from the repository config
fn load_rules(repo_path: &Path) -> Result<Option<CommitMessageRules>> {
    let rules_path = get_rules_path(repo_path)?;

    if !rules_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&rules_path).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to read commit rules file: {}", e))
    })?;

    let rules: CommitMessageRules = serde_json::from_str(&content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to parse commit rules file: {}", e))
    })?;

    Ok(Some(rules))
}

/// Save commit message rules to the repository config
fn save_rules(repo_path: &Path, rules: &CommitMessageRules) -> Result<()> {
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
        GitnadoError::OperationFailed(format!("Failed to serialize commit rules: {}", e))
    })?;

    fs::write(&rules_path, content).map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to write commit rules file: {}", e))
    })?;

    Ok(())
}

/// Parse a conventional commit subject line.
/// Returns (type, scope, description) if valid, or None.
fn parse_conventional_commit(subject: &str) -> Option<(String, Option<String>, String)> {
    // Pattern: type(scope): description  or  type: description
    let colon_pos = subject.find(": ")?;
    let prefix = &subject[..colon_pos];
    let description = subject[colon_pos + 2..].to_string();

    if description.is_empty() {
        return None;
    }

    if let Some(paren_start) = prefix.find('(') {
        if !prefix.ends_with(')') {
            return None;
        }
        let commit_type = prefix[..paren_start].to_string();
        let scope = prefix[paren_start + 1..prefix.len() - 1].to_string();
        if commit_type.is_empty() {
            return None;
        }
        Some((commit_type, Some(scope), description))
    } else {
        if prefix.is_empty() {
            return None;
        }
        Some((prefix.to_string(), None, description))
    }
}

/// Core validation logic (not a Tauri command, for testability)
pub fn validate_message(message: &str, rules: &CommitMessageRules) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let lines: Vec<&str> = message.lines().collect();

    if lines.is_empty() || lines[0].trim().is_empty() {
        errors.push(ValidationError {
            rule: "non_empty_subject".to_string(),
            message: "Commit message must have a non-empty subject line".to_string(),
            line: Some(1),
        });
        return ValidationResult {
            is_valid: false,
            errors,
            warnings,
        };
    }

    let subject = lines[0];

    // Check max subject length
    if let Some(max_len) = rules.max_subject_length {
        if subject.len() > max_len as usize {
            errors.push(ValidationError {
                rule: "max_subject_length".to_string(),
                message: format!(
                    "Subject line is {} characters, maximum is {}",
                    subject.len(),
                    max_len
                ),
                line: Some(1),
            });
        }
    }

    // Check conventional commit format
    if rules.require_conventional_format {
        match parse_conventional_commit(subject) {
            Some((commit_type, scope, _description)) => {
                // Check allowed types
                if !rules.allowed_types.is_empty()
                    && !rules.allowed_types.iter().any(|t| t == &commit_type)
                {
                    errors.push(ValidationError {
                        rule: "allowed_types".to_string(),
                        message: format!(
                            "Type '{}' is not allowed. Allowed types: {}",
                            commit_type,
                            rules.allowed_types.join(", ")
                        ),
                        line: Some(1),
                    });
                }

                // Check require scope
                if rules.require_scope && scope.is_none() {
                    errors.push(ValidationError {
                        rule: "require_scope".to_string(),
                        message: "Conventional commit requires a scope: type(scope): description"
                            .to_string(),
                        line: Some(1),
                    });
                }
            }
            None => {
                errors.push(ValidationError {
                    rule: "conventional_format".to_string(),
                    message:
                        "Subject must follow conventional commit format: type(scope): description"
                            .to_string(),
                    line: Some(1),
                });
            }
        }
    }

    // Check blank line before body
    if lines.len() > 1 && rules.require_blank_line_before_body && !lines[1].trim().is_empty() {
        errors.push(ValidationError {
            rule: "blank_line_before_body".to_string(),
            message: "There must be a blank line between the subject and body".to_string(),
            line: Some(2),
        });
    }

    // Check require body
    if rules.require_body {
        let has_body = lines.len() > 2 && lines.iter().skip(2).any(|line| !line.trim().is_empty());
        let has_body = has_body
            || (lines.len() > 1
                && !rules.require_blank_line_before_body
                && lines.iter().skip(1).any(|line| !line.trim().is_empty()));

        if !has_body {
            errors.push(ValidationError {
                rule: "require_body".to_string(),
                message: "Commit message must include a body".to_string(),
                line: None,
            });
        }
    }

    // Check max body line length
    if let Some(max_len) = rules.max_body_line_length {
        for (i, line) in lines.iter().enumerate().skip(1) {
            if line.len() > max_len as usize {
                warnings.push(ValidationError {
                    rule: "max_body_line_length".to_string(),
                    message: format!(
                        "Line {} is {} characters, maximum is {}",
                        i + 1,
                        line.len(),
                        max_len
                    ),
                    line: Some((i + 1) as u32),
                });
            }
        }
    }

    // Check forbidden phrases
    for phrase in &rules.forbidden_phrases {
        let phrase_lower = phrase.to_lowercase();
        for (i, line) in lines.iter().enumerate() {
            if line.to_lowercase().contains(&phrase_lower) {
                errors.push(ValidationError {
                    rule: "forbidden_phrase".to_string(),
                    message: format!("Forbidden phrase '{}' found on line {}", phrase, i + 1),
                    line: Some((i + 1) as u32),
                });
            }
        }
    }

    ValidationResult {
        is_valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// Validate a commit message against the provided rules
#[command]
pub async fn validate_commit_message(
    message: String,
    rules: CommitMessageRules,
) -> Result<ValidationResult> {
    Ok(validate_message(&message, &rules))
}

/// Get the commit message rules for a repository
#[command]
pub async fn get_commit_message_rules(path: String) -> Result<Option<CommitMessageRules>> {
    load_rules(Path::new(&path))
}

/// Set the commit message rules for a repository
#[command]
pub async fn set_commit_message_rules(
    path: String,
    rules: CommitMessageRules,
) -> Result<CommitMessageRules> {
    save_rules(Path::new(&path), &rules)?;
    Ok(rules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn default_rules() -> CommitMessageRules {
        CommitMessageRules::default()
    }

    fn conventional_rules() -> CommitMessageRules {
        CommitMessageRules {
            require_conventional_format: true,
            require_scope: false,
            ..default_rules()
        }
    }

    fn strict_rules() -> CommitMessageRules {
        CommitMessageRules {
            max_subject_length: Some(50),
            max_body_line_length: Some(72),
            require_blank_line_before_body: true,
            require_conventional_format: true,
            allowed_types: vec!["feat".to_string(), "fix".to_string(), "docs".to_string()],
            require_scope: true,
            require_body: true,
            forbidden_phrases: vec!["WIP".to_string(), "TODO".to_string()],
        }
    }

    // --- Unit tests for parse_conventional_commit ---

    #[test]
    fn test_parse_conventional_commit_simple() {
        let result = parse_conventional_commit("feat: add new feature");
        assert!(result.is_some());
        let (t, s, d) = result.unwrap();
        assert_eq!(t, "feat");
        assert!(s.is_none());
        assert_eq!(d, "add new feature");
    }

    #[test]
    fn test_parse_conventional_commit_with_scope() {
        let result = parse_conventional_commit("fix(auth): resolve login issue");
        assert!(result.is_some());
        let (t, s, d) = result.unwrap();
        assert_eq!(t, "fix");
        assert_eq!(s, Some("auth".to_string()));
        assert_eq!(d, "resolve login issue");
    }

    #[test]
    fn test_parse_conventional_commit_no_colon() {
        let result = parse_conventional_commit("just a message");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_conventional_commit_empty_description() {
        let result = parse_conventional_commit("feat: ");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_conventional_commit_empty_type() {
        let result = parse_conventional_commit(": description");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_conventional_commit_malformed_scope() {
        let result = parse_conventional_commit("feat(scope: description");
        assert!(result.is_none());
    }

    // --- Unit tests for validate_message ---

    #[test]
    fn test_valid_simple_message() {
        let rules = default_rules();
        let result = validate_message("Add a new feature", &rules);
        assert!(result.is_valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_empty_message() {
        let rules = default_rules();
        let result = validate_message("", &rules);
        assert!(!result.is_valid);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].rule, "non_empty_subject");
    }

    #[test]
    fn test_whitespace_only_subject() {
        let rules = default_rules();
        let result = validate_message("   ", &rules);
        assert!(!result.is_valid);
        assert_eq!(result.errors[0].rule, "non_empty_subject");
    }

    #[test]
    fn test_subject_too_long() {
        let rules = CommitMessageRules {
            max_subject_length: Some(20),
            ..default_rules()
        };
        let result = validate_message("This subject line is way too long for the limit", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "max_subject_length"));
    }

    #[test]
    fn test_subject_within_limit() {
        let rules = CommitMessageRules {
            max_subject_length: Some(100),
            ..default_rules()
        };
        let result = validate_message("Short subject", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_missing_blank_line_before_body() {
        let rules = CommitMessageRules {
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let result = validate_message("Subject\nBody starts here", &rules);
        assert!(!result.is_valid);
        assert!(result
            .errors
            .iter()
            .any(|e| e.rule == "blank_line_before_body"));
    }

    #[test]
    fn test_blank_line_before_body_present() {
        let rules = CommitMessageRules {
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let result = validate_message("Subject\n\nBody starts here", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_no_body_only_subject() {
        let rules = CommitMessageRules {
            require_blank_line_before_body: true,
            ..default_rules()
        };
        // Single-line message with blank line rule should be fine (no body = no violation)
        let result = validate_message("Just a subject", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_require_body_missing() {
        let rules = CommitMessageRules {
            require_body: true,
            ..default_rules()
        };
        let result = validate_message("Just a subject", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "require_body"));
    }

    #[test]
    fn test_require_body_present() {
        let rules = CommitMessageRules {
            require_body: true,
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let result = validate_message("Subject\n\nThis is the body", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_require_body_blank_lines_only() {
        let rules = CommitMessageRules {
            require_body: true,
            ..default_rules()
        };
        let result = validate_message("Subject\n\n  \n  ", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "require_body"));
    }

    #[test]
    fn test_conventional_format_valid() {
        let rules = conventional_rules();
        let result = validate_message("feat: add new feature", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_conventional_format_invalid() {
        let rules = conventional_rules();
        let result = validate_message("Added new feature", &rules);
        assert!(!result.is_valid);
        assert!(result
            .errors
            .iter()
            .any(|e| e.rule == "conventional_format"));
    }

    #[test]
    fn test_conventional_format_with_scope() {
        let rules = conventional_rules();
        let result = validate_message("fix(auth): resolve login bug", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_conventional_type_not_allowed() {
        let rules = CommitMessageRules {
            require_conventional_format: true,
            allowed_types: vec!["feat".to_string(), "fix".to_string()],
            ..default_rules()
        };
        let result = validate_message("chore: update deps", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "allowed_types"));
    }

    #[test]
    fn test_require_scope_missing() {
        let rules = CommitMessageRules {
            require_conventional_format: true,
            require_scope: true,
            ..default_rules()
        };
        let result = validate_message("feat: add feature without scope", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "require_scope"));
    }

    #[test]
    fn test_require_scope_present() {
        let rules = CommitMessageRules {
            require_conventional_format: true,
            require_scope: true,
            ..default_rules()
        };
        let result = validate_message("feat(ui): add new button", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_body_line_too_long_is_warning() {
        let rules = CommitMessageRules {
            max_body_line_length: Some(30),
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let result = validate_message(
            "Short subject\n\nThis body line is way too long and exceeds the maximum length",
            &rules,
        );
        // Body line length violations are warnings, not errors
        assert!(result.is_valid);
        assert!(!result.warnings.is_empty());
        assert!(result
            .warnings
            .iter()
            .any(|w| w.rule == "max_body_line_length"));
    }

    #[test]
    fn test_forbidden_phrase_found() {
        let rules = CommitMessageRules {
            forbidden_phrases: vec!["WIP".to_string(), "TODO".to_string()],
            ..default_rules()
        };
        let result = validate_message("WIP: work in progress", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "forbidden_phrase"));
    }

    #[test]
    fn test_forbidden_phrase_case_insensitive() {
        let rules = CommitMessageRules {
            forbidden_phrases: vec!["wip".to_string()],
            ..default_rules()
        };
        let result = validate_message("WIP: work in progress", &rules);
        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.rule == "forbidden_phrase"));
    }

    #[test]
    fn test_forbidden_phrase_in_body() {
        let rules = CommitMessageRules {
            forbidden_phrases: vec!["TODO".to_string()],
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let result = validate_message("Clean subject\n\nTODO: finish this later", &rules);
        assert!(!result.is_valid);
        let error = result
            .errors
            .iter()
            .find(|e| e.rule == "forbidden_phrase")
            .unwrap();
        assert_eq!(error.line, Some(3));
    }

    #[test]
    fn test_no_forbidden_phrases() {
        let rules = CommitMessageRules {
            forbidden_phrases: vec!["WIP".to_string()],
            ..default_rules()
        };
        let result = validate_message("feat: clean commit message", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_strict_rules_valid() {
        let rules = strict_rules();
        let result = validate_message(
            "feat(ui): add login button\n\nThis adds a new login button to the header.\nIt uses the standard design system.",
            &rules,
        );
        assert!(result.is_valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_strict_rules_multiple_errors() {
        let rules = strict_rules();
        let result = validate_message("WIP adding TODO items without any type format", &rules);
        assert!(!result.is_valid);
        // Should have errors for: conventional_format, require_body, forbidden_phrases
        assert!(result.errors.len() >= 3);
    }

    #[test]
    fn test_validation_result_serialization() {
        let result = ValidationResult {
            is_valid: false,
            errors: vec![ValidationError {
                rule: "test_rule".to_string(),
                message: "Test message".to_string(),
                line: Some(1),
            }],
            warnings: vec![],
        };

        let json = serde_json::to_string(&result).expect("Failed to serialize");
        assert!(json.contains("\"isValid\":false"));
        assert!(json.contains("\"testRule\"") || json.contains("\"rule\":\"test_rule\""));
    }

    #[test]
    fn test_commit_message_rules_serialization() {
        let rules = default_rules();
        let json = serde_json::to_string(&rules).expect("Failed to serialize");
        assert!(json.contains("maxSubjectLength"));
        assert!(json.contains("maxBodyLineLength"));
        assert!(json.contains("requireBlankLineBeforeBody"));
        assert!(json.contains("requireConventionalFormat"));
        assert!(json.contains("allowedTypes"));
        assert!(json.contains("requireScope"));
        assert!(json.contains("requireBody"));
        assert!(json.contains("forbiddenPhrases"));
    }

    #[test]
    fn test_commit_message_rules_deserialization() {
        let json = r#"{
            "maxSubjectLength": 50,
            "maxBodyLineLength": 72,
            "requireBlankLineBeforeBody": true,
            "requireConventionalFormat": true,
            "allowedTypes": ["feat", "fix"],
            "requireScope": false,
            "requireBody": false,
            "forbiddenPhrases": ["WIP"]
        }"#;
        let rules: CommitMessageRules = serde_json::from_str(json).expect("Failed to deserialize");
        assert_eq!(rules.max_subject_length, Some(50));
        assert_eq!(rules.max_body_line_length, Some(72));
        assert!(rules.require_blank_line_before_body);
        assert!(rules.require_conventional_format);
        assert_eq!(rules.allowed_types, vec!["feat", "fix"]);
        assert!(!rules.require_scope);
        assert!(!rules.require_body);
        assert_eq!(rules.forbidden_phrases, vec!["WIP"]);
    }

    #[test]
    fn test_default_rules() {
        let rules = CommitMessageRules::default();
        assert_eq!(rules.max_subject_length, Some(72));
        assert_eq!(rules.max_body_line_length, Some(100));
        assert!(rules.require_blank_line_before_body);
        assert!(!rules.require_conventional_format);
        assert!(!rules.require_scope);
        assert!(!rules.require_body);
        assert!(rules.forbidden_phrases.is_empty());
        assert!(rules.allowed_types.contains(&"feat".to_string()));
        assert!(rules.allowed_types.contains(&"fix".to_string()));
    }

    // --- Async command tests ---

    #[tokio::test]
    async fn test_validate_commit_message_command() {
        let rules = default_rules();
        let result = validate_commit_message("Valid commit message".to_string(), rules).await;
        assert!(result.is_ok());
        let validation = result.unwrap();
        assert!(validation.is_valid);
    }

    #[tokio::test]
    async fn test_validate_commit_message_command_invalid() {
        let rules = CommitMessageRules {
            require_conventional_format: true,
            ..default_rules()
        };
        let result = validate_commit_message("Bad message".to_string(), rules).await;
        assert!(result.is_ok());
        let validation = result.unwrap();
        assert!(!validation.is_valid);
    }

    // --- Integration tests using TestRepo ---

    #[tokio::test]
    async fn test_get_commit_message_rules_no_rules() {
        let repo = TestRepo::new();
        let result = get_commit_message_rules(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_set_and_get_commit_message_rules() {
        let repo = TestRepo::new();
        let rules = CommitMessageRules {
            max_subject_length: Some(50),
            require_conventional_format: true,
            ..default_rules()
        };

        let set_result = set_commit_message_rules(repo.path_str(), rules.clone()).await;
        assert!(set_result.is_ok());

        let get_result = get_commit_message_rules(repo.path_str()).await;
        assert!(get_result.is_ok());
        let loaded = get_result.unwrap().unwrap();
        assert_eq!(loaded.max_subject_length, Some(50));
        assert!(loaded.require_conventional_format);
    }

    #[tokio::test]
    async fn test_set_commit_message_rules_overwrites() {
        let repo = TestRepo::new();

        // Set initial rules
        let rules1 = CommitMessageRules {
            max_subject_length: Some(50),
            ..default_rules()
        };
        set_commit_message_rules(repo.path_str(), rules1)
            .await
            .unwrap();

        // Overwrite with new rules
        let rules2 = CommitMessageRules {
            max_subject_length: Some(100),
            require_body: true,
            ..default_rules()
        };
        set_commit_message_rules(repo.path_str(), rules2)
            .await
            .unwrap();

        let loaded = get_commit_message_rules(repo.path_str())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.max_subject_length, Some(100));
        assert!(loaded.require_body);
    }

    #[tokio::test]
    async fn test_get_commit_message_rules_invalid_path() {
        let result = get_commit_message_rules("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_rules_file_location() {
        let repo = TestRepo::new();
        let rules_path = get_rules_path(Path::new(&repo.path_str())).unwrap();
        assert!(
            rules_path
                .to_string_lossy()
                .contains("gitnado/commit_rules.json")
                || rules_path
                    .to_string_lossy()
                    .contains("gitnado\\commit_rules.json")
        );
    }

    #[test]
    fn test_no_max_subject_length() {
        let rules = CommitMessageRules {
            max_subject_length: None,
            ..default_rules()
        };
        let long_subject = "a".repeat(200);
        let result = validate_message(&long_subject, &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_no_max_body_line_length() {
        let rules = CommitMessageRules {
            max_body_line_length: None,
            require_blank_line_before_body: true,
            ..default_rules()
        };
        let msg = format!("Subject\n\n{}", "a".repeat(500));
        let result = validate_message(&msg, &rules);
        assert!(result.is_valid);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_allowed_types_empty_means_all_allowed() {
        let rules = CommitMessageRules {
            require_conventional_format: true,
            allowed_types: vec![],
            ..default_rules()
        };
        let result = validate_message("anything: some description", &rules);
        assert!(result.is_valid);
    }

    #[test]
    fn test_multiple_forbidden_phrases() {
        let rules = CommitMessageRules {
            forbidden_phrases: vec!["WIP".to_string(), "FIXME".to_string(), "HACK".to_string()],
            ..default_rules()
        };
        let result = validate_message("FIXME: this is a HACK", &rules);
        assert!(!result.is_valid);
        let forbidden_errors: Vec<_> = result
            .errors
            .iter()
            .filter(|e| e.rule == "forbidden_phrase")
            .collect();
        assert_eq!(forbidden_errors.len(), 2);
    }
}
