//! Search/grep command handlers
//! Search in files, diffs, commits, and commit messages

use std::collections::HashMap;
use std::io::BufRead;
use std::process::Command;
use tauri::command;

use crate::error::{GitnadoError, Result};

/// A single search match within a file
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: u32,
    pub line_content: String,
    pub match_start: u32,
    pub match_end: u32,
}

/// Grouped search results for a single file
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    pub file_path: String,
    pub matches: Vec<SearchResult>,
    pub match_count: u32,
}

/// A search result from commit history
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSearchResult {
    pub commit_id: String,
    pub author: String,
    pub date: i64,
    pub message: String,
    pub file_path: String,
    pub line_content: String,
}

/// Find the byte offset of a query match within a line (case-sensitive or insensitive)
pub(crate) fn find_match_position(line: &str, query: &str, case_sensitive: bool) -> (u32, u32) {
    if case_sensitive {
        if let Some(start) = line.find(query) {
            (start as u32, (start + query.len()) as u32)
        } else {
            (0, 0)
        }
    } else {
        let line_lower = line.to_lowercase();
        let query_lower = query.to_lowercase();
        if let Some(start) = line_lower.find(&query_lower) {
            (start as u32, (start + query.len()) as u32)
        } else {
            (0, 0)
        }
    }
}

/// Read NUL-framed `git grep -z -n` records (path\0line\0content\n) from a
/// reader, stopping once `limit` records have been collected.
pub(crate) fn read_grep_records<R: BufRead>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Vec<(String, u32, String)>> {
    let mut records = Vec::with_capacity(limit.min(128));
    let mut path = Vec::new();
    let mut line = Vec::new();
    let mut content = Vec::new();

    while records.len() < limit {
        path.clear();
        if reader.read_until(0, &mut path)? == 0 {
            break;
        }
        if path.pop() != Some(0) {
            break;
        }

        line.clear();
        if reader.read_until(0, &mut line)? == 0 || line.pop() != Some(0) {
            break;
        }

        content.clear();
        if reader.read_until(b'\n', &mut content)? == 0 {
            break;
        }
        if content.last() == Some(&b'\n') {
            content.pop();
        }
        if content.last() == Some(&b'\r') {
            content.pop();
        }

        if let Ok(line_number) = String::from_utf8_lossy(&line).parse::<u32>() {
            records.push((
                String::from_utf8_lossy(&path).into_owned(),
                line_number,
                String::from_utf8_lossy(&content).into_owned(),
            ));
        }
    }

    Ok(records)
}

/// Search for a pattern in repository files using git grep
#[command]
pub async fn search_in_files(
    path: String,
    query: String,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    file_pattern: Option<String>,
    max_results: Option<u32>,
) -> Result<Vec<SearchFileResult>> {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = regex.unwrap_or(false);
    let max_results = max_results.unwrap_or(1000);

    let mut cmd = Command::new("git");
    // `--no-color` and `--no-column` because the output is parsed field by
    // field: `color.grep` (or `color.ui`) set to `always` wraps the path and
    // the line number in SGR escapes even into a pipe, so the line-number
    // parse fails and every match is silently dropped, and `grep.column`
    // inserts an extra column field that would end up prefixed to the reported
    // line content. `-z` because the default `path:line:content` framing is
    // ambiguous and lossy: a path containing a colon shifts every field (and
    // the match is then dropped by the line-number parse), a path containing a
    // newline splits one record into two, and `core.quotePath` — on by default
    // — emits any path with a non-ASCII byte double-quoted and octal-escaped,
    // which would be shown to the user and opened as a file that does not
    // exist. `-I` because `git grep -z` still prints an unframed
    // `Binary file <path> matches` line, which would desynchronise the
    // NUL-framed reader. Kept in step with the workspace grep, which parses the
    // same records.
    cmd.arg("-C")
        .arg(&path)
        .arg("grep")
        .arg("--no-color")
        .arg("--no-column")
        .arg("-n")
        .arg("-z")
        .arg("-I");

    if !case_sensitive {
        cmd.arg("-i");
    }

    if use_regex {
        cmd.arg("-E");
    } else {
        // Non-regex ("plain text") search must match the query literally, exactly
        // like `git grep -F`. Without -F, git grep treats the pattern as a basic
        // regular expression: literal queries like "a.c" over-match ("abc") and
        // queries containing regex metacharacters like "a[" fatally error.
        cmd.arg("-F");
    }

    cmd.arg("--").arg(&query);

    if let Some(ref pattern) = file_pattern {
        cmd.arg(pattern);
    }

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git grep: {}", e)))?;

    // git grep returns exit code 1 when no matches are found (not an error)
    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git grep failed: {}",
            stderr
        )));
    }

    let records = read_grep_records(
        &mut std::io::Cursor::new(&output.stdout),
        max_results as usize,
    )
    .map_err(|e| GitnadoError::OperationFailed(format!("Failed to read git grep output: {}", e)))?;

    let mut file_map: HashMap<String, Vec<SearchResult>> = HashMap::new();

    for (file_path, line_number, line_content) in records {
        let (match_start, match_end) = find_match_position(&line_content, &query, case_sensitive);

        let result = SearchResult {
            file_path: file_path.clone(),
            line_number,
            line_content,
            match_start,
            match_end,
        };

        file_map.entry(file_path).or_default().push(result);
    }

    let results: Vec<SearchFileResult> = file_map
        .into_iter()
        .map(|(file_path, matches)| {
            let match_count = matches.len() as u32;
            SearchFileResult {
                file_path,
                matches,
                match_count,
            }
        })
        .collect();

    Ok(results)
}

