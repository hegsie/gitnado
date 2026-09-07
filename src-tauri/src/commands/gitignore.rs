//! Gitignore management command handlers
//! Add files/patterns to .gitignore from the UI

use std::path::Path;
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::create_command;

/// Entry in a .gitignore file
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreEntry {
    pub pattern: String,
    pub line_number: usize,
    pub is_comment: bool,
    pub is_negation: bool,
    pub is_empty: bool,
}

/// Get the contents of the .gitignore file
#[command]
pub async fn get_gitignore(path: String) -> Result<Vec<GitignoreEntry>> {
    let gitignore_path = Path::new(&path).join(".gitignore");
    let mut entries = Vec::new();

    if !gitignore_path.exists() {
        return Ok(entries);
    }

    let content = std::fs::read_to_string(&gitignore_path)?;

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        entries.push(GitignoreEntry {
            pattern: line.to_string(),
            line_number: i + 1,
            is_comment: trimmed.starts_with('#'),
            is_negation: trimmed.starts_with('!'),
            is_empty: trimmed.is_empty(),
        });
    }

    Ok(entries)
}

/// Add patterns to .gitignore
#[command]
pub async fn add_to_gitignore(path: String, patterns: Vec<String>) -> Result<()> {
    let gitignore_path = Path::new(&path).join(".gitignore");

    let mut content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)?
    } else {
        String::new()
    };

    // Ensure file ends with newline
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }

    for pattern in &patterns {
        // Check if pattern already exists
        let already_exists = content.lines().any(|line| line.trim() == pattern.trim());

        if !already_exists {
            content.push_str(pattern);
            content.push('\n');
        }
    }

    std::fs::write(&gitignore_path, &content)?;
    Ok(())
}

/// Remove one rule from .gitignore, identified by its line.
///
/// `line_number` is the 1-based line the caller is looking at, as reported by
/// [`get_gitignore`]. Matching on the pattern text alone is not enough: a
/// .gitignore may legitimately carry the same text twice — repeated section
/// comments, or a pattern restated after a negation, where order changes what
/// git does — and removing every identical line would delete rules the user
/// never selected. The pattern is still passed and re-checked against that
/// line so that a file edited behind the dialog's back fails loudly instead of
/// deleting whichever rule has since moved into that slot.
#[command]
pub async fn remove_from_gitignore(
    path: String,
    pattern: String,
    line_number: usize,
) -> Result<()> {
    let gitignore_path = Path::new(&path).join(".gitignore");

    if !gitignore_path.exists() {
        return Err(GitnadoError::OperationFailed(
            ".gitignore file does not exist".to_string(),
        ));
    }

    let content = std::fs::read_to_string(&gitignore_path)?;
    let lines: Vec<&str> = content.lines().collect();

    let index = line_number
        .checked_sub(1)
        .filter(|i| *i < lines.len())
        .ok_or_else(|| {
            GitnadoError::OperationFailed(format!(
                ".gitignore has no line {line_number} — reload and try again"
            ))
        })?;

    if lines[index].trim() != pattern.trim() {
        return Err(GitnadoError::OperationFailed(format!(
            ".gitignore line {line_number} no longer reads \"{}\" — reload and try again",
            pattern.trim()
        )));
    }

    let new_content: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, line)| *line)
        .collect();

    let mut result = new_content.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }

    std::fs::write(&gitignore_path, &result)?;
    Ok(())
}

/// Whether a path is tracked (present in the index at stage 0).
///
/// Git never applies gitignore rules to tracked files, so callers must treat a
/// tracked path as not ignored regardless of what the gitignore patterns say.
fn is_path_tracked(repo: &git2::Repository, path: &Path) -> bool {
    match repo.index() {
        Ok(index) => index.get_path(path, 0).is_some(),
        Err(_) => false,
    }
}

/// Check if a file path matches any gitignore pattern
#[command]
pub async fn is_ignored(path: String, file_path: String) -> Result<bool> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let file = Path::new(&file_path);
    // gitignore only affects untracked files; a tracked file is never ignored.
    if is_path_tracked(&repo, file) {
        return Ok(false);
    }
    Ok(repo.is_path_ignored(file)?)
}

