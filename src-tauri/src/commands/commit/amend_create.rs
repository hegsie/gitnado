//! Commit creation, amending, date editing, and rewording commands

use std::path::Path;
use tauri::command;

use super::{parse_iso8601_to_git_time, should_sign_commit, signature_with_date};
use crate::error::{GitnadoError, Result};
use crate::models::Commit;

/// Create a new commit
///
/// If `sign_commit` is Some(true), the commit will be GPG signed.
/// If `sign_commit` is Some(false), the commit will not be signed.
/// If `sign_commit` is None, the repository's default setting (commit.gpgsign) is used.
/// If `allow_empty` is Some(true), the commit is created even with no staged changes.
/// If `author_date` is provided, uses it as the author date (ISO 8601 format).
/// If `committer_date` is provided, uses it as the committer date (ISO 8601 format).
#[command]
pub async fn create_commit(
    path: String,
    message: String,
    amend: Option<bool>,
    sign_commit: Option<bool>,
    allow_empty: Option<bool>,
    author_date: Option<String>,
    committer_date: Option<String>,
) -> Result<Commit> {
    let is_allow_empty = allow_empty.unwrap_or(false);
    let has_custom_dates = author_date.is_some() || committer_date.is_some();

    // git refuses `git commit --amend` mid-operation ("You are in the middle of
    // a merge -- cannot amend."), and nothing here did.
    //
    // With the Amend box ticked during a merge, the git2 path rewrote the
    // PRE-merge HEAD using its pre-merge parents: MERGE_HEAD never became a
    // parent, and cleanup_state() only runs on the non-amend branch. The result
    // was an ordinary commit with the merged branch's changes baked in, the
    // merge silently dropped from the history, and the repository still in
    // MERGING state with the banner stuck on. Checked before the CLI dispatch
    // so signed and allow-empty amends refuse with the same message.
    if amend.unwrap_or(false) {
        let state = git2::Repository::open(Path::new(&path))?.state();
        if let Some(what) = crate::commands::branch::in_progress_operation(state) {
            return Err(GitnadoError::OperationFailed(format!(
                "Cannot amend while a {} is in progress. Finish or abort it first.",
                what
            )));
        }
    }

    // Check if we need to sign via git CLI
    let should_sign = should_sign_commit(&path, sign_commit)?;

    // Use git CLI for signed commits, allow-empty commits, or custom dates with signing
    if should_sign || is_allow_empty {
        return create_commit_with_git_cli(
            &path,
            &message,
            amend.unwrap_or(false),
            should_sign,
            is_allow_empty,
            author_date.as_deref(),
            committer_date.as_deref(),
        )
        .await;
    }

    crate::utils::blocking_git(move || {
        // Use git2 for unsigned commits (faster)
        let mut repo = git2::Repository::open(Path::new(&path))?;

        // A commit created while a merge is in progress must include MERGE_HEAD
        // as a parent, otherwise the merged branch is silently dropped and the
        // repository stays stuck in MERGING state. Collect the merge heads up
        // front (mergehead_foreach needs a unique borrow of the repo).
        //
        // Cherry-pick and revert also leave sequencer state (CHERRY_PICK_HEAD /
        // REVERT_HEAD) that must be cleared after committing, or the app stays
        // stuck showing the operation "in progress". Unlike a merge, though, the
        // resulting commit keeps a SINGLE parent (HEAD only) — the picked/reverted
        // commit is NOT an extra parent.
        let state = repo.state();
        let merging = state == git2::RepositoryState::Merge;
        let needs_cleanup = matches!(
            state,
            git2::RepositoryState::Merge
                | git2::RepositoryState::CherryPick
                | git2::RepositoryState::Revert
        );
        let mut merge_oids: Vec<git2::Oid> = Vec::new();
        if merging {
            repo.mergehead_foreach(|oid| {
                merge_oids.push(*oid);
                true
            })?;
        }
        let repo = repo;

        // Run client-side hooks like canonical git does — the git2 commit path
        // otherwise bypasses them entirely. pre-commit can veto the commit;
        // commit-msg can veto or rewrite the message.
        crate::commands::hooks::run_hook_blocking(&repo, "pre-commit", &[], None)?;
        let message = crate::commands::hooks::run_commit_msg_hook(&repo, &message)?;

        let default_signature = repo.signature()?;

        // Build author and committer signatures, optionally with custom dates
        let author_sig = if has_custom_dates {
            signature_with_date(
                default_signature.name().ok().unwrap_or("Unknown"),
                default_signature.email().ok().unwrap_or(""),
                author_date.as_deref(),
            )?
        } else {
            default_signature.clone()
        };

        let committer_sig = if has_custom_dates {
            signature_with_date(
                default_signature.name().ok().unwrap_or("Unknown"),
                default_signature.email().ok().unwrap_or(""),
                committer_date.as_deref(),
            )?
        } else {
            default_signature
        };

        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;

        // `git commit` refuses a commit that changes nothing unless --allow-empty,
        // and this path never checked. The only guard was the frontend's staged
        // COUNT, which goes stale the moment anything unstages outside the app — a
        // terminal, another tool, watcher lag — so pressing Commit then wrote a
        // no-op commit into history with no warning at all.
        //
        // Not applied mid-merge: concluding a merge whose result happens to match
        // HEAD's tree is a legitimate commit, and git allows that one too.
        if !amend.unwrap_or(false) && merge_oids.is_empty() {
            let head_tree_id = repo
                .head()
                .ok()
                .and_then(|h| h.peel_to_commit().ok())
                .map(|c| c.tree_id());
            let nothing_staged = match head_tree_id {
                Some(head_tree_id) => head_tree_id == tree_oid,
                // Unborn HEAD: there is no parent tree to compare against, so
                // "nothing staged" means the index itself is empty. Comparing
                // against a None head tree could never match, which let the very
                // first commit in a repository be created empty — `git commit`
                // refuses that one too.
                None => repo
                    .find_tree(tree_oid)
                    .map(|t| t.is_empty())
                    .unwrap_or(false),
            };
            if nothing_staged {
                return Err(GitnadoError::OperationFailed(
                    "No staged changes to commit".to_string(),
                ));
            }
        }

        let commit_oid = if amend.unwrap_or(false) {
            let head_commit = repo.head()?.peel_to_commit()?;

            // `git commit --amend` PRESERVES the original author identity and author
            // date; only `--reset-author` changes them. An explicitly supplied
            // author date still applies, on top of the original identity.
            //
            // The signed path (`git commit --amend` via the CLI) and amend_commit
            // both already preserve the author, so rebuilding it from
            // repo.signature() here also made the result depend on whether
            // commit.gpgsign happened to be enabled.
            let amend_author: git2::Signature<'_> = if author_date.is_some() {
                let original = head_commit.author();
                signature_with_date(
                    original.name().ok().unwrap_or("Unknown"),
                    original.email().ok().unwrap_or(""),
                    author_date.as_deref(),
                )?
            } else {
                head_commit.author()
            };

            // Commit::amend, not repo.commit(Some("HEAD"), .., parents).
            //
            // libgit2 validates that the updated ref's current tip IS the new
            // commit's first parent. An amend replaces the tip, so that check can
            // never pass and this path failed outright with "current tip is not the
            // first parent" — meaning amend from the commit panel was broken for
            // every repository without commit.gpgsign enabled. Commit::amend
            // performs the replacement libgit2 expects and carries the original
            // parents over unchanged.
            head_commit.amend(
                Some("HEAD"),
                Some(&amend_author),
                Some(&committer_sig),
                None,
                Some(&message),
                Some(&tree),
            )?
        } else {
            let mut parents: Vec<git2::Commit> = repo
                .head()
                .ok()
                .and_then(|h| h.peel_to_commit().ok())
                .into_iter()
                .collect();

            // Include MERGE_HEAD parents collected above when mid-merge
            for oid in &merge_oids {
                parents.push(repo.find_commit(*oid)?);
            }
            let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

            let commit_oid = repo.commit(
                Some("HEAD"),
                &author_sig,
                &committer_sig,
                &message,
                &tree,
                &parent_refs,
            )?;
            if needs_cleanup {
                repo.cleanup_state()?;
            }
            commit_oid
        };

        // post-commit runs after the commit is created and never blocks it.
        crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

        let commit = repo.find_commit(commit_oid)?;
        Ok(Commit::from_git2(&commit))
    })
    .await
}