/// Search for a pattern within the current diff (staged or unstaged)
#[command]
pub async fn search_in_diff(
    path: String,
    query: String,
    staged: Option<bool>,
) -> Result<Vec<SearchResult>> {
    let is_staged = staged.unwrap_or(false);

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&path).arg("diff").arg("--unified=0");

    if is_staged {
        cmd.arg("--cached");
    }

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git diff: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git diff failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();
    let mut current_file = String::new();
    // The old-side path parsed from the "--- a/<path>" header. Needed for deleted
    // files, whose new-side header is "+++ /dev/null" and thus carries no path.
    let mut old_file = String::new();
    // Separate counters for the two sides of the hunk: added lines advance the
    // new-side counter, removed lines advance the old-side counter.
    let mut current_new_line: u32 = 0;
    let mut current_old_line: u32 = 0;

    for line in stdout.lines() {
        // Track the old-side path from the "--- a/<path>" header (or /dev/null
        // for added files). Must be checked before the generic "-" line handling.
        if let Some(rest) = line.strip_prefix("--- ") {
            old_file = rest.strip_prefix("a/").unwrap_or(rest).to_string();
            continue;
        }
        // Track the current file from the new-side header. Deleted files report
        // "+++ /dev/null", so fall back to the old-side path parsed above.
        if let Some(rest) = line.strip_prefix("+++ ") {
            current_file = match rest.strip_prefix("b/") {
                Some(path) => path.to_string(),
                None => old_file.clone(),
            };
            continue;
        }

        // Parse hunk header for line numbers: @@ -oldStart,count +newStart,count @@
        if line.starts_with("@@") {
            let mut tokens = line.split(' ');
            let _ = tokens.next(); // "@@"
            if let Some(old_tok) = tokens.next() {
                current_old_line = old_tok
                    .trim_start_matches('-')
                    .split(',')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
            }
            if let Some(new_tok) = tokens.next() {
                current_new_line = new_tok
                    .trim_start_matches('+')
                    .split(',')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }

        // Check added lines for the query (new-side numbering).
        if line.starts_with('+') && !line.starts_with("+++") {
            let content = &line[1..]; // Strip the '+' prefix

            if content.to_lowercase().contains(&query_lower) {
                let (match_start, match_end) = find_match_position(content, &query, false);

                results.push(SearchResult {
                    file_path: current_file.clone(),
                    line_number: current_new_line,
                    line_content: content.to_string(),
                    match_start,
                    match_end,
                });
            }

            current_new_line += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            let content = &line[1..]; // Strip the '-' prefix

            if content.to_lowercase().contains(&query_lower) {
                let (match_start, match_end) = find_match_position(content, &query, false);

                results.push(SearchResult {
                    file_path: current_file.clone(),
                    line_number: current_old_line,
                    line_content: content.to_string(),
                    match_start,
                    match_end,
                });
            }

            current_old_line += 1;
        }
    }

    Ok(results)
}