/// Result of checking whether a file is ignored by gitignore rules
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreCheckResult {
    pub path: String,
    pub is_ignored: bool,
}

/// Verbose result of checking whether a file is ignored, including rule details
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreCheckVerboseResult {
    pub path: String,
    pub is_ignored: bool,
    /// Which .gitignore file contains the matching rule
    pub source_file: Option<String>,
    /// Line number in the .gitignore file
    pub source_line: Option<u32>,
    /// The matching pattern
    pub pattern: Option<String>,
    /// Whether the matching pattern is negated (! prefix)
    pub is_negated: bool,
}

/// Check if files are ignored by gitignore rules
#[command]
pub async fn check_ignore(path: String, file_paths: Vec<String>) -> Result<Vec<IgnoreCheckResult>> {
    let repo = git2::Repository::open(Path::new(&path))?;

    let mut results = Vec::with_capacity(file_paths.len());
    for file_path in &file_paths {
        let file = Path::new(file_path);
        // gitignore only affects untracked files; a tracked file is never ignored.
        let is_ignored = if is_path_tracked(&repo, file) {
            false
        } else {
            repo.is_path_ignored(file).unwrap_or(false)
        };
        results.push(IgnoreCheckResult {
            path: file_path.clone(),
            is_ignored,
        });
    }

    Ok(results)
}

/// Check if files are ignored by gitignore rules, with verbose rule details.
///
/// Uses `git check-ignore -v -n -z --stdin` to get the source file, line number,
/// and pattern that matches each path. The `-z` / `--stdin` combination:
///   * consults the index natively, so tracked files are reported as NOT ignored
///     (matching `git check-ignore`; gitignore rules only affect untracked files),
///   * NUL-separates the four output fields and disables pathname C-quoting, so
///     non-ASCII paths and patterns containing `:` are handled correctly, and
///   * passes pathnames on stdin, avoiding argument-length limits.
#[command]
pub async fn check_ignore_verbose(
    path: String,
    file_paths: Vec<String>,
) -> Result<Vec<IgnoreCheckVerboseResult>> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    // Feed the paths on stdin, NUL-separated (required by -z / --stdin).
    let mut stdin_bytes = Vec::new();
    for file_path in &file_paths {
        stdin_bytes.extend_from_slice(file_path.as_bytes());
        stdin_bytes.push(0);
    }

    let mut child = create_command("git")
        .arg("-C")
        .arg(&path)
        .arg("check-ignore")
        .arg("-v")
        .arg("-n")
        .arg("-z")
        .arg("--stdin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to run git check-ignore: {}", e))
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(&stdin_bytes).map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to write to git check-ignore: {}", e))
        })?;
    }

    let output = child.wait_with_output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to run git check-ignore: {}", e))
    })?;

    Ok(parse_check_ignore_z(&output.stdout))
}

/// Parse the NUL-separated output of `git check-ignore -v -n -z --stdin`.
///
/// Records are groups of four NUL-terminated fields:
/// `<source>\0<linenum>\0<pattern>\0<pathname>\0`. A non-matching path has empty
/// `source`, `linenum`, and `pattern` fields.
fn parse_check_ignore_z(stdout: &[u8]) -> Vec<IgnoreCheckVerboseResult> {
    // Collect NUL-terminated fields, dropping the trailing empty field after the
    // final NUL. Fields are decoded lossily (paths are otherwise raw bytes).
    let mut fields: Vec<String> = stdout
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    if fields.last().map(|f| f.is_empty()).unwrap_or(false) {
        fields.pop();
    }

    let mut results = Vec::with_capacity(fields.len() / 4);
    for record in fields.as_chunks::<4>().0 {
        let source = &record[0];
        let line_num_str = &record[1];
        let pattern = &record[2];
        let path_name = record[3].clone();

        // Non-matching path: all rule fields empty.
        if source.is_empty() && pattern.is_empty() {
            results.push(IgnoreCheckVerboseResult {
                path: path_name,
                is_ignored: false,
                source_file: None,
                source_line: None,
                pattern: None,
                is_negated: false,
            });
            continue;
        }

        let is_negated = pattern.starts_with('!');
        results.push(IgnoreCheckVerboseResult {
            path: path_name,
            is_ignored: !is_negated,
            source_file: if source.is_empty() {
                None
            } else {
                Some(source.clone())
            },
            source_line: line_num_str.parse::<u32>().ok(),
            pattern: if pattern.is_empty() {
                None
            } else {
                Some(pattern.clone())
            },
            is_negated,
        });
    }

    results
}