/// Create a commit using git CLI (supports GPG signing, allow-empty, and custom dates)
async fn create_commit_with_git_cli(
    path: &str,
    message: &str,
    amend: bool,
    sign: bool,
    allow_empty: bool,
    author_date: Option<&str>,
    committer_date: Option<&str>,
) -> Result<Commit> {
    let mut args = vec!["commit", "-m", message];

    if sign {
        args.push("-S");
    }

    if amend {
        args.push("--amend");
    }

    if allow_empty {
        args.push("--allow-empty");
    }

    let mut cmd = crate::utils::create_command("git");
    cmd.current_dir(path).args(&args);

    // Set date environment variables if provided
    if let Some(ad) = author_date {
        cmd.env("GIT_AUTHOR_DATE", ad);
    }
    if let Some(cd) = committer_date {
        cmd.env("GIT_COMMITTER_DATE", cd);
    }

    let output = cmd
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to run git commit: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Git commit failed: {}",
            stderr
        )));
    }

    // Get the new commit
    let repo = git2::Repository::open(Path::new(path))?;
    let head_commit = repo.head()?.peel_to_commit()?;
    Ok(Commit::from_git2(&head_commit))
}

/// Amend the HEAD commit message without changing any files
///
/// This only updates the commit message; the tree and parents remain the same.
#[command]
pub async fn amend_commit_message(path: String, message: String) -> Result<Commit> {
    crate::utils::blocking_git(move || {
        // libgit2's repo.commit() cannot sign and would strip any existing signature.
        // When commit.gpgsign is enabled, amend via the CLI so the reworded commit is
        // re-signed instead of silently emitted unsigned.
        if should_sign_commit(&path, None)? {
            let output = crate::utils::create_command("git")
                .current_dir(&path)
                .args(["commit", "--amend", "-S", "-m", &message])
                .output()
                .map_err(|e| {
                    GitnadoError::OperationFailed(format!(
                        "Failed to run git commit --amend: {}",
                        e
                    ))
                })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(GitnadoError::OperationFailed(format!(
                    "Git commit --amend failed: {}",
                    stderr.trim()
                )));
            }
            let repo = git2::Repository::open(Path::new(&path))?;
            let head_commit = repo.head()?.peel_to_commit()?;
            return Ok(Commit::from_git2(&head_commit));
        }

        let repo = git2::Repository::open(Path::new(&path))?;

        // git runs pre-commit/commit-msg/post-commit for `git commit --amend` too;
        // the git2 amend path otherwise bypasses them.
        crate::commands::hooks::run_hook_blocking(&repo, "pre-commit", &[], None)?;
        let message = crate::commands::hooks::run_commit_msg_hook(&repo, &message)?;

        let head_commit = repo
            .head()?
            .peel_to_commit()
            .map_err(|_| GitnadoError::CommitNotFound("HEAD".to_string()))?;

        let tree = head_commit.tree()?;
        let signature = repo.signature()?;

        // A reword changes only the message. Passing the fresh signature as AUTHOR
        // as well re-attributed the commit to whoever reworded it and reset the
        // author date to now — which also reorders it in date-sorted history views.
        // git preserves the author across a reword; only the committer changes.
        //
        // Commit::amend, not repo.commit(Some("HEAD"), .., parents): libgit2 checks
        // that the updated ref's tip is the new commit's first parent, which a
        // reword never satisfies, so that call failed with "current tip is not the
        // first parent". Commit::amend performs the replacement and carries the
        // original parents over unchanged.
        let new_oid = head_commit.amend(
            Some("HEAD"),
            Some(&head_commit.author()),
            Some(&signature),
            None,
            Some(&message),
            Some(&tree),
        )?;

        crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);

        let new_commit = repo.find_commit(new_oid)?;
        Ok(Commit::from_git2(&new_commit))
    })
    .await
}

