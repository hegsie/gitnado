//! Shortlog command handlers
//! Provides contributor commit summaries similar to `git shortlog`

use std::collections::HashMap;
use std::path::Path;
use tauri::command;

use crate::error::Result;

/// A single entry in the shortlog output
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortlogEntry {
    pub name: String,
    pub email: Option<String>,
    pub count: u32,
    pub commits: Vec<String>, // commit messages (if not summary mode)
}

/// Result of the shortlog command
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortlogResult {
    pub entries: Vec<ShortlogEntry>,
    pub total_commits: u32,
    pub total_contributors: u32,
}

/// Get shortlog output - contributor commit summaries
///
/// # Arguments
/// * `path` - Repository path
/// * `range` - Optional revision range (e.g., "v1.0..HEAD")
/// * `all` - Include all branches (--all)
/// * `numbered` - Sort by number of commits (--numbered)
/// * `summary` - Suppress commit descriptions (--summary)
/// * `email` - Show email instead of name (--email)
/// * `group` - Group by "author" or "committer"
#[command]
pub async fn shortlog(
    path: String,
    range: Option<String>,
    all: Option<bool>,
    numbered: Option<bool>,
    summary: Option<bool>,
    email: Option<bool>,
    group: Option<String>,
) -> Result<ShortlogResult> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let use_all = all.unwrap_or(false);
        let use_numbered = numbered.unwrap_or(false);
        let use_summary = summary.unwrap_or(false);
        let show_email = email.unwrap_or(false);
        let group_by = group.as_deref().unwrap_or("author");

        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(git2::Sort::TIME)?;

        // Handle revision range
        if let Some(ref range_spec) = range {
            if range_spec.contains("...") {
                let parts: Vec<&str> = range_spec.splitn(2, "...").collect();
                let from_spec = if parts[0].is_empty() {
                    "HEAD"
                } else {
                    parts[0]
                };
                let to_spec = match parts.get(1) {
                    Some(s) if !s.is_empty() => *s,
                    _ => "HEAD",
                };

                let from_id = repo.revparse_single(from_spec)?.peel_to_commit()?.id();
                let to_id = repo.revparse_single(to_spec)?.peel_to_commit()?.id();

                revwalk.push(from_id)?;
                revwalk.push(to_id)?;
                for base in repo.merge_bases(from_id, to_id)?.iter() {
                    revwalk.hide(*base)?;
                }
            } else if range_spec.contains("..") {
                let parts: Vec<&str> = range_spec.split("..").collect();
                if parts.len() == 2 {
                    let from_spec = parts[0];
                    let to_spec = if parts[1].is_empty() {
                        "HEAD"
                    } else {
                        parts[1]
                    };

                    let to_obj = repo.revparse_single(to_spec)?;
                    revwalk.push(to_obj.id())?;

                    if !from_spec.is_empty() {
                        let from_obj = repo.revparse_single(from_spec)?;
                        revwalk.hide(from_obj.id())?;
                    }
                } else {
                    let obj = repo.revparse_single(range_spec)?;
                    revwalk.push(obj.id())?;
                }
            } else {
                let obj = repo.revparse_single(range_spec)?;
                revwalk.push(obj.id())?;
            }
        } else if use_all {
            for r in repo.references()?.flatten() {
                if let Some(oid) = r.target() {
                    let _ = revwalk.push(oid);
                }
            }
        } else if revwalk.push_head().is_err() {
            return Ok(ShortlogResult {
                entries: Vec::new(),
                total_commits: 0,
                total_contributors: 0,
            });
        }

        let mailmap = repo.mailmap().ok();

        let mut contributors_map: HashMap<String, (String, Option<String>, u32, Vec<String>)> =
            HashMap::new();
        let mut total_commits: u32 = 0;

        for oid_result in revwalk {
            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;
            total_commits += 1;

            let person = if group_by == "committer" {
                commit.committer()
            } else {
                commit.author()
            };

            let resolved = mailmap
                .as_ref()
                .and_then(|mm| mm.resolve_signature(&person).ok());
            let effective = resolved.as_ref().unwrap_or(&person);

            let person_name = effective.name().unwrap_or("Unknown").to_string();
            let person_email = effective.email().ok().map(|s| s.to_string());

            let key = if show_email {
                format!(
                    "{}\u{0}{}",
                    person_name,
                    person_email.clone().unwrap_or_default()
                )
            } else {
                person_name.clone()
            };

            let commit_summary = commit.summary().ok().flatten().unwrap_or("").to_string();

            let entry = contributors_map
                .entry(key)
                .or_insert_with(|| (person_name.clone(), person_email.clone(), 0, Vec::new()));

            if entry.0 == "Unknown" && person_name != "Unknown" {
                entry.0 = person_name;
            }
            if entry.1.is_none() && person_email.is_some() {
                entry.1 = person_email;
            }

            entry.2 += 1;

            if !use_summary {
                entry.3.push(commit_summary);
            }
        }

        let mut entries: Vec<ShortlogEntry> = contributors_map
            .into_iter()
            .map(|(_, (name, email, count, commits))| ShortlogEntry {
                name: name.clone(),
                email,
                count,
                commits,
            })
            .collect();

        if use_numbered {
            entries.sort_by_key(|b| std::cmp::Reverse(b.count));
        } else {
            entries.sort_by_key(|a| a.name.to_lowercase());
        }

        let total_contributors = entries.len() as u32;

        Ok(ShortlogResult {
            entries,
            total_commits,
            total_contributors,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_shortlog_empty_repo() {
        let repo = TestRepo::new();
        let result = shortlog(repo.path_str(), None, None, None, None, None, None).await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        assert_eq!(shortlog_result.total_commits, 0);
        assert_eq!(shortlog_result.total_contributors, 0);
        assert!(shortlog_result.entries.is_empty());
    }

    #[tokio::test]
    async fn test_shortlog_with_commits() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        let result = shortlog(repo.path_str(), None, None, None, None, None, None).await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        assert_eq!(shortlog_result.total_commits, 3);
        assert_eq!(shortlog_result.total_contributors, 1);
        assert_eq!(shortlog_result.entries[0].name, "Test User");
        assert_eq!(shortlog_result.entries[0].count, 3);
    }

    #[tokio::test]
    async fn test_shortlog_summary_mode() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            None,
            Some(true), // summary mode
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        assert_eq!(shortlog_result.total_commits, 2);
        // In summary mode, commits list should be empty
        assert!(shortlog_result.entries[0].commits.is_empty());
    }

    #[tokio::test]
    async fn test_shortlog_with_commit_messages() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            None,
            Some(false), // not summary mode
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // Should have commit messages
        assert_eq!(shortlog_result.entries[0].commits.len(), 2);
        assert!(shortlog_result.entries[0]
            .commits
            .iter()
            .any(|m| m.contains("Initial commit") || m.contains("Second commit")));
    }

    #[tokio::test]
    async fn test_shortlog_numbered() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            Some(true), // numbered
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // Should be sorted by count (only one contributor so trivially true)
        assert_eq!(shortlog_result.entries[0].count, 2);
    }

    #[tokio::test]
    async fn test_shortlog_shows_email() {
        let repo = TestRepo::with_initial_commit();

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            None,
            Some(true),
            Some(true), // show email
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        assert!(shortlog_result.entries[0].email.is_some());
        assert_eq!(
            shortlog_result.entries[0].email.as_ref().unwrap(),
            "test@example.com"
        );
    }

    #[tokio::test]
    async fn test_shortlog_group_by_committer() {
        let repo = TestRepo::with_initial_commit();

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            None,
            Some(true),
            None,
            Some("committer".to_string()),
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // In test repo, author and committer are the same
        assert_eq!(shortlog_result.total_contributors, 1);
    }

    #[tokio::test]
    async fn test_shortlog_with_range() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid().to_string();
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        // Use range from first commit to HEAD (exclusive of first)
        let range = format!("{}..HEAD", first_oid);
        let result = shortlog(
            repo.path_str(),
            Some(range),
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // Should only have 2 commits (Second and Third, not Initial)
        assert_eq!(shortlog_result.total_commits, 2);
    }

    #[tokio::test]
    async fn test_shortlog_with_tag_range() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1.0");
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        // Use range from v1.0 to HEAD
        let result = shortlog(
            repo.path_str(),
            Some("v1.0..HEAD".to_string()),
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // Should only have 2 commits (after v1.0)
        assert_eq!(shortlog_result.total_commits, 2);
    }

    #[tokio::test]
    async fn test_shortlog_all_branches() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        let result = shortlog(
            repo.path_str(),
            None,
            Some(true), // all branches
            None,
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();
        // Should include commits from all branches
        assert!(shortlog_result.total_commits >= 2);
    }

    #[tokio::test]
    async fn test_shortlog_invalid_path() {
        let result = shortlog(
            "/nonexistent/path".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_shortlog_entry_fields() {
        let repo = TestRepo::with_initial_commit();

        let result = shortlog(repo.path_str(), None, None, None, None, None, None).await;
        assert!(result.is_ok());
        let shortlog_result = result.unwrap();

        let entry = &shortlog_result.entries[0];
        assert_eq!(entry.name, "Test User");
        assert!(entry.email.is_some());
        assert_eq!(entry.email.as_ref().unwrap(), "test@example.com");
        assert_eq!(entry.count, 1);
        assert_eq!(entry.commits.len(), 1);
    }

    /// Commit `file`=`content` authored (and committed) by the given identity.
    fn commit_as(repo: &TestRepo, name: &str, email: &str, file: &str, content: &str, msg: &str) {
        repo.create_file(file, content);
        repo.stage_file(file);
        let git = repo.repo();
        let mut index = git.index().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now(name, email).unwrap();
        let parent = git.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.as_ref().into_iter().collect();
        git.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap();
    }

    // Finding 72: default grouping is by author NAME, so Alice's two emails
    // collapse into one entry while Bob and Carol (who share an email) stay
    // distinct.
    #[tokio::test]
    async fn test_shortlog_groups_by_name_not_email() {
        let repo = TestRepo::new();
        commit_as(&repo, "Alice", "a@x", "1.txt", "1", "c1");
        commit_as(&repo, "Alice", "b@x", "2.txt", "2", "c2");
        commit_as(&repo, "Bob", "shared@corp", "3.txt", "3", "c3");
        commit_as(&repo, "Carol", "shared@corp", "4.txt", "4", "c4");

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            Some(true),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.total_contributors, 3,
            "entries: {:?}",
            result.entries
        );
        let alice = result.entries.iter().find(|e| e.name == "Alice").unwrap();
        assert_eq!(alice.count, 2);
        let bob = result.entries.iter().find(|e| e.name == "Bob").unwrap();
        assert_eq!(bob.count, 1);
        let carol = result.entries.iter().find(|e| e.name == "Carol").unwrap();
        assert_eq!(carol.count, 1);
    }

    // Finding 72: with --email the (name, email) pair is the identity, so the
    // two Alice emails and the two shared-email people are all distinct.
    #[tokio::test]
    async fn test_shortlog_email_mode_groups_by_name_and_email() {
        let repo = TestRepo::new();
        commit_as(&repo, "Alice", "a@x", "1.txt", "1", "c1");
        commit_as(&repo, "Alice", "b@x", "2.txt", "2", "c2");
        commit_as(&repo, "Bob", "shared@corp", "3.txt", "3", "c3");
        commit_as(&repo, "Carol", "shared@corp", "4.txt", "4", "c4");

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            Some(true),
            Some(true),
            Some(true), // --email
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.total_contributors, 4,
            "entries: {:?}",
            result.entries
        );
        assert!(result.entries.iter().all(|e| e.count == 1));
    }

    // Finding 72: a .mailmap canonicalizes identities before grouping.
    #[tokio::test]
    async fn test_shortlog_honors_mailmap() {
        let repo = TestRepo::new();
        commit_as(&repo, "Alice", "a@x", "1.txt", "1", "c1");
        commit_as(&repo, "Alice", "b@x", "2.txt", "2", "c2");
        // Map both of Alice's emails to the canonical name "Alicia".
        repo.create_file(".mailmap", "Alicia <a@x>\nAlicia <b@x>\n");

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            Some(true),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        assert!(
            result.entries.iter().all(|e| e.name != "Alice"),
            "Alice should be remapped to Alicia: {:?}",
            result.entries
        );
        let alicia = result
            .entries
            .iter()
            .find(|e| e.name == "Alicia")
            .expect("Alicia entry");
        assert_eq!(alicia.count, 2);
    }

    // Finding 73: three-dot symmetric-difference ranges are valid and must not
    // error. On linear history v1...HEAD == v1..HEAD.
    #[tokio::test]
    async fn test_shortlog_three_dot_range_linear() {
        let repo = TestRepo::with_initial_commit();
        repo.create_tag("v1");
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_commit("Third commit", &[("file2.txt", "content2")]);

        let result = shortlog(
            repo.path_str(),
            Some("v1...HEAD".to_string()),
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;

        assert!(
            result.is_ok(),
            "three-dot range errored: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap().total_commits, 2);
    }

    // Finding 73: on divergent history v1...HEAD is the symmetric difference,
    // excluding the common merge base.
    #[tokio::test]
    async fn test_shortlog_three_dot_range_divergent() {
        let repo = TestRepo::with_initial_commit();
        // feature branch diverges from main after the base commit.
        repo.create_branch("feature");
        repo.create_commit("Main work", &[("m.txt", "m")]);
        repo.checkout_branch("feature");
        repo.create_commit("Feature work", &[("f.txt", "f")]);

        let result = shortlog(
            repo.path_str(),
            Some("main...feature".to_string()),
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;

        assert!(
            result.is_ok(),
            "three-dot range errored: {:?}",
            result.err()
        );
        // Symmetric difference = {Main work, Feature work}, base excluded.
        assert_eq!(result.unwrap().total_commits, 2);
    }

    #[tokio::test]
    async fn test_shortlog_alphabetical_sort() {
        // With a single contributor, we can't test multi-contributor sorting
        // but we can verify the code path runs without error
        let repo = TestRepo::with_initial_commit();

        let result = shortlog(
            repo.path_str(),
            None,
            None,
            Some(false), // alphabetical sort
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
    }
}