/// Get common gitignore templates
#[command]
pub async fn get_gitignore_templates() -> Result<Vec<GitignoreTemplate>> {
    Ok(vec![
        GitignoreTemplate {
            name: "Node.js".to_string(),
            patterns: vec![
                "node_modules/".to_string(),
                "dist/".to_string(),
                ".env".to_string(),
                ".env.local".to_string(),
                "npm-debug.log*".to_string(),
                "yarn-debug.log*".to_string(),
                "yarn-error.log*".to_string(),
                ".npm".to_string(),
                "coverage/".to_string(),
            ],
        },
        GitignoreTemplate {
            name: "Rust".to_string(),
            patterns: vec![
                "/target/".to_string(),
                "Cargo.lock".to_string(),
                "**/*.rs.bk".to_string(),
            ],
        },
        GitignoreTemplate {
            name: "Python".to_string(),
            patterns: vec![
                "__pycache__/".to_string(),
                "*.py[cod]".to_string(),
                "*$py.class".to_string(),
                "*.so".to_string(),
                ".Python".to_string(),
                "build/".to_string(),
                "develop-eggs/".to_string(),
                "dist/".to_string(),
                "eggs/".to_string(),
                ".eggs/".to_string(),
                "*.egg-info/".to_string(),
                "*.egg".to_string(),
                ".venv/".to_string(),
                "venv/".to_string(),
            ],
        },
        GitignoreTemplate {
            name: "Java".to_string(),
            patterns: vec![
                "*.class".to_string(),
                "*.jar".to_string(),
                "*.war".to_string(),
                "*.ear".to_string(),
                "target/".to_string(),
                ".gradle/".to_string(),
                "build/".to_string(),
            ],
        },
        GitignoreTemplate {
            name: "IDE".to_string(),
            patterns: vec![
                ".idea/".to_string(),
                ".vscode/".to_string(),
                "*.swp".to_string(),
                "*.swo".to_string(),
                "*~".to_string(),
                ".DS_Store".to_string(),
                "Thumbs.db".to_string(),
            ],
        },
    ])
}