/// Result of an amend operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendResult {
    pub new_oid: String,
    pub old_oid: String,
    pub success: bool,
}

/// Amend the HEAD commit
///
/// This can update the commit message and/or reset the author.
/// If message is None, the original message is preserved.
/// If reset_author is true, the author is updated to the current user.
/// If sign_amend is Some(true), the amended commit will be GPG signed.
/// If sign_amend is Some(false), the amended commit will not be signed.
/// If sign_amend is None, the repository's default setting (commit.gpgsign) is used.
#[command]
pub async fn amend_commit(
    path: String,
    message: Option<String>,
    reset_author: Option<bool>,
    sign_amend: Option<bool>,
) -> Result<AmendResult> {
    // Check if we need to sign via git CLI
    let should_sign = should_sign_commit(&path, sign_amend)?;

    if should_sign {
        return amend_commit_with_git_cli(&path, message.as_deref(), reset_author.unwrap_or(false))
            .await;
    }

    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;

        // git runs pre-commit for `git commit --amend`; the git2 path bypasses it.
        crate::commands::hooks::run_hook_blocking(&repo, "pre-commit", &[], None)?;

        let head_commit = repo
            .head()?
            .peel_to_commit()
            .map_err(|_| GitnadoError::CommitNotFound("HEAD".to_string()))?;

        let old_oid = head_commit.id().to_string();
        let tree = head_commit.tree()?;
        let signature = repo.signature()?;

        // Use the new message or keep the original
        let commit_message =
            message.unwrap_or_else(|| head_commit.message().ok().unwrap_or("").to_string());
        // commit-msg may veto or rewrite the (possibly reused) message.
        let commit_message = crate::commands::hooks::run_commit_msg_hook(&repo, &commit_message)?;

        // Use new author if reset_author is true, otherwise keep original
        let author = if reset_author.unwrap_or(false) {
            signature.clone()
        } else {
            head_commit.author()
        };

        let parent_ids: Vec<git2::Oid> = head_commit.parent_ids().collect();
        let parents: Vec<git2::Commit> = parent_ids
            .iter()
            .filter_map(|id| repo.find_commit(*id).ok())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        // Create commit without updating ref (avoids git2 parent validation error
        // for root commits), then manually update HEAD.
        let new_oid = repo.commit(
            None,
            &author,
            &signature,
            &commit_message,
            &tree,
            &parent_refs,
        )?;

        // Update HEAD to point to the new commit
        let head_ref = repo.head()?;
        if head_ref.is_branch() {
            let branch_name = head_ref
                .name()
                .map_err(|_| GitnadoError::OperationFailed("Invalid HEAD ref".to_string()))?;
            repo.reference(
                branch_name,
                new_oid,
                true,
                &format!("amend: {}", &old_oid[..std::cmp::min(7, old_oid.len())]),
            )?;
        } else {
            repo.set_head_detached(new_oid)?;
        }

        crate::commands::hooks::run_hook_noblock(&repo, "post-commit", &[]);
        // The Hooks dialog advertises post-rewrite for "rebase, amend" and lets
        // the user enable it, but nothing ran it — so the same Amend button fired
        // it or not depending purely on whether GPG signing was on, since the
        // signed path shells out to git and git runs it.
        crate::commands::hooks::run_hook_noblock_with_stdin(
            &repo,
            "post-rewrite",
            &["amend"],
            Some(&format!("{} {}\n", old_oid, new_oid)),
        );

        Ok(AmendResult {
            new_oid: new_oid.to_string(),
            old_oid,
            success: true,
        })
    })
    .await
}