/// Search for commits where a string was added or removed (pickaxe search)
#[command]
pub async fn search_in_commits(
    path: String,
    query: String,
    max_commits: Option<u32>,
) -> Result<Vec<DiffSearchResult>> {
    let max_commits = max_commits.unwrap_or(100);

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&path)
        .arg("log")
        .arg(format!("-S{}", query))
        .arg("--format=%H|%an|%at|%s")
        .arg(format!("-{}", max_commits))
        .arg("--name-only");

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git log: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git log failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<DiffSearchResult> = Vec::new();
    let mut current_commit_id = String::new();
    let mut current_author = String::new();
    let mut current_date: i64 = 0;
    let mut current_message = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Check if this is a commit header line (contains | separators)
        if line.contains('|') {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            if parts.len() == 4 {
                current_commit_id = parts[0].to_string();
                current_author = parts[1].to_string();
                current_date = parts[2].parse().unwrap_or(0);
                current_message = parts[3].to_string();
                continue;
            }
        }

        // Otherwise it's a file name
        if !current_commit_id.is_empty() {
            results.push(DiffSearchResult {
                commit_id: current_commit_id.clone(),
                author: current_author.clone(),
                date: current_date,
                message: current_message.clone(),
                file_path: line.to_string(),
                line_content: String::new(),
            });
        }
    }

    Ok(results)
}

/// Search in commit messages using git log --grep
#[command]
pub async fn search_in_commit_messages(
    path: String,
    query: String,
    max_commits: Option<u32>,
) -> Result<Vec<DiffSearchResult>> {
    let max_commits = max_commits.unwrap_or(100);

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&path)
        .arg("log")
        .arg(format!("--grep={}", query))
        .arg("-i")
        // Match the query literally (like `git log --grep=… -F`). Without -F the
        // query is treated as a regex, so "v1.2" would spuriously match "v1x2"
        // and invalid patterns like "fix a[" would make git log exit non-zero.
        .arg("--fixed-strings")
        .arg("--format=%H|%an|%at|%s")
        .arg(format!("-{}", max_commits));

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git log: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git log failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<DiffSearchResult> = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() == 4 {
            results.push(DiffSearchResult {
                commit_id: parts[0].to_string(),
                author: parts[1].to_string(),
                date: parts[2].parse().unwrap_or(0),
                message: parts[3].to_string(),
                file_path: String::new(),
                line_content: String::new(),
            });
        }
    }

    Ok(results)
}

/// A commit returned from content/file search
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCommit {
    pub oid: String,
    pub short_oid: String,
    pub message: String,
    pub author_name: String,
    pub author_date: i64,
    pub matches: Vec<SearchMatch>,
}

/// A match location within a commit's changes
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub file_path: String,
    pub line_number: Option<u32>,
    pub line_content: Option<String>,
}

/// Search for commits that changed specific content (git log -G or -S with --pickaxe-regex)
///
/// This is useful for finding when a specific string or pattern was added, removed, or modified.
/// Uses `git log -G` for regex patterns (finds commits where the diff contains the pattern)
/// or `git log -S` for exact string matches (finds commits that change the number of occurrences).
#[command]
pub async fn search_commits_by_content(
    path: String,
    search_text: String,
    regex: Option<bool>,
    ignore_case: Option<bool>,
    max_count: Option<u32>,
) -> Result<Vec<SearchCommit>> {
    let max_count = max_count.unwrap_or(100);
    let use_regex = regex.unwrap_or(false);
    let case_insensitive = ignore_case.unwrap_or(false);

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&path)
        .arg("log")
        // Use NUL (%x00) as the field separator so that a commit subject (%s) or
        // author name (%an) containing '|' cannot be misparsed into the wrong
        // field. File names from --name-only never contain NUL, so they remain
        // unambiguously distinguishable from header lines.
        .arg("--format=%H%x00%h%x00%s%x00%an%x00%at")
        .arg("--name-only")
        .arg(format!("-{}", max_count));

    // Use -G for regex (grep in diff), -S for exact string match (pickaxe)
    if use_regex {
        cmd.arg(format!("-G{}", search_text));
        if case_insensitive {
            cmd.arg("-i");
        }
    } else {
        cmd.arg(format!("-S{}", search_text));
        if case_insensitive {
            cmd.arg("-i");
        }
    }

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git log: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git log failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<SearchCommit> = Vec::new();
    let mut current_commit: Option<SearchCommit> = None;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            // Empty line can appear between the header and the file list,
            // or after the file list. Only finalize if the commit has matches
            // (to avoid finalizing before file names are parsed).
            if let Some(ref commit) = current_commit {
                if !commit.matches.is_empty() {
                    results.push(current_commit.take().unwrap());
                }
            }
            continue;
        }

        // Header lines contain NUL field separators; file names never do.
        if line.contains('\0') {
            // Save previous commit if exists
            if let Some(commit) = current_commit.take() {
                results.push(commit);
            }

            let parts: Vec<&str> = line.splitn(5, '\0').collect();
            if parts.len() == 5 {
                current_commit = Some(SearchCommit {
                    oid: parts[0].to_string(),
                    short_oid: parts[1].to_string(),
                    message: parts[2].to_string(),
                    author_name: parts[3].to_string(),
                    author_date: parts[4].parse().unwrap_or(0),
                    matches: Vec::new(),
                });
            }
        } else if let Some(ref mut commit) = current_commit {
            // This is a file name
            commit.matches.push(SearchMatch {
                file_path: line.to_string(),
                line_number: None,
                line_content: None,
            });
        }
    }

    // Don't forget the last commit
    if let Some(commit) = current_commit {
        results.push(commit);
    }

    Ok(results)
}