/// Gitignore template with common patterns
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitignoreTemplate {
    pub name: String,
    pub patterns: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_get_gitignore_no_file() {
        let repo = TestRepo::with_initial_commit();
        let result = get_gitignore(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_add_to_gitignore_creates_file() {
        let repo = TestRepo::with_initial_commit();

        let result = add_to_gitignore(
            repo.path_str(),
            vec!["node_modules/".to_string(), ".env".to_string()],
        )
        .await;
        assert!(result.is_ok());

        let gitignore_path = repo.path.join(".gitignore");
        assert!(gitignore_path.exists());

        let content = std::fs::read_to_string(&gitignore_path).unwrap();
        assert!(content.contains("node_modules/"));
        assert!(content.contains(".env"));
    }

    #[tokio::test]
    async fn test_add_to_gitignore_no_duplicates() {
        let repo = TestRepo::with_initial_commit();

        add_to_gitignore(repo.path_str(), vec!["node_modules/".to_string()])
            .await
            .unwrap();

        // Add again
        add_to_gitignore(repo.path_str(), vec!["node_modules/".to_string()])
            .await
            .unwrap();

        let content = std::fs::read_to_string(repo.path.join(".gitignore")).unwrap();
        let count = content
            .lines()
            .filter(|l| l.trim() == "node_modules/")
            .count();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_get_gitignore_entries() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "# Comment\nnode_modules/\n\n!important.txt\n");

        let result = get_gitignore(repo.path_str()).await.unwrap();
        assert_eq!(result.len(), 4);
        assert!(result[0].is_comment);
        assert!(!result[1].is_comment);
        assert_eq!(result[1].pattern, "node_modules/");
        assert!(result[2].is_empty);
        assert!(result[3].is_negation);
    }

    #[tokio::test]
    async fn test_remove_from_gitignore() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "node_modules/\n.env\ndist/\n");

        let result = remove_from_gitignore(repo.path_str(), ".env".to_string(), 2).await;
        assert!(result.is_ok());

        let content = std::fs::read_to_string(repo.path.join(".gitignore")).unwrap();
        assert!(!content.contains(".env"));
        assert!(content.contains("node_modules/"));
        assert!(content.contains("dist/"));
    }

    /// Removing one displayed row must not take its twins with it: a .gitignore
    /// can repeat a line (section comments, or a pattern restated around a
    /// negation) and only the selected occurrence was asked for.
    #[tokio::test]
    async fn test_remove_from_gitignore_removes_only_the_selected_line() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "# generated\ndist/\n# generated\ncoverage/\n");

        remove_from_gitignore(repo.path_str(), "# generated".to_string(), 1)
            .await
            .unwrap();

        let content = std::fs::read_to_string(repo.path.join(".gitignore")).unwrap();
        assert_eq!(content, "dist/\n# generated\ncoverage/\n");
    }

    /// A stale line number must fail loudly rather than delete whatever rule
    /// has since moved into that slot.
    #[tokio::test]
    async fn test_remove_from_gitignore_rejects_a_stale_line() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "node_modules/\ndist/\n");

        let result = remove_from_gitignore(repo.path_str(), ".env".to_string(), 2).await;
        assert!(result.is_err());

        let content = std::fs::read_to_string(repo.path.join(".gitignore")).unwrap();
        assert_eq!(content, "node_modules/\ndist/\n");
    }

    #[tokio::test]
    async fn test_remove_from_gitignore_rejects_a_line_past_the_end() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "dist/\n");

        assert!(
            remove_from_gitignore(repo.path_str(), "dist/".to_string(), 9)
                .await
                .is_err()
        );
        assert!(
            remove_from_gitignore(repo.path_str(), "dist/".to_string(), 0)
                .await
                .is_err()
        );

        let content = std::fs::read_to_string(repo.path.join(".gitignore")).unwrap();
        assert_eq!(content, "dist/\n");
    }

    #[tokio::test]
    async fn test_remove_from_nonexistent_gitignore() {
        let repo = TestRepo::with_initial_commit();
        let result = remove_from_gitignore(repo.path_str(), "pattern".to_string(), 1).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_is_ignored() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "*.log\n");
        repo.stage_file(".gitignore");
        repo.create_commit("Add gitignore", &[(".gitignore", "*.log\n")]);

        let result = is_ignored(repo.path_str(), "test.log".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap());

        let result2 = is_ignored(repo.path_str(), "test.txt".to_string()).await;
        assert!(result2.is_ok());
        assert!(!result2.unwrap());
    }

    #[tokio::test]
    async fn test_get_gitignore_templates() {
        let result = get_gitignore_templates().await;
        assert!(result.is_ok());
        let templates = result.unwrap();
        assert!(!templates.is_empty());
        assert!(templates.iter().any(|t| t.name == "Node.js"));
        assert!(templates.iter().any(|t| t.name == "Rust"));
    }

    #[tokio::test]
    async fn test_check_ignore_multiple_files() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "*.log\nbuild/\n");
        repo.stage_file(".gitignore");
        repo.create_commit("Add gitignore", &[(".gitignore", "*.log\nbuild/\n")]);

        let results = check_ignore(
            repo.path_str(),
            vec![
                "test.log".to_string(),
                "src/main.rs".to_string(),
                "build/output.js".to_string(),
            ],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 3);
        assert!(results[0].is_ignored); // test.log matches *.log
        assert_eq!(results[0].path, "test.log");
        assert!(!results[1].is_ignored); // src/main.rs not ignored
        assert_eq!(results[1].path, "src/main.rs");
        assert!(results[2].is_ignored); // build/output.js matches build/
        assert_eq!(results[2].path, "build/output.js");
    }

    #[tokio::test]
    async fn test_check_ignore_empty_list() {
        let repo = TestRepo::with_initial_commit();

        let results = check_ignore(repo.path_str(), vec![]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_check_ignore_no_gitignore() {
        let repo = TestRepo::with_initial_commit();

        let results = check_ignore(
            repo.path_str(),
            vec!["test.log".to_string(), "src/main.rs".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 2);
        assert!(!results[0].is_ignored);
        assert!(!results[1].is_ignored);
    }

    #[tokio::test]
    async fn test_check_ignore_verbose_ignored_file() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file(".gitignore", "*.log\nbuild/\n");
        repo.stage_file(".gitignore");
        repo.create_commit("Add gitignore", &[(".gitignore", "*.log\nbuild/\n")]);

        let results = check_ignore_verbose(
            repo.path_str(),
            vec!["test.log".to_string(), "src/main.rs".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 2);

        // test.log should be ignored with pattern details
        let log_result = results.iter().find(|r| r.path == "test.log").unwrap();
        assert!(log_result.is_ignored);
        assert!(log_result.source_file.is_some());
        assert!(log_result.source_line.is_some());
        assert_eq!(log_result.pattern.as_deref(), Some("*.log"));
        assert!(!log_result.is_negated);

        // src/main.rs should not be ignored
        let rs_result = results.iter().find(|r| r.path == "src/main.rs").unwrap();
        assert!(!rs_result.is_ignored);
    }

    // Regression (finding 91): ignore rules never apply to tracked files.
    // Canonical git: `git check-ignore -v tracked.log` prints nothing / exits 1,
    // and `git status --ignored` never lists a tracked file.
    #[tokio::test]
    async fn test_tracked_file_is_never_ignored() {
        let repo = TestRepo::with_initial_commit();
        // Commit both the ignore rule and a file the rule would otherwise match.
        repo.create_commit(
            "Add gitignore and tracked log",
            &[(".gitignore", "*.log\n"), ("tracked.log", "data\n")],
        );

        // is_ignored: tracked file must be reported as NOT ignored.
        let single = is_ignored(repo.path_str(), "tracked.log".to_string())
            .await
            .unwrap();
        assert!(!single, "tracked.log is tracked, so it must not be ignored");

        // Sanity: an untracked *.log file is still ignored.
        let untracked = is_ignored(repo.path_str(), "untracked.log".to_string())
            .await
            .unwrap();
        assert!(untracked, "untracked.log must still be ignored");

        // check_ignore: tracked file must be NOT ignored.
        let results = check_ignore(
            repo.path_str(),
            vec!["tracked.log".to_string(), "untracked.log".to_string()],
        )
        .await
        .unwrap();
        let tracked = results.iter().find(|r| r.path == "tracked.log").unwrap();
        assert!(
            !tracked.is_ignored,
            "check_ignore must not ignore tracked.log"
        );
        let untracked = results.iter().find(|r| r.path == "untracked.log").unwrap();
        assert!(
            untracked.is_ignored,
            "check_ignore must ignore untracked.log"
        );

        // check_ignore_verbose: tracked file must be NOT ignored, with no rule details.
        let verbose = check_ignore_verbose(
            repo.path_str(),
            vec!["tracked.log".to_string(), "untracked.log".to_string()],
        )
        .await
        .unwrap();
        let tracked = verbose.iter().find(|r| r.path == "tracked.log").unwrap();
        assert!(
            !tracked.is_ignored,
            "check_ignore_verbose must not ignore tracked.log"
        );
        assert!(tracked.source_file.is_none());
        assert!(tracked.pattern.is_none());
        let untracked = verbose.iter().find(|r| r.path == "untracked.log").unwrap();
        assert!(untracked.is_ignored);
        assert_eq!(untracked.pattern.as_deref(), Some("*.log"));
    }

    // Regression (finding 92): non-ASCII pathnames must be reported once, unquoted.
    #[tokio::test]
    async fn test_check_ignore_verbose_non_ascii_path() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add gitignore", &[(".gitignore", "caf*\n")]);

        let verbose = check_ignore_verbose(repo.path_str(), vec!["café.log".to_string()])
            .await
            .unwrap();

        // Exactly one entry for one input path (no garbled duplicate).
        assert_eq!(verbose.len(), 1, "expected a single result for one path");
        let entry = &verbose[0];
        assert_eq!(entry.path, "café.log", "path must be returned unquoted");
        assert!(entry.is_ignored);
        assert_eq!(entry.source_file.as_deref(), Some(".gitignore"));
        assert_eq!(entry.source_line, Some(1));
        assert_eq!(entry.pattern.as_deref(), Some("caf*"));
    }

    #[tokio::test]
    async fn test_check_ignore_verbose_empty_list() {
        let repo = TestRepo::with_initial_commit();

        let results = check_ignore_verbose(repo.path_str(), vec![]).await.unwrap();
        assert!(results.is_empty());
    }

    // Build the NUL-separated output of `git check-ignore -v -n -z` for the given
    // records of (source, linenum, pattern, path).
    fn z_output(records: &[(&str, &str, &str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (source, linenum, pattern, path) in records {
            for field in [source, linenum, pattern, path] {
                out.extend_from_slice(field.as_bytes());
                out.push(0);
            }
        }
        out
    }

    #[test]
    fn test_parse_check_ignore_z_matching() {
        let out = z_output(&[(".gitignore", "1", "*.log", "test.log")]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.path, "test.log");
        assert!(r.is_ignored);
        assert_eq!(r.source_file.as_deref(), Some(".gitignore"));
        assert_eq!(r.source_line, Some(1));
        assert_eq!(r.pattern.as_deref(), Some("*.log"));
        assert!(!r.is_negated);
    }

    #[test]
    fn test_parse_check_ignore_z_non_matching() {
        let out = z_output(&[("", "", "", "src/main.rs")]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.path, "src/main.rs");
        assert!(!r.is_ignored);
        assert!(r.source_file.is_none());
        assert!(r.source_line.is_none());
        assert!(r.pattern.is_none());
        assert!(!r.is_negated);
    }

    #[test]
    fn test_parse_check_ignore_z_negated() {
        let out = z_output(&[(".gitignore", "3", "!important.log", "important.log")]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.path, "important.log");
        assert!(!r.is_ignored);
        assert!(r.is_negated);
        assert_eq!(r.pattern.as_deref(), Some("!important.log"));
    }

    #[test]
    fn test_parse_check_ignore_z_multiple_records() {
        let out = z_output(&[
            ("src/.gitignore", "2", "*.tmp", "src/data.tmp"),
            ("", "", "", "keep.txt"),
        ]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].path, "src/data.tmp");
        assert!(results[0].is_ignored);
        assert_eq!(results[0].source_file.as_deref(), Some("src/.gitignore"));
        assert_eq!(results[0].source_line, Some(2));
        assert_eq!(results[0].pattern.as_deref(), Some("*.tmp"));
        assert_eq!(results[1].path, "keep.txt");
        assert!(!results[1].is_ignored);
    }

    #[test]
    fn test_parse_check_ignore_z_non_ascii_path() {
        // With -z there is no C-quoting: the raw UTF-8 path comes through verbatim.
        let out = z_output(&[(".gitignore", "3", "caf*", "café.log")]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "café.log");
        assert!(results[0].is_ignored);
        assert_eq!(results[0].pattern.as_deref(), Some("caf*"));
    }

    #[test]
    fn test_parse_check_ignore_z_pattern_with_colon() {
        // A pattern containing ':' must survive (the old colon-splitting parser
        // mangled it); -z fields are unambiguous.
        let out = z_output(&[(".gitignore", "5", "foo:bar", "foo:bar")]);
        let results = parse_check_ignore_z(&out);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].pattern.as_deref(), Some("foo:bar"));
        assert_eq!(results[0].path, "foo:bar");
    }
}