/// Amend a commit using git CLI (supports GPG signing)
async fn amend_commit_with_git_cli(
    path: &str,
    message: Option<&str>,
    reset_author: bool,
) -> Result<AmendResult> {
    // Get the old OID before amending
    let repo = git2::Repository::open(Path::new(path))?;
    let old_oid = repo.head()?.peel_to_commit()?.id().to_string();
    drop(repo);

    let mut args = vec!["commit", "--amend", "-S"];

    if let Some(msg) = message {
        args.push("-m");
        args.push(msg);
    } else {
        args.push("--no-edit");
    }

    if reset_author {
        args.push("--reset-author");
    }

    let output = crate::utils::create_command("git")
        .current_dir(path)
        .args(&args)
        .output()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to run git commit --amend: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Git commit --amend failed: {}",
            stderr
        )));
    }

    // Get the new commit OID
    let repo = git2::Repository::open(Path::new(path))?;
    let new_oid = repo.head()?.peel_to_commit()?.id().to_string();

    Ok(AmendResult {
        new_oid,
        old_oid,
        success: true,
    })
}

/// Edit the author and/or committer date of an existing commit
///
/// For the HEAD commit, this recreates the commit with updated signatures.
/// For non-HEAD commits, this uses interactive rebase with environment variables
/// to set `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`.
///
/// Dates should be in ISO 8601 format (e.g., "2024-01-15T10:30:00Z") or unix timestamps.
///
/// NOTE: no UI path reaches this command today — there is no date-editing
/// dialog, and `gitService.editCommitDate` has no call site outside its own
/// definition. It is not exposed as an AI tool either. It stays registered, and
/// its wrapper stays exported, for callers that invoke it directly — so its
/// tests, including those covering the non-HEAD rebase below, are backend
/// coverage only: passing tests here do not mean any date edit a user can
/// actually trigger is covered, because there is none.
#[command]
pub async fn edit_commit_date(
    path: String,
    oid: String,
    author_date: Option<String>,
    committer_date: Option<String>,
) -> Result<AmendResult> {
    if author_date.is_none() && committer_date.is_none() {
        return Err(GitnadoError::OperationFailed(
            "At least one of author_date or committer_date must be provided".to_string(),
        ));
    }

    // Extract commit info in a closure to ensure git2 objects are dropped before any .await
    struct CommitDateInfo {
        is_head: bool,
        author_name: String,
        author_email: String,
        committer_name: String,
        committer_email: String,
        message: String,
        parent_ids: Vec<git2::Oid>,
    }

    let info: std::result::Result<CommitDateInfo, GitnadoError> = {
        let path = path.clone();
        let oid = oid.clone();
        crate::utils::blocking_git(move || {
            let repo = git2::Repository::open(Path::new(&path))?;

            let target_oid =
                git2::Oid::from_str(&oid).map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;
            let target_commit = repo
                .find_commit(target_oid)
                .map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;

            let head_oid = repo.head()?.peel_to_commit()?.id();
            let is_head = head_oid == target_oid;

            if repo.state() != git2::RepositoryState::Clean {
                return Err(GitnadoError::OperationFailed(
                    "Another operation is in progress".to_string(),
                ));
            }

            // Extract all values from signatures before they are dropped
            let author_name = target_commit
                .author()
                .name()
                .ok()
                .unwrap_or("Unknown")
                .to_string();
            let author_email = target_commit
                .author()
                .email()
                .ok()
                .unwrap_or("")
                .to_string();
            let committer_name = target_commit
                .committer()
                .name()
                .ok()
                .unwrap_or("Unknown")
                .to_string();
            let committer_email = target_commit
                .committer()
                .email()
                .ok()
                .unwrap_or("")
                .to_string();
            let message = target_commit.message().ok().unwrap_or("").to_string();
            let parent_ids = target_commit.parent_ids().collect();

            Ok(CommitDateInfo {
                is_head,
                author_name,
                author_email,
                committer_name,
                committer_email,
                message,
                parent_ids,
            })
        })
        .await
    };

    let info = info?;

    if info.is_head {
        let path = path.clone();
        let oid = oid.clone();
        let author_date = author_date.clone();
        let committer_date = committer_date.clone();
        crate::utils::blocking_git(move || {
            // For HEAD commit, recreate it with updated dates using git2
            let repo = git2::Repository::open(Path::new(&path))?;
            let target_oid = git2::Oid::from_str(&oid)?;
            let target_commit = repo.find_commit(target_oid)?;

            let old_oid = target_oid.to_string();

            // Build author signature with optional new date
            let new_author = if let Some(ref ad) = author_date {
                let time = parse_iso8601_to_git_time(ad)?;
                git2::Signature::new(&info.author_name, &info.author_email, &time)?
            } else {
                target_commit.author()
            };

            // Build committer signature with optional new date
            let new_committer = if let Some(ref cd) = committer_date {
                let time = parse_iso8601_to_git_time(cd)?;
                git2::Signature::new(&info.committer_name, &info.committer_email, &time)?
            } else {
                target_commit.committer()
            };

            let tree = target_commit.tree()?;
            let parents: Vec<git2::Commit> = info
                .parent_ids
                .iter()
                .filter_map(|id| repo.find_commit(*id).ok())
                .collect();
            let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

            // Create commit without updating ref (avoids git2 parent validation error),
            // then manually update HEAD to point to the new commit.
            let new_oid = repo.commit(
                None,
                &new_author,
                &new_committer,
                &info.message,
                &tree,
                &parent_refs,
            )?;

            // Update HEAD to point to the new commit
            let head_ref = repo.head()?;
            if head_ref.is_branch() {
                // HEAD points to a branch - update the branch target
                let branch_name = head_ref
                    .name()
                    .map_err(|_| GitnadoError::OperationFailed("Invalid HEAD ref".to_string()))?;
                repo.reference(
                    branch_name,
                    new_oid,
                    true,
                    &format!("edit_commit_date: updated {}", &old_oid[..7]),
                )?;
            } else {
                // Detached HEAD - update HEAD directly
                repo.set_head_detached(new_oid)?;
            }

            Ok(AmendResult {
                new_oid: new_oid.to_string(),
                old_oid,
                success: true,
            })
        })
        .await
    } else {
        // For non-HEAD commits, use git CLI with rebase and environment variables
        edit_commit_date_with_rebase(
            &path,
            &oid,
            author_date.as_deref(),
            committer_date.as_deref(),
        )
        .await
    }
}

