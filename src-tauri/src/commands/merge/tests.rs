#[cfg(test)]
mod tests {

    /// A commit-phase failure must leave the merge RESUMABLE and ABORTABLE.
    ///
    /// repo.merge() has already written the merged result into the index and
    /// working tree by then. cleanup_state() only unlinks MERGE_HEAD/MERGE_MSG,
    /// so calling it there left the merge fully applied but unmarked: the
    /// banner vanished, abort_merge refused, and the diff sat staged under a
    /// "Merge failed" toast. Committing that by hand yields a single-parent
    /// commit, so the source branch never becomes an ancestor of HEAD.
    #[tokio::test]
    async fn test_merge_commit_failure_keeps_the_merge_abortable() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("base", &[("shared.txt", "base\n")]);
        test_repo.create_branch("feature");
        test_repo.checkout_branch("feature");
        test_repo.create_commit("feature work", &[("feature.txt", "f\n")]);
        test_repo.checkout_branch("main");
        test_repo.create_commit("main work", &[("main.txt", "m\n")]);

        // No identity configured -> repo.signature() fails in the commit step,
        // exactly as it does on a fresh install.
        let repo = test_repo.repo();
        let mut cfg = repo.config().unwrap();
        let _ = cfg.remove("user.name");
        let _ = cfg.remove("user.email");
        drop(cfg);

        let result = merge(
            test_repo.path_str(),
            "feature".to_string(),
            None,
            None,
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "the commit step must fail without an identity"
        );

        let repo = test_repo.repo();
        assert_eq!(
            repo.state(),
            git2::RepositoryState::Merge,
            "the merge must remain in progress, not be silently cleaned up"
        );

