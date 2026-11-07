//! Refs command handlers
//! Provides commit-to-refs mapping for graph visualization

use std::collections::HashMap;
use std::path::Path;
use tauri::command;

use crate::error::Result;

/// A reference (branch or tag) pointing to a commit
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub name: String,
    pub shorthand: String,
    pub ref_type: RefType,
    pub is_head: bool,
    /// For tags: whether the tag is annotated (has message/tagger)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_annotated: Option<bool>,
    /// For tags: the tag message (if annotated)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefType {
    LocalBranch,
    RemoteBranch,
    Tag,
    /// A detached HEAD. Not a branch — it must not offer branch operations —
    /// but it is a ref the graph has to know about.
    DetachedHead,
}

/// Get all refs mapped by their target commit OID
/// Returns a map of commit OID -> list of refs pointing to it
#[command]
pub async fn get_refs_by_commit(path: String) -> Result<HashMap<String, Vec<RefInfo>>> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let mut refs_map: HashMap<String, Vec<RefInfo>> = HashMap::new();

        let head = repo.head().ok();
        let head_name = head
            .as_ref()
            .and_then(|h| h.name().ok().map(|s| s.to_string()));

        // Get all references
        for reference in repo.references()? {
            let reference = match reference {
                Ok(r) => r,
                Err(_) => continue,
            };

            let name = match reference.name() {
                Ok(n) => n.to_string(),
                Err(_) => continue,
            };

            // Skip HEAD and other special refs
            if name == "HEAD" || name.starts_with("refs/stash") {
                continue;
            }

            // Get the target commit OID and tag metadata
            let (target_oid, is_annotated, tag_message) = if reference.is_tag() {
                // Try to peel to tag object first (for annotated tags)
                let tag_obj = reference.peel_to_tag().ok();
                let is_annotated = tag_obj.is_some();
                let tag_message = tag_obj
                    .as_ref()
                    .and_then(|t| t.message().ok().flatten().map(|m| m.to_string()));

                // For annotated tags, peel to the commit
                let oid = reference.peel_to_commit().ok().map(|c| c.id().to_string());
                (oid, Some(is_annotated), tag_message)
            } else {
                (reference.target().map(|oid| oid.to_string()), None, None)
            };

            let target_oid = match target_oid {
                Some(oid) => oid,
                None => continue,
            };

            // Determine ref type and create shorthand
            let (ref_type, shorthand) = if name.starts_with("refs/heads/") {
                (
                    RefType::LocalBranch,
                    name.strip_prefix("refs/heads/")
                        .unwrap_or(&name)
                        .to_string(),
                )
            } else if name.starts_with("refs/remotes/") {
                (
                    RefType::RemoteBranch,
                    name.strip_prefix("refs/remotes/")
                        .unwrap_or(&name)
                        .to_string(),
                )
            } else if name.starts_with("refs/tags/") {
                (
                    RefType::Tag,
                    name.strip_prefix("refs/tags/").unwrap_or(&name).to_string(),
                )
            } else {
                continue; // Skip other ref types
            };

            let is_head = head_name.as_ref().map(|h| h == &name).unwrap_or(false);

            let ref_info = RefInfo {
                name,
                shorthand,
                ref_type,
                is_head,
                is_annotated,
                tag_message,
            };

            refs_map.entry(target_oid).or_default().push(ref_info);
        }

        if let Some(head_ref) = head.as_ref() {
            if repo.head_detached()? {
                if let Some(oid) = head_ref.target() {
                    refs_map.entry(oid.to_string()).or_default().push(RefInfo {
                        name: "HEAD".to_string(),
                        shorthand: "HEAD (detached)".to_string(),
                        ref_type: RefType::DetachedHead,
                        is_head: true,
                        is_annotated: None,
                        tag_message: None,
                    });
                }
            }
        }

        Ok(refs_map)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// A detached HEAD must still be reported, or the graph loses HEAD entirely.
    ///
    /// The literal "HEAD" ref is skipped in the loop, and when HEAD is detached
    /// no branch ref carries is_head — so the map had nothing marked HEAD at
    /// all. The graph's getHeadOid() returned undefined, which silently dropped
    /// the lane-0 mainline pinning, left no HEAD marker on a checkout the app
    /// itself offers, and made "Jump to HEAD" a no-op.
    #[tokio::test]
    async fn test_get_refs_by_commit_reports_a_detached_head() {
        let repo = TestRepo::with_initial_commit();
        let target = repo.create_commit("Second", &[("a.txt", "a")]);

        // Detach HEAD onto that commit, the way the graph's checkout-commit
        // action does.
        {
            let git_repo = repo.repo();
            git_repo.set_head_detached(target).unwrap();
        }

        let refs_map = get_refs_by_commit(repo.path_str()).await.unwrap();

        let head_refs: Vec<_> = refs_map
            .get(&target.to_string())
            .expect("the detached HEAD commit must appear in the map")
            .iter()
            .filter(|r| r.is_head)
            .collect();

        assert_eq!(head_refs.len(), 1, "exactly one ref marks HEAD");
        assert!(
            matches!(head_refs[0].ref_type, RefType::DetachedHead),
            "a detached HEAD is not a branch and must not offer branch operations"
        );
        assert!(head_refs[0].shorthand.contains("detached"));
    }

    /// On a normal branch checkout the branch itself is HEAD — no synthetic ref.
    #[tokio::test]
    async fn test_get_refs_by_commit_marks_the_checked_out_branch_as_head() {
        let repo = TestRepo::with_initial_commit();
        let tip = repo.create_commit("Second", &[("a.txt", "a")]);

        let refs_map = get_refs_by_commit(repo.path_str()).await.unwrap();
        let head_refs: Vec<_> = refs_map
            .get(&tip.to_string())
            .expect("the tip must appear in the map")
            .iter()
            .filter(|r| r.is_head)
            .collect();

        assert_eq!(head_refs.len(), 1, "exactly one ref marks HEAD");
        assert!(
            matches!(head_refs[0].ref_type, RefType::LocalBranch),
            "an attached HEAD is the branch itself, not a synthetic ref"
        );
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_empty_repo() {
        let repo = TestRepo::new();
        // Empty repo without commits has no refs
        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();
        assert!(refs_map.is_empty());
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_with_initial_commit() {
        let repo = TestRepo::with_initial_commit();
        let head_oid = repo.head_oid().to_string();

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // Should have refs for the HEAD commit (main/master branch)
        assert!(refs_map.contains_key(&head_oid));
        let refs = refs_map.get(&head_oid).unwrap();
        assert!(!refs.is_empty());

        // The main branch should be marked as HEAD
        let head_ref = refs.iter().find(|r| r.is_head);
        assert!(head_ref.is_some());
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_with_branches() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid().to_string();

        // Create a new branch at the same commit
        repo.create_branch("feature");

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // Both branches should point to the same commit
        let refs = refs_map.get(&first_oid).unwrap();
        assert!(refs.len() >= 2);

        // Check that feature branch exists
        let feature_ref = refs.iter().find(|r| r.shorthand == "feature");
        assert!(feature_ref.is_some());
        let feature_ref = feature_ref.unwrap();
        assert!(matches!(feature_ref.ref_type, RefType::LocalBranch));
        assert!(!feature_ref.is_head);
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_with_tag() {
        let repo = TestRepo::with_initial_commit();
        let head_oid = repo.head_oid().to_string();

        // Create a tag
        repo.create_tag("v1.0.0");

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // The tag should point to the HEAD commit
        let refs = refs_map.get(&head_oid).unwrap();
        let tag_ref = refs.iter().find(|r| r.shorthand == "v1.0.0");
        assert!(tag_ref.is_some());
        let tag_ref = tag_ref.unwrap();
        assert!(matches!(tag_ref.ref_type, RefType::Tag));
        assert_eq!(tag_ref.name, "refs/tags/v1.0.0");
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_with_lightweight_tag() {
        let repo = TestRepo::with_initial_commit();
        let head_oid = repo.head_oid().to_string();

        // Create a lightweight tag
        repo.create_lightweight_tag("v1.0.0-light");

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // The lightweight tag should point to the HEAD commit
        let refs = refs_map.get(&head_oid).unwrap();
        let tag_ref = refs.iter().find(|r| r.shorthand == "v1.0.0-light");
        assert!(tag_ref.is_some());
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_multiple_commits() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid().to_string();

        // Create a second commit
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        let second_oid = repo.head_oid().to_string();

        // Create a branch at first commit
        let git_repo = repo.repo();
        let first_commit = git_repo
            .find_commit(git2::Oid::from_str(&first_oid).unwrap())
            .unwrap();
        git_repo.branch("old-branch", &first_commit, false).unwrap();

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // Should have refs for both commits
        assert!(refs_map.contains_key(&first_oid));
        assert!(refs_map.contains_key(&second_oid));

        // First commit should have old-branch
        let first_refs = refs_map.get(&first_oid).unwrap();
        assert!(first_refs.iter().any(|r| r.shorthand == "old-branch"));

        // Second commit should have the current branch (HEAD)
        let second_refs = refs_map.get(&second_oid).unwrap();
        assert!(second_refs.iter().any(|r| r.is_head));
    }

    #[tokio::test]
    async fn test_get_refs_by_commit_invalid_path() {
        let result = get_refs_by_commit("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_ref_info_fields() {
        let repo = TestRepo::with_initial_commit();
        let head_oid = repo.head_oid().to_string();

        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        let refs = refs_map.get(&head_oid).unwrap();
        let head_ref = refs.iter().find(|r| r.is_head).unwrap();

        // Verify ref info has proper fields
        assert!(head_ref.name.starts_with("refs/heads/"));
        assert!(!head_ref.shorthand.is_empty());
        assert!(matches!(head_ref.ref_type, RefType::LocalBranch));
    }

    #[tokio::test]
    async fn test_get_refs_excludes_stash() {
        let repo = TestRepo::with_initial_commit();

        // We can't easily create a stash in tests, but we verify the function
        // handles repos correctly even without stashes
        let result = get_refs_by_commit(repo.path_str()).await;
        assert!(result.is_ok());
        let refs_map = result.unwrap();

        // Verify no stash refs are included
        for refs in refs_map.values() {
            for r in refs {
                assert!(!r.name.starts_with("refs/stash"));
            }
        }
    }
}