/// Edit a non-HEAD commit's date using interactive rebase with env vars
async fn edit_commit_date_with_rebase(
    path: &str,
    oid: &str,
    author_date: Option<&str>,
    committer_date: Option<&str>,
) -> Result<AmendResult> {
    // Find the parent of the target commit for the rebase base. The tip is read
    // here too, so a rebase that has to be undone below is put back to the
    // commit THIS call started from rather than to ORIG_HEAD, which any earlier
    // operation in the repository may have left pointing somewhere else.
    let (parent_oid_str, pre_rebase_head) = {
        let repo = git2::Repository::open(Path::new(path))?;
        let target_oid =
            git2::Oid::from_str(oid).map_err(|_| GitnadoError::CommitNotFound(oid.to_string()))?;
        let target_commit = repo
            .find_commit(target_oid)
            .map_err(|_| GitnadoError::CommitNotFound(oid.to_string()))?;

        let parent = target_commit.parent(0).map_err(|_| {
            GitnadoError::OperationFailed("Cannot edit date of root commit".to_string())
        })?;
        let head = repo.head()?.peel_to_commit()?.id().to_string();
        (parent.id().to_string(), head)
    };

    let short_oid = &oid[..std::cmp::min(7, oid.len())];

    // Git evaluates GIT_SEQUENCE_EDITOR through a shell — the POSIX one Git for
    // Windows bundles, not cmd.exe — and appends the todo path, so hand it the
    // command directly. The per-platform script this replaces was written into
    // the git dir under a FIXED name, so two date edits in one repo clobbered
    // each other's editor mid-run, and the `?` returns between writing it and
    // the cleanup left it behind in the user's repository.
    let sequence_editor = crate::utils::todo_action_editor_command(short_oid, "edit");

    // Start the rebase. `rebase.autostash` is pinned OFF — not for the todo's
    // shape, but because the recovery path below hard-resets the branch. With
    // autostash on, a dirty tree does not stop the rebase: git stashes it,
    // replays the range, exits 0 with a Clean state (so the recovery path is
    // taken), and pops the stash back into the working tree an instant before
    // the `reset --hard` wipes it — uncommitted tracked work destroyed, and
    // reported as "Nothing was changed", recoverable only through
    // `git fsck --lost-found`. `rebase.autoStash` is a setting the app itself
    // offers in its Settings tab, so this is a configuration users have. Off,
    // rebase refuses a dirty tree up front, nothing has been rewritten when the
    // failure is reported, and the reset below can only ever run on a tree with
    // nothing to lose.
    let output = crate::utils::create_command("git")
        .current_dir(path)
        .env("GIT_SEQUENCE_EDITOR", &sequence_editor)
        .args(crate::utils::TODO_FORMAT_ARGS)
        .args(["-c", "rebase.autostash=false"])
        .args(["rebase", "-i", &parent_oid_str])
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to start rebase: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A non-zero exit is not always "the rebase never started". A merge
        // target is linearized rather than listed, so git replays the merged-in
        // side onto the first parent — and that replay can CONFLICT, stopping
        // the rebase on a detached HEAD with a conflicted index: exactly the
        // state the restore below exists to prevent, reached through the one
        // exit that never ran it. Undo it, the way the amend failure does.
        // Guarding on the state leaves the common "rebase refused to start on a
        // dirty tree" case, which has nothing to abort, untouched; the caller
        // has already refused to get this far unless the repository was Clean,
        // so a rebase in progress here can only be the one started above.
        let rebase_in_progress = git2::Repository::open(Path::new(path))
            .map(|r| r.state() != git2::RepositoryState::Clean)
            .unwrap_or(false);
        if rebase_in_progress {
            let _ = crate::utils::create_command("git")
                .current_dir(path)
                .args(["rebase", "--abort"])
                .output();
        }
        return Err(GitnadoError::OperationFailed(format!(
            "Rebase failed: {}",
            stderr
        )));
    }

    // Exit 0 does NOT mean the todo rewrite took. Whenever the sequence editor
    // finds no `pick <oid>` line to turn into `edit` — the target is a MERGE
    // commit, which `rebase -i` linearizes away rather than listing, or a
    // config this does not pin reshapes the line — git replays the range to
    // completion and leaves the DESCENDANT at HEAD. The amend below would then
    // redate that descendant and report success for a commit the user never
    // named. A paused rebase is the only state in which it is the right commit.
    let rebase_is_paused = {
        let repo = git2::Repository::open(Path::new(path))?;
        repo.state() != git2::RepositoryState::Clean
    };
    if !rebase_is_paused {
        // Refusing here is not enough on its own: the replay has ALREADY run.
        // For a merge target git linearizes the range — the merge commit is
        // gone from the branch and the merged-in side is replayed onto the
        // first parent — so an error on its own would leave the user with a
        // rewritten branch and only the reflog to get it back. Put the branch
        // where it was before reporting the failure, so a date edit that did
        // not happen changes nothing. The working tree is necessarily clean
        // because rebase refuses to start otherwise — which is only true
        // because the invocation above pins `rebase.autostash=false`.
        let restored = crate::utils::create_command("git")
            .current_dir(path)
            .args(["reset", "--hard", &pre_rebase_head])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        return Err(GitnadoError::OperationFailed(if restored {
            "Rebase did not stop at the target commit — is it a merge commit? Nothing was changed."
                .to_string()
        } else {
            "Rebase did not stop at the target commit, and the branch could not be put back — \
             recover the previous tip from the reflog"
                .to_string()
        }));
    }

    // Now amend the commit with the new date(s)
    let mut amend_cmd = crate::utils::create_command("git");
    amend_cmd
        .current_dir(path)
        .args(["commit", "--amend", "--no-edit", "--allow-empty"]);

    if let Some(ad) = author_date {
        amend_cmd.env("GIT_AUTHOR_DATE", ad);
    }
    if let Some(cd) = committer_date {
        amend_cmd.env("GIT_COMMITTER_DATE", cd);
    }

    let amend_output = amend_cmd.output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to amend commit date: {}", e))
    })?;

    if !amend_output.status.success() {
        let stderr = String::from_utf8_lossy(&amend_output.stderr);
        // Abort the rebase on failure
        let _ = crate::utils::create_command("git")
            .current_dir(path)
            .args(["rebase", "--abort"])
            .output();
        return Err(GitnadoError::OperationFailed(format!(
            "Failed to amend commit date: {}",
            stderr
        )));
    }

    // The amend at the `edit` stop produced the FINAL commit for that todo
    // entry — `rebase --continue` only replays the descendants on top of it —
    // so read it here. Reading HEAD after the continue instead named the last
    // replayed descendant, so the (old_oid -> new_oid) pair AmendResult
    // promises pointed at a commit that was never the one edited, and
    // disagreed with reword_commit's answer for the same situation.
    let redated_oid = {
        let repo = git2::Repository::open(Path::new(path))?;
        let head_oid = repo.head()?.peel_to_commit()?.id();
        head_oid.to_string()
    };

    // Continue the rebase
    let continue_output = crate::utils::create_command("git")
        .current_dir(path)
        .args(["rebase", "--continue"])
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to continue rebase: {}", e)))?;

    if !continue_output.status.success() {
        let stderr = String::from_utf8_lossy(&continue_output.stderr);
        if stderr.contains("CONFLICT") || stderr.contains("conflict") {
            return Err(GitnadoError::RebaseConflict);
        }
        // Sometimes rebase --continue fails because there's nothing to continue
        // (single commit case) - check if we're in a clean state
        let repo = git2::Repository::open(Path::new(path))?;
        if repo.state() != git2::RepositoryState::Clean {
            let _ = crate::utils::create_command("git")
                .current_dir(path)
                .args(["rebase", "--abort"])
                .output();
            return Err(GitnadoError::OperationFailed(format!(
                "Rebase continue failed: {}",
                stderr
            )));
        }
    }

    Ok(AmendResult {
        new_oid: redated_oid,
        old_oid: oid.to_string(),
        success: true,
    })
}