/// Search for commits that touched files matching a pattern (git log -- <pattern>)
///
/// This is useful for finding all commits that modified files matching a glob pattern.
#[command]
pub async fn search_commits_by_file(
    path: String,
    file_pattern: String,
    max_count: Option<u32>,
) -> Result<Vec<SearchCommit>> {
    let max_count = max_count.unwrap_or(100);

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&path)
        .arg("log")
        // NUL-separated fields so a '|' in the subject/author cannot corrupt
        // field parsing (see search_commits_by_content for details).
        .arg("--format=%H%x00%h%x00%s%x00%an%x00%at")
        .arg("--name-only")
        .arg(format!("-{}", max_count))
        .arg("--")
        .arg(&file_pattern);

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to execute git log: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git log failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<SearchCommit> = Vec::new();
    let mut current_commit: Option<SearchCommit> = None;

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            // Empty line can appear between the header and the file list,
            // or after the file list. Only finalize if the commit has matches
            // (to avoid finalizing before file names are parsed).
            if let Some(ref commit) = current_commit {
                if !commit.matches.is_empty() {
                    results.push(current_commit.take().unwrap());
                }
            }
            continue;
        }

        // Header lines contain NUL field separators; file names never do.
        if line.contains('\0') {
            // Save previous commit if exists
            if let Some(commit) = current_commit.take() {
                results.push(commit);
            }

            let parts: Vec<&str> = line.splitn(5, '\0').collect();
            if parts.len() == 5 {
                current_commit = Some(SearchCommit {
                    oid: parts[0].to_string(),
                    short_oid: parts[1].to_string(),
                    message: parts[2].to_string(),
                    author_name: parts[3].to_string(),
                    author_date: parts[4].parse().unwrap_or(0),
                    matches: Vec::new(),
                });
            }
        } else if let Some(ref mut commit) = current_commit {
            // This is a file name
            commit.matches.push(SearchMatch {
                file_path: line.to_string(),
                line_number: None,
                line_content: None,
            });
        }
    }

    // Don't forget the last commit
    if let Some(commit) = current_commit {
        results.push(commit);
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_search_in_files_basic() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add search test files",
            &[
                ("search_test.txt", "Hello World\nfoo bar baz\nHello Again"),
                ("other.txt", "no match here"),
            ],
        );

        let result = search_in_files(
            repo.path_str(),
            "Hello".to_string(),
            Some(true),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        assert!(!files.is_empty());

        let file = files.iter().find(|f| f.file_path == "search_test.txt");
        assert!(file.is_some());
        let file = file.unwrap();
        assert_eq!(file.match_count, 2);
    }

    #[tokio::test]
    async fn test_search_in_files_case_insensitive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add case test",
            &[("case_test.txt", "Hello world\nhello WORLD\nHELLO")],
        );

        let result = search_in_files(
            repo.path_str(),
            "hello".to_string(),
            Some(false),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        let file = files.iter().find(|f| f.file_path == "case_test.txt");
        assert!(file.is_some());
        assert_eq!(file.unwrap().match_count, 3);
    }

    #[tokio::test]
    async fn test_search_in_files_no_match() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("test.txt", "nothing relevant")]);

        let result = search_in_files(
            repo.path_str(),
            "ZZZZNOTFOUND".to_string(),
            Some(true),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_in_files_max_results() {
        let repo = TestRepo::with_initial_commit();
        // Create a file with many matches
        let content: String = (0..20).map(|i| format!("match line {}\n", i)).collect();
        repo.create_commit("Add many matches", &[("many.txt", &content)]);

        let result = search_in_files(
            repo.path_str(),
            "match".to_string(),
            Some(false),
            None,
            None,
            Some(5),
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        let total: u32 = files.iter().map(|f| f.match_count).sum();
        assert!(total <= 5);
    }

    #[tokio::test]
    async fn test_search_in_files_literal_non_regex() {
        // Regression (finding 107): a non-regex search must match literally
        // (like `git grep -F`). "a.c" must match only the literal "a.c literal"
        // line, not "abc" (where '.' would match 'b' under BRE semantics).
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add literal test", &[("lit.txt", "abc\na.c literal\n")]);

        let result = search_in_files(
            repo.path_str(),
            "a.c".to_string(),
            Some(false), // case-insensitive
            Some(false), // NOT regex → literal
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let files = result.unwrap();
        let total: u32 = files.iter().map(|f| f.match_count).sum();
        assert_eq!(total, 1, "literal 'a.c' should match exactly one line");
        assert!(files
            .iter()
            .flat_map(|f| &f.matches)
            .all(|m| m.line_content.contains("a.c literal")));
    }

    #[tokio::test]
    async fn test_search_in_files_literal_regex_metacharacters_no_error() {
        // Regression (finding 107): a literal query containing regex
        // metacharacters (e.g. an unbalanced "[") must NOT error out; under -F it
        // is matched verbatim rather than compiled as an invalid regex.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add bracket", &[("br.txt", "value a[ here\n")]);

        let result = search_in_files(
            repo.path_str(),
            "a[".to_string(),
            Some(false),
            Some(false),
            None,
            None,
        )
        .await;

        assert!(result.is_ok(), "literal 'a[' must not error");
        let files = result.unwrap();
        let total: u32 = files.iter().map(|f| f.match_count).sum();
        assert_eq!(total, 1);
    }

    /// `color.grep = always` makes git colour its output even into a pipe.
    /// The `file:line:content` records are split field by field, so without
    /// `--no-color` the SGR escapes around the line number fail to parse and
    /// every match is dropped — a query that does match reads as no results.
    #[tokio::test]
    async fn test_search_in_files_ignores_forced_colour_output() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        repo.repo()
            .config()
            .unwrap()
            .set_str("color.grep", "always")
            .unwrap();

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        let file = files
            .iter()
            .find(|f| f.file_path == "search.txt")
            .expect("forced colour must not hide the match");
        assert_eq!(file.match_count, 1);
        assert_eq!(file.matches[0].line_number, 1);
        assert_eq!(file.matches[0].line_content, "literal a.b");
    }

    /// `grep.column = true` adds a column field before the content, so without
    /// `--no-column` the reported line content is prefixed with the column
    /// number instead of being the matched line.
    #[tokio::test]
    async fn test_search_in_files_ignores_forced_column_output() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        repo.repo()
            .config()
            .unwrap()
            .set_bool("grep.column", true)
            .unwrap();

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        let file = files
            .iter()
            .find(|f| f.file_path == "search.txt")
            .expect("forced column must not hide the match");
        assert_eq!(file.match_count, 1);
        assert_eq!(file.matches[0].line_number, 1);
        assert_eq!(file.matches[0].line_content, "literal a.b");
    }

    /// Colour and column forced together: neither neutralising flag may undo
    /// the other, and a query that does not match must still report nothing.
    #[tokio::test]
    async fn test_search_in_files_ignores_forced_colour_and_column_together() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("search.txt", "literal a.b\n")]);
        let git_repo = repo.repo();
        let mut config = git_repo.config().unwrap();
        config.set_str("color.grep", "always").unwrap();
        config.set_bool("grep.column", true).unwrap();

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        let file = files
            .iter()
            .find(|f| f.file_path == "search.txt")
            .expect("forced colour and column must not hide the match");
        assert_eq!(file.matches[0].line_content, "literal a.b");

        let missing = search_in_files(
            repo.path_str(),
            "zzz-absent".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(missing.is_empty());
    }

    /// The default `path:line:content` framing is ambiguous when the path
    /// itself contains a colon: the fields shift, the line-number parse fails
    /// and the match is dropped, so a query that does match reports nothing.
    /// Windows cannot host the fixture — git rejects a colon as an invalid path
    /// character, and the situation cannot arise there — so the end-to-end leg
    /// runs on Unix only; `test_workspace_grep_parser_accepts_colons_in_file_names`
    /// pins the parsing itself on every platform.
    #[tokio::test]
    #[cfg_attr(windows, ignore = "a colon is not a legal path character on Windows")]
    async fn test_search_in_files_finds_matches_in_paths_containing_a_colon() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add search content",
            &[("folder/na:me.txt", "literal a.b\n")],
        );

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        let file = files
            .iter()
            .find(|f| f.file_path == "folder/na:me.txt")
            .expect("a colon in the path must not hide the match");
        assert_eq!(file.match_count, 1);
        assert_eq!(file.matches[0].line_number, 1);
        assert_eq!(file.matches[0].line_content, "literal a.b");
    }

    /// `core.quotePath` is on by default, so without `-z` git emits any path
    /// holding a non-ASCII byte double-quoted and octal-escaped. That string is
    /// what the search dialog shows and what it asks the app to open, so the
    /// path must come back exactly as it is on disk.
    #[tokio::test]
    async fn test_search_in_files_reports_a_non_ascii_path_verbatim() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add search content", &[("café.txt", "literal a.b\n")]);
        repo.repo()
            .config()
            .unwrap()
            .set_bool("core.quotePath", true)
            .unwrap();

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        let paths: Vec<&str> = files.iter().map(|f| f.file_path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["café.txt"],
            "path must not be escaped or quoted"
        );
        assert_eq!(files[0].matches[0].line_content, "literal a.b");
    }

    /// A binary file that matches makes git print an unframed
    /// `Binary file <path> matches` line even under `-z`; `-I` keeps it out so
    /// the following records stay readable and the text matches survive.
    #[tokio::test]
    async fn test_search_in_files_keeps_text_matches_alongside_a_binary_match() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add search content",
            &[
                ("a-binary.dat", "literal a.b\u{0}binary\u{0}payload\n"),
                ("z-text.txt", "literal a.b\n"),
            ],
        );

        let files = search_in_files(
            repo.path_str(),
            "a.b".to_string(),
            Some(true),
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();

        let file = files
            .iter()
            .find(|f| f.file_path == "z-text.txt")
            .expect("a binary match must not swallow the text match that follows it");
        assert_eq!(file.matches[0].line_number, 1);
        assert_eq!(file.matches[0].line_content, "literal a.b");
        assert!(
            files.iter().all(|f| f.file_path != "a-binary.dat"),
            "binary files are not reported as text matches"
        );
    }

    #[tokio::test]
    async fn test_search_in_diff_unstaged() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add base file", &[("diff_test.txt", "original content")]);

        // Modify the file without staging
        repo.create_file("diff_test.txt", "original content\nnew search term here");

        let result = search_in_diff(repo.path_str(), "search term".to_string(), Some(false)).await;

        assert!(result.is_ok());
        let matches = result.unwrap();
        assert!(!matches.is_empty());
        assert!(matches[0].line_content.contains("new search term here"));
    }

    #[tokio::test]
    async fn test_search_in_diff_staged() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add base file", &[("staged_test.txt", "original line")]);

        // Modify and stage the file
        repo.create_file("staged_test.txt", "original line\nadded staged content");
        repo.stage_file("staged_test.txt");

        let result =
            search_in_diff(repo.path_str(), "staged content".to_string(), Some(true)).await;

        assert!(result.is_ok());
        let matches = result.unwrap();
        assert!(!matches.is_empty());
    }

    #[tokio::test]
    async fn test_search_in_diff_no_match() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("no_diff.txt", "content")]);

        repo.create_file("no_diff.txt", "content\nmore content");

        let result = search_in_diff(repo.path_str(), "ZZZZNOTFOUND".to_string(), Some(false)).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_in_diff_deleted_file_attribution() {
        // Regression (finding 109): content removed by deleting a file must be
        // attributed to that deleted file (whose new-side header is
        // "+++ /dev/null"), not to the previous file in the diff, and removed
        // lines must carry old-side (not new-side) line numbers.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add base files",
            &[
                ("alive.txt", "alive line 1\n"),
                ("doomed.txt", "secret_token here\nsecond line\n"),
            ],
        );

        // Modify alive.txt and delete doomed.txt in the working tree.
        repo.create_file("alive.txt", "alive line 1\nalive line 2\n");
        std::fs::remove_file(format!("{}/doomed.txt", repo.path_str()))
            .expect("failed to delete doomed.txt");

        let result = search_in_diff(repo.path_str(), "secret_token".to_string(), Some(false)).await;

        assert!(result.is_ok());
        let matches = result.unwrap();
        let m = matches
            .iter()
            .find(|m| m.line_content.contains("secret_token"))
            .expect("secret_token match should be present");
        assert_eq!(
            m.file_path, "doomed.txt",
            "removed content must be attributed to the deleted file"
        );
        assert_eq!(
            m.line_number, 1,
            "removed line must use its old-side line number, not 0"
        );
    }

    #[tokio::test]
    async fn test_search_in_commits_basic() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add unique string",
            &[("pickaxe.txt", "unique_pickaxe_term")],
        );

        let result =
            search_in_commits(repo.path_str(), "unique_pickaxe_term".to_string(), Some(50)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        assert!(commits.iter().any(|c| c.file_path.contains("pickaxe.txt")));
    }

    #[tokio::test]
    async fn test_search_in_commits_no_match() {
        let repo = TestRepo::with_initial_commit();

        let result = search_in_commits(
            repo.path_str(),
            "ZZZZNOTFOUND_PICKAXE".to_string(),
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_in_commit_messages_basic() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "fix: resolve unique_bug_identifier crash",
            &[("fix.txt", "fixed")],
        );

        let result = search_in_commit_messages(
            repo.path_str(),
            "unique_bug_identifier".to_string(),
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        assert!(commits
            .iter()
            .any(|c| c.message.contains("unique_bug_identifier")));
    }

    #[tokio::test]
    async fn test_search_in_commit_messages_no_match() {
        let repo = TestRepo::with_initial_commit();

        let result =
            search_in_commit_messages(repo.path_str(), "ZZZZNOTFOUND_MSG".to_string(), Some(50))
                .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_in_commit_messages_case_insensitive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Feature: Add UniqueFeatureName",
            &[("feature.txt", "feature content")],
        );

        // git log --grep with -i should find it
        let result =
            search_in_commit_messages(repo.path_str(), "uniquefeaturename".to_string(), Some(50))
                .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
    }

    #[tokio::test]
    async fn test_search_in_commit_messages_literal_not_regex() {
        // Regression (finding 108): the message query must be matched literally,
        // so "v1.2" must NOT match a commit message of "release v1x2".
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("release v1x2", &[("rel.txt", "content")]);

        let result = search_in_commit_messages(repo.path_str(), "v1.2".to_string(), Some(50)).await;

        assert!(result.is_ok());
        assert!(
            result.unwrap().is_empty(),
            "literal 'v1.2' must not match 'v1x2'"
        );
    }

    #[test]
    fn test_find_match_position_case_sensitive() {
        let (start, end) = find_match_position("hello world", "world", true);
        assert_eq!(start, 6);
        assert_eq!(end, 11);
    }

    #[test]
    fn test_find_match_position_case_insensitive() {
        let (start, end) = find_match_position("Hello WORLD", "world", false);
        assert_eq!(start, 6);
        assert_eq!(end, 11);
    }

    #[test]
    fn test_find_match_position_no_match() {
        let (start, end) = find_match_position("hello world", "xyz", true);
        assert_eq!(start, 0);
        assert_eq!(end, 0);
    }

    // Tests for search_commits_by_content

    #[tokio::test]
    async fn test_search_commits_by_content_basic() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add unique content",
            &[("content_test.txt", "unique_search_content_xyz")],
        );

        let result = search_commits_by_content(
            repo.path_str(),
            "unique_search_content_xyz".to_string(),
            Some(false), // not regex
            Some(false), // case sensitive
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        assert!(commits
            .iter()
            .any(|c| c.message.contains("Add unique content")));
        assert!(commits.iter().any(|c| c
            .matches
            .iter()
            .any(|m| m.file_path.contains("content_test.txt"))));
    }

    #[tokio::test]
    async fn test_search_commits_by_content_subject_with_pipe() {
        // Regression (finding 106): a commit subject containing '|' must not
        // corrupt the author/date fields of the parsed SearchCommit.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "feat: support a|b unique_pipe_token in parser",
            &[("pipe_content.txt", "unique_pipe_token_body")],
        );

        let result = search_commits_by_content(
            repo.path_str(),
            "unique_pipe_token_body".to_string(),
            Some(false),
            Some(false),
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        let commit = commits
            .iter()
            .find(|c| c.message.starts_with("feat: support a|b"))
            .expect("commit with pipe subject should be present");
        assert_eq!(
            commit.message,
            "feat: support a|b unique_pipe_token in parser"
        );
        assert_eq!(commit.author_name, "Test User");
        assert!(
            commit.author_date > 0,
            "author date must parse (not fall back to 0)"
        );
        assert!(commit
            .matches
            .iter()
            .any(|m| m.file_path.contains("pipe_content.txt")));
    }

    #[tokio::test]
    async fn test_search_commits_by_file_subject_with_pipe() {
        // Regression (finding 106): search_commits_by_file shares the same
        // parsing; a '|' in the subject must not corrupt fields.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "chore: rename a|b in config",
            &[("piped_config.json", "{}")],
        );

        let result = search_commits_by_file(repo.path_str(), "*.json".to_string(), Some(50)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        let commit = commits
            .iter()
            .find(|c| c.message.starts_with("chore: rename a|b"))
            .expect("commit with pipe subject should be present");
        assert_eq!(commit.message, "chore: rename a|b in config");
        assert_eq!(commit.author_name, "Test User");
        assert!(commit.author_date > 0);
    }

    #[tokio::test]
    async fn test_search_commits_by_content_regex() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add pattern content", &[("pattern.txt", "pattern_abc_123")]);
        repo.create_commit(
            "Add another pattern",
            &[("pattern2.txt", "pattern_def_456")],
        );

        let result = search_commits_by_content(
            repo.path_str(),
            "pattern_[a-z]+_[0-9]+".to_string(),
            Some(true),  // use regex
            Some(false), // case sensitive
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(commits.len() >= 2);
    }

    #[tokio::test]
    async fn test_search_commits_by_content_case_insensitive() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add case test", &[("case.txt", "UniqueSearchCase")]);

        let result = search_commits_by_content(
            repo.path_str(),
            "uniquesearchcase".to_string(),
            Some(false), // not regex
            Some(true),  // case insensitive
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
    }

    #[tokio::test]
    async fn test_search_commits_by_content_no_match() {
        let repo = TestRepo::with_initial_commit();

        let result = search_commits_by_content(
            repo.path_str(),
            "ZZZZNOTFOUND_CONTENT_XYZ".to_string(),
            Some(false),
            Some(false),
            Some(50),
        )
        .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_commits_by_content_max_count() {
        let repo = TestRepo::with_initial_commit();
        // Create multiple commits with the same content
        for i in 0..5 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[(&format!("file{}.txt", i), "repeated_content_xyz")],
            );
        }

        let result = search_commits_by_content(
            repo.path_str(),
            "repeated_content_xyz".to_string(),
            Some(false),
            Some(false),
            Some(2),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(commits.len() <= 2);
    }

    // Tests for search_commits_by_file

    #[tokio::test]
    async fn test_search_commits_by_file_basic() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add Rust file", &[("src/main.rs", "fn main() {}")]);
        repo.create_commit("Add TS file", &[("src/app.ts", "console.log('hi')")]);

        let result = search_commits_by_file(repo.path_str(), "*.rs".to_string(), Some(50)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        // Should find the commit that touched .rs files
        assert!(commits
            .iter()
            .any(|c| c.matches.iter().any(|m| m.file_path.ends_with(".rs"))));
    }

    #[tokio::test]
    async fn test_search_commits_by_file_glob_pattern() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add src files", &[("src/lib.rs", "pub mod foo;")]);
        repo.create_commit("Add test file", &[("tests/test.rs", "mod tests;")]);

        let result =
            search_commits_by_file(repo.path_str(), "src/*.rs".to_string(), Some(50)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        // Should only find commits touching src/*.rs
        assert!(commits
            .iter()
            .any(|c| c.matches.iter().any(|m| m.file_path.starts_with("src/"))));
    }

    #[tokio::test]
    async fn test_search_commits_by_file_no_match() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("test.txt", "content")]);

        let result =
            search_commits_by_file(repo.path_str(), "*.nonexistent".to_string(), Some(50)).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_commits_by_file_max_count() {
        let repo = TestRepo::with_initial_commit();
        // Create multiple commits touching the same file pattern
        for i in 0..5 {
            repo.create_commit(
                &format!("Update config {}", i),
                &[(&format!("config{}.json", i), "{}")],
            );
        }

        let result = search_commits_by_file(repo.path_str(), "*.json".to_string(), Some(2)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(commits.len() <= 2);
    }

    #[tokio::test]
    async fn test_search_commits_by_file_multiple_files_in_commit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit(
            "Add multiple files",
            &[
                ("src/a.rs", "mod a;"),
                ("src/b.rs", "mod b;"),
                ("src/c.txt", "text"),
            ],
        );

        let result = search_commits_by_file(repo.path_str(), "*.rs".to_string(), Some(50)).await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(!commits.is_empty());
        // The commit should list the .rs files it touched
        let commit = commits.iter().find(|c| c.message.contains("Add multiple"));
        assert!(commit.is_some());
        let commit = commit.unwrap();
        assert!(commit.matches.len() >= 2);
    }
}