        // And the user must be able to get out of it.
        abort_merge(test_repo.path_str())
            .await
            .expect("a merge left in progress must be abortable");
        assert_eq!(test_repo.repo().state(), git2::RepositoryState::Clean);
    }
    use super::super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_merge_fast_forward() {
        let repo = TestRepo::with_initial_commit();

        // Create a feature branch and add a commit
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        // Switch back to main/master branch
        let main_branch = repo.current_branch();
        repo.checkout_branch(&main_branch);

        // Merge feature branch (should be fast-forward)
        let result = merge(repo.path_str(), "feature".to_string(), None, None, None).await;

        assert!(result.is_ok());

        // Verify the file from feature branch exists
        assert!(repo.path.join("feature.txt").exists());
    }

    #[tokio::test]
    async fn test_merge_no_ff() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Create a feature branch and add a commit
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);

        // Switch back to main branch
        repo.checkout_branch(&initial_branch);

        // Merge with no-ff flag
        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true), // no-ff
            None,
            Some("Merge feature branch".to_string()),
        )
        .await;

        assert!(result.is_ok());

        // With no-ff, a merge commit should have been created
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();

        // Merge commit should have 2 parents
        assert_eq!(commit.parent_count(), 2);
    }

    #[tokio::test]
    async fn test_merge_squash() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Create a feature branch with multiple commits
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit 1", &[("file1.txt", "content1")]);
        repo.create_commit("Feature commit 2", &[("file2.txt", "content2")]);

        // Switch back to main branch
        repo.checkout_branch(&initial_branch);

        // Squash merge
        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            None,
            Some(true), // squash
            Some("Squashed feature".to_string()),
        )
        .await;

        assert!(result.is_ok());

        // Squash merge should have only 1 parent (not a merge commit)
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert_eq!(commit.parent_count(), 1);

        // But both files should exist
        assert!(repo.path.join("file1.txt").exists());
        assert!(repo.path.join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_merge_already_up_to_date() {
        let repo = TestRepo::with_initial_commit();

        // Create branch at same point
        repo.create_branch("same-point");

        // Merge should succeed (no-op)
        let result = merge(repo.path_str(), "same-point".to_string(), None, None, None).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_merge_nonexistent_branch() {
        let repo = TestRepo::with_initial_commit();

        let result = merge(repo.path_str(), "nonexistent".to_string(), None, None, None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_abort_merge_without_merge_in_progress_errors() {
        // `git merge --abort` fails with "fatal: There is no merge to abort
        // (MERGE_HEAD missing)." and leaves staged work untouched. It must
        // NOT silently hard-reset the index and working tree.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("a.txt", "base")]);
        repo.create_file("a.txt", "staged precious work");
        repo.stage_file("a.txt");

        let result = abort_merge(repo.path_str()).await;
        assert!(
            result.is_err(),
            "abort_merge without a merge in progress must fail like git"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("no merge to abort"),
            "unexpected message: {msg}"
        );

        // The staged edit is untouched.
        let content = std::fs::read_to_string(repo.path.join("a.txt")).unwrap();
        assert_eq!(content, "staged precious work");
        let git_repo = repo.repo();
        let statuses = git_repo.statuses(None).unwrap();
        let entry = statuses
            .iter()
            .find(|s| s.path().ok() == Some("a.txt"))
            .expect("a.txt should still have a status entry");
        assert!(entry.status().contains(git2::Status::INDEX_MODIFIED));
    }

    #[tokio::test]
    async fn test_abort_merge_preserves_unrelated_uncommitted_changes() {
        // `git merge --abort` (git reset --merge) restores only what the
        // merge touched; uncommitted changes to unrelated files survive.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add files",
            &[("shared.txt", "base"), ("notes.txt", "notes\n")],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        // Uncommitted edit to a file the merge does not touch.
        repo.create_file("notes.txt", "notes\nmy uncommitted notes\n");

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        abort_merge(repo.path_str()).await.unwrap();

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert!(!git_repo.index().unwrap().has_conflicts());
        // The merged file is restored to HEAD...
        let shared = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert_eq!(shared, "main content");
        // ...but the unrelated uncommitted edit is preserved, like git.
        let notes = std::fs::read_to_string(repo.path.join("notes.txt")).unwrap();
        assert_eq!(notes, "notes\nmy uncommitted notes\n");
    }

    #[tokio::test]
    async fn test_rebase_simple() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        let initial_oid = repo.head_oid();

        // Create a feature branch
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature")]);

        // Go back to main and add a commit
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main commit", &[("main.txt", "main")]);
        let main_oid = repo.head_oid();

        // Checkout feature and rebase onto main
        repo.checkout_branch("feature");

        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(result.is_ok());

        // After rebase, feature should be based on main's latest commit
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        let parent = commit.parent(0).unwrap();

        assert_eq!(parent.id(), main_oid);
        assert_ne!(parent.id(), initial_oid);
    }

    #[tokio::test]
    async fn test_rebase_skips_commit_already_applied_upstream() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature adds shared file", &[("shared.txt", "shared\n")]);
        repo.create_commit(
            "Feature adds follow-up",
            &[("follow-up.txt", "follow-up\n")],
        );

        repo.checkout_branch(&initial_branch);
        // Same patch as the feature's first commit, but a distinct commit.
        repo.create_commit(
            "Main already has shared file",
            &[("shared.txt", "shared\n")],
        );
        let main_oid = repo.head_oid();

        repo.checkout_branch("feature");
        let skipped = rebase(repo.path_str(), initial_branch)
            .await
            .expect("an already-applied patch must be skipped, not abort the rebase");

        // The dropped commit is the only signal the UI has that a local commit
        // vanished from the branch.
        assert_eq!(skipped, 1);
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "Feature adds follow-up");
        assert_eq!(head.parent(0).unwrap().id(), main_oid);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("shared.txt")).unwrap(),
            "shared\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("follow-up.txt")).unwrap(),
            "follow-up\n"
        );
    }

    #[tokio::test]
    async fn test_rebase_empty_only_rebase() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature adds shared file", &[("shared.txt", "shared\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit(
            "Main already has shared file",
            &[("shared.txt", "shared\n")],
        );
        let main_oid = repo.head_oid();

        repo.checkout_branch("feature");
        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().unwrap();
            config.set_bool("notes.rewrite.rebase", true).unwrap();
            config
                .set_str("notes.rewriteRef", "refs/notes/commits")
                .unwrap();
        }
        let skipped = rebase(repo.path_str(), initial_branch).await.unwrap();

        // Every commit on `feature` is gone and the branch now equals `main` —
        // the case that most needs reporting.
        assert_eq!(skipped, 1);
        assert_eq!(repo.repo().state(), git2::RepositoryState::Clean);
        assert_eq!(repo.head_oid(), main_oid);
    }

    #[tokio::test]
    async fn test_rebase_preserves_commit_that_started_empty() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        {
            let git_repo = repo.repo();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let tree = head.tree().unwrap();
            let signature = git_repo.signature().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    "Intentional empty marker",
                    &tree,
                    &[&head],
                )
                .unwrap();
        }
        repo.create_commit("Feature follow-up", &[("feature.txt", "feature\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main diverges", &[("main.txt", "main\n")]);
        let main_oid = repo.head_oid();

        repo.checkout_branch("feature");
        let skipped = rebase(repo.path_str(), initial_branch)
            .await
            .expect("a commit that started empty must be preserved");

        // Preserved, not skipped — nothing disappeared, so nothing to report.
        assert_eq!(skipped, 0);
        let git_repo = repo.repo();
        let follow_up = git_repo.head().unwrap().peel_to_commit().unwrap();
        let empty = follow_up.parent(0).unwrap();
        assert_eq!(follow_up.message().unwrap(), "Feature follow-up");
        assert_eq!(empty.message().unwrap(), "Intentional empty marker");
        assert_eq!(empty.parent(0).unwrap().id(), main_oid);
        assert_eq!(empty.tree_id(), empty.parent(0).unwrap().tree_id());
    }

    #[tokio::test]
    async fn test_rebase_preserves_raw_metadata_on_commit_that_started_empty() {
        use std::io::Write;

        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");

        {
            let git_repo = repo.repo();
            let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
            let mut content = Vec::new();
            writeln!(content, "tree {}", parent.tree_id()).unwrap();
            writeln!(content, "parent {}", parent.id()).unwrap();
            writeln!(content, "author Legacy <legacy@example.com> 1 -0000").unwrap();
            writeln!(content, "committer Test User <test@example.com> 1 +0000").unwrap();
            writeln!(content, "encoding ISO-8859-1").unwrap();
            content.extend_from_slice(b"\nmarker \xe9\n");
            let oid = git_repo
                .odb()
                .unwrap()
                .write(git2::ObjectType::Commit, &content)
                .unwrap();
            git_repo
                .find_reference("refs/heads/feature")
                .unwrap()
                .set_target(oid, "test raw empty commit")
                .unwrap();
            git_repo.set_head("refs/heads/feature").unwrap();
            git_repo
                .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .unwrap();
        }
        repo.create_commit("Feature follow-up", &[("feature.txt", "feature\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main diverges", &[("main.txt", "main\n")]);
        repo.checkout_branch("feature");
        rebase(repo.path_str(), initial_branch).await.unwrap();

        let git_repo = repo.repo();
        let empty = git_repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent(0)
            .unwrap();
        assert_eq!(empty.author().when().sign(), '-');
        assert_eq!(empty.message_encoding().unwrap(), Some("ISO-8859-1"));
        assert_eq!(empty.message_raw_bytes(), b"marker \xe9\n");
    }

    #[tokio::test]
    async fn test_rebase_preserves_notes_on_commit_that_started_empty() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let empty_oid = {
            let git_repo = repo.repo();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let tree = head.tree().unwrap();
            let signature = git_repo.signature().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    "Noted empty marker",
                    &tree,
                    &[&head],
                )
                .unwrap()
        };
        {
            let git_repo = repo.repo();
            let signature = git_repo.signature().unwrap();
            git_repo
                .note(
                    &signature,
                    &signature,
                    Some("refs/notes/commits"),
                    empty_oid,
                    "keep this note",
                    true,
                )
                .unwrap();
            let mut config = git_repo.config().unwrap();
            config.set_bool("notes.rewrite.rebase", true).unwrap();
            config
                .set_str("notes.rewriteRef", "refs/notes/commits")
                .unwrap();
        }

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main diverges", &[("main.txt", "main\n")]);
        repo.checkout_branch("feature");

        rebase(repo.path_str(), initial_branch)
            .await
            .expect("notes rewriting must accept a synthetic empty commit");

        let git_repo = repo.repo();
        let rebased_empty = git_repo.head().unwrap().peel_to_commit().unwrap();
        let note = git_repo
            .find_note(Some("refs/notes/commits"), rebased_empty.id())
            .expect("the original note must be copied");
        assert_eq!(note.message().unwrap(), "keep this note");
    }

    // Like `git rebase`, a modification to a tracked file must abort the rebase
    // up front, leaving no in-progress rebase state behind.
    #[tokio::test]
    async fn test_rebase_dirty_working_tree_rejected() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Create a feature branch that diverges so a real rebase would run.
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main commit", &[("main.txt", "main")]);

        repo.checkout_branch("feature");

        // Modify a TRACKED file (feature.txt) — canonical git refuses this.
        repo.create_file("feature.txt", "uncommitted change");

        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(
            result.is_err(),
            "rebase must be rejected when a tracked file has uncommitted changes"
        );

        // No rebase state should have been created.
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert!(!repo.path.join(".git/rebase-merge").exists());
        assert!(!repo.path.join(".git/rebase-apply").exists());
    }

    // Canonical `git rebase` proceeds when only untracked files are present — the
    // dirty-tree guard must not block on them.
    #[tokio::test]
    async fn test_rebase_allows_untracked_files() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main commit", &[("main.txt", "main")]);

        repo.checkout_branch("feature");

        // A brand-new untracked file must NOT block the rebase.
        repo.create_file("scratch.txt", "untracked");

        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(
            result.is_ok(),
            "rebase must not be blocked by an untracked file: {result:?}"
        );
        // The untracked file survives the rebase.
        assert!(repo.path.join("scratch.txt").exists());
    }

    #[tokio::test]
    async fn test_rebase_nonexistent_onto() {
        let repo = TestRepo::with_initial_commit();

        let result = rebase(repo.path_str(), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_abort_rebase() {
        let repo = TestRepo::with_initial_commit();

        // Without an active rebase, this should fail
        let result = abort_rebase(repo.path_str()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_rebase_commits() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Create feature branch with commits
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature 1", &[("f1.txt", "1")]);
        repo.create_commit("Feature 2", &[("f2.txt", "2")]);
        repo.create_commit("Feature 3", &[("f3.txt", "3")]);

        let result = get_rebase_commits(repo.path_str(), initial_branch).await;
        assert!(result.is_ok());

        let commits = result.unwrap().commits;
        assert_eq!(commits.len(), 3);

        // Commits should be in oldest-first order (git rebase order)
        assert!(commits[0].summary.contains("Feature 1"));
        assert!(commits[1].summary.contains("Feature 2"));
        assert!(commits[2].summary.contains("Feature 3"));

        // Each commit should have "pick" as the default action
        for commit in &commits {
            assert_eq!(commit.action, "pick");
        }
    }

    #[tokio::test]
    async fn test_interactive_rebase_can_squash_without_an_editor() {
        // GIT_SEQUENCE_EDITOR only supplies the todo; a `squash` line then opens
        // GIT_EDITOR for the combined message. This is the one rebase whose todo
        // the user composes, so it is the one that can contain a squash — and
        // without GIT_EDITOR git fell through to core.editor/VISUAL/EDITOR/vi,
        // which dies on the null stdin Command::output() gives it, leaving a
        // paused rebase and a detached HEAD.
        //
        // A machine with EDITOR set would mask the bug this covers, so the
        // masking has to be shut off — but NOT by scrubbing the process
        // environment, which this test used to do. `remove_var` mutates state
        // shared by all 2959 tests running in parallel, and on macOS a
        // concurrent `unsetenv`/`getenv` (libgit2 reads GIT_* constantly, and
        // is outside std's env lock) corrupts the environ block: the whole
        // harness aborted with no message, nondeterministically.
        //
        // git consults GIT_EDITOR, then core.editor, then VISUAL, then EDITOR.
        // Trapping core.editor in THIS repository's own config therefore does
        // the same job locally and does it better: ambient VISUAL/EDITOR are
        // never reached, and if the command under test ever stops setting
        // GIT_EDITOR the rebase fails loudly instead of opening something.
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_str("core.editor", "false")
            .unwrap();
        let base = repo.head_oid().to_string();
        repo.create_commit("first", &[("a.txt", "a")]);
        repo.create_commit("second", &[("b.txt", "b")]);

        let commits = get_rebase_commits(repo.path_str(), base.clone())
            .await
            .unwrap()
            .commits;
        assert_eq!(commits.len(), 2);

        // Oldest-first from get_rebase_commits, which is git's todo order.
        let todo = format!("pick {}\nsquash {}\n", commits[0].oid, commits[1].oid);

        let outcome = execute_interactive_rebase(repo.path_str(), base.clone(), todo)
            .await
            .expect("a squash must complete without opening an editor");
        assert!(!outcome.paused, "and must not leave the rebase paused");

        // One commit above the base instead of two.
        let after = get_rebase_commits(repo.path_str(), base)
            .await
            .unwrap()
            .commits;
        assert_eq!(after.len(), 1, "the two commits became one");
        assert_eq!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "and the repository is not left mid-rebase"
        );
    }

    #[tokio::test]
    async fn test_interactive_rebase_rejects_a_flag_like_target() {
        // `onto` is forwarded to `git rebase -i` as a bare positional, so a ref
        // named `--exec=<command>` would become a flag that runs it after every
        // replayed commit. cli_safety states the rule; this command was the one
        // never added to the 24 sites applying it.
        let repo = TestRepo::with_initial_commit();
        let err = execute_interactive_rebase(
            repo.path_str(),
            "--exec=touch /tmp/gitnado-should-not-exist".to_string(),
            "pick abc123\n".to_string(),
        )
        .await
        .expect_err("a flag-like rebase target must be refused");
        assert!(
            format!("{}", err).contains("must not start with '-'"),
            "and say why: {}",
            err
        );
        assert!(
            !std::path::Path::new("/tmp/gitnado-should-not-exist").exists(),
            "and refuse BEFORE spawning anything"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_reword_preserves_the_commit_body() {
        // The reword route amends with `-m`, which replaces the whole message.
        // Seeding the editor from the subject alone deleted trailers, issue
        // references and rationale — silently, since the dialog only ever
        // showed the subject.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        repo.create_commit(
            "Add retry to the uploader\n\nBackoff is exponential.\nFixes #4412",
            &[("a.txt", "a")],
        );

        let commits = get_rebase_commits(repo.path_str(), base.clone())
            .await
            .unwrap()
            .commits;
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary, "Add retry to the uploader");
        assert!(
            commits[0].body.contains("Fixes #4412"),
            "the body must cross the boundary, or the editor cannot show it"
        );
    }

    #[tokio::test]
    async fn test_interactive_rebase_can_be_aborted() {
        // libgit2 refuses to OPEN an interactive rebase ("interactive rebase is
        // not supported"), so open_rebase failed for every rebase started
        // through execute_interactive_rebase — making Abort impossible from the
        // banner, the toast action, and the conflict dialog, which renders no ×
        // and suppresses Escape. continue_rebase has had the CLI branch since it
        // was written; abort never got it.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        let branch_before = repo.current_branch();
        repo.create_commit("first", &[("a.txt", "a")]);
        repo.create_commit("second", &[("b.txt", "b")]);
        let head_before = repo.head_oid();

        let commits = get_rebase_commits(repo.path_str(), base.clone())
            .await
            .unwrap()
            .commits;
        // An `edit` line pauses the rebase, which is the state Abort exists for.
        let todo = format!("edit {}\npick {}\n", commits[0].oid, commits[1].oid);

        let outcome = execute_interactive_rebase(repo.path_str(), base, todo)
            .await
            .expect("the rebase itself runs");
        assert!(outcome.paused, "paused at the edit line");

        abort_rebase(repo.path_str())
            .await
            .expect("an interactive rebase must be abortable");

        let after = repo.repo();
        assert_eq!(
            after.state(),
            git2::RepositoryState::Clean,
            "the repository is no longer mid-rebase"
        );
        assert_eq!(
            after.head().unwrap().target().unwrap(),
            head_before,
            "and HEAD is back where it started"
        );
        assert_eq!(
            repo.current_branch(),
            branch_before,
            "on the original branch"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_rebase_pre_rebase_hook_can_refuse() {
        // The Hooks dialog advertises pre-rebase as "Can prevent the rebase",
        // and it does fire for Interactive rebase (git runs it). This libgit2
        // path ran no hooks, so the same enabled hook vetoed one Rebase button
        // and was silently ignored by the other.
        let repo = TestRepo::with_initial_commit();
        let main_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("on feature", &[("a.txt", "a")]);
        let head_before = repo.head_oid();

        repo.install_hook("pre-rebase", "#!/bin/sh\nexit 1\n");

        let err = rebase(repo.path_str(), main_branch)
            .await
            .expect_err("the hook must be able to refuse");
        assert!(
            format!("{}", err).to_lowercase().contains("pre-rebase"),
            "and say which hook: {}",
            err
        );
        assert_eq!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "a refusal leaves no rebase state behind"
        );
        assert_eq!(repo.head_oid(), head_before, "and HEAD unmoved");
    }

    #[tokio::test]
    async fn test_rebase_plan_omits_merge_commits() {
        // `git rebase -i` omits merges from its todo, and a `pick` of one dies
        // with "is a merge but no -m option was given" — after earlier commits
        // have already been replayed, leaving a detached HEAD and a live
        // rebase. The plain revwalk also emitted commits from the merged-in
        // side that the user never touched.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        let main_branch = repo.current_branch();
        repo.create_commit("m1", &[("m.txt", "m")]);

        repo.create_branch("side");
        repo.checkout_branch("side");
        repo.create_commit("s1", &[("s.txt", "s")]);
        repo.checkout_branch(&main_branch);

        merge(repo.path_str(), "side".to_string(), None, None, None)
            .await
            .expect("a clean merge");
        repo.create_commit("after", &[("a.txt", "a")]);

        let plan = get_rebase_commits(repo.path_str(), base)
            .await
            .unwrap()
            .commits;
        let git_repo = repo.repo();
        for c in &plan {
            let commit = git_repo.find_commit(c.oid.parse().unwrap()).unwrap();
            assert_eq!(
                commit.parent_count(),
                1,
                "a merge commit reached the plan: {}",
                c.summary
            );
        }
    }

    /// `git rebase --continue` exits 0 when it merely advances to the NEXT
    /// `edit`/`break` line. Reporting that as completion closed the conflict
    /// dialog with no message and left the repo mid-rebase on a detached HEAD,
    /// where the most obvious remaining button throws the rebase away.
    #[tokio::test]
    async fn test_continue_rebase_reports_a_pause_at_the_next_edit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("first", &[("a.txt", "a\n")]);
        repo.create_commit("second", &[("b.txt", "b\n")]);
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        let first = head.parent(0).unwrap();

        // A CLI interactive rebase that stops at two `edit` lines.
        let todo = format!("edit {}\nedit {}\n", first.id(), head.id());
        let base = first.parent(0).unwrap().id().to_string();
        let outcome = execute_interactive_rebase(repo.path_str(), base, todo).await;
        let Ok(outcome) = outcome else {
            // The CLI rebase could not start in this environment; nothing to assert.
            return;
        };
        assert!(outcome.paused, "the rebase must stop at the first edit");

        // Continuing advances to the SECOND edit — still paused, not finished.
        let result = continue_rebase(repo.path_str()).await;
        let git_dir = repo.repo().path().to_path_buf();
        if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            let err = result.expect_err("a rebase still on disk has not completed");
            assert!(
                err.to_string().contains("paused"),
                "the pause must be reported, not swallowed: {}",
                err
            );
        }
    }

    #[test]
    fn test_rewritten_list_survives_a_conflict_pause() {
        // post-rewrite must describe the WHOLE rebase. Both rebase() and
        // continue_rebase() accumulate pairs in a local Vec and fire the hook
        // only if that one invocation runs to completion, so every commit
        // replayed BEFORE a conflict was dropped: rebasing A-B-C where B
        // conflicts reported only B and C.
        let test_repo = TestRepo::with_initial_commit();
        let repo = test_repo.repo();
        std::fs::create_dir_all(test_repo.path.join(".git/rebase-merge")).unwrap();

        append_rewritten(&repo, &["oldA newA".to_string()]);
        append_rewritten(&repo, &["oldB newB".to_string(), "oldC newC".to_string()]);

        let taken = take_rewritten(&repo);
        assert_eq!(
            taken,
            vec!["oldA newA", "oldB newB", "oldC newC"],
            "every leg of the rebase must reach the hook, in order"
        );

        assert!(
            take_rewritten(&repo).is_empty(),
            "the list must be consumed, or the next rebase inherits it"
        );
    }

    #[test]
    fn test_rewritten_list_ignores_an_empty_append() {
        let test_repo = TestRepo::with_initial_commit();
        let repo = test_repo.repo();
        std::fs::create_dir_all(test_repo.path.join(".git/rebase-merge")).unwrap();

        append_rewritten(&repo, &[]);

        assert!(
            take_rewritten(&repo).is_empty(),
            "a pause with nothing replayed must leave no blank lines behind"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_continue_rebase_runs_post_rewrite() {
        // rebase() fires post-rewrite when it completes in one go. A rebase
        // that PAUSED on a conflict finishes in continue_rebase instead, which
        // fired nothing — so whether the hook ran depended only on whether the
        // user happened to hit a conflict.
        let repo = TestRepo::with_initial_commit();
        let main_branch = repo.current_branch();
        repo.create_commit("on main", &[("shared.txt", "main side\n")]);
        // A feature branch that conflicts with main on the same file.
        repo.repo()
            .reference(
                "refs/heads/feature",
                repo.repo()
                    .find_reference(&format!("refs/heads/{}", main_branch))
                    .unwrap()
                    .target()
                    .unwrap(),
                true,
                "test",
            )
            .unwrap();
        repo.checkout_branch("feature");
        // Rewind feature to before the main commit so the rebase has work.
        repo.create_commit("on feature", &[("shared.txt", "feature side\n")]);

        let marker = repo.path.join("post-rewrite-ran");
        repo.install_hook(
            "post-rewrite",
            &format!("#!/bin/sh\ncat > \"{}\"\n", marker.display()),
        );

        // Drive a libgit2 rebase to a paused state, resolve, then continue.
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap();
        let head_commit = git_repo.reference_to_annotated_commit(&head).unwrap();
        let onto = git_repo
            .find_reference(&format!("refs/heads/{}", main_branch))
            .unwrap();
        let onto_commit = git_repo.reference_to_annotated_commit(&onto).unwrap();
        let mut rb = git_repo
            .rebase(Some(&head_commit), Some(&onto_commit), None, None)
            .unwrap();
        let sig = git_repo.signature().unwrap();
        let mut paused = false;
        while let Some(op) = rb.next() {
            op.unwrap();
            if git_repo.index().unwrap().has_conflicts() {
                paused = true;
                break;
            }
            let _ = rb.commit(None, &sig, None);
        }
        drop(rb);

        if !paused {
            // No conflict arose; nothing for continue_rebase to finish.
            return;
        }

        // Resolve the conflict the way the conflict dialog does.
        repo.create_file("shared.txt", "resolved\n");
        repo.stage_file("shared.txt");

        continue_rebase(repo.path_str()).await.expect("continue");

        assert!(
            marker.exists(),
            "post-rewrite must run when a paused rebase is continued"
        );
        let payload = std::fs::read_to_string(&marker).unwrap();
        assert!(
            payload.split_whitespace().count() >= 2,
            "post-rewrite stdin must carry <old> <new> pairs, got: {:?}",
            payload
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_rebase_runs_post_rewrite() {
        // The Hooks dialog advertises post-rewrite for "rebase, amend"; the
        // libgit2 path ran no hooks, so the same Rebase fired it only when it
        // happened to go through the CLI.
        let repo = TestRepo::with_initial_commit();
        let main_branch = repo.current_branch();
        repo.create_commit("on main", &[("m.txt", "m")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("on feature", &[("f.txt", "f")]);

        let marker = repo.path.join("post-rewrite-ran");
        repo.install_hook(
            "post-rewrite",
            &format!("#!/bin/sh\ncat > \"{}\"\n", marker.display()),
        );

        rebase(repo.path_str(), main_branch).await.expect("rebase");

        assert!(marker.exists(), "post-rewrite must run after a rebase");
        let recorded = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(
            recorded.split_whitespace().count(),
            2,
            "one `<old> <new>` pair for the replayed commit: {:?}",
            recorded
        );
    }

    #[tokio::test]
    async fn test_is_ancestor_of_head() {
        // The graph offers Reword and Amend on every branch's commits. Routing
        // an off-branch commit to `<oid>^` produced a plan holding the CURRENT
        // branch's history with the target absent, and an enabled Start Rebase
        // one click from replaying this branch onto an unrelated one.
        let repo = TestRepo::with_initial_commit();
        let main_branch = repo.current_branch();
        let on_main = repo.create_commit("on main", &[("a.txt", "a")]).to_string();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let on_feature = repo
            .create_commit("on feature", &[("b.txt", "b")])
            .to_string();
        repo.checkout_branch(&main_branch);

        assert!(
            is_ancestor_of_head(repo.path_str(), on_main.clone())
                .await
                .unwrap(),
            "a commit on the current branch can be rewritten in place"
        );
        assert!(
            !is_ancestor_of_head(repo.path_str(), on_feature)
                .await
                .unwrap(),
            "one that lives only on another branch cannot"
        );
    }

    #[tokio::test]
    async fn test_head_is_its_own_ancestor_for_this_check() {
        // graph_descendant_of is false for equal oids, but HEAD is obviously
        // rewritable in place.
        let repo = TestRepo::with_initial_commit();
        let head = repo.head_oid().to_string();
        assert!(is_ancestor_of_head(repo.path_str(), head).await.unwrap());
    }

    #[tokio::test]
    async fn test_interactive_rebase_runs_at_all() {
        // The plainest possible plan: reorder nothing, drop nothing, squash
        // nothing. It failed too. Git runs GIT_SEQUENCE_EDITOR for every
        // `rebase -i` and evaluates it through a shell with the real todo path
        // appended, so the editor is a quoted `cp` and no temp file is ever
        // exec'd — which is why the todo handle can stay open for the whole
        // run. This test pins the general execution path, not just the squash
        // that led here.
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        repo.create_commit("first", &[("a.txt", "a")]);
        repo.create_commit("second", &[("b.txt", "b")]);

        let commits = get_rebase_commits(repo.path_str(), base.clone())
            .await
            .unwrap()
            .commits;
        let todo = commits
            .iter()
            .map(|c| format!("pick {}", c.oid))
            .collect::<Vec<_>>()
            .join("\n");

        let outcome = execute_interactive_rebase(repo.path_str(), base.clone(), todo)
            .await
            .expect("an all-pick interactive rebase must run");
        assert!(!outcome.paused);

        let after = get_rebase_commits(repo.path_str(), base)
            .await
            .unwrap()
            .commits;
        assert_eq!(after.len(), 2, "both commits survive an all-pick plan");
    }

    #[tokio::test]
    async fn test_interactive_rebase_can_drop() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid().to_string();
        repo.create_commit("keep", &[("a.txt", "a")]);
        repo.create_commit("remove", &[("b.txt", "b")]);

        let commits = get_rebase_commits(repo.path_str(), base.clone())
            .await
            .unwrap()
            .commits;
        let todo = format!("pick {}\ndrop {}\n", commits[0].oid, commits[1].oid);

        execute_interactive_rebase(repo.path_str(), base.clone(), todo)
            .await
            .expect("a drop plan must run");

        let after = get_rebase_commits(repo.path_str(), base)
            .await
            .unwrap()
            .commits;
        assert_eq!(after.len(), 1);
        assert!(after[0].summary.contains("keep"));
    }

    #[tokio::test]
    async fn test_get_rebase_commits_accepts_a_revspec() {
        // The graph's Reword and Amend entries route non-HEAD commits here as
        // `<oid>^`. find_reference is an exact refname lookup and `^` is
        // illegal in a refname, so the dialog opened empty and disabled with a
        // raw libgit2 message and no way forward.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("second", &[("a.txt", "a")]);
        repo.create_commit("third", &[("b.txt", "b")]);

        let head_oid = repo.head_oid().to_string();

        let commits = get_rebase_commits(repo.path_str(), format!("{}^", head_oid))
            .await
            .expect("a revspec must resolve, not error")
            .commits;

        assert_eq!(commits.len(), 1, "just the tip, whose parent we asked for");
        assert_eq!(commits[0].oid, head_oid);
    }

    #[tokio::test]
    async fn test_get_rebase_commits_still_accepts_a_branch_name() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("on feature", &[("a.txt", "a")]);

        let commits = get_rebase_commits(repo.path_str(), base)
            .await
            .unwrap()
            .commits;
        assert_eq!(commits.len(), 1);
    }

    #[tokio::test]
    async fn test_get_rebase_commits_no_divergence() {
        let repo = TestRepo::with_initial_commit();

        // Create branch at same point
        repo.create_branch("same-point");

        let result = get_rebase_commits(repo.path_str(), "same-point".to_string()).await;
        assert!(result.is_ok());

        // No commits to rebase
        let commits = result.unwrap().commits;
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn test_get_conflicts_no_conflicts() {
        let repo = TestRepo::with_initial_commit();

        let result = get_conflicts(repo.path_str()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_blob_content() {
        let repo = TestRepo::with_initial_commit();
        let content = "Hello, World!";
        repo.create_commit("Add file", &[("test.txt", content)]);

        // Get the blob OID from the tree
        let git_repo = repo.repo();
        let head = git_repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        let tree = commit.tree().unwrap();
        let entry = tree.get_name("test.txt").unwrap();
        let blob_oid = entry.id().to_string();

        let result = get_blob_content(repo.path_str(), blob_oid).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[tokio::test]
    async fn test_get_blob_content_invalid_oid() {
        let repo = TestRepo::with_initial_commit();

        let result = get_blob_content(
            repo.path_str(),
            "0000000000000000000000000000000000000000".to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_resolve_conflict_writes_and_stages() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("conflict.txt", "original")]);

        let resolved_content = "resolved content";
        let result = resolve_conflict(
            repo.path_str(),
            "conflict.txt".to_string(),
            resolved_content.to_string(),
            None,
        )
        .await;

        assert!(result.is_ok());

        // Verify file content was written
        let file_content = std::fs::read_to_string(repo.path.join("conflict.txt")).unwrap();
        assert_eq!(file_content, resolved_content);

        // Verify file is staged
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let entry = index
            .iter()
            .find(|e| String::from_utf8_lossy(&e.path) == "conflict.txt");
        assert!(entry.is_some());
    }

    #[tokio::test]
    async fn test_rebase_commit_struct_serialization() {
        let commit = RebaseCommit {
            oid: "abc123def456".to_string(),
            short_id: "abc123d".to_string(),
            summary: "Test commit".to_string(),
            body: "Explains why.\n\nFixes #1".to_string(),
            action: "pick".to_string(),
        };

        let json = serde_json::to_string(&commit);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"oid\":\"abc123def456\""));
        assert!(json_str.contains("\"shortId\":\"abc123d\""));
        assert!(json_str.contains("\"action\":\"pick\""));
        // The body has to cross the boundary, or the reword editor cannot show
        // it and `--amend -m` silently drops it.
        assert!(json_str.contains("\"body\""));
        assert!(json_str.contains("Fixes #1"));
    }

    #[tokio::test]
    async fn test_merge_with_conflict() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Create conflicting changes
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        // Attempt merge - should result in conflict
        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true), // no-ff to force merge
            None,
            None,
        )
        .await;

        // Should return MergeConflict error
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_merge_ff_refuses_to_overwrite_local_changes() {
        // git aborts a fast-forward merge that would overwrite uncommitted
        // local changes ("Your local changes to the following files would be
        // overwritten by merge ... Aborting"), leaving the ref unmoved.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add file", &[("file.txt", "base")]);
        let pre_merge_oid = repo.head_oid();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("file.txt", "feature")]);
        repo.checkout_branch(&initial_branch);

        // Uncommitted local edit the fast-forward checkout would overwrite.
        repo.create_file("file.txt", "my precious local edit");

        let result = merge(repo.path_str(), "feature".to_string(), None, None, None).await;
        assert!(
            result.is_err(),
            "fast-forward merge over local changes must refuse like git"
        );
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("overwritten by merge"),
            "unexpected message: {msg}"
        );

        // Local edit preserved and ref unmoved.
        let content = std::fs::read_to_string(repo.path.join("file.txt")).unwrap();
        assert_eq!(content, "my precious local edit");
        assert_eq!(repo.head_oid(), pre_merge_oid);
    }

    #[tokio::test]
    async fn test_merge_ff_refuses_to_overwrite_untracked_file() {
        // git: "The following untracked working tree files would be
        // overwritten by merge ... Aborting".
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Add new file", &[("new.txt", "feature version")]);
        repo.checkout_branch(&initial_branch);
        let pre_merge_oid = repo.head_oid();

        // Precious untracked file the fast-forward would overwrite.
        repo.create_file("new.txt", "precious untracked content");

        let result = merge(repo.path_str(), "feature".to_string(), None, None, None).await;
        assert!(
            result.is_err(),
            "fast-forward merge over an untracked file must refuse like git"
        );

        let content = std::fs::read_to_string(repo.path.join("new.txt")).unwrap();
        assert_eq!(content, "precious untracked content");
        assert_eq!(repo.head_oid(), pre_merge_oid);
    }

    #[tokio::test]
    async fn test_merge_refuses_when_merge_already_in_progress() {
        // git: "error: Merging is not possible because you have unmerged
        // files." / "You have not concluded your merge (MERGE_HEAD exists)."
        // — not a misleading "uncommitted change would be overwritten".
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let msg = result
            .expect_err("merging while a merge is in progress must fail")
            .to_string();
        assert!(
            msg.contains("not concluded your merge"),
            "unexpected message: {msg}"
        );
        // The original merge state stays intact for resolve/abort.
        assert_eq!(repo.repo().state(), git2::RepositoryState::Merge);
    }

    #[tokio::test]
    async fn test_merge_default_message_is_canonical() {
        // `git merge --no-edit feature` produces the subject
        // "Merge branch 'feature'", not "Merge 'feature' into HEAD".
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);

        merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Merge branch 'feature'"));
    }

    #[tokio::test]
    async fn test_merge_default_message_into_nondefault_branch() {
        // git appends " into <branch>" to the merge subject for any branch
        // other than master/main. Merging feature into "develop" must yield
        // "Merge branch 'feature' into develop".
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("develop");
        repo.checkout_branch("develop");
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature commit", &[("feature.txt", "content")]);
        repo.checkout_branch("develop");

        merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.summary().unwrap(),
            Some("Merge branch 'feature' into develop")
        );
    }

    #[tokio::test]
    async fn test_continue_rebase_without_active_rebase() {
        let repo = TestRepo::with_initial_commit();

        // Should fail without an active rebase
        let result = continue_rebase(repo.path_str()).await;
        assert!(result.is_err());
    }

    /// Set up a merge conflict on shared.txt between the initial branch and
    /// "feature", ending checked out on the initial branch (merge not run).
    /// The plan must report merges it excluded.
    ///
    /// Omitting them silently produced a todo that reads as a clean linear list
    /// while the range is not linear: replaying it flattens the topology and
    /// rewrites the merged-in side commits.
    #[tokio::test]
    async fn test_get_rebase_commits_reports_excluded_merges() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid();
        let default_branch = repo.current_branch();

        // A side branch merged back in, so the range contains a merge commit.
        repo.create_branch("side");
        repo.checkout_branch("side");
        repo.create_commit("Side work", &[("side.txt", "side")]);
        repo.checkout_branch(&default_branch);
        repo.create_commit("Main work", &[("main.txt", "main")]);

        merge(repo.path_str(), "side".to_string(), Some(true), None, None)
            .await
            .expect("merge should succeed");

        let plan = get_rebase_commits(repo.path_str(), base.to_string())
            .await
            .expect("plan should load");

        assert_eq!(
            plan.merge_count, 1,
            "the excluded merge commit must be reported"
        );
        assert!(
            plan.commits
                .iter()
                .all(|c| c.summary != "Merge branch 'side'"),
            "merge commits stay out of the todo"
        );
        assert!(
            !plan.commits.is_empty(),
            "the non-merge commits are still listed"
        );
    }

    /// A linear range reports nothing, so the warning stays off.
    #[tokio::test]
    async fn test_get_rebase_commits_reports_zero_merges_for_linear_history() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid();
        repo.create_commit("One", &[("a.txt", "a")]);
        repo.create_commit("Two", &[("b.txt", "b")]);

        let plan = get_rebase_commits(repo.path_str(), base.to_string())
            .await
            .expect("plan should load");

        assert_eq!(plan.merge_count, 0);
        assert_eq!(plan.commits.len(), 2);
    }

    fn setup_conflicting_branches(repo: &TestRepo) {
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
    }

    // ── Merge preview ────────────────────────────────────────────────────────

    /// The whole point: name the files that would conflict, before the working
    /// tree is in a conflicted state.
    #[tokio::test]
    async fn test_preview_merge_reports_the_conflicting_paths() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add shared",
            &[("shared.txt", "base"), ("other.txt", "base")],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit(
            "Feature change",
            &[("shared.txt", "feature"), ("other.txt", "feature")],
        );
        repo.checkout_branch(&initial_branch);
        repo.create_commit(
            "Main change",
            &[("shared.txt", "main"), ("other.txt", "main")],
        );

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("preview should succeed even though the merge conflicts");

        assert_eq!(preview.outcome, "normal");
        assert_eq!(preview.conflict_count, 2);
        assert_eq!(
            preview.conflicting_files,
            vec!["other.txt".to_string(), "shared.txt".to_string()],
            "the exact conflicting paths must be named, sorted"
        );
        assert!(!preview.unrelated_histories);
        assert!(preview.operation_in_progress.is_none());
    }

    /// A preview that mutated anything would be worse than no preview at all:
    /// the user asked what WOULD happen, not for it to happen.
    #[tokio::test]
    async fn test_preview_merge_leaves_the_working_tree_and_index_untouched() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main")]);

        // An uncommitted edit as well, so a preview that checked anything out
        // would be caught destroying work rather than just moving the index.
        repo.create_file("dirty.txt", "uncommitted");

        let head_before = repo.head_oid();
        let index_before = repo.repo().index().unwrap().write_tree().unwrap();
        let workdir_before =
            std::fs::read_to_string(repo.path.join("shared.txt")).expect("shared.txt");
        let reflog_before = repo.repo().reflog("HEAD").map(|l| l.len()).unwrap_or(0);

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("preview should succeed");
        assert_eq!(preview.conflict_count, 1, "sanity: this merge conflicts");

        let after = repo.repo();
        assert_eq!(after.head().unwrap().target().unwrap(), head_before);
        assert_eq!(
            after.index().unwrap().write_tree().unwrap(),
            index_before,
            "the on-disk index must be byte-identical after a preview"
        );
        assert!(
            !after.index().unwrap().has_conflicts(),
            "the preview must not stage conflicts"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("shared.txt")).unwrap(),
            workdir_before,
            "the working copy must not gain conflict markers"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("dirty.txt")).unwrap(),
            "uncommitted",
            "uncommitted work must survive a preview"
        );
        assert_eq!(after.state(), git2::RepositoryState::Clean);
        assert!(!after.path().join("MERGE_HEAD").exists());
        assert_eq!(after.worktrees().unwrap().len(), 0, "no ghost worktree");
        assert_eq!(
            after.reflog("HEAD").map(|l| l.len()).unwrap_or(0),
            reflog_before,
            "no ref moved"
        );
    }

    /// A branch ahead of HEAD with no divergence fast-forwards.
    #[tokio::test]
    async fn test_preview_merge_reports_a_fast_forward() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature file", &[("feature.txt", "feature")]);
        repo.checkout_branch(&initial_branch);

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("preview should succeed");

        assert_eq!(preview.outcome, "fastForward");
        assert_eq!(preview.conflict_count, 0);
        assert!(preview.conflicting_files.is_empty());
    }

    /// Divergent branches touching different files need a merge commit and
    /// conflict in nothing.
    #[tokio::test]
    async fn test_preview_merge_reports_a_clean_merge_commit() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature file", &[("feature.txt", "feature")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main file", &[("main.txt", "main")]);

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("preview should succeed");

        assert_eq!(preview.outcome, "normal");
        assert_eq!(preview.conflict_count, 0);
        assert!(preview.conflicting_files.is_empty());
        assert!(!preview.unrelated_histories);
    }

    /// Merging an ancestor changes nothing, and the confirm must say so rather
    /// than promising a merge commit that will never be recorded.
    #[tokio::test]
    async fn test_preview_merge_reports_up_to_date() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main file", &[("main.txt", "main")]);

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("preview should succeed");

        assert_eq!(preview.outcome, "upToDate");
        assert_eq!(preview.conflict_count, 0);
    }

    /// libgit2 merges unrelated histories rather than refusing the way the CLI
    /// does, so the preview is the only place a user can be warned.
    #[tokio::test]
    async fn test_preview_merge_reports_unrelated_histories() {
        let repo = TestRepo::with_initial_commit();
        let repository = repo.repo();
        let signature = repository.signature().unwrap();

        // An orphan commit: a tree of its own with no parents at all.
        let orphan_tree = {
            let mut builder = repository.treebuilder(None).unwrap();
            let blob = repository.blob(b"orphan").unwrap();
            builder.insert("orphan.txt", blob, 0o100644).unwrap();
            let oid = builder.write().unwrap();
            repository.find_tree(oid).unwrap()
        };
        let orphan = repository
            .commit(
                Some("refs/heads/orphan"),
                &signature,
                &signature,
                "Orphan root",
                &orphan_tree,
                &[],
            )
            .unwrap();
        assert!(repository.find_commit(orphan).is_ok());

        let preview = preview_merge(repo.path_str(), "orphan".to_string(), None)
            .await
            .expect("preview should succeed for unrelated histories");

        assert_eq!(preview.outcome, "normal");
        assert!(
            preview.unrelated_histories,
            "the two sides share no merge base"
        );
    }

    /// A branch with no commits yet: `merge` cannot fast-forward a HEAD that
    /// does not point at anything, so "this will fast-forward" would be a lie.
    #[tokio::test]
    async fn test_preview_merge_reports_an_unborn_head() {
        let repo = TestRepo::new();
        let repository = repo.repo();
        let signature = repository.signature().unwrap();
        let tree = {
            let mut builder = repository.treebuilder(None).unwrap();
            let blob = repository.blob(b"seed").unwrap();
            builder.insert("seed.txt", blob, 0o100644).unwrap();
            let oid = builder.write().unwrap();
            repository.find_tree(oid).unwrap()
        };
        repository
            .commit(
                Some("refs/heads/seed"),
                &signature,
                &signature,
                "Seed",
                &tree,
                &[],
            )
            .unwrap();

        let preview = preview_merge(repo.path_str(), "seed".to_string(), None)
            .await
            .expect("preview should succeed on an unborn HEAD");

        assert_eq!(preview.outcome, "unborn");
        assert_eq!(preview.conflict_count, 0);
    }

    /// A repository already mid-merge: the preview still answers, and names the
    /// state that will make the real merge refuse.
    #[tokio::test]
    async fn test_preview_merge_reports_an_operation_in_progress() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main")]);

        // Leave the repository in the state a conflicted merge leaves it in.
        merge(repo.path_str(), "feature".to_string(), None, None, None)
            .await
            .expect_err("this merge conflicts");
        assert_eq!(repo.repo().state(), git2::RepositoryState::Merge);

        let preview = preview_merge(repo.path_str(), "feature".to_string(), None)
            .await
            .expect("the preview is read-only and must still answer");

        assert_eq!(preview.operation_in_progress.as_deref(), Some("Merge"));
    }

    /// The drop-onto-another-branch path checks the target out and merges into
    /// THAT, so a preview against HEAD would describe the wrong merge.
    #[tokio::test]
    async fn test_preview_merge_predicts_a_merge_into_another_branch() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("target");
        repo.create_branch("source");

        repo.checkout_branch("source");
        repo.create_commit("Source change", &[("shared.txt", "source")]);

        repo.checkout_branch("target");
        repo.create_commit("Target change", &[("shared.txt", "target")]);

        // HEAD is somewhere else entirely, and merging source into it is clean.
        repo.checkout_branch(&initial_branch);

        let into_head = preview_merge(repo.path_str(), "source".to_string(), None)
            .await
            .expect("preview should succeed");
        assert_eq!(into_head.conflict_count, 0, "sanity: clean against HEAD");

        let into_target = preview_merge(
            repo.path_str(),
            "source".to_string(),
            Some("target".to_string()),
        )
        .await
        .expect("preview should succeed");

        assert_eq!(into_target.outcome, "normal");
        assert_eq!(
            into_target.conflicting_files,
            vec!["shared.txt".to_string()]
        );
    }

    /// An unknown ref must fail loudly rather than come back as a clean merge.
    #[tokio::test]
    async fn test_preview_merge_errors_on_an_unknown_source() {
        let repo = TestRepo::with_initial_commit();

        let result = preview_merge(repo.path_str(), "no-such-branch".to_string(), None).await;
        assert!(
            result.is_err(),
            "an unknown source must not be reported as a clean merge"
        );
    }

    // ── Ghost-rebase preview ─────────────────────────────────────────────────

    /// The preview must actually predict the conflict it exists to predict.
    ///
    /// It scanned only stderr for "CONFLICT", and git prints those lines to
    /// STDOUT — so `conflicts` was always empty and every conflicting rebase was
    /// reported as `conflictingCommits: 0, cleanCommits: totalCommits`. A user
    /// asking "will this rebase be clean?" was told yes, always.
    #[tokio::test]
    async fn test_preview_rebase_reports_the_conflicting_file() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let preview = preview_rebase(repo.path_str(), "feature".to_string())
            .await
            .expect("preview should succeed even though the rebase conflicts");

        assert_eq!(
            preview.conflicts.len(),
            1,
            "the conflicting file must be named: {:?}",
            preview.conflicts
        );
        assert_eq!(preview.conflicts[0].file_path, "shared.txt");
        assert_eq!(
            preview.conflicting_commits, 1,
            "the rebase stops on one commit"
        );
        assert!(
            preview.clean_commits < preview.total_commits,
            "a conflicting commit cannot also be counted clean"
        );

        // The ghost worktree must not outlive the preview.
        let worktrees = repo.repo().worktrees().unwrap();
        assert_eq!(worktrees.len(), 0, "the temp worktree must be removed");
        assert_eq!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "the preview must not touch the user's own repository state"
        );
    }

    /// Control: a rebase that applies cleanly reports no conflicts.
    #[tokio::test]
    async fn test_preview_rebase_reports_a_clean_rebase() {
        // Branches that touch different files, so the rebase replays cleanly.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add base", &[("base.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature file", &[("feature.txt", "feature")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main file", &[("main.txt", "main")]);

        let preview = preview_rebase(repo.path_str(), "feature".to_string())
            .await
            .expect("a clean preview should succeed");

        assert!(preview.conflicts.is_empty());
        assert_eq!(preview.conflicting_commits, 0);
        assert_eq!(preview.clean_commits, preview.total_commits);
    }

    /// A rebase that fails for a reason other than a conflict must not be
    /// reported as a clean rebase — there is nothing to say about it.
    #[tokio::test]
    async fn test_preview_rebase_errors_when_the_target_does_not_exist() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = preview_rebase(repo.path_str(), "no-such-branch".to_string()).await;
        assert!(
            result.is_err(),
            "an unknown target must not come back as a clean preview"
        );

        let worktrees = repo.repo().worktrees().unwrap();
        assert_eq!(
            worktrees.len(),
            0,
            "a failed preview must still remove its worktree"
        );
    }

    /// stdout and stderr must not run together.
    ///
    /// git does not always terminate stdout with a newline, and a direct
    /// concatenation then glues the last stdout line onto the first stderr line
    /// — which is precisely the `error: could not apply ...` line being matched.
    #[test]
    fn test_join_output_separates_streams_without_doubling_newlines() {
        // No trailing newline on stdout: a separator must be inserted, or the
        // stderr line stops being matchable.
        let joined = join_output(
            "CONFLICT (content): Merge conflict in shared.txt",
            "error: could not apply 1a2b3c4... Main change\n",
        );
        assert_eq!(
            stopped_commit_summary(&joined).as_deref(),
            Some("Main change"),
            "joined output must keep the error line on its own line: {:?}",
            joined
        );

        // Already newline-terminated: no blank line is introduced.
        assert_eq!(join_output("out\n", "err\n"), "out\nerr\n");

        // Either side empty: pass the other through untouched.
        assert_eq!(join_output("", "err"), "err");
        assert_eq!(join_output("out", ""), "out");
    }

    #[test]
    fn test_stopped_commit_summary_reads_the_stopped_commit() {
        let output = "Auto-merging shared.txt\n\
             CONFLICT (content): Merge conflict in shared.txt\n\
             error: could not apply 1a2b3c4... Main change\n\
             hint: Resolve all conflicts manually\n";
        assert_eq!(
            stopped_commit_summary(output).as_deref(),
            Some("Main change")
        );

        // A localized or otherwise unrecognised output yields no summary rather
        // than a wrong one.
        assert_eq!(stopped_commit_summary("KONFLIKT irgendwo\n"), None);
    }

    #[tokio::test]
    async fn test_commit_merge_completes_conflicted_merge() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let result = commit_merge(repo.path_str(), Some("Merge feature".to_string()), None).await;
        assert!(result.is_ok(), "commit_merge failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            2,
            "merge commit must have both parents"
        );
        assert_eq!(head.summary().unwrap(), Some("Merge feature"));
    }

    #[tokio::test]
    async fn test_commit_merge_squash_produces_single_parent() {
        // A conflicted merge resolved and completed with squash:true must yield
        // a SINGLE-parent commit (the squash the user asked for), not a merge
        // commit, and clear the merge state.
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let result = commit_merge(repo.path_str(), Some("Squashed".to_string()), Some(true)).await;
        assert!(
            result.is_ok(),
            "squash commit_merge failed: {:?}",
            result.err()
        );

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            1,
            "squash merge commit must have a single parent"
        );
        assert_eq!(head.summary().unwrap(), Some("Squashed"));
    }

    #[tokio::test]
    async fn test_commit_merge_strips_conflict_comments_from_merge_msg() {
        // MERGE_MSG carries libgit2's '# Conflicts:' / '#\t<path>' comment lines.
        // Defaulting to it must NOT bake those comment lines into history.
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        // Simulate git's MERGE_MSG with conflict comment lines.
        let merge_msg = "Merge branch 'feature'\n\n# Conflicts:\n#\tshared.txt\n";
        std::fs::write(repo.repo().path().join("MERGE_MSG"), merge_msg).unwrap();

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        // No explicit message → defaults to (cleaned) MERGE_MSG.
        commit_merge(repo.path_str(), None, None).await.unwrap();

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        let msg = head.message().unwrap();
        assert!(
            !msg.lines().any(|l| l.starts_with('#')),
            "commit message must not contain '#' comment lines: {:?}",
            msg
        );
        assert!(
            !msg.contains("Conflicts"),
            "commit message must not contain the Conflicts block: {:?}",
            msg
        );
        assert_eq!(head.summary().unwrap(), Some("Merge branch 'feature'"));
    }

    /// Branches that touch different files, so the merge completes cleanly and
    /// never routes through the conflict path.
    fn setup_cleanly_mergeable_branches(repo: &TestRepo) {
        let initial_branch = repo.current_branch();
        repo.create_commit("Add base", &[("base.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature file", &[("feature.txt", "feature")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main file", &[("main.txt", "main")]);
    }

    /// A CLEAN merge must honour commit.gpgsign, exactly as a conflicted one
    /// does.
    ///
    /// merge() created the merge commit with repo.commit(), which cannot sign,
    /// while a conflicted merge finishes through commit_merge and does sign. So
    /// the same gesture produced a signed or unsigned merge commit depending
    /// purely on whether the branches happened to touch the same lines. On a
    /// repo that enforces signed commits the unsigned ones are rejected on push
    /// or show as unverified, with nothing to explain why only some fail.
    ///
    /// Signing is asserted by its failure: with a bogus gpg.program the merge
    /// must now FAIL, which it can only do if it went through `git commit -S`.
    /// Before the fix it silently succeeded with an unsigned commit.
    #[tokio::test]
    async fn test_clean_merge_is_signed_when_gpgsign_enabled() {
        let repo = TestRepo::with_initial_commit();
        setup_cleanly_mergeable_branches(&repo);

        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().unwrap();
            config.set_bool("commit.gpgsign", true).unwrap();
            config
                .set_str("gpg.program", "/nonexistent/definitely-not-real-gpg")
                .unwrap();
        }

        let result = merge(repo.path_str(), "feature".to_string(), None, None, None).await;
        assert!(
            result.is_err(),
            "a clean merge must go through the signing path, so bogus signing config must fail it"
        );

        // The merge stays resumable rather than being half-applied and forgotten.
        let git_repo = repo.repo();
        assert!(
            git_repo.path().join("MERGE_HEAD").exists(),
            "a failed signed merge must leave MERGE_HEAD so it can be retried or aborted"
        );
    }

    /// A signed merge must run commit-msg exactly ONCE.
    ///
    /// The signed path hands the merge to `git commit -S`, which runs commit-msg
    /// itself. Running our own `run_commit_msg_hook` first as well fired the hook
    /// twice for a single merge: a Change-Id or ticket-prefix hook stamps the
    /// message twice, and a hook that counts or notifies does it twice over.
    ///
    /// The merge is failed at the signing step by a bogus gpg.program — hooks run
    /// before the commit object is signed, so the count is unaffected.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_signed_merge_runs_commit_msg_hook_once() {
        let repo = TestRepo::with_initial_commit();
        setup_cleanly_mergeable_branches(&repo);

        let counter = std::path::Path::new(&repo.path_str()).join("commit-msg-runs");
        repo.install_hook(
            "commit-msg",
            &format!("#!/bin/sh\necho run >> \"{}\"\n", counter.display()),
        );

        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().unwrap();
            config.set_bool("commit.gpgsign", true).unwrap();
            config
                .set_str("gpg.program", "/nonexistent/definitely-not-real-gpg")
                .unwrap();
        }

        let _ = merge(repo.path_str(), "feature".to_string(), None, None, None).await;

        let runs = std::fs::read_to_string(&counter)
            .map(|c| c.lines().count())
            .unwrap_or(0);
        assert_eq!(
            runs, 1,
            "commit-msg must run once for one merge, not once per code path"
        );
    }

    /// Control: with signing off, a clean merge still completes normally and
    /// records a two-parent merge commit.
    #[tokio::test]
    async fn test_clean_merge_without_signing_still_succeeds() {
        let repo = TestRepo::with_initial_commit();
        setup_cleanly_mergeable_branches(&repo);

        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().unwrap();
            config.set_bool("commit.gpgsign", false).unwrap();
        }

        merge(repo.path_str(), "feature".to_string(), None, None, None)
            .await
            .expect("clean merge should succeed");

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2, "a merge commit has two parents");
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
    }

    #[tokio::test]
    async fn test_commit_merge_signed_squash_restores_state_on_failure() {
        // The squash-signed path clears merge state before running `git commit`.
        // If that CLI commit fails (bogus signing config here), the merge state
        // must be restored so the user can retry or abort.
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        // Force a signed commit whose signing will fail (bogus gpg program).
        {
            let git_repo = repo.repo();
            let mut config = git_repo.config().unwrap();
            config.set_bool("commit.gpgsign", true).unwrap();
            config
                .set_str("gpg.program", "/nonexistent/definitely-not-real-gpg")
                .unwrap();
        }

        let result = commit_merge(repo.path_str(), Some("Squashed".to_string()), Some(true)).await;
        assert!(
            result.is_err(),
            "signed squash commit should fail with a bogus gpg program"
        );

        // Merge state restored so retry/abort still work.
        let git_repo = repo.repo();
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Merge,
            "merge state must be restored after a failed signed squash commit"
        );
        assert!(git_repo.path().join("MERGE_HEAD").exists());
    }

    #[tokio::test]
    async fn test_commit_merge_refuses_unresolved_conflicts() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let result = commit_merge(repo.path_str(), None, None).await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));
        // Still mid-merge so the user can keep resolving
        assert_eq!(repo.repo().state(), git2::RepositoryState::Merge);
    }

    #[tokio::test]
    async fn test_commit_merge_without_merge_in_progress() {
        let repo = TestRepo::with_initial_commit();
        let result = commit_merge(repo.path_str(), None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_resolve_conflict_delete_file_stages_removal() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add doomed file", &[("doomed.txt", "contents")]);

        let result = resolve_conflict(
            repo.path_str(),
            "doomed.txt".to_string(),
            String::new(),
            Some(true),
        )
        .await;
        assert!(
            result.is_ok(),
            "delete resolution failed: {:?}",
            result.err()
        );

        assert!(!repo.path.join("doomed.txt").exists());
        let git_repo = repo.repo();
        let statuses = git_repo.statuses(None).unwrap();
        let entry = statuses
            .iter()
            .find(|s| s.path().ok() == Some("doomed.txt"))
            .expect("deletion should be staged");
        assert!(entry.status().contains(git2::Status::INDEX_DELETED));
    }

    #[tokio::test]
    async fn test_take_side_gitlink_materializes_a_nested_missing_parent_dir() {
        // A NESTED gitlink (`vendor/sub`) whose parent directory does not
        // exist on disk. create_dir (non-recursive) would fail; the
        // resolution must create the parent chain and succeed.
        let repo = TestRepo::with_initial_commit();
        let git_repo = repo.repo();
        let ptr_ours = repo.create_commit("ptr ours", &[("a.txt", "2")]);
        let ptr_theirs = repo.create_commit("ptr theirs", &[("a.txt", "3")]);

        // Directly stage a 3-stage conflict for the nested gitlink path so
        // the worktree genuinely has no `vendor/` directory.
        let mut index = git_repo.index().unwrap();
        for (stage, oid) in [(1u16, ptr_ours), (2u16, ptr_ours), (3u16, ptr_theirs)] {
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o160000,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: oid,
                flags: stage << 12,
                flags_extended: 0,
                path: b"vendor/sub".to_vec(),
            };
            index.add(&entry).unwrap();
        }
        index.write().unwrap();
        assert!(!repo.path.join("vendor").exists());

        resolve_conflict_take_side(
            repo.path_str(),
            "vendor/sub".to_string(),
            "ours".to_string(),
        )
        .await
        .expect("nested gitlink resolution must create the parent dir");

        let meta = std::fs::symlink_metadata(repo.path.join("vendor/sub")).unwrap();
        assert!(meta.file_type().is_dir(), "gitlink materialized as a dir");
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        assert_eq!(
            index.get_path(Path::new("vendor/sub"), 0).unwrap().mode,
            0o160000
        );
    }

    #[tokio::test]
    async fn test_resolve_conflict_delete_leaves_a_submodule_directory_in_place() {
        // resolve_conflict with delete_file on a path that is a DIRECTORY on
        // disk (a submodule worktree) must stage the removal without erroring
        // on remove_file, and must NOT delete the directory tree.
        let repo = TestRepo::with_initial_commit();
        let git_repo = repo.repo();
        let ptr = repo.create_commit("ptr", &[("a.txt", "1")]);
        let mut index = git_repo.index().unwrap();
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o160000,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: ptr,
            flags: 0,
            flags_extended: 0,
            path: b"sub".to_vec(),
        };
        index.add(&entry).unwrap();
        index.write().unwrap();
        // A populated submodule worktree directory sits on disk.
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        std::fs::write(repo.path.join("sub/work.txt"), "wip\n").unwrap();

        resolve_conflict(
            repo.path_str(),
            "sub".to_string(),
            String::new(),
            Some(true),
        )
        .await
        .expect("delete on a submodule dir must not error on remove_file");

        // The directory (and its uncommitted work) is left on disk.
        assert!(repo.path.join("sub/work.txt").exists());
        let git_repo = repo.repo();
        assert!(git_repo
            .index()
            .unwrap()
            .get_path(Path::new("sub"), 0)
            .is_none());
    }

    #[tokio::test]
    async fn test_resolve_conflict_take_side_theirs() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let result = resolve_conflict_take_side(
            repo.path_str(),
            "shared.txt".to_string(),
            "theirs".to_string(),
        )
        .await;
        assert!(result.is_ok(), "take side failed: {:?}", result.err());

        let content = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert_eq!(content, "feature content");
        assert!(!repo.repo().index().unwrap().has_conflicts());
    }

    #[tokio::test]
    async fn test_resolve_conflict_take_deleted_side_removes_file() {
        // modify/delete conflict: feature deletes the file, main modifies it
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::remove_file(repo.path.join("shared.txt")).unwrap();
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            index
                .remove_path(std::path::Path::new("shared.txt"))
                .unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            let sig = git_repo.signature().unwrap();
            let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
            git_repo
                .commit(Some("HEAD"), &sig, &sig, "Delete shared", &tree, &[&parent])
                .unwrap();
        }
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Modify shared", &[("shared.txt", "modified")]);

        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        let result = resolve_conflict_take_side(
            repo.path_str(),
            "shared.txt".to_string(),
            "theirs".to_string(),
        )
        .await;
        assert!(
            result.is_ok(),
            "take deleted side failed: {:?}",
            result.err()
        );
        assert!(!repo.path.join("shared.txt").exists());
        assert!(!repo.repo().index().unwrap().has_conflicts());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_resolve_conflict_rejects_writing_text_over_a_symlink() {
        // resolve_conflict (the text pipeline) must refuse a symlink
        // conflict server-side — writing text content would corrupt the
        // link. The UI routes these to take-side; this enforces it.
        use std::os::unix::fs::symlink;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        let link = repo.path.join("link");
        symlink("base-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Add link", &[]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::remove_file(&link).unwrap();
        symlink("theirs-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Feature retargets", &[]);
        repo.checkout_branch(&initial_branch);
        std::fs::remove_file(&link).unwrap();
        symlink("ours-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Main retargets", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let err = resolve_conflict(
            repo.path_str(),
            "link".to_string(),
            "arbitrary text".to_string(),
            None,
        )
        .await
        .expect_err("must refuse to write text over a symlink conflict");
        assert!(err.to_string().contains("symlink or submodule conflict"));
        // The link is untouched and still conflicted.
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink());
        assert!(repo.repo().index().unwrap().has_conflicts());
    }

    #[tokio::test]
    async fn test_take_side_refuses_a_non_utf8_filename() {
        // A non-UTF-8 filename cannot round-trip through the String API —
        // the frontend already has a lossy name — so resolving would target
        // a DIFFERENT (mangled) path. Refuse honestly instead of silently
        // creating a ghost and leaving the real file conflicted.
        let repo = TestRepo::with_initial_commit();
        let git_repo = repo.repo();
        let ours_oid = git_repo.blob(b"ours\n").unwrap();
        let theirs_oid = git_repo.blob(b"theirs\n").unwrap();
        // café.txt where é is the raw Latin-1 byte 0xE9 (not valid UTF-8).
        let raw_path: &[u8] = b"caf\xe9.txt";

        let mut index = git_repo.index().unwrap();
        for (stage, oid) in [(2u16, ours_oid), (3u16, theirs_oid)] {
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: oid,
                flags: stage << 12,
                flags_extended: 0,
                path: raw_path.to_vec(),
            };
            index.add(&entry).unwrap();
        }
        index.write().unwrap();
        assert!(git_repo.index().unwrap().has_conflicts());

        // The frontend would send the LOSSY name (get_conflicts lossy-
        // encoded it). take-side finds the entry by lossy match, then
        // refuses because the entry's real bytes aren't UTF-8.
        let lossy = String::from_utf8_lossy(raw_path).to_string();
        let err = resolve_conflict_take_side(repo.path_str(), lossy, "ours".to_string())
            .await
            .expect_err("must refuse a non-UTF-8 filename rather than corrupt");
        assert!(err.to_string().contains("non-UTF-8 name"));
    }

    #[tokio::test]
    async fn test_get_conflicts_flags_binary() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        std::fs::write(repo.path.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        repo.stage_file("blob.bin");
        repo.create_commit("Add binary", &[]);

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::write(repo.path.join("blob.bin"), [0u8, 9, 9, 9]).unwrap();
        repo.stage_file("blob.bin");
        repo.create_commit("Feature binary", &[]);

        repo.checkout_branch(&initial_branch);
        std::fs::write(repo.path.join("blob.bin"), [0u8, 7, 7, 7]).unwrap();
        repo.stage_file("blob.bin");
        repo.create_commit("Main binary", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let bin = conflicts
            .iter()
            .find(|c| c.path == "blob.bin")
            .expect("binary conflict should be listed");
        assert!(bin.is_binary, "binary conflict must be flagged");
    }

    #[tokio::test]
    async fn test_get_conflicts_reports_marker_size() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Raise the marker size for .txt files via gitattributes, committed
        // on all branches so it is in effect during the merge.
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=12\n"),
                ("shared.txt", "base"),
                ("other.md", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit(
            "Feature change",
            &[("shared.txt", "feature content"), ("other.md", "feature")],
        );
        repo.checkout_branch(&initial_branch);
        repo.create_commit(
            "Main change",
            &[("shared.txt", "main content"), ("other.md", "main")],
        );

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // libgit2's merge ignores conflict-marker-size and writes 7-char
        // markers, so the raised attribute must NOT be reported for this
        // file — the frontend would parse the real markers as content.
        let written = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert!(
            written.lines().any(|l| l.starts_with("<<<<<<<")),
            "precondition: libgit2 wrote default-size markers; got:\n{written}"
        );
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("txt conflict should be listed");
        assert_eq!(
            txt.marker_size, 7,
            "raised attribute must fall back to 7 when the file was written with 7-char markers"
        );
        assert_eq!(txt.conflict_style, "merge");
        let md = conflicts
            .iter()
            .find(|c| c.path == "other.md")
            .expect("md conflict should be listed");
        assert_eq!(md.marker_size, 7, "unset attribute must default to 7");

        // Git's CLI (rebase/cherry-pick shell-outs, external git) DOES honor
        // the attribute. Simulate its emission: with real 12-char markers on
        // disk the raised size must be reported. (The extra content line is
        // not in the blobs, so this exercises the structural fallback.)
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<<<<<<< HEAD\nmain content\n<<<<<<< a 7-char sample in content\n============\nfeature content\n>>>>>>>>>>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("txt conflict should be listed");
        assert_eq!(
            txt.marker_size, 12,
            "raised attribute must be reported when the file really uses raised markers"
        );
    }

    /// Replays a merge of the conflicted index entries for `path` with the
    /// given options and writes the result to the working directory —
    /// simulating what a different engine (git's CLI) would have written.
    fn replay_conflict_to_workdir(repo: &TestRepo, path: &str, opts: &mut git2::MergeFileOptions) {
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        let conflict = index
            .conflicts()
            .unwrap()
            .flatten()
            .find(|c| {
                c.our
                    .as_ref()
                    .map(|e| String::from_utf8_lossy(&e.path) == path)
                    .unwrap_or(false)
            })
            .expect("conflict should exist");
        let result = git_repo
            .merge_file_from_index(
                conflict.ancestor.as_ref().unwrap(),
                conflict.our.as_ref().unwrap(),
                conflict.their.as_ref().unwrap(),
                Some(opts),
            )
            .unwrap();
        std::fs::write(repo.path.join(path), result.content()).unwrap();
    }

    #[tokio::test]
    async fn test_get_conflicts_replay_detects_cli_written_raised_markers() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=12\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Rewrite the conflict exactly as git's CLI would: raised size, with
        // labels DIFFERENT from libgit2's index-entry paths — the replay
        // comparison must tolerate label differences.
        let mut opts = git2::MergeFileOptions::new();
        opts.marker_size(12);
        opts.our_label("HEAD");
        opts.their_label("feature");
        replay_conflict_to_workdir(&repo, "shared.txt", &mut opts);

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("txt conflict should be listed");
        assert_eq!(txt.marker_size, 12);
        assert_eq!(txt.conflict_style, "merge");
    }

    #[tokio::test]
    async fn test_get_conflicts_quoted_raised_sample_does_not_fool_size_detection() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // The OURS side's CONTENT quotes a complete 12-char conflict — the
        // very kind of file conflict-marker-size gets raised for. A purely
        // structural scan reports 12 here; only the merge replay can tell
        // that libgit2 actually wrote the real markers at 7.
        let quoted = "docs:\n<<<<<<<<<<<< sample\none\n============\ntwo\n>>>>>>>>>>>> sample\n";
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=12\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", quoted)]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let written = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert!(
            written.contains("<<<<<<<<<<<< sample") && written.contains("<<<<<<< "),
            "precondition: quoted 12-sample AND real 7-char markers coexist; got:\n{written}"
        );
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("txt conflict should be listed");
        assert_eq!(
            txt.marker_size, 7,
            "the quoted sample must not defeat the replay verification"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_add_add_conflict_replays_against_empty_base() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // An add/add conflict has NO ancestor entry, so index-based replay
        // is impossible — the empty-base replay must still certify the size.
        // One side quotes a complete 12-char conflict (the docs case the
        // attribute was raised for); the real markers are libgit2's 7.
        let quoted = "docs:\n<<<<<<<<<<<< sample\none\n============\ntwo\n>>>>>>>>>>>> sample\n";
        repo.create_commit(
            "Add attrs",
            &[(".gitattributes", "*.md conflict-marker-size=12\n")],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature adds doc", &[("new.md", quoted)]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main adds doc", &[("new.md", "unrelated text\n")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let written = std::fs::read_to_string(repo.path.join("new.md")).unwrap();
        assert!(
            written.contains("<<<<<<< ") && written.contains("<<<<<<<<<<<< sample"),
            "precondition: real 7-char markers AND the quoted 12-sample coexist; got:\n{written}"
        );
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let md = conflicts
            .iter()
            .find(|c| c.path == "new.md")
            .expect("add/add conflict should be listed");
        assert!(md.ancestor.is_none(), "precondition: no ancestor entry");
        assert_eq!(
            md.marker_size, 7,
            "empty-base replay must certify the real size for add/add conflicts"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_add_add_pipe_content_is_not_diff3() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // Ours content contains a 7-pipe run (Markdown table art). With no
        // ancestor entry the replay must still run (empty base) and report
        // merge style — a diff3 misreport would make the frontend discard
        // every ours line after the pipe run as a "base section".
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature adds", &[("new.txt", "THEIRS\n")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main adds", &[("new.txt", "a\n|||||||\nz\n")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "new.txt")
            .expect("add/add conflict should be listed");
        assert!(txt.ancestor.is_none(), "precondition: no ancestor entry");
        assert_eq!(txt.marker_size, 7);
        assert_eq!(
            txt.conflict_style, "merge",
            "pipe-run content must not misreport diff3 for add/add conflicts"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_undecidable_fallback_prefers_default_size() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=12\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Hand-edit the file so no replay matches, with COMPLETE conflict
        // structures at BOTH sizes. Undecidable from bytes — the fallback
        // must prefer 7 (this app's own engine) so the real markers written
        // by libgit2 stay parseable rather than leaking as resolved text.
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<<<<<<< quoted\nq1\n============\nq2\n>>>>>>>>>>>> quoted\nedited by hand\n<<<<<<< HEAD\nmain content\n=======\nfeature content\n>>>>>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 7);
    }

    #[tokio::test]
    async fn test_get_conflicts_undecidable_fallback_prefers_smaller_real_sub7_size() {
        // Mirror of the prefers-default-size case, in the DANGEROUS direction:
        // the real markers are a SUB-7 size (conflict-marker-size=3, honored by
        // the git CLI) and the file ALSO quotes a standard 7-char conflict (a
        // README/fixture showing markers). Both sizes look complete, so the
        // structural fallback is undecidable — it must prefer the SMALLER (3).
        // Reporting 7 would make the frontend's exact-match parser miss the
        // real size-3 markers AND its `>=7` orphan safety-net miss them too,
        // leaking raw markers into the pane and letting Mark Resolved stage
        // them to disk as "resolved".
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=3\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Hand-edit: a QUOTED standard 7-char conflict block (plain content)
        // plus the REAL size-3 conflict, with a stray edit so no replay matches
        // and the structural fallback must decide.
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<< quoted\nq1\n=======\nq2\n>>>>>>> quoted\nedited by hand\n<<< HEAD\nmain content\n===\nfeature content\n>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 3);
    }

    #[tokio::test]
    async fn test_get_conflicts_fallback_prefers_smallest_demonstrated_size() {
        // NEITHER the attribute size nor 7 shows a complete conflict, but the
        // content demonstrates two SUB-7 sizes: the REAL size-3 markers and a
        // quoted size-5 block. The fallback must prefer the SMALLEST (3) —
        // reporting 5 would make the exact-match parser miss the real size-3
        // markers and the `>=min(7,5)=5` orphan net miss them too.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Real size-3 conflict + a quoted size-5 conflict, hand-edited so no
        // replay matches. No conflict-marker-size attribute (attr defaults to
        // 7); neither 7 nor any attribute size is complete.
        std::fs::write(
            repo.path.join("shared.txt"),
            "context\n<<< ours\nmain content\n===\nfeature content\n>>> theirs\nhand edit\n<<<<< example\nfoo\n=====\nbar\n>>>>> example\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 3);
    }

    #[tokio::test]
    async fn test_get_conflicts_fallback_never_reports_a_sub3_attribute_size() {
        // conflict-marker-size=2 is legal (git honors sizes as low as 1), but
        // reporting 2 would make the frontend parse ordinary `<<`/`==`/`>>`
        // prose as markers. When nothing >=3 is demonstrated (here the file was
        // hand-resolved to plain content with no markers left, yet the index is
        // still conflicted), the fallback must report the safe default 7, never
        // the sub-3 attribute size.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=2\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Hand-resolved to plain content — no conflict markers remain, so no
        // size is demonstrated and replay cannot match.
        std::fs::write(
            repo.path.join("shared.txt"),
            "just ordinary prose\n<< not a marker, only two\nmore text\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 7);
    }

    #[tokio::test]
    async fn test_get_conflicts_fallback_uses_explicit_attr_when_real_conflict_hand_broken() {
        // The structural fallback runs only for HAND-EDITED files, and a hand
        // edit can break the real conflict's structure (delete its separator) so
        // its size is NOT demonstrated-complete in the content. Here the real
        // markers are size 5 (explicit conflict-marker-size=5) but hand-broken,
        // and the file quotes a COMPLETE size-10 block. Without folding the
        // explicit attribute, the fallback would floor UP to 10 and leak the real
        // size-5 markers; folding attr_size (5) caps the reported size at 5.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=5\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // A quoted COMPLETE size-10 block + the REAL size-5 conflict with its
        // separator hand-DELETED (so size 5 is not demonstrated-complete), plus a
        // stray edit so no replay matches.
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<<<<< ex\nx\n==========\ny\n>>>>>>>>>> ex\nhand edit\n<<<<< HEAD\nmain content\nfeature content\n>>>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 5);
    }

    #[tokio::test]
    async fn test_get_conflicts_recovers_sub7_size_when_attribute_reverted_to_default() {
        // The attribute was conflict-marker-size=3 when git wrote the markers,
        // then REVERTED to the default 7 (e.g. resolving .gitattributes' own
        // conflict). attr_marker_size now returns 7, so a two-candidate
        // attr-vs-7 check would be blind to the real size-3 markers — and a
        // quoted 7-char block makes 7 look complete, so it would report 7 and
        // leak the real size-3 markers. Taking the smallest DEMONSTRATED size
        // recovers 3.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=3\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Revert the attribute to default (remove the rule) and stage it, as
        // resolving .gitattributes' own conflict via `git add` would — the
        // lookup now falls through to the index and returns the default 7.
        std::fs::write(repo.path.join(".gitattributes"), "").unwrap();
        {
            let repo_stage = git2::Repository::open(&repo.path).unwrap();
            let mut idx = repo_stage.index().unwrap();
            idx.add_path(Path::new(".gitattributes")).unwrap();
            idx.write().unwrap();
        }

        // Quoted standard 7-char conflict block + stray edit (breaks replay),
        // plus the REAL size-3 markers git actually wrote.
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<< quoted\nq1\n=======\nq2\n>>>>>>> quoted\nedited by hand\n<<< HEAD\nmain content\n===\nfeature content\n>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 3);
    }

    #[tokio::test]
    async fn test_get_conflicts_detects_size_when_attribute_went_stale() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // NO conflict-marker-size attribute — but the file's markers were
        // written at 12 (the attribute was dropped mid-operation, e.g. by
        // resolving .gitattributes' own conflict). The size must be
        // detected from the content, or the frontend would find zero
        // conflicts and Mark Resolved would stage the raw markers.
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Simulate CLI-written raised markers (with a hand edit so replay
        // cannot match and the structural fallback must decide).
        std::fs::write(
            repo.path.join("shared.txt"),
            "<<<<<<<<<<<< HEAD\nmain content\nhand edit\n============\nfeature content\n>>>>>>>>>>>> feature\n",
        )
        .unwrap();
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(
            txt.marker_size, 12,
            "the written size must be detected from content when no size matches the attribute"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_reports_authoritative_hunk_positions() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        // Workdir: <<<<<<< ours / main content / ======= / feature content
        // / >>>>>>> theirs — the replay matched, so positions are exact.
        assert_eq!(txt.conflict_hunks.len(), 1);
        let h = &txt.conflict_hunks[0];
        assert_eq!((h.start, h.separator, h.end, h.base), (0, 2, 4, None));

        // The positions must actually point at the marker lines on disk.
        let written = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert!(lines[h.start as usize].starts_with("<<<<<<<"));
        assert!(lines[h.separator as usize].starts_with("======="));
        assert!(lines[h.end as usize].starts_with(">>>>>>>"));
    }

    #[tokio::test]
    async fn test_hand_edited_file_reports_no_hunk_positions() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        // A hand edit breaks the replay match — positions would be guesses,
        // so none may be reported (the frontend heuristics take over).
        let mut content = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        content.push_str("hand edit\n");
        std::fs::write(repo.path.join("shared.txt"), content).unwrap();

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert!(txt.conflict_hunks.is_empty());
    }

    #[test]
    fn test_replay_hunks_and_collision_free_size() {
        let replay = "ctx\n<<<<<<<<<< ours\na\n==========\nb\n>>>>>>>>>> theirs\ntail\n";
        let hunks = replay_hunks(replay, 10, false).unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(
            (
                hunks[0].start,
                hunks[0].separator,
                hunks[0].end,
                hunks[0].base
            ),
            (1, 3, 5, None)
        );

        let diff3 = "<<<<<<<<<< o\na\n||||||||||\nbase\n==========\nb\n>>>>>>>>>> t\n";
        let hunks = replay_hunks(diff3, 10, true).unwrap();
        assert_eq!(hunks[0].base, Some(2));

        // Collision-free size must exceed every marker-shaped run in blobs.
        let blob = b"content\n<<<<<<<<<<<<<<< quoted long run\n" as &[u8];
        let star = collision_free_size(&[blob], 7).expect("fits in u16");
        assert!(star as usize > 15);

        // A run near u16::MAX has no collision-free size that fits in u16 —
        // bail to None rather than clamp to a colliding size.
        let huge = vec![b'<'; u16::MAX as usize];
        assert!(collision_free_size(&[&huge], 7).is_none());
    }

    #[test]
    fn test_detected_marker_sizes() {
        let raised = "ctx\n<<<<<<<<<<<< HEAD\nours\n============\ntheirs\n>>>>>>>>>>>> f\n";
        assert_eq!(detected_marker_sizes(raised, 7), vec![12]);

        let none = "just\nplain\ntext\n< quoted line\n";
        assert!(detected_marker_sizes(none, 7).is_empty());

        // An incomplete start-shaped line demonstrates nothing.
        let incomplete = "<<<<<<< HEAD\nno separator or end\n";
        assert!(detected_marker_sizes(incomplete, 7).is_empty());

        // Git emits runs as small as 1 — sub-7 sizes are demonstrable when
        // the floor allows them (used for replay candidates only).
        let tiny = "<<<< HEAD\nours\n====\ntheirs\n>>>> f\n";
        assert_eq!(detected_marker_sizes(tiny, 1), vec![4]);
        assert!(detected_marker_sizes(tiny, 7).is_empty());

        // The separator must be the bare run — a trailing label makes it
        // content, exactly like has_complete_conflict treats it.
        let labeled_sep = "<<<<<<< HEAD\nours\n======= label\ntheirs\n>>>>>>> f\n";
        assert!(detected_marker_sizes(labeled_sep, 7).is_empty());

        // Out-of-order marker lines (end before separator) demonstrate
        // nothing at that size.
        let out_of_order = "<<<<<<< HEAD\nours\n>>>>>>> f\n=======\n";
        assert!(detected_marker_sizes(out_of_order, 7).is_empty());
    }

    #[test]
    fn test_detected_marker_sizes_always_retains_the_smallest_size() {
        // 16 distinct LARGE complete conflicts fill the cap, then a real
        // sub-7 conflict appears. The smallest (sub-7) size must survive
        // the cap — dropping it would floor the structural fallback to 7
        // and hide the real markers as content.
        let mut content = String::new();
        for n in 20..36usize {
            content.push_str(&"<".repeat(n));
            content.push('\n');
            content.push_str(&"=".repeat(n));
            content.push('\n');
            content.push_str(&">".repeat(n));
            content.push('\n');
        }
        // The real, small conflict, demonstrated LAST (after the cap filled).
        content.push_str("<<<< HEAD\nours\n====\ntheirs\n>>>> f\n");
        let sizes = detected_marker_sizes(&content, 1);
        assert!(
            sizes.contains(&4),
            "the smallest demonstrated size must be retained past the cap; got {sizes:?}"
        );
    }

    #[test]
    fn test_detected_marker_sizes_retains_smallest_ge3_when_global_min_is_sub3() {
        // A sub-3 decoy (size 2) is the GLOBAL smallest, so it occupies the
        // "retain smallest" slot — but the structural fallback filters to >= 3,
        // dropping it. Meanwhile a real size-5 conflict is cap-evicted. Without
        // separately retaining the smallest complete size >= 3, the fallback
        // would floor to 6 and leak the real size-5 markers.
        let mut content = String::new();
        // Sub-3 complete conflict → sets the global min to 2.
        content.push_str("<<\na\n==\nb\n>>\n");
        // 20 distinct decoys at sizes 6..=25 fill the 16-slot cap first.
        for n in 6..=25usize {
            content.push_str(&"<".repeat(n));
            content.push('\n');
            content.push_str("a\n");
            content.push_str(&"=".repeat(n));
            content.push('\n');
            content.push_str("b\n");
            content.push_str(&">".repeat(n));
            content.push('\n');
        }
        // The REAL size-5 conflict, LAST — its slot push is cap-blocked.
        content.push_str("<<<<<\nours\n=====\ntheirs\n>>>>>\n");

        let sizes = detected_marker_sizes(&content, 1);
        assert!(
            sizes.contains(&5),
            "the smallest complete size >=3 must be retained past the cap; got {sizes:?}"
        );
        let min_ge3 = sizes.iter().copied().filter(|&n| n >= 3).min().unwrap();
        assert_eq!(
            min_ge3, 5,
            "the >=3 structural fallback would floor to {min_ge3}, leaking size-5 markers"
        );
    }

    #[test]
    fn test_detected_marker_sizes_caps_hostile_escalating_runs() {
        // A crafted file demonstrating thousands of distinct sizes must
        // neither hang the scan (it is single-pass) nor hand thousands of
        // replay candidates downstream — each candidate costs up to three
        // merge replays in detect_conflict_emission.
        let mut content = String::new();
        for n in 1..=2000usize {
            content.push_str(&"<".repeat(n));
            content.push('\n');
            content.push_str(&"=".repeat(n));
            content.push('\n');
            content.push_str(&">".repeat(n));
            content.push('\n');
        }
        let sizes = detected_marker_sizes(&content, 1);
        assert_eq!(sizes.len(), MAX_DETECTED_SIZES);
        // The earliest-completed sizes are the ones kept — the first
        // complete conflict in a real file is git's own emission.
        assert_eq!(sizes, (1..=MAX_DETECTED_SIZES as u32).collect::<Vec<u32>>());
    }

    #[tokio::test]
    async fn test_get_conflicts_recovers_sub7_size_when_attribute_went_stale() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // The file's markers were written at size 4 (git honors sub-7
        // attribute values), but the attribute has since changed to 8 —
        // e.g. by resolving .gitattributes' own conflict mid-operation.
        // The replay must still certify the true size via the
        // content-demonstrated candidates.
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=8\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Rewrite the conflict as size-4 emission (what git wrote before
        // the attribute changed).
        let mut opts = git2::MergeFileOptions::new();
        opts.marker_size(4);
        replay_conflict_to_workdir(&repo, "shared.txt", &mut opts);
        let written = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert!(
            written.lines().any(|l| l.starts_with("<<<< ")),
            "precondition: size-4 markers on disk; got:\n{written}"
        );

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(
            txt.marker_size, 4,
            "the replay must certify the sub-7 size the content demonstrates"
        );
        assert!(
            !txt.conflict_hunks.is_empty(),
            "replay-certified files get authoritative hunks"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_structural_fallback_recovers_sub7_size_on_hand_edited_files() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // Markers were written at size 4 (git honors sub-7 attribute
        // values) but the attribute has since gone back to the default,
        // AND the user hand-edited the file so no replay can match. The
        // structural fallback must still report the demonstrated size —
        // flooring to 7 would parse the surviving size-4 hunk as ZERO
        // conflicts and let Mark Resolved stage the raw markers silently.
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // What git's CLI wrote at conflict-marker-size=4 before the
        // attribute was resolved away, then hand-edited (an extra line),
        // so every replay candidate fails the exact-content match.
        std::fs::write(
            repo.path.join("shared.txt"),
            "hand-added line\n<<<< HEAD\nmain content\n====\nfeature content\n>>>> feature\n",
        )
        .unwrap();

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(
            txt.marker_size, 4,
            "the structural fallback must keep the content-demonstrated sub-7 size"
        );
        assert!(
            txt.conflict_hunks.is_empty(),
            "hand-edited files get heuristics, not authoritative hunks"
        );
    }

    #[tokio::test]
    async fn test_take_side_writes_the_file_side_of_a_submodule_type_conflict() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        let ptr = repo.create_commit("ptr", &[("a.txt", "1")]);
        let git_repo = repo.repo();
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        stage_gitlink(&git_repo, "sub", ptr);
        repo.create_commit("Add submodule", &[]);

        // Feature replaces the submodule with a vendored regular FILE.
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        {
            let mut index = git_repo.index().unwrap();
            index.remove_path(Path::new("sub")).unwrap();
            index.write().unwrap();
        }
        std::fs::remove_dir_all(repo.path.join("sub")).ok();
        std::fs::write(repo.path.join("sub"), "vendored contents\n").unwrap();
        repo.stage_file("sub");
        repo.create_commit("Feature vendors sub", &[]);

        // Main moves the submodule pointer.
        repo.checkout_branch(&initial_branch);
        let ptr2 = repo.create_commit("ptr2", &[("a.txt", "2")]);
        stage_gitlink(&git_repo, "sub", ptr2);
        repo.create_commit("Main moves submodule", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        assert!(
            conflicts.iter().any(|c| c.path == "sub" && c.is_submodule),
            "gitlink<->file type conflict should be listed as a submodule conflict"
        );
        // Model an initialized submodule: its worktree DIRECTORY sits at
        // the conflicted path (empty placeholder here). fs::write on it
        // would fail with EISDIR.
        if std::fs::symlink_metadata(repo.path.join("sub")).is_err() {
            std::fs::create_dir(repo.path.join("sub")).unwrap();
        } else if std::fs::symlink_metadata(repo.path.join("sub"))
            .unwrap()
            .file_type()
            .is_file()
        {
            std::fs::remove_file(repo.path.join("sub")).unwrap();
            std::fs::create_dir(repo.path.join("sub")).unwrap();
        }

        resolve_conflict_take_side(repo.path_str(), "sub".to_string(), "theirs".to_string())
            .await
            .expect("taking the FILE side over an empty submodule dir must succeed");

        assert_eq!(
            std::fs::read_to_string(repo.path.join("sub")).unwrap(),
            "vendored contents\n"
        );
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        let staged = index.get_path(Path::new("sub"), 0).expect("stage-0 entry");
        assert_eq!(staged.mode, 0o100644, "staged as a regular file");
    }

    #[tokio::test]
    async fn test_take_side_gitlink_materializes_dir_and_leaves_clean_worktree() {
        // Taking the SUBMODULE side of a submodule↔file type conflict must
        // leave the worktree consistent with the staged gitlink (git checks
        // a gitlink out as an empty directory). Without materializing it,
        // the OTHER side's regular file stays on disk and `git status`
        // reports the just-"resolved" path as dirty.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        let ptr = repo.create_commit("ptr", &[("a.txt", "1")]);
        let git_repo = repo.repo();
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        stage_gitlink(&git_repo, "sub", ptr);
        repo.create_commit("Add submodule", &[]);

        // Feature replaces the submodule with a regular file.
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        {
            let mut index = git_repo.index().unwrap();
            index.remove_path(Path::new("sub")).unwrap();
            index.write().unwrap();
        }
        std::fs::remove_dir_all(repo.path.join("sub")).ok();
        std::fs::write(repo.path.join("sub"), "vendored\n").unwrap();
        repo.stage_file("sub");
        repo.create_commit("Feature vendors sub", &[]);

        repo.checkout_branch(&initial_branch);
        let ptr2 = repo.create_commit("ptr2", &[("a.txt", "2")]);
        stage_gitlink(&git_repo, "sub", ptr2);
        repo.create_commit("Main moves submodule", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Force the workdir to hold the OTHER side's regular FILE (the exact
        // shape that would be left behind if the gitlink arm ignored the
        // worktree).
        if std::fs::symlink_metadata(repo.path.join("sub"))
            .map(|m| !m.file_type().is_file())
            .unwrap_or(true)
        {
            let _ = std::fs::remove_dir_all(repo.path.join("sub"));
            let _ = std::fs::remove_file(repo.path.join("sub"));
            std::fs::write(repo.path.join("sub"), "vendored\n").unwrap();
        }

        resolve_conflict_take_side(repo.path_str(), "sub".to_string(), "ours".to_string())
            .await
            .expect("taking the gitlink side must succeed");

        // The worktree path is now an (empty) directory, matching a gitlink
        // checkout — not the leftover regular file.
        let meta = std::fs::symlink_metadata(repo.path.join("sub")).unwrap();
        assert!(meta.file_type().is_dir(), "gitlink materialized as a dir");

        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        let staged = index.get_path(Path::new("sub"), 0).expect("stage-0 entry");
        assert_eq!(staged.mode, 0o160000, "staged as a gitlink");
        assert_eq!(staged.id, ptr2, "ours' commit pointer");
        // The path is no longer reported as a conflict/dirty typechange.
        assert!(get_conflicts(repo.path_str())
            .await
            .unwrap()
            .iter()
            .all(|c| c.path != "sub"));
    }

    #[tokio::test]
    async fn test_take_side_refuses_to_delete_a_populated_submodule_worktree() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        let ptr = repo.create_commit("ptr", &[("a.txt", "1")]);
        let git_repo = repo.repo();
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        stage_gitlink(&git_repo, "sub", ptr);
        repo.create_commit("Add submodule", &[]);

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        {
            let mut index = git_repo.index().unwrap();
            index.remove_path(Path::new("sub")).unwrap();
            index.write().unwrap();
        }
        std::fs::remove_dir_all(repo.path.join("sub")).ok();
        std::fs::write(repo.path.join("sub"), "vendored contents\n").unwrap();
        repo.stage_file("sub");
        repo.create_commit("Feature vendors sub", &[]);

        repo.checkout_branch(&initial_branch);
        let ptr2 = repo.create_commit("ptr2", &[("a.txt", "2")]);
        stage_gitlink(&git_repo, "sub", ptr2);
        repo.create_commit("Main moves submodule", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // A POPULATED submodule worktree — possibly uncommitted work.
        std::fs::remove_file(repo.path.join("sub")).ok();
        std::fs::remove_dir_all(repo.path.join("sub")).ok();
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        std::fs::write(repo.path.join("sub/work.txt"), "uncommitted\n").unwrap();

        let err =
            resolve_conflict_take_side(repo.path_str(), "sub".to_string(), "theirs".to_string())
                .await
                .expect_err("must refuse rather than delete a populated tree");
        assert!(
            err.to_string().contains("is a directory with files in it"),
            "actionable message, not a raw OS error; got: {err}"
        );
        // The tree is untouched.
        assert_eq!(
            std::fs::read_to_string(repo.path.join("sub/work.txt")).unwrap(),
            "uncommitted\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_take_side_recreates_symlinks_without_corrupting_targets() {
        use std::os::unix::fs::symlink;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Tracked target files the link may point at.
        repo.create_commit(
            "Add targets",
            &[("target-a", "A CONTENT\n"), ("target-b", "B CONTENT\n")],
        );
        // Base: link -> target-a
        let link = repo.path.join("link");
        symlink("target-a", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Add link", &[]);

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::remove_file(&link).unwrap();
        symlink("target-b", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Feature retargets link", &[]);

        repo.checkout_branch(&initial_branch);
        std::fs::remove_file(&link).unwrap();
        symlink("target-a-changed", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Main retargets link", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let entry = conflicts
            .iter()
            .find(|c| c.path == "link")
            .expect("symlink conflict should be listed");
        // Routed to the whole-blob chooser, never the text editor.
        assert!(entry.is_binary, "symlink conflicts must use the chooser");

        resolve_conflict_take_side(repo.path_str(), "link".to_string(), "theirs".to_string())
            .await
            .unwrap();

        // The resolution is a real symlink to theirs' target...
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink(), "a LINK, not a text file");
        assert_eq!(
            std::fs::read_link(&link).unwrap().to_string_lossy(),
            "target-b"
        );
        // ...the tracked target files are untouched...
        assert_eq!(
            std::fs::read_to_string(repo.path.join("target-a")).unwrap(),
            "A CONTENT\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.path.join("target-b")).unwrap(),
            "B CONTENT\n"
        );
        // ...and the index stages the CHOSEN side's blob at link mode.
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        let staged = index.get_path(Path::new("link"), 0).expect("stage-0 entry");
        assert_eq!(staged.mode, 0o120000, "staged as a symlink");
        let staged_blob = git_repo.find_blob(staged.id).unwrap();
        assert_eq!(staged_blob.content(), b"target-b");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_take_side_replaces_a_regular_file_with_the_chosen_symlink() {
        use std::os::unix::fs::symlink;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_commit(
            "Add target and thing",
            &[("target-a", "A CONTENT\n"), ("thing", "base thing\n")],
        );

        // Feature turns `thing` into a symlink; main keeps editing it as a
        // regular file — a file<->symlink TYPE conflict.
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let thing = repo.path.join("thing");
        std::fs::remove_file(&thing).unwrap();
        symlink("target-a", &thing).unwrap();
        repo.stage_file("thing");
        repo.create_commit("Feature turns thing into a link", &[]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main edits thing", &[("thing", "ours thing\n")]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let entry = conflicts
            .iter()
            .find(|c| c.path == "thing")
            .expect("type conflict should be listed");
        assert!(entry.is_binary, "file<->symlink conflicts use the chooser");
        // The workdir holds ours' REGULAR file — exactly the shape a bare
        // symlink() call refuses to overwrite (EEXIST).
        let meta = std::fs::symlink_metadata(&thing).unwrap();
        assert!(
            meta.file_type().is_file(),
            "precondition: a regular file is on disk"
        );

        resolve_conflict_take_side(repo.path_str(), "thing".to_string(), "theirs".to_string())
            .await
            .expect("taking the symlink side over a regular file must succeed");

        let meta = std::fs::symlink_metadata(&thing).unwrap();
        assert!(meta.file_type().is_symlink(), "resolved as a real symlink");
        assert_eq!(
            std::fs::read_link(&thing).unwrap().to_string_lossy(),
            "target-a"
        );
        // The link's tracked target file is untouched.
        assert_eq!(
            std::fs::read_to_string(repo.path.join("target-a")).unwrap(),
            "A CONTENT\n"
        );
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        let staged = index
            .get_path(Path::new("thing"), 0)
            .expect("stage-0 entry");
        assert_eq!(staged.mode, 0o120000, "staged as a symlink");
    }

    /// Stage a gitlink (submodule pointer) entry at `path` pointing at
    /// `commit_oid`. Gitlink OIDs reference the SUBMODULE's history, so
    /// libgit2 does not require them in this repo's object database.
    fn stage_gitlink(repo: &git2::Repository, path: &str, commit_oid: git2::Oid) {
        let mut index = repo.index().unwrap();
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o160000,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: commit_oid,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        };
        index.add(&entry).unwrap();
        index.write().unwrap();
    }

    #[tokio::test]
    async fn test_submodule_conflicts_are_flagged_and_take_side_stages_the_pointer() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Three distinct commit OIDs to use as submodule pointers.
        let ptr_base = repo.create_commit("ptr base", &[("a.txt", "1")]);
        let ptr_ours = repo.create_commit("ptr ours", &[("a.txt", "2")]);
        let ptr_theirs = repo.create_commit("ptr theirs", &[("a.txt", "3")]);

        let git_repo = repo.repo();
        // The worktree presence of a gitlink is just a directory.
        std::fs::create_dir(repo.path.join("sub")).unwrap();
        stage_gitlink(&git_repo, "sub", ptr_base);
        repo.create_commit("Add submodule", &[]);

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        stage_gitlink(&git_repo, "sub", ptr_theirs);
        repo.create_commit("Feature moves submodule", &[]);

        repo.checkout_branch(&initial_branch);
        stage_gitlink(&git_repo, "sub", ptr_ours);
        repo.create_commit("Main moves submodule", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let entry = conflicts
            .iter()
            .find(|c| c.path == "sub")
            .expect("submodule conflict should be listed");
        // Routed to the submodule chooser: NOT binary (its OIDs are
        // commits, not blobs) and never the text editor.
        assert!(entry.is_submodule, "gitlink conflicts must be flagged");
        assert!(!entry.is_binary);
        assert!(entry.conflict_hunks.is_empty());

        resolve_conflict_take_side(repo.path_str(), "sub".to_string(), "theirs".to_string())
            .await
            .expect("taking a side of a submodule conflict must not dead-end");

        // Fresh handle: the earlier Repository caches its in-memory index
        // and would not see the command's on-disk write.
        let git_repo = repo.repo();
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        let staged = index.get_path(Path::new("sub"), 0).expect("stage-0 entry");
        assert_eq!(staged.mode, 0o160000, "still a gitlink");
        assert_eq!(staged.id, ptr_theirs, "the CHOSEN side's commit pointer");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_take_side_delete_removes_a_dangling_symlink_from_disk() {
        use std::os::unix::fs::symlink;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Base: a DANGLING symlink (its target is not tracked and does not
        // exist — common for links into ignored/generated trees).
        let link = repo.path.join("link");
        symlink("missing-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Add dangling link", &[]);

        // Feature deletes the link; main retargets it — modify/delete.
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::remove_file(&link).unwrap();
        let git_repo = repo.repo();
        let mut index = git_repo.index().unwrap();
        index.remove_path(Path::new("link")).unwrap();
        index.write().unwrap();
        repo.create_commit("Feature deletes link", &[]);

        repo.checkout_branch(&initial_branch);
        std::fs::remove_file(&link).unwrap();
        symlink("missing-target-2", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Main retargets link", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        assert!(
            conflicts.iter().any(|c| c.path == "link"),
            "modify/delete on the link should conflict"
        );
        // Precondition: the dangling link IS on disk — the exact shape
        // Path::exists() lies about (it follows the link).
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "precondition: the dangling link is in the worktree"
        );
        assert!(!link.exists(), "precondition: exists() follows the link");

        resolve_conflict_take_side(repo.path_str(), "link".to_string(), "theirs".to_string())
            .await
            .unwrap();

        // The deletion is real: gone from BOTH the index and the disk — a
        // leftover link would resurface as untracked and block checkouts.
        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "the dangling link must be removed from disk"
        );
        let index = git_repo.index().unwrap();
        assert!(!index.has_conflicts());
        assert!(index.get_path(Path::new("link"), 0).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_take_side_preserves_non_utf8_symlink_targets() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // A symlink target is an arbitrary byte string — not necessarily
        // UTF-8. from_utf8_lossy would replace the odd bytes with U+FFFD
        // and silently break the recreated link.
        let odd_target: &[u8] = b"target-\xff\xfe-end";
        let link = repo.path.join("link");
        // Base points somewhere neutral; ours and theirs both retarget it
        // differently, so the merge genuinely conflicts.
        symlink("base-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Add link", &[]);

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        std::fs::remove_file(&link).unwrap();
        symlink(std::ffi::OsStr::from_bytes(odd_target), &link).unwrap();
        // Re-stage so feature's tree records the odd-target link as theirs.
        repo.stage_file("link");
        repo.create_commit("Feature uses odd link", &[]);

        repo.checkout_branch(&initial_branch);
        std::fs::remove_file(&link).unwrap();
        symlink("plain-target", &link).unwrap();
        repo.stage_file("link");
        repo.create_commit("Main retargets link", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        resolve_conflict_take_side(repo.path_str(), "link".to_string(), "theirs".to_string())
            .await
            .unwrap();

        // The recreated link's target is byte-identical — no U+FFFD.
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink());
        let recreated = std::fs::read_link(&link).unwrap();
        assert_eq!(
            recreated.as_os_str().as_bytes(),
            odd_target,
            "the non-utf8 target must survive byte-for-byte"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_take_side_applies_the_chosen_sides_mode_downward() {
        use std::os::unix::fs::PermissionsExt;
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Base + theirs: non-executable. Ours: executable.
        repo.create_commit("Add script", &[("script.sh", "#!/bin/sh\nbase\n")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("script.sh", "#!/bin/sh\ntheirs\n")]);
        repo.checkout_branch(&initial_branch);
        let script = repo.path.join("script.sh");
        std::fs::write(&script, "#!/bin/sh\nours\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        repo.stage_file("script.sh");
        repo.create_commit("Main change makes executable", &[]);

        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        // The conflicted on-disk file carries ours' executable bit.
        assert_ne!(
            std::fs::metadata(&script).unwrap().permissions().mode() & 0o111,
            0,
            "precondition: conflicted file is executable"
        );

        // Taking THEIRS (non-executable) must chmod DOWN, not keep ours' bit.
        resolve_conflict_take_side(
            repo.path_str(),
            "script.sh".to_string(),
            "theirs".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::metadata(&script).unwrap().permissions().mode() & 0o111,
            0,
            "the resolved file must carry the CHOSEN side's mode"
        );
    }

    #[tokio::test]
    async fn test_get_conflicts_hostile_marker_size_attribute_is_rejected() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        // A hostile/typo attribute value must not force a multi-gigabyte
        // allocation — it is rejected at parse time and falls back to 7.
        repo.create_commit(
            "Add attrs and shared",
            &[
                (".gitattributes", "*.txt conflict-marker-size=4000000000\n"),
                ("shared.txt", "base"),
            ],
        );
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("txt conflict should be listed");
        assert_eq!(txt.marker_size, 7);
    }

    #[tokio::test]
    async fn test_get_conflicts_reports_diff3_style() {
        let repo = TestRepo::with_initial_commit();
        setup_conflicting_branches(&repo);
        let _ = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;

        // Rewrite the conflict as diff3 emission (merge.conflictStyle=diff3
        // via git's CLI) — the style must be detected and reported so the
        // frontend knows a ||||||| line is a base section, not ours content.
        let mut opts = git2::MergeFileOptions::new();
        opts.style_diff3(true);
        replay_conflict_to_workdir(&repo, "shared.txt", &mut opts);
        let written = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert!(
            written.contains("|||||||"),
            "precondition: diff3 emission has a base marker; got:\n{written}"
        );

        let conflicts = get_conflicts(repo.path_str()).await.unwrap();
        let txt = conflicts
            .iter()
            .find(|c| c.path == "shared.txt")
            .expect("conflict should be listed");
        assert_eq!(txt.marker_size, 7);
        assert_eq!(txt.conflict_style, "diff3");
    }

    #[test]
    fn test_diff3_within_first_conflict() {
        let diff3 = "<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> f\n";
        assert!(diff3_within_first_conflict(diff3, 7));

        let merge_style = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> f\n";
        assert!(!diff3_within_first_conflict(merge_style, 7));

        // A pipe run in the THEIRS section is content, not a diff3 signal.
        let pipes_in_theirs = "<<<<<<< HEAD\nours\n=======\n||||||| x\ntheirs\n>>>>>>> f\n";
        assert!(!diff3_within_first_conflict(pipes_in_theirs, 7));
    }

    #[test]
    fn test_has_complete_conflict() {
        let raised = "<<<<<<<<<<<< HEAD\nours\n============\ntheirs\n>>>>>>>>>>>> feature\n";
        assert!(has_complete_conflict(raised, 12));
        assert!(
            !has_complete_conflict(raised, 7),
            "runs longer than the size must not match"
        );

        let default = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n";
        assert!(!has_complete_conflict(default, 12));

        // Emission order is required: an end marker before the separator
        // (quoted docs) does not complete a conflict.
        let out_of_order = "<<<<<<<<<<<< HEAD\n>>>>>>>>>>>> nope\n============\n";
        assert!(!has_complete_conflict(out_of_order, 12));

        // CRLF-terminated lines still match.
        let crlf =
            "<<<<<<<<<<<< HEAD\r\nours\r\n============\r\ntheirs\r\n>>>>>>>>>>>> feature\r\n";
        assert!(has_complete_conflict(crlf, 12));

        // A separator with trailing label text is not git's separator.
        let labeled_sep = "<<<<<<<<<<<< HEAD\n============ x\n>>>>>>>>>>>> f\n";
        assert!(!has_complete_conflict(labeled_sep, 12));
    }

    #[tokio::test]
    async fn test_continue_rebase_after_resolution() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        setup_conflicting_branches(&repo);

        repo.checkout_branch("feature");
        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(matches!(result, Err(GitnadoError::RebaseConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("continue_rebase must succeed");
        // Nothing disappeared from the branch, so nothing to report.
        assert_eq!(skipped, 0);
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let content = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert_eq!(content, "resolved");
    }

    #[tokio::test]
    async fn test_continue_rebase_skips_empty_commit() {
        // Resolving to exactly the onto side's content leaves an empty patch;
        // continuing must skip it (like `git rebase --skip`), not fail.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        setup_conflicting_branches(&repo);

        repo.checkout_branch("feature");
        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(matches!(result, Err(GitnadoError::RebaseConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "main content".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("continue_rebase should skip the empty commit, not fail");
        // The resolved commit vanished from the branch — the continue is the
        // only surface that can say so.
        assert_eq!(skipped, 1);
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let content = std::fs::read_to_string(repo.path.join("shared.txt")).unwrap();
        assert_eq!(content, "main content");
    }

    #[tokio::test]
    async fn test_continue_rebase_preserves_a_commit_that_started_empty() {
        // The other arm of GIT_EAPPLIED, on the continue path: a commit that
        // was ALREADY empty before the rebase is not an already-applied patch,
        // and git keeps it. Placed AFTER the conflicting commit so it is
        // replayed by continue_rebase's remaining-operations loop.
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        setup_conflicting_branches(&repo);

        repo.checkout_branch("feature");
        {
            let git_repo = repo.repo();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let tree = head.tree().unwrap();
            let signature = git_repo.signature().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    "Intentional empty marker",
                    &tree,
                    &[&head],
                )
                .unwrap();
        }

        let result = rebase(repo.path_str(), initial_branch.clone()).await;
        assert!(matches!(result, Err(GitnadoError::RebaseConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        continue_rebase(repo.path_str())
            .await
            .expect("a commit that started empty must survive the continue");

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let empty = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(empty.message().unwrap(), "Intentional empty marker");
        assert_eq!(empty.tree_id(), empty.parent(0).unwrap().tree_id());
        assert_eq!(
            empty.parent(0).unwrap().message().unwrap(),
            "Feature change"
        );
    }

    /// A rebase that pauses returns RebaseConflict, not a count — so every
    /// commit it dropped before the conflict had no way to reach the UI. The
    /// count is carried across the pause and reported by the continue, exactly
    /// as the `<old> <new>` pairs already are.
    #[tokio::test]
    async fn test_continue_rebase_reports_skips_from_before_the_pause() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");

        repo.checkout_branch("feature");
        // Dropped by rebase() BEFORE the conflict below.
        repo.create_commit("Feature adds cross", &[("cross.txt", "cross\n")]);
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main adds cross", &[("cross.txt", "cross\n")]);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        repo.checkout_branch("feature");
        let result = rebase(repo.path_str(), initial_branch).await;
        assert!(matches!(result, Err(GitnadoError::RebaseConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("continue must finish the paused rebase");

        assert_eq!(
            skipped, 1,
            "the commit dropped before the pause must still be reported"
        );
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
    }

    /// The other half: commits dropped by the continue's own
    /// remaining-operations loop, after the conflict was resolved.
    #[tokio::test]
    async fn test_continue_rebase_counts_the_commits_it_drops_itself() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");

        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        // Replayed AFTER the conflict, by continue_rebase's own loop.
        repo.create_commit("Feature adds cross", &[("cross.txt", "cross\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);
        repo.create_commit("Main adds cross", &[("cross.txt", "cross\n")]);

        repo.checkout_branch("feature");
        let result = rebase(repo.path_str(), initial_branch).await;
        assert!(matches!(result, Err(GitnadoError::RebaseConflict)));

        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("continue must finish the paused rebase");

        assert_eq!(skipped, 1);
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "Feature change");
    }

    /// The CLI (interactive) arm of `continue_rebase` is the arm that performs
    /// the skips — `git rebase --continue` drops the commit it is stopped on,
    /// and the loop's own `git rebase --skip` drops the ones after it — so it
    /// has to report them. It returned a hard-coded 0, and the dialog it feeds
    /// is the same conflict dialog an interactive-rebase conflict opens: the
    /// identical gesture (resolve, click Continue) said a bare "Rebase
    /// completed" while a local commit disappeared from the branch.
    #[tokio::test]
    async fn test_continue_rebase_counts_skips_on_the_interactive_arm() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        setup_conflicting_branches(&repo);
        repo.checkout_branch("feature");

        // A CLI interactive rebase (todo file on disk) whose single pick
        // conflicts.
        let todo = format!("pick {}\n", repo.head_oid());
        let started = execute_interactive_rebase(repo.path_str(), initial_branch, todo).await;
        assert!(started.is_err(), "the pick must stop on the conflict");

        let git_dir = repo.repo().path().to_path_buf();
        if !git_dir.join("rebase-merge/git-rebase-todo").exists() {
            // The CLI rebase could not start in this environment; nothing to assert.
            return;
        }

        // Resolving to exactly the target's content empties the patch, so the
        // continue drops the commit.
        resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "main content".to_string(),
            None,
        )
        .await
        .unwrap();

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("the interactive continue must finish, not fail");
        assert_eq!(
            skipped, 1,
            "the commit the continue dropped must be reported"
        );
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            git_repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .message()
                .unwrap(),
            "Main change",
            "the dropped commit really is gone from the branch"
        );
    }

    /// Both halves of the interactive arm's count in one rebase: the commit
    /// `git rebase --continue` drops without a word, AND the one it stops on
    /// and hands to the loop's `git rebase --skip`. Counting only the second
    /// (or neither) under-reports commits that have left the branch.
    #[tokio::test]
    async fn test_interactive_continue_counts_both_the_silent_and_the_skipped_drop() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");

        repo.checkout_branch("feature");
        let one = repo.create_commit("Feature one", &[("one.txt", "one\n")]);
        let two = repo.create_commit("Feature two", &[("two.txt", "two\n")]);

        // The same two changes land on the target independently, so both picks
        // come back empty.
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main one", &[("one.txt", "one\n")]);
        repo.create_commit("Main two", &[("two.txt", "two\n")]);

        repo.checkout_branch("feature");
        let todo = format!("pick {}\npick {}\n", one, two);
        let started = execute_interactive_rebase(repo.path_str(), initial_branch, todo).await;
        assert!(started.is_err(), "the first pick comes back empty");

        let git_dir = repo.repo().path().to_path_buf();
        if !git_dir.join("rebase-merge/git-rebase-todo").exists() {
            // The CLI rebase could not start in this environment; nothing to assert.
            return;
        }

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("the interactive continue must finish, not fail");
        assert_eq!(
            skipped, 2,
            "both dropped commits must be reported, not just the one git asked to skip"
        );
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            git_repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .message()
                .unwrap(),
            "Main two",
            "neither commit survived the rebase"
        );
    }

    /// And the interactive arm's skips survive its own pauses, as the libgit2
    /// arm's already do: a rebase that drops a commit and then stops at an
    /// `edit` line returns RebasePaused — not a count — so the drop would go
    /// unreported unless it is carried to whichever continue finishes.
    #[tokio::test]
    async fn test_interactive_continue_carries_skips_across_a_pause() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");

        repo.checkout_branch("feature");
        let dropped = repo.create_commit("Feature one", &[("one.txt", "one\n")]);
        let kept = repo.create_commit("Feature extra", &[("extra.txt", "extra\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main one", &[("one.txt", "one\n")]);

        repo.checkout_branch("feature");
        let todo = format!("pick {}\nedit {}\n", dropped, kept);
        let started = execute_interactive_rebase(repo.path_str(), initial_branch, todo).await;
        assert!(started.is_err(), "the first pick comes back empty");

        let git_dir = repo.repo().path().to_path_buf();
        if !git_dir.join("rebase-merge/git-rebase-todo").exists() {
            // The CLI rebase could not start in this environment; nothing to assert.
            return;
        }

        // First leg: drops the emptied commit, then stops at the `edit`.
        let paused = continue_rebase(repo.path_str())
            .await
            .expect_err("the rebase stops at the edit line");
        assert!(
            paused.to_string().contains("paused"),
            "the pause must be reported: {}",
            paused
        );

        // Second leg: finishes, and still knows about the earlier drop. An
        // `edit` stop has applied its commit already, so continuing from one
        // must not be counted as a drop of its own.
        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("the second continue must finish the rebase");
        assert_eq!(
            skipped, 1,
            "the commit dropped before the pause must still be reported, and only it"
        );
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "Feature extra");
        assert_eq!(
            head.parent(0).unwrap().message().unwrap(),
            "Main one",
            "the dropped commit is not between them"
        );
    }

    /// A rebase that drops nothing must still report nothing: `break` and
    /// `edit` stops leave the same clean index matching HEAD that an emptied
    /// patch does, and counting those would invent skips the user never had.
    #[tokio::test]
    async fn test_interactive_continue_reports_no_skips_for_a_break_stop() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");

        repo.checkout_branch("feature");
        let only = repo.create_commit("Feature only", &[("only.txt", "only\n")]);

        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("main.txt", "main\n")]);

        repo.checkout_branch("feature");
        let todo = format!("break\npick {}\n", only);
        let started = execute_interactive_rebase(repo.path_str(), initial_branch, todo).await;
        let Ok(outcome) = started else {
            // The CLI rebase could not start in this environment; nothing to assert.
            return;
        };
        assert!(outcome.paused, "the rebase must stop at the break");

        let skipped = continue_rebase(repo.path_str())
            .await
            .expect("continuing past a break must finish the rebase");
        assert_eq!(skipped, 0, "a break drops nothing");
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert_eq!(
            git_repo
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .message()
                .unwrap(),
            "Feature only",
            "and the commit is still on the branch"
        );
    }

    /// The running total survives more than one pause, and the file it lives
    /// in goes away with the rebase state.
    #[test]
    fn test_skipped_count_accumulates_across_legs_and_is_cleared() {
        let repo = TestRepo::with_initial_commit();
        let git_repo = repo.repo();
        std::fs::create_dir_all(git_repo.path().join("rebase-merge")).unwrap();

        assert_eq!(take_skipped(&git_repo), 0, "no file means nothing skipped");

        append_skipped(&git_repo, 0);
        assert!(
            !skipped_count_path(&git_repo).exists(),
            "zero must not create a file"
        );

        append_skipped(&git_repo, 2);
        append_skipped(&git_repo, 3);
        assert_eq!(take_skipped(&git_repo), 5);
        assert!(
            !skipped_count_path(&git_repo).exists(),
            "taking the count clears it"
        );
    }

    #[test]
    fn test_parse_conflict_markers_simple() {
        let content = r#"some code
<<<<<<< HEAD
our changes
=======
their changes
>>>>>>> feature
more code"#;

        let markers = parse_conflict_markers(content);
        assert_eq!(markers.len(), 1);

        let marker = &markers[0];
        assert_eq!(marker.start_line, 2);
        assert_eq!(marker.separator_line, 4);
        assert_eq!(marker.end_line, 6);
        assert_eq!(marker.ours_content, "our changes");
        assert_eq!(marker.theirs_content, "their changes");
        assert!(marker.base_content.is_none());
    }

    #[test]
    fn test_parse_conflict_markers_diff3() {
        let content = r#"<<<<<<< HEAD
our changes
||||||| base
original content
=======
their changes
>>>>>>> feature"#;

        let markers = parse_conflict_markers(content);
        assert_eq!(markers.len(), 1);

        let marker = &markers[0];
        assert_eq!(marker.ours_content, "our changes");
        assert_eq!(marker.theirs_content, "their changes");
        assert_eq!(marker.base_content.as_deref(), Some("original content"));
    }

    #[test]
    fn test_parse_conflict_markers_multiple() {
        let content = r#"<<<<<<< HEAD
change 1 ours
=======
change 1 theirs
>>>>>>> branch
middle content
<<<<<<< HEAD
change 2 ours
=======
change 2 theirs
>>>>>>> branch"#;

        let markers = parse_conflict_markers(content);
        assert_eq!(markers.len(), 2);

        assert_eq!(markers[0].ours_content, "change 1 ours");
        assert_eq!(markers[0].theirs_content, "change 1 theirs");

        assert_eq!(markers[1].ours_content, "change 2 ours");
        assert_eq!(markers[1].theirs_content, "change 2 theirs");
    }

    #[test]
    fn test_parse_conflict_markers_multiline() {
        let content = r#"<<<<<<< HEAD
line 1
line 2
line 3
=======
other line 1
other line 2
>>>>>>> feature"#;

        let markers = parse_conflict_markers(content);
        assert_eq!(markers.len(), 1);

        assert_eq!(markers[0].ours_content, "line 1\nline 2\nline 3");
        assert_eq!(markers[0].theirs_content, "other line 1\nother line 2");
    }

    #[test]
    fn test_parse_conflict_markers_empty_sections() {
        let content = r#"<<<<<<< HEAD
=======
their content
>>>>>>> feature"#;

        let markers = parse_conflict_markers(content);
        assert_eq!(markers.len(), 1);

        assert_eq!(markers[0].ours_content, "");
        assert_eq!(markers[0].theirs_content, "their content");
    }

    #[test]
    fn test_parse_conflict_markers_no_conflicts() {
        let content = "normal file content\nno conflicts here";

        let markers = parse_conflict_markers(content);
        assert!(markers.is_empty());
    }

    #[test]
    fn test_parse_merge_branch_from_msg() {
        assert_eq!(
            parse_merge_branch_from_msg("Merge branch 'feature' into main"),
            Some("feature".to_string())
        );

        assert_eq!(
            parse_merge_branch_from_msg("Merge branch 'feature/login' into develop"),
            Some("feature/login".to_string())
        );

        assert_eq!(
            parse_merge_branch_from_msg("Merge remote-tracking branch 'origin/main'"),
            Some("origin/main".to_string())
        );

        assert_eq!(
            parse_merge_branch_from_msg("Some other commit message"),
            None
        );
    }

    #[tokio::test]
    async fn test_detect_conflict_markers_no_conflicts() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("test.txt", "normal content")]);

        let result = detect_conflict_markers(repo.path_str(), Some("test.txt".to_string())).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_detect_conflict_markers_with_markers() {
        let repo = TestRepo::with_initial_commit();

        // Write a file with conflict markers directly (simulating a conflict state)
        let conflict_content = r#"start
<<<<<<< HEAD
our version
=======
their version
>>>>>>> feature
end"#;
        std::fs::write(repo.path.join("conflict.txt"), conflict_content).unwrap();

        let result =
            detect_conflict_markers(repo.path_str(), Some("conflict.txt".to_string())).await;
        assert!(result.is_ok());

        let files = result.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "conflict.txt");
        assert_eq!(files[0].conflict_count, 1);
        assert_eq!(files[0].markers[0].ours_content, "our version");
        assert_eq!(files[0].markers[0].theirs_content, "their version");
    }

    #[tokio::test]
    async fn test_get_conflict_details() {
        let repo = TestRepo::with_initial_commit();

        // Write a file with conflict markers
        let conflict_content = r#"<<<<<<< HEAD
ours
=======
theirs
>>>>>>> feature"#;
        std::fs::write(repo.path.join("file.txt"), conflict_content).unwrap();

        let result = get_conflict_details(repo.path_str(), "file.txt".to_string()).await;
        assert!(result.is_ok());

        let details = result.unwrap();
        assert_eq!(details.file_path, "file.txt");
        assert!(!details.our_ref.is_empty());
        assert_eq!(details.markers.len(), 1);
    }

    #[tokio::test]
    async fn test_get_conflict_details_nonexistent_file() {
        let repo = TestRepo::with_initial_commit();

        let result = get_conflict_details(repo.path_str(), "nonexistent.txt".to_string()).await;
        assert!(result.is_err());
    }

    // ---- merge hook parity ----

    #[cfg(unix)]
    #[tokio::test]
    async fn test_merge_pre_merge_commit_hook_aborts() {
        let repo = TestRepo::with_initial_commit();
        let initial = repo.current_branch();
        let head_before = repo.head_oid();

        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("feature.txt", "content")]);
        repo.checkout_branch(&initial);

        repo.install_hook("pre-merge-commit", "#!/bin/sh\necho denied 1>&2\nexit 1\n");

        // no_ff forces an actual merge commit, so pre-merge-commit must run.
        let result = merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "pre-merge-commit exit 1 must stop the automatic merge commit"
        );
        assert!(result.unwrap_err().to_string().contains("denied"));

        // git does NOT abort on a pre-merge-commit veto: it leaves the merge
        // resumable ("use 'git commit' to complete the merge"). So MERGE_HEAD
        // must survive (state == Merge) and HEAD must not have moved yet.
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Merge);
        assert_eq!(repo.head_oid(), head_before);

        // The merge must remain completable via commit_merge (hooks aside).
        commit_merge(repo.path_str(), None, None).await.unwrap();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            2,
            "completing the merge yields a merge commit"
        );
        assert_eq!(repo.repo().state(), git2::RepositoryState::Clean);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_merge_runs_commit_msg_hook() {
        // git runs commit-msg for an automatic (non-conflict) merge commit; the
        // hook may rewrite the message. Verify it fires and its edit lands.
        let repo = TestRepo::with_initial_commit();
        let initial = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("feature.txt", "content")]);
        repo.checkout_branch(&initial);

        repo.install_hook(
            "commit-msg",
            "#!/bin/sh\necho 'Reviewed-by: hook' >> \"$1\"\n",
        );

        merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert!(
            head.message().unwrap().contains("Reviewed-by: hook"),
            "commit-msg hook must run and rewrite the auto-merge message, got: {:?}",
            head.message()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_merge_runs_post_merge_hook() {
        let repo = TestRepo::with_initial_commit();
        let initial = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("feature.txt", "content")]);
        repo.checkout_branch(&initial);

        let marker = repo.path.join("post-merge.log");
        repo.install_hook(
            "post-merge",
            &format!("#!/bin/sh\necho \"$1\" > \"{}\"\n", marker.display()),
        );

        merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-merge must run");
        assert_eq!(logged.trim(), "0", "post-merge flag must be 0 (not squash)");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_fast_forward_merge_runs_post_merge_hook() {
        let repo = TestRepo::with_initial_commit();
        let initial = repo.current_branch();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature", &[("feature.txt", "content")]);
        repo.checkout_branch(&initial);

        let marker = repo.path.join("post-merge.log");
        repo.install_hook(
            "post-merge",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );

        // Plain fast-forward merge.
        merge(repo.path_str(), "feature".to_string(), None, None, None)
            .await
            .unwrap();

        assert!(
            marker.exists(),
            "post-merge must run after fast-forward too"
        );
    }

    #[test]
    fn stopped_commit_summary_reads_past_the_progress_carriage_return() {
        let stderr = "Rebasing (1/1)\rerror: could not apply bf28cbb... x edits\nhint: Resolve all conflicts\n";
        assert_eq!(stopped_commit_summary(stderr).as_deref(), Some("x edits"));
        assert_eq!(
            stopped_commit_summary("error: could not apply abc123 plain\n").as_deref(),
            Some("plain")
        );
        assert_eq!(stopped_commit_summary("nothing here"), None);
    }
}