/// Reword a commit that is not HEAD by performing an interactive rebase
///
/// This uses git CLI under the hood as git2 doesn't support interactive rebase well.
///
/// NOTE: no UI path reaches this command today — `handleRewordCommit` in
/// `app-shell.ts` sends a non-HEAD reword through `gn-interactive-rebase-dialog`
/// and `execute_interactive_rebase` instead. It stays registered, and its
/// `gitService.rewordCommit` wrapper stays exported, for callers that invoke it
/// directly — so its tests are backend coverage only: passing tests here do not
/// mean the reword a user can actually trigger is covered.
#[command]
pub async fn reword_commit(path: String, oid: String, message: String) -> Result<AmendResult> {
    // Run the inspection on the blocking pool, and inside one closure: git2
    // types are not Send, so no handle may cross the await that follows.
    let result: std::result::Result<(bool, Option<git2::Oid>), GitnadoError> = {
        let path = path.clone();
        let oid = oid.clone();
        crate::utils::blocking_git(move || {
            let repo = git2::Repository::open(Path::new(&path))?;

            // Verify the commit exists
            let target_oid =
                git2::Oid::from_str(&oid).map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;
            let target_commit = repo
                .find_commit(target_oid)
                .map_err(|_| GitnadoError::CommitNotFound(oid.clone()))?;

            // Check if this is the HEAD commit - if so, use amend instead
            let head_oid = repo.head()?.peel_to_commit()?.id();
            let is_head = head_oid == target_oid;

            // Check for existing operations in progress
            if repo.state() != git2::RepositoryState::Clean {
                return Err(GitnadoError::OperationFailed(
                    "Another operation is in progress".to_string(),
                ));
            }

            // For non-HEAD commits, we need to use git rebase
            // Find the parent of the target commit to use as the base
            let parent_oid = if !is_head {
                // A merge commit never survives that rebase. `rebase -i <merge>^1`
                // linearizes the range instead of listing the merge, so there is no
                // `pick <oid>` for the sequence editor to turn into `reword`: git
                // replays the side branch onto the first parent, exits 0, and the
                // message is never touched. The loop below would then find no
                // commit carrying the new message, keep its HEAD seed, and report
                // success — for a reword that did not happen on a branch whose
                // merge commit had just been destroyed. Refuse before anything is
                // rewritten, matching the frontend's own refusal in
                // `isMergeCommit`. (The `is_head` path amends in place and keeps
                // every parent, so it stays allowed.)
                if target_commit.parent_count() > 1 {
                    return Err(GitnadoError::OperationFailed(
                        "Cannot reword a merge commit".to_string(),
                    ));
                }
                Some(
                    target_commit
                        .parent(0)
                        .map_err(|_| {
                            GitnadoError::OperationFailed("Cannot reword root commit".to_string())
                        })?
                        .id(),
                )
            } else {
                None
            };

            Ok((is_head, parent_oid))
        })
        .await
    };

    let (is_head, parent_oid) = result?;

    // Now we can safely await since all git2 objects are dropped
    if is_head {
        return amend_commit(path, Some(message), None, None).await;
    }

    let parent_oid = parent_oid.expect("parent_oid should be set for non-HEAD commits");

    crate::utils::blocking_git(move || {
        // Write the new message to a temporary file
        let git_dir = git2::Repository::open(Path::new(&path))?
            .path()
            .to_path_buf();
        let msg_file = git_dir.join("REWORD_MSG");
        std::fs::write(&msg_file, &message)?;

        // Git evaluates both editor variables through a shell — the POSIX one Git
        // for Windows bundles, not cmd.exe — and appends the file it wants edited,
        // so hand it the commands directly. The per-platform scripts these replace
        // interpolated the message path into a DOUBLE-quoted `cp`, so a repository
        // whose path contained `$` or a quote made the shell rewrite the path and
        // the reword died on a message file that was never there.
        let sequence_editor = crate::utils::todo_action_editor_command(&oid[..7], "reword");
        let commit_editor = crate::utils::copy_file_editor_command(&msg_file);

        // Run the rebase
        let output = crate::utils::create_command("git")
            .current_dir(&path)
            .env("GIT_SEQUENCE_EDITOR", &sequence_editor)
            .env("GIT_EDITOR", &commit_editor)
            .args(crate::utils::TODO_FORMAT_ARGS)
            .args(["rebase", "-i", &parent_oid.to_string()])
            .output()
            .map_err(|e| GitnadoError::OperationFailed(e.to_string()))?;

        // Clean up temporary files
        let _ = std::fs::remove_file(&msg_file);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("CONFLICT") || stderr.contains("conflict") {
                return Err(GitnadoError::RebaseConflict);
            }
            return Err(GitnadoError::OperationFailed(format!(
                "Rebase failed: {}",
                stderr
            )));
        }

        // Reopen the repository to get the new state after rebase
        let repo = git2::Repository::open(Path::new(&path))?;

        // Get the new HEAD to find the reworded commit's new OID
        let new_head = repo.head()?.peel_to_commit()?;

        // Walk back to find the commit that replaced our target
        // The new commit will be at approximately the same position in history
        let mut revwalk = repo.revwalk()?;
        revwalk.push(new_head.id())?;
        revwalk.set_sorting(git2::Sort::TOPOLOGICAL)?;

        let mut new_commit_oid = new_head.id().to_string();
        for rev_oid in revwalk.flatten() {
            let commit = repo.find_commit(rev_oid)?;
            // The reworded commit will have our new message. Compared with the
            // trailing whitespace off both sides: git normalizes a commit message
            // to end in a newline, so an exact comparison against the argument
            // never matched and `new_commit_oid` kept its seed — leaving the caller
            // with the DESCENDANT's oid for the commit it had just reworded.
            if commit.message().ok().unwrap_or("").trim_end() == message.trim_end() {
                new_commit_oid = rev_oid.to_string();
                break;
            }
        }

        Ok(AmendResult {
            new_oid: new_commit_oid,
            old_oid: oid,
            success: true,
        })
    })
    .await
}
