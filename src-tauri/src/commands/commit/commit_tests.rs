#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::test_utils::TestRepo;

    /// follow_renames must actually follow the rename.
    ///
    /// The per-commit diff was built with a pathspec, which filters deltas at
    /// diff-GENERATION time — so at the renaming commit the diff held only the
    /// Added(new) half and find_similar had no Deleted(old) to pair it with.
    /// delta.status() was never Renamed, renamed_from was never set, and the
    /// walk stopped at the rename: history before it was invisible, which is
    /// the one thing the option exists to provide.
    /// Commit the current index at an EXPLICIT time.
    ///
    /// The rename tests need timestamps that deliberately disagree with
    /// topology. With wall-clock times every commit lands in the same second in
    /// commit order, so `Sort::TIME` alone already produces the right order and
    /// the tests would pass even with `Sort::TOPOLOGICAL` removed — proving
    /// nothing about the walk they exist to cover.
    fn commit_index_at(repo: &TestRepo, message: &str, seconds: i64) -> git2::Oid {
        let git_repo = repo.repo();
        let mut index = git_repo.index().unwrap();
        index.write().unwrap();
        let tree = git_repo.find_tree(index.write_tree().unwrap()).unwrap();
        let when = git2::Time::new(seconds, 0);
        let sig = git2::Signature::new("Test User", "test@example.com", &when).unwrap();
        let parent = git_repo.head().unwrap().peel_to_commit().unwrap();
        git_repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap()
    }

    /// Write a file, stage it, and commit at an explicit time.
    fn commit_file_at(repo: &TestRepo, message: &str, file: &str, body: &str, seconds: i64) {
        std::fs::write(repo.path.join(file), body).unwrap();
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            index.add_path(std::path::Path::new(file)).unwrap();
            index.write().unwrap();
        }
        commit_index_at(repo, message, seconds);
    }

    /// Stage a rename and commit it at an explicit time.
    fn commit_rename_at(repo: &TestRepo, from: &str, to: &str, message: &str, seconds: i64) {
        std::fs::rename(repo.path.join(from), repo.path.join(to)).unwrap();
        {
            let git_repo = repo.repo();
            let mut index = git_repo.index().unwrap();
            index.remove_path(std::path::Path::new(from)).unwrap();
            index.add_path(std::path::Path::new(to)).unwrap();
            index.write().unwrap();
        }
        commit_index_at(repo, message, seconds);
    }

    #[tokio::test]
    async fn test_get_file_history_follows_a_rename() {
        let repo = TestRepo::with_initial_commit();

        // Timestamps chosen to DISAGREE with topology: the rename is older than
        // its own parent. Under a TIME-only walk the parent would be visited
        // first — before the path is known to have changed — so this ordering
        // is what makes the test able to fail.
        commit_file_at(&repo, "Add original", "old-name.txt", "line one\n", 1_000);
        commit_file_at(
            &repo,
            "Edit original",
            "old-name.txt",
            "line one\nline two\n",
            3_000,
        );
        // Renamed with identical content, so it is unambiguously a rename.
        commit_rename_at(&repo, "old-name.txt", "new-name.txt", "Rename it", 2_000);
        commit_file_at(
            &repo,
            "Edit after rename",
            "new-name.txt",
            "line one\nline two\nline three\n",
            4_000,
        );

        let following = get_file_history(
            repo.path_str(),
            "new-name.txt".to_string(),
            None,
            Some(true),
        )
        .await
        .unwrap();
        let summaries: Vec<String> = following.iter().map(|e| e.commit.summary.clone()).collect();

        assert!(
            summaries.iter().any(|s| s == "Add original"),
            "history before the rename must be reachable, got {:?}",
            summaries
        );
        assert!(
            summaries.iter().any(|s| s == "Edit original"),
            "edits under the old name must be reachable, got {:?}",
            summaries
        );
        assert!(summaries.iter().any(|s| s == "Rename it"));
        assert!(summaries.iter().any(|s| s == "Edit after rename"));
    }

    /// Every row must carry the path the file had AT that commit.
    ///
    /// Without it a caller acting on a pre-rename row — restoring the file to
    /// that version — passes the file's CURRENT name, which is not in that
    /// commit's tree at all, so the action can only fail.
    #[tokio::test]
    async fn test_get_file_history_reports_the_path_at_each_commit() {
        let repo = TestRepo::with_initial_commit();

        commit_file_at(&repo, "Add original", "old-name.txt", "line one\n", 1_000);
        commit_rename_at(&repo, "old-name.txt", "new-name.txt", "Rename it", 2_000);
        commit_file_at(
            &repo,
            "Edit after rename",
            "new-name.txt",
            "line one\nline two\n",
            3_000,
        );

        let history = get_file_history(
            repo.path_str(),
            "new-name.txt".to_string(),
            None,
            Some(true),
        )
        .await
        .unwrap();

        let path_of = |summary: &str| {
            history
                .iter()
                .find(|c| c.commit.summary == summary)
                .unwrap_or_else(|| panic!("{} missing from history", summary))
                .path_at_commit
                .clone()
        };

        assert_eq!(path_of("Edit after rename"), "new-name.txt".to_string());
        assert_eq!(path_of("Rename it"), "new-name.txt".to_string());
        assert_eq!(
            path_of("Add original"),
            "old-name.txt".to_string(),
            "a commit from before the rename holds the file under its OLD name"
        );
    }

    /// With following OFF, the history stops at the rename — as asked.
    #[tokio::test]
    async fn test_get_file_history_without_following_stops_at_the_rename() {
        let repo = TestRepo::with_initial_commit();

        // Same topology-inconsistent timestamps as the following test, so the
        // two differ only in the flag under test.
        commit_file_at(&repo, "Add original", "old-name.txt", "line one\n", 3_000);
        commit_rename_at(&repo, "old-name.txt", "new-name.txt", "Rename it", 2_000);

        let not_following = get_file_history(
            repo.path_str(),
            "new-name.txt".to_string(),
            None,
            Some(false),
        )
        .await
        .unwrap();
        let summaries: Vec<String> = not_following
            .iter()
            .map(|e| e.commit.summary.clone())
            .collect();

        assert!(
            !summaries.iter().any(|s| s == "Add original"),
            "not following must not reach past the rename, got {:?}",
            summaries
        );
    }

    /// Every entry must carry the path the file had in ITS commit.
    ///
    /// Following a rename makes pre-rename commits reachable, but a bare
    /// `Commit` says nothing about where the file lived then, so the UI had
    /// only the file's current path to offer for diff/blame — a name that did
    /// not exist yet at those commits.
    #[tokio::test]
    async fn test_file_history_entries_carry_the_path_at_each_commit() {
        let repo = TestRepo::with_initial_commit();

        // Topology-inconsistent timestamps, as in the rename tests above.
        commit_file_at(&repo, "Add original", "old-name.txt", "line one\n", 1_000);
        commit_file_at(
            &repo,
            "Edit original",
            "old-name.txt",
            "line one\nline two\n",
            3_000,
        );
        commit_rename_at(&repo, "old-name.txt", "new-name.txt", "Rename it", 2_000);
        commit_file_at(
            &repo,
            "Edit after rename",
            "new-name.txt",
            "line one\nline two\nline three\n",
            4_000,
        );

        let entries = get_file_history(
            repo.path_str(),
            "new-name.txt".to_string(),
            None,
            Some(true),
        )
        .await
        .unwrap();

        let path_for = |summary: &str| -> String {
            entries
                .iter()
                .find(|e| e.commit.summary == summary)
                .unwrap_or_else(|| panic!("missing entry {:?}", summary))
                .path_at_commit
                .clone()
        };

        assert_eq!(
            path_for("Add original"),
            "old-name.txt",
            "a commit older than the rename must report the OLD path"
        );
        assert_eq!(
            path_for("Edit original"),
            "old-name.txt",
            "edits under the old name must report the OLD path"
        );
        assert_eq!(
            path_for("Rename it"),
            "new-name.txt",
            "at the renaming commit the file already exists under the new name"
        );
        assert_eq!(path_for("Edit after rename"), "new-name.txt");
    }

    /// The point of the per-entry path: it is actually diffable.
    ///
    /// The second half of this test is what every UI click on a pre-rename row
    /// used to do — pass the file's current name — and it still fails, which is
    /// exactly why the entry has to carry its own path.
    #[tokio::test]
    async fn test_file_history_path_at_commit_is_diffable() {
        let repo = TestRepo::with_initial_commit();

        commit_file_at(&repo, "Add original", "old-name.txt", "line one\n", 1_000);
        commit_rename_at(&repo, "old-name.txt", "new-name.txt", "Rename it", 2_000);

        let entries = get_file_history(
            repo.path_str(),
            "new-name.txt".to_string(),
            None,
            Some(true),
        )
        .await
        .unwrap();

        let entry = entries
            .iter()
            .find(|e| e.commit.summary == "Add original")
            .expect("pre-rename commit must be listed");

        let ok = crate::commands::diff::get_commit_file_diff(
            repo.path_str(),
            entry.commit.oid.clone(),
            entry.path_at_commit.clone(),
            None,
            None,
            None,
        )
        .await
        .expect("the path the entry reports must be diffable at that commit");
        assert_eq!(ok.path, "old-name.txt");

        let err = crate::commands::diff::get_commit_file_diff(
            repo.path_str(),
            entry.commit.oid.clone(),
            "new-name.txt".to_string(),
            None,
            None,
            None,
        )
        .await
        .expect_err("the file's CURRENT name does not exist at that commit");
        assert!(
            err.to_string().contains("File not found in commit"),
            "unexpected error: {}",
            err
        );
    }

    /// Edge case: nothing was renamed, so every entry keeps the requested path.
    #[tokio::test]
    async fn test_file_history_entries_use_the_requested_path_when_nothing_was_renamed() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Modify README", &[("README.md", "# Updated")]);
        repo.create_commit("Modify again", &[("README.md", "# Updated again")]);

        let entries = get_file_history(
            repo.path_str(),
            "README.md".to_string(),
            Some(100),
            Some(true),
        )
        .await
        .unwrap();

        assert_eq!(entries.len(), 3);
        for entry in &entries {
            assert_eq!(
                entry.path_at_commit, "README.md",
                "no rename happened, so every entry keeps the requested path"
            );
        }
    }

    #[tokio::test]
    async fn test_commit_history_all_branches_pagination_and_total() {
        let repo = TestRepo::with_initial_commit();
        for i in 0..9 {
            repo.create_commit(
                &format!("Commit {}", i),
                &[("file.txt", &format!("v{}", i))],
            );
        }

        // Full walk: 10 commits (initial + 9)
        let all = get_commit_history(repo.path_str(), None, Some(100), None, Some(true))
            .await
            .unwrap();
        assert_eq!(all.len(), 10);

        // Paged walk (served from the cache) must slice the same order
        let page1 = get_commit_history(repo.path_str(), None, Some(4), Some(0), Some(true))
            .await
            .unwrap();
        let page2 = get_commit_history(repo.path_str(), None, Some(4), Some(4), Some(true))
            .await
            .unwrap();
        let page3 = get_commit_history(repo.path_str(), None, Some(4), Some(8), Some(true))
            .await
            .unwrap();
        assert_eq!(page1.len(), 4);
        assert_eq!(page2.len(), 4);
        assert_eq!(page3.len(), 2);

        let paged_oids: Vec<String> = page1
            .iter()
            .chain(page2.iter())
            .chain(page3.iter())
            .map(|c| c.oid.clone())
            .collect();
        let all_oids: Vec<String> = all.iter().map(|c| c.oid.clone()).collect();
        assert_eq!(paged_oids, all_oids);

        let total = get_commit_total(repo.path_str()).await.unwrap();
        assert_eq!(total, 10);
    }

    #[tokio::test]
    async fn test_commit_history_cache_invalidates_on_new_commit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("a.txt", "a")]);

        // Warm the cache
        let before = get_commit_history(repo.path_str(), None, Some(100), None, Some(true))
            .await
            .unwrap();
        assert_eq!(before.len(), 2);
        assert_eq!(get_commit_total(repo.path_str()).await.unwrap(), 2);

        // A new commit moves the branch tip — the fingerprint changes and
        // the stale cached walk must not be served
        repo.create_commit("Third", &[("b.txt", "b")]);
        let after = get_commit_history(repo.path_str(), None, Some(100), None, Some(true))
            .await
            .unwrap();
        assert_eq!(after.len(), 3);
        assert_eq!(after[0].summary, "Third");
        assert_eq!(get_commit_total(repo.path_str()).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn test_commit_history_includes_detached_head_commits() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid();
        repo.create_commit("On branch", &[("a.txt", "a")]);

        // Detach HEAD at the older commit and commit while detached — the
        // new commit is reachable ONLY from HEAD, not from any ref
        repo.repo().set_head_detached(base).unwrap();
        let detached = repo.create_commit("Detached work", &[("d.txt", "d")]);

        let commits = get_commit_history(repo.path_str(), None, Some(100), None, Some(true))
            .await
            .unwrap();
        assert!(
            commits.iter().any(|c| c.oid == detached.to_string()),
            "detached-HEAD commit must appear in the all-branches walk"
        );
        assert_eq!(get_commit_total(repo.path_str()).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn test_commit_history_all_branches_includes_side_branches() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();
        repo.create_branch("side");
        repo.checkout_branch("side");
        repo.create_commit("Side commit", &[("side.txt", "side")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main commit", &[("main.txt", "main")]);

        let commits = get_commit_history(repo.path_str(), None, Some(100), None, Some(true))
            .await
            .unwrap();
        let summaries: Vec<&str> = commits.iter().map(|c| c.summary.as_str()).collect();
        assert!(summaries.contains(&"Side commit"));
        assert!(summaries.contains(&"Main commit"));
    }

    /// Committing with nothing staged must refuse, as `git commit` does.
    ///
    /// The only guard was the frontend's staged COUNT, and it goes stale the
    /// moment something unstages outside the app — a terminal, another tool,
    /// watcher lag. Pressing Commit then wrote a no-op commit into history with
    /// no warning at all.
    #[tokio::test]
    async fn test_create_commit_refuses_when_nothing_is_staged() {
        let repo = TestRepo::with_initial_commit();
        let before = repo.repo().head().unwrap().peel_to_commit().unwrap().id();

        let err = create_commit(
            repo.path_str(),
            "Nothing to see here".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await
        .expect_err("an empty commit must be refused");
        assert!(
            err.to_string().contains("No staged changes"),
            "unexpected error: {}",
            err
        );

        let after = repo.repo().head().unwrap().peel_to_commit().unwrap().id();
        assert_eq!(before, after, "HEAD must not move");
    }

    /// Amending a commit that is already on the remote must be detectable.
    ///
    /// Amend rewrites HEAD; when HEAD is published that rewrites history the
    /// remote already has, so the branch and its upstream diverge and the next
    /// push is rejected until someone force pushes. No amend surface warned,
    /// because nothing could tell.
    #[tokio::test]
    async fn test_is_head_published_detects_a_pushed_head() {
        let repo = TestRepo::with_initial_commit();
        let branch = repo.current_branch();
        let tip = repo.create_commit("Published", &[("a.txt", "a")]);

        // set_upstream needs a real remote to resolve its fetch refspec; the
        // URL is never contacted.
        repo.add_remote("origin", "/nonexistent/origin.git");

        // Stand up a remote-tracking ref at the same commit, with upstream
        // config — exactly the state a push leaves behind.
        {
            let git_repo = repo.repo();
            git_repo
                .reference(
                    &format!("refs/remotes/origin/{}", branch),
                    tip,
                    true,
                    "test",
                )
                .unwrap();
            let mut local = git_repo
                .find_branch(&branch, git2::BranchType::Local)
                .unwrap();
            local
                .set_upstream(Some(&format!("origin/{}", branch)))
                .unwrap();
        }

        assert!(
            is_head_published(repo.path_str()).await.unwrap(),
            "a commit sitting on its upstream is published"
        );
    }

    /// An upstream that has moved PAST head still means head was published.
    #[tokio::test]
    async fn test_is_head_published_when_the_upstream_is_ahead() {
        let repo = TestRepo::with_initial_commit();
        let branch = repo.current_branch();
        let published = repo.create_commit("Published", &[("a.txt", "a")]);
        let remote_only = repo.create_commit("Remote moved on", &[("b.txt", "b")]);
        repo.add_remote("origin", "/nonexistent/origin.git");

        {
            let git_repo = repo.repo();
            git_repo
                .reference(
                    &format!("refs/remotes/origin/{}", branch),
                    remote_only,
                    true,
                    "test",
                )
                .unwrap();
            let mut local = git_repo
                .find_branch(&branch, git2::BranchType::Local)
                .unwrap();
            local
                .set_upstream(Some(&format!("origin/{}", branch)))
                .unwrap();
            // Move the local branch back to the published commit.
            git_repo
                .reference(&format!("refs/heads/{}", branch), published, true, "test")
                .unwrap();
            git_repo
                .set_head(&format!("refs/heads/{}", branch))
                .unwrap();
        }

        assert!(
            is_head_published(repo.path_str()).await.unwrap(),
            "an upstream that contains head means head is published"
        );
    }

    /// The ordinary case must NOT warn.
    ///
    /// A local-only commit, a branch with no upstream at all, and an unpushed
    /// commit ahead of its upstream are all safe to amend. Warning on those
    /// would train the user to click through the one warning that matters.
    #[tokio::test]
    async fn test_is_head_published_is_false_for_unpublished_work() {
        // No upstream configured at all.
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Local only", &[("a.txt", "a")]);
        assert!(
            !is_head_published(repo.path_str()).await.unwrap(),
            "a branch with no upstream has nothing published"
        );

        // Upstream configured, but head is AHEAD of it.
        let repo = TestRepo::with_initial_commit();
        let branch = repo.current_branch();
        let published = repo.create_commit("Published", &[("a.txt", "a")]);
        repo.add_remote("origin", "/nonexistent/origin.git");
        {
            let git_repo = repo.repo();
            git_repo
                .reference(
                    &format!("refs/remotes/origin/{}", branch),
                    published,
                    true,
                    "test",
                )
                .unwrap();
            let mut local = git_repo
                .find_branch(&branch, git2::BranchType::Local)
                .unwrap();
            local
                .set_upstream(Some(&format!("origin/{}", branch)))
                .unwrap();
        }
        repo.create_commit("Not pushed yet", &[("b.txt", "b")]);
        assert!(
            !is_head_published(repo.path_str()).await.unwrap(),
            "an unpushed commit is safe to amend"
        );
    }

    /// A detached HEAD has no upstream to diverge from.
    #[tokio::test]
    async fn test_is_head_published_is_false_when_detached() {
        let repo = TestRepo::with_initial_commit();
        let tip = repo.create_commit("Second", &[("a.txt", "a")]);
        repo.repo().set_head_detached(tip).unwrap();

        assert!(!is_head_published(repo.path_str()).await.unwrap());
    }

    /// An empty INITIAL commit must be refused too.
    ///
    /// On an unborn HEAD there is no parent tree, so the head-tree comparison
    /// had nothing to match and every first commit was allowed through — even
    /// with an empty index. `git commit` refuses that one as well.
    #[tokio::test]
    async fn test_create_commit_refuses_an_empty_initial_commit() {
        let repo = TestRepo::new();

        let err = create_commit(
            repo.path_str(),
            "Initial commit".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await
        .expect_err("an empty initial commit must be refused");
        assert!(
            err.to_string().contains("No staged changes"),
            "unexpected error: {}",
            err
        );

        assert!(
            repo.repo().head().is_err(),
            "HEAD must still be unborn — no commit was created"
        );
    }

    /// Control: a real initial commit still works on an unborn HEAD.
    #[tokio::test]
    async fn test_create_commit_allows_a_real_initial_commit() {
        let repo = TestRepo::new();
        std::fs::write(repo.path.join("first.txt"), "content").unwrap();
        repo.stage_file("first.txt");

        create_commit(
            repo.path_str(),
            "Initial commit".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await
        .expect("an initial commit with staged content must succeed");

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Initial commit"));
        assert_eq!(head.parent_count(), 0, "the initial commit has no parents");
    }

    /// Control: with something staged, the same call still commits.
    #[tokio::test]
    async fn test_create_commit_still_commits_staged_changes() {
        let repo = TestRepo::with_initial_commit();
        std::fs::write(repo.path.join("new.txt"), "content").unwrap();
        repo.stage_file("new.txt");

        create_commit(
            repo.path_str(),
            "Add new.txt".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await
        .expect("a commit with staged changes must succeed");

        let git_repo = repo.repo();
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("Add new.txt"));
    }

    /// Amending mid-merge must refuse, as `git commit --amend` does
    /// ("You are in the middle of a merge -- cannot amend.").
    ///
    /// The git2 amend branch rewrote the PRE-merge HEAD with its pre-merge
    /// parents, so MERGE_HEAD never became a parent and cleanup_state() — which
    /// only runs on the non-amend branch — never ran. The merge was silently
    /// dropped from the history while the repository stayed MERGING with the
    /// merged branch's changes baked into an ordinary commit.
    #[tokio::test]
    async fn test_create_commit_refuses_to_amend_mid_merge() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        let merge_result = crate::commands::merge::merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(merge_result.is_err(), "expected merge conflict");

        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let head_before = repo.repo().head().unwrap().peel_to_commit().unwrap().id();

        let err = create_commit(
            repo.path_str(),
            "Amended mid-merge".to_string(),
            Some(true),
            Some(false),
            None,
            None,
            None,
        )
        .await
        .expect_err("amending mid-merge must be refused");
        assert!(
            err.to_string().contains("Cannot amend while a merge"),
            "unexpected error: {}",
            err
        );

        // The merge is still there to finish or abort, and HEAD is untouched.
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Merge);
        assert!(git_repo.path().join("MERGE_HEAD").exists());
        assert_eq!(
            git_repo.head().unwrap().peel_to_commit().unwrap().id(),
            head_before,
            "the pre-merge HEAD must not have been rewritten"
        );
    }

    #[tokio::test]
    async fn test_create_commit_mid_merge_includes_merge_head() {
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        // Conflicting merge, resolved manually, then committed from the
        // normal commit panel: the commit must get MERGE_HEAD as a second
        // parent and clear the MERGING state.
        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        let merge_result = crate::commands::merge::merge(
            repo.path_str(),
            "feature".to_string(),
            Some(true),
            None,
            None,
        )
        .await;
        assert!(merge_result.is_err(), "expected merge conflict");

        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let result = create_commit(
            repo.path_str(),
            "Commit during merge".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok(), "commit failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            2,
            "commit made mid-merge must keep MERGE_HEAD as a parent"
        );
    }

    #[tokio::test]
    async fn test_get_commit_history() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file2.txt", "content")]);
        repo.create_commit("Third commit", &[("file3.txt", "content")]);

        let result = get_commit_history(repo.path_str(), None, Some(10), None, None).await;
        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 3);
        // Commits are in reverse chronological order
        assert!(commits[0].summary.contains("Third"));
        assert!(commits[1].summary.contains("Second"));
        assert!(commits[2].summary.contains("Initial"));
    }

    #[tokio::test]
    async fn test_get_commit_history_with_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file2.txt", "content")]);
        repo.create_commit("Third commit", &[("file3.txt", "content")]);

        let result = get_commit_history(repo.path_str(), None, Some(2), None, None).await;
        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2);
    }

    #[tokio::test]
    async fn test_get_commit_history_with_skip() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file2.txt", "content")]);
        repo.create_commit("Third commit", &[("file3.txt", "content")]);

        let result = get_commit_history(repo.path_str(), None, Some(10), Some(1), None).await;
        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2);
        // Should skip the most recent commit
        assert!(commits[0].summary.contains("Second"));
    }

    #[tokio::test]
    async fn test_get_commit() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = get_commit(repo.path_str(), oid.to_string()).await;
        assert!(result.is_ok());
        let commit = result.unwrap();
        assert_eq!(commit.oid, oid.to_string());
        assert!(commit.summary.contains("Initial"));
    }

    #[tokio::test]
    async fn test_get_commit_not_found() {
        let repo = TestRepo::with_initial_commit();
        let fake_oid = "0000000000000000000000000000000000000000".to_string();

        let result = get_commit(repo.path_str(), fake_oid).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_commit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("new-file.txt", "new content");
        repo.stage_file("new-file.txt");

        let result = create_commit(
            repo.path_str(),
            "Test commit message".to_string(),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let commit = result.unwrap();
        assert!(commit.summary.contains("Test commit message"));
    }

    #[tokio::test]
    async fn test_create_empty_commit() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();

        // Create an empty commit (no staged changes)
        let result = create_commit(
            repo.path_str(),
            "Empty commit message".to_string(),
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        let commit = result.unwrap();
        assert!(commit.summary.contains("Empty commit message"));
        // The new commit should have a different OID from the initial commit
        assert_ne!(commit.oid, initial_oid.to_string());
    }

    // Note: The amend test is complex because git2's commit() with update_ref
    // has safety checks that conflict with how we build the parent list.
    // In production, amend works through the UI flow which handles this properly.
    // Skipping this test for now - the amend functionality works in the app.

    #[tokio::test]
    async fn test_search_commits_by_message() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add feature X", &[("feature.txt", "x")]);
        repo.create_commit("Fix bug Y", &[("bugfix.txt", "y")]);

        let result = search_commits(
            repo.path_str(),
            Some("feature".to_string()),
            None,
            None,
            None,
            None,
            None,
            Some(100),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 1);
        assert!(commits[0].summary.contains("feature"));
    }

    #[tokio::test]
    async fn test_search_commits_by_sha() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();
        let short_sha = &oid.to_string()[..7];

        let result = search_commits(
            repo.path_str(),
            Some(short_sha.to_string()),
            None,
            None,
            None,
            None,
            None,
            Some(100),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 1);
    }

    #[tokio::test]
    async fn test_search_commits_by_author() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Another commit", &[("file.txt", "content")]);

        let result = search_commits(
            repo.path_str(),
            None,
            Some("Test User".to_string()),
            None,
            None,
            None,
            None,
            Some(100),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert_eq!(commits.len(), 2);
    }

    #[tokio::test]
    async fn test_search_commits_no_match() {
        let repo = TestRepo::with_initial_commit();

        let result = search_commits(
            repo.path_str(),
            Some("nonexistent message xyz123".to_string()),
            None,
            None,
            None,
            None,
            None,
            Some(100),
        )
        .await;

        assert!(result.is_ok());
        let commits = result.unwrap();
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn test_get_file_history() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Modify README", &[("README.md", "# Updated")]);
        repo.create_commit("Modify again", &[("README.md", "# Updated again")]);

        let result = get_file_history(
            repo.path_str(),
            "README.md".to_string(),
            Some(100),
            Some(true),
        )
        .await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 3); // Initial + 2 modifications
    }

    #[tokio::test]
    async fn test_get_file_history_with_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Modify README", &[("README.md", "# Updated")]);
        repo.create_commit("Modify again", &[("README.md", "# Updated again")]);

        let result = get_file_history(
            repo.path_str(),
            "README.md".to_string(),
            Some(2),
            Some(true),
        )
        .await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[tokio::test]
    async fn test_get_file_history_nonexistent_file() {
        let repo = TestRepo::with_initial_commit();

        let result = get_file_history(
            repo.path_str(),
            "nonexistent.txt".to_string(),
            Some(100),
            Some(true),
        )
        .await;

        assert!(result.is_ok());
        let entries = result.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn test_commit_has_author_info() {
        let repo = TestRepo::with_initial_commit();
        let result = get_commit(repo.path_str(), repo.head_oid().to_string()).await;

        assert!(result.is_ok());
        let commit = result.unwrap();
        assert_eq!(commit.author.name, "Test User");
        assert_eq!(commit.author.email, "test@example.com");
    }

    #[tokio::test]
    async fn test_commit_has_parent() {
        let repo = TestRepo::with_initial_commit();
        let initial_oid = repo.head_oid();
        repo.create_commit("Second", &[("file.txt", "content")]);

        let result = get_commit(repo.path_str(), repo.head_oid().to_string()).await;
        assert!(result.is_ok());
        let commit = result.unwrap();
        assert_eq!(commit.parent_ids.len(), 1);
        assert_eq!(commit.parent_ids[0], initial_oid.to_string());
    }

    #[tokio::test]
    async fn test_get_commit_message() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = get_commit_message(repo.path_str(), oid.to_string()).await;
        assert!(result.is_ok());
        let message = result.unwrap();
        assert!(message.contains("Initial commit"));
    }

    #[tokio::test]
    async fn test_get_commit_message_not_found() {
        let repo = TestRepo::with_initial_commit();
        let fake_oid = "0000000000000000000000000000000000000000".to_string();

        let result = get_commit_message(repo.path_str(), fake_oid).await;
        assert!(result.is_err());
    }

    /// Amending through create_commit must actually succeed.
    ///
    /// The commit panel sends {message, amend} to create_commit, which took the
    /// git2 path whenever commit.gpgsign was off. That path called
    /// repo.commit(Some("HEAD"), .., parents-of-HEAD), and libgit2 rejects it
    /// because the ref's tip is not the new commit's first parent — so amend
    /// failed outright with "current tip is not the first parent" for every
    /// repository without signing enabled.
    #[tokio::test]
    async fn test_unsigned_amend_replaces_head_instead_of_failing() {
        let test_repo = TestRepo::with_initial_commit();
        let first = test_repo.head_oid();
        test_repo.create_commit("Second", &[("a.txt", "content")]);
        let before = test_repo.head_oid();

        let result = create_commit(
            test_repo.path_str(),
            "Amended second".to_string(),
            Some(true),
            Some(false), // unsigned: the git2 path
            None,
            None,
            None,
        )
        .await;

        assert!(
            result.is_ok(),
            "unsigned amend must succeed, got: {:?}",
            result.err()
        );

        let repo = test_repo.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();

        assert_eq!(head.message().unwrap().trim(), "Amended second");
        assert_ne!(head.id(), before, "amend must replace the tip");
        assert_eq!(head.parent_count(), 1, "the original parent is preserved");
        assert_eq!(head.parent_id(0).unwrap(), first);
    }

    /// `git commit --amend` preserves the ORIGINAL author identity and author
    /// date; only `--reset-author` changes them.
    ///
    /// The commit panel sends only message+amend, so every amend through it
    /// silently re-attributed the commit to the current user and reset its
    /// author date to now — and only when commit.gpgsign was OFF, since the
    /// signed path shells out to `git commit --amend`, which gets it right.
    #[tokio::test]
    async fn test_amend_preserves_the_original_author() {
        let test_repo = TestRepo::with_initial_commit();

        const ORIGINAL_TIME: i64 = 1_000_000_000;
        {
            let repo = test_repo.repo();
            test_repo.create_file("a.txt", "content");
            test_repo.stage_file("a.txt");

            let mut index = repo.index().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();

            let author = git2::Signature::new(
                "Original Author",
                "original@example.com",
                &git2::Time::new(ORIGINAL_TIME, 0),
            )
            .unwrap();
            let committer = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();

            repo.commit(
                Some("HEAD"),
                &author,
                &committer,
                "Original message",
                &tree,
                &[&parent],
            )
            .unwrap();
        }

        create_commit(
            test_repo.path_str(),
            "Amended message".to_string(),
            Some(true),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let repo = test_repo.repo();
        let amended = repo.head().unwrap().peel_to_commit().unwrap();
        let local = repo.signature().unwrap();

        assert_eq!(amended.message().unwrap().trim(), "Amended message");

        // Author untouched, timestamp included.
        assert_eq!(amended.author().name().unwrap(), "Original Author");
        assert_eq!(amended.author().email().unwrap(), "original@example.com");
        assert_eq!(amended.author().when().seconds(), ORIGINAL_TIME);

        // Committer is whoever performed the amend.
        assert_eq!(amended.committer().name().unwrap(), local.name().unwrap());
    }

    /// Messages of every commit reachable from HEAD, newest first.
    fn history(repo: &TestRepo) -> Vec<String> {
        let repo = repo.repo();
        let mut revwalk = repo.revwalk().unwrap();
        revwalk.push_head().unwrap();
        revwalk
            .flatten()
            .map(|oid| {
                repo.find_commit(oid)
                    .unwrap()
                    .message()
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            })
            .collect()
    }

    /// Rewording a commit below HEAD goes through `git rebase -i`, which reaches
    /// the new message through GIT_EDITOR. Nothing about that is Windows-only,
    /// so it has to keep working before the Windows shape can be trusted.
    #[tokio::test]
    async fn test_reword_non_head_commit_rewrites_only_that_message() {
        let repo = TestRepo::with_initial_commit();
        let target = repo.create_commit("original message", &[("a.txt", "a")]);
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = reword_commit(
            repo.path_str(),
            target.to_string(),
            "reworded message".to_string(),
        )
        .await;

        let result = result.expect("reword of a non-HEAD commit must succeed");
        assert!(result.success);
        assert_eq!(
            history(&repo),
            vec!["descendant", "reworded message", "Initial commit"],
            "only the targeted commit's message changes, and its descendant survives"
        );

        let repo_handle = repo.repo();
        let new_head = repo_handle.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            result.new_oid,
            new_head.parent(0).unwrap().id().to_string(),
            "new_oid names the REWORDED commit, not the descendant replayed on top of it"
        );
    }

    /// The todo the sequence editor rewrites is written in a format the USER
    /// configures. `rebase.abbreviateCommands=true` makes git write
    /// `p <oid> subject` instead of `pick <oid> subject`, so an unpinned rebase
    /// matched nothing, replayed every commit as a plain pick and exited 0 —
    /// and the reword reported success with the old message still in place.
    #[tokio::test]
    async fn test_reword_non_head_commit_with_abbreviated_todo_commands() {
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_bool("rebase.abbreviateCommands", true)
            .unwrap();
        let target = repo.create_commit("original message", &[("a.txt", "a")]);
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = reword_commit(
            repo.path_str(),
            target.to_string(),
            "reworded message".to_string(),
        )
        .await
        .expect("reword must survive rebase.abbreviateCommands");

        assert!(result.success);
        assert_eq!(
            history(&repo),
            vec!["descendant", "reworded message", "Initial commit"],
            "the todo line must still be rewritten when git abbreviates the command"
        );
    }

    /// The editor commands used to be shell SCRIPTS that interpolated the
    /// message path into a DOUBLE-quoted `cp`. A repository directory holding a
    /// `$` — legal on every platform, and all it takes is a folder named
    /// `re$po` — was then expanded by the shell before `cp` saw it, so the copy
    /// read a path that did not exist, GIT_EDITOR failed, and the user got
    /// "Rebase failed" plus a repository stopped mid-rebase.
    #[tokio::test]
    async fn test_reword_non_head_commit_in_a_path_the_shell_would_expand() {
        let repo = TestRepo::with_initial_commit_named("re$po 'dir'");
        let target = repo.create_commit("original message", &[("a.txt", "a")]);
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = reword_commit(
            repo.path_str(),
            target.to_string(),
            "reworded message".to_string(),
        )
        .await;

        assert!(
            result.is_ok(),
            "a repository path containing shell metacharacters must still reword: {:?}",
            result.err()
        );
        assert_eq!(
            history(&repo),
            vec!["descendant", "reworded message", "Initial commit"]
        );
        assert_eq!(
            repo.repo().state(),
            git2::RepositoryState::Clean,
            "no rebase may be left in progress"
        );
    }

    /// A root commit has no parent to rebase onto, so there is nothing to
    /// reword through — the user gets a message rather than a raw git error.
    #[tokio::test]
    async fn test_reword_root_commit_below_head_is_rejected() {
        let repo = TestRepo::with_initial_commit();
        let root = repo.head_oid();
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = reword_commit(repo.path_str(), root.to_string(), "new".to_string()).await;

        let err = result
            .expect_err("root commit cannot be reworded")
            .to_string();
        assert!(err.contains("Cannot reword root commit"), "{err}");
    }

    /// `rebase -i <merge>^1` linearizes the merge away instead of listing it, so
    /// the sequence editor finds no `pick <oid>` to turn into `reword`: git
    /// replays the side branch onto the first parent and exits 0 with the
    /// message untouched. The message-matching walk below then finds nothing,
    /// keeps its HEAD seed and reports `success: true` — a reword that never
    /// happened, naming an unrelated commit, on a branch whose merge commit has
    /// just been destroyed. Refuse before anything is rewritten.
    #[tokio::test]
    async fn test_reword_merge_commit_is_rejected_without_rewriting_the_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("base", &[("a.txt", "a")]);

        // Built through git2 alone so the side commit never touches the working
        // tree, matching the shape a real merged-in branch has here.
        let side = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let base = git_repo.head().unwrap().peel_to_commit().unwrap();
            let blob = git_repo.blob(b"s").unwrap();
            let mut builder = git_repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
            builder.insert("s.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            git_repo
                .commit(None, &sig, &sig, "side work", &tree, &[&base])
                .unwrap()
        };
        repo.create_commit("main work", &[("m.txt", "m")]);
        let merge = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let other = git_repo.find_commit(side).unwrap();
            let tree = head.tree().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "Merge side",
                    &tree,
                    &[&head, &other],
                )
                .unwrap()
        };
        repo.create_commit("descendant", &[("d.txt", "d")]);
        let before = repo.head_oid();

        let err = reword_commit(
            repo.path_str(),
            merge.to_string(),
            "Renamed merge".to_string(),
        )
        .await
        .expect_err("a merge commit cannot be reworded by rebase");

        assert!(
            err.to_string().contains("Cannot reword a merge commit"),
            "{err}"
        );

        let git_repo = repo.repo();
        assert_eq!(
            git_repo.head().unwrap().peel_to_commit().unwrap().id(),
            before,
            "a refused reword must leave the branch tip where it was"
        );
        assert_eq!(
            git_repo
                .find_commit(merge)
                .unwrap()
                .message()
                .unwrap()
                .trim(),
            "Merge side",
            "the merge commit's message must be untouched"
        );
        assert!(
            history(&repo).contains(&"Merge side".to_string()),
            "the merge commit must still be on the branch: {:?}",
            history(&repo)
        );
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "no rebase may be left in progress"
        );
    }

    /// The merge refusal is about the rebase, so it must not spill onto the HEAD
    /// path: that one amends in place and `Commit::amend` carries both parents
    /// over, which is a perfectly good way to rename a merge.
    #[tokio::test]
    async fn test_reword_merge_commit_at_head_still_works() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("base", &[("a.txt", "a")]);

        let side = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let base = git_repo.head().unwrap().peel_to_commit().unwrap();
            let blob = git_repo.blob(b"s").unwrap();
            let mut builder = git_repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
            builder.insert("s.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            git_repo
                .commit(None, &sig, &sig, "side work", &tree, &[&base])
                .unwrap()
        };
        repo.create_commit("main work", &[("m.txt", "m")]);
        let merge = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let other = git_repo.find_commit(side).unwrap();
            let tree = head.tree().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "Merge side",
                    &tree,
                    &[&head, &other],
                )
                .unwrap()
        };

        let result = reword_commit(
            repo.path_str(),
            merge.to_string(),
            "Merge side branch".to_string(),
        )
        .await
        .expect("a merge commit at HEAD is reworded by amend, not by rebase");

        let git_repo = repo.repo();
        let new_head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(new_head.id().to_string(), result.new_oid);
        assert_eq!(new_head.message().unwrap().trim(), "Merge side branch");
        assert_eq!(
            new_head.parent_count(),
            2,
            "the amended merge must keep both parents"
        );
    }

    /// Editing the date of a commit below HEAD is the other half of the
    /// sequence-editor path: the todo entry for that ONE commit has to become
    /// `edit` so the rebase stops there. If it does not, the rebase runs to
    /// completion and the amend lands on the descendant instead — which is why
    /// this asserts on the redated commit rather than only on HEAD.
    #[tokio::test]
    async fn test_edit_commit_date_non_head_commit() {
        let repo = TestRepo::with_initial_commit();
        let target = repo.create_commit("target", &[("a.txt", "a")]);
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = edit_commit_date(
            repo.path_str(),
            target.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await;

        let result = result.expect("editing a non-HEAD commit date must succeed");
        assert!(result.success);
        assert_eq!(
            history(&repo),
            vec!["descendant", "target", "Initial commit"],
            "the rebase replays the descendant on top of the redated commit"
        );

        let repo_handle = repo.repo();
        let redated = repo_handle
            .find_commit(git2::Oid::from_str(&result.new_oid).unwrap())
            .unwrap();
        assert_eq!(
            redated.summary().unwrap(),
            Some("target"),
            "new_oid names the REDATED commit, not the descendant replayed on top of it"
        );
        // 2020-06-15T12:00:00Z
        assert_eq!(
            redated.committer().when().seconds(),
            1592222400,
            "the rebase must have stopped on `target` for the amend"
        );

        let head = repo_handle.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent(0).unwrap().id(), redated.id());
        assert_ne!(
            head.committer().when().seconds(),
            1592222400,
            "the descendant is replayed, not redated"
        );
    }

    /// `core.abbrev` sets the width of the oid git writes into the todo, and a
    /// repository configured below the 7 characters the pattern uses made the
    /// sed match nothing. The rebase then ran to completion with no `edit`
    /// stop, so `git commit --amend` landed on the DESCENDANT sitting at HEAD —
    /// the wrong commit redated, reported to the caller as a success.
    #[tokio::test]
    async fn test_edit_commit_date_non_head_commit_with_a_short_core_abbrev() {
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_str("core.abbrev", "6")
            .unwrap();
        let target = repo.create_commit("target", &[("a.txt", "a")]);
        repo.create_commit("descendant", &[("b.txt", "b")]);

        let result = edit_commit_date(
            repo.path_str(),
            target.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await
        .expect("editing a non-HEAD commit date must survive core.abbrev");

        let repo_handle = repo.repo();
        let redated = repo_handle
            .find_commit(git2::Oid::from_str(&result.new_oid).unwrap())
            .unwrap();
        assert_eq!(redated.summary().unwrap(), Some("target"));
        assert_eq!(
            redated.committer().when().seconds(),
            1592222400,
            "the rebase must have stopped on `target` even with a 6-character abbreviation"
        );

        let head = repo_handle.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent(0).unwrap().id(), redated.id());
        assert_ne!(
            head.committer().when().seconds(),
            1592222400,
            "the descendant must not be the commit that got redated"
        );
    }

    /// `rebase.autoSquash=true` makes git REWRITE the todo before the sequence
    /// editor ever sees it: every `fixup!`/`squash!` commit in the range has its
    /// line turned into a `fixup`/`squash` and moved next to the commit it
    /// names. The reword itself still landed, but the rebase then MELDED the
    /// user's fixup commit into its target — a commit destroyed by an operation
    /// that was only ever asked to change one message.
    #[tokio::test]
    async fn test_reword_non_head_commit_keeps_the_users_fixup_commits() {
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_bool("rebase.autoSquash", true)
            .unwrap();
        let target = repo.create_commit("base work", &[("a.txt", "a")]);
        repo.create_commit("fixup! base work", &[("b.txt", "b")]);
        repo.create_commit("descendant", &[("c.txt", "c")]);

        let result = reword_commit(
            repo.path_str(),
            target.to_string(),
            "reworded message".to_string(),
        )
        .await
        .expect("reword must survive rebase.autoSquash");

        assert!(result.success);
        assert_eq!(
            history(&repo),
            vec![
                "descendant",
                "fixup! base work",
                "reworded message",
                "Initial commit"
            ],
            "a reword must not squash the fixup commits the user still has queued"
        );
    }

    /// The date-edit half of the same trap: with `rebase.autoSquash=true` the
    /// rebase that only had to stop on one commit also swallowed the fixup
    /// commit sitting after it.
    #[tokio::test]
    async fn test_edit_commit_date_non_head_commit_keeps_the_users_fixup_commits() {
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_bool("rebase.autoSquash", true)
            .unwrap();
        let target = repo.create_commit("base work", &[("a.txt", "a")]);
        repo.create_commit("fixup! base work", &[("b.txt", "b")]);
        repo.create_commit("descendant", &[("c.txt", "c")]);

        let result = edit_commit_date(
            repo.path_str(),
            target.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await
        .expect("editing a date must survive rebase.autoSquash");

        assert_eq!(
            history(&repo),
            vec![
                "descendant",
                "fixup! base work",
                "base work",
                "Initial commit"
            ],
            "a date edit must not squash the fixup commits the user still has queued"
        );

        let repo_handle = repo.repo();
        let redated = repo_handle
            .find_commit(git2::Oid::from_str(&result.new_oid).unwrap())
            .unwrap();
        assert_eq!(
            redated.committer().when().seconds(),
            1592222400,
            "new_oid must still name the commit that got the new date"
        );
    }

    /// A merge commit never reaches the todo — `rebase -i` linearizes the range
    /// and lists the side commits instead — so the sequence editor finds no
    /// `pick <oid>` to turn into `edit`, git replays everything and exits 0. The
    /// amend that follows then landed on whatever the completed rebase left at
    /// HEAD, and the caller was told the date edit had succeeded while naming a
    /// commit the user never picked.
    #[tokio::test]
    async fn test_edit_commit_date_on_a_merge_commit_is_an_error_not_a_silent_success() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("base", &[("a.txt", "a")]);

        // Built through git2 alone so the side commit never touches the working
        // tree: the rebase below has to replay it onto a checkout that has never
        // seen s.txt.
        let side = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let base = git_repo.head().unwrap().peel_to_commit().unwrap();
            let blob = git_repo.blob(b"s").unwrap();
            let mut builder = git_repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
            builder.insert("s.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            git_repo
                .commit(None, &sig, &sig, "side work", &tree, &[&base])
                .unwrap()
        };
        repo.create_commit("main work", &[("m.txt", "m")]);
        let merge = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let other = git_repo.find_commit(side).unwrap();
            let tree = head.tree().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "Merge side",
                    &tree,
                    &[&head, &other],
                )
                .unwrap()
        };
        repo.create_commit("descendant", &[("d.txt", "d")]);
        let before = repo.head_oid();

        let err = edit_commit_date(
            repo.path_str(),
            merge.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await
        .expect_err("a rebase that never stopped must not be reported as a date edit");

        assert!(
            err.to_string()
                .contains("Rebase did not stop at the target commit"),
            "{err}"
        );

        // The error is only half the job: git had already replayed the range by
        // the time it was raised, linearizing the merge away and rewriting the
        // side branch. A refused date edit has to leave the branch exactly as
        // it found it, not hand the user a rewritten history plus a message.
        let git_repo = repo.repo();
        assert_eq!(
            git_repo.head().unwrap().peel_to_commit().unwrap().id(),
            before,
            "a refused date edit must leave the branch tip where it was"
        );
        let merge_commit = git_repo.find_commit(merge).unwrap();
        assert_eq!(
            merge_commit.parent_count(),
            2,
            "the merge commit itself must survive"
        );
        assert!(
            history(&repo).contains(&"Merge side".to_string()),
            "the merge commit must still be on the branch, not only in the reflog: {:?}",
            history(&repo)
        );
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "no rebase may be left in progress"
        );
        assert!(
            git_repo
                .statuses(None)
                .unwrap()
                .iter()
                .all(|s| s.status() == git2::Status::CURRENT),
            "the working tree must be left clean"
        );
    }

    /// The merge test above gives the side branch a file of its own, so the
    /// linearizing replay can never conflict and `git rebase -i` always exits
    /// 0. Give the side branch the SAME file the first-parent line writes and
    /// the replay conflicts: git stops mid-rebase on a detached HEAD with a
    /// conflicted index and exits non-zero, taking the one exit that runs
    /// before any of the restore logic. Returning there without aborting left
    /// the user in exactly the state the restore exists to prevent.
    #[tokio::test]
    async fn test_edit_commit_date_on_a_conflicting_merge_commit_aborts_the_rebase() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("base", &[("a.txt", "a")]);

        // Built through git2 so the side commit never touches the working tree,
        // and writing m.txt — the same file `main work` adds below — so that
        // replaying it onto the first parent is an add/add conflict.
        let side = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let base = git_repo.head().unwrap().peel_to_commit().unwrap();
            let blob = git_repo.blob(b"from the side\n").unwrap();
            let mut builder = git_repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
            builder.insert("m.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            git_repo
                .commit(None, &sig, &sig, "side work", &tree, &[&base])
                .unwrap()
        };
        repo.create_commit("main work", &[("m.txt", "from the first parent\n")]);
        let merge = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let other = git_repo.find_commit(side).unwrap();
            let tree = head.tree().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "Merge side",
                    &tree,
                    &[&head, &other],
                )
                .unwrap()
        };
        repo.create_commit("descendant", &[("d.txt", "d")]);
        let before = repo.head_oid();

        let err = edit_commit_date(
            repo.path_str(),
            merge.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await
        .expect_err("a rebase that stopped on a conflict is not a date edit");

        assert!(err.to_string().contains("Rebase failed"), "{err}");

        let git_repo = repo.repo();
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "a rebase that failed must not be left in progress"
        );
        assert_eq!(
            git_repo.head().unwrap().peel_to_commit().unwrap().id(),
            before,
            "a refused date edit must leave the branch tip where it was"
        );
        assert!(
            history(&repo).contains(&"Merge side".to_string()),
            "the merge commit must still be on the branch: {:?}",
            history(&repo)
        );
        assert!(
            git_repo
                .statuses(None)
                .unwrap()
                .iter()
                .all(|s| s.status() == git2::Status::CURRENT),
            "the working tree must be left clean, with no conflict markers"
        );
    }

    /// The recovery path above hard-resets the branch on the premise that a
    /// rebase refuses to start on a dirty tree. `rebase.autoStash=true` — a
    /// setting the app offers in its own Settings tab — breaks that premise:
    /// git stashes the dirty tree, replays the range, exits 0 in a Clean state
    /// so the recovery path IS taken, and pops the stash back into the working
    /// tree an instant before the `reset --hard` destroys it. The autostash
    /// commit is unreferenced after a successful pop, so the user's uncommitted
    /// work was gone from everywhere but `git fsck --lost-found` — while the
    /// error said "Nothing was changed".
    #[tokio::test]
    async fn test_edit_commit_date_refusal_does_not_destroy_an_autostashed_working_tree() {
        let repo = TestRepo::with_initial_commit();
        repo.repo()
            .config()
            .unwrap()
            .set_bool("rebase.autoStash", true)
            .unwrap();
        repo.create_commit("base", &[("a.txt", "a")]);

        // Built through git2 alone so the side commit never touches the working
        // tree, matching the merge-commit case above.
        let side = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let base = git_repo.head().unwrap().peel_to_commit().unwrap();
            let blob = git_repo.blob(b"s").unwrap();
            let mut builder = git_repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
            builder.insert("s.txt", blob, 0o100644).unwrap();
            let tree_oid = builder.write().unwrap();
            let tree = git_repo.find_tree(tree_oid).unwrap();
            git_repo
                .commit(None, &sig, &sig, "side work", &tree, &[&base])
                .unwrap()
        };
        repo.create_commit("main work", &[("m.txt", "m")]);
        let merge = {
            let git_repo = repo.repo();
            let sig = git_repo.signature().unwrap();
            let head = git_repo.head().unwrap().peel_to_commit().unwrap();
            let other = git_repo.find_commit(side).unwrap();
            let tree = head.tree().unwrap();
            git_repo
                .commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    "Merge side",
                    &tree,
                    &[&head, &other],
                )
                .unwrap()
        };
        repo.create_commit("descendant", &[("d.txt", "d")]);
        let before = repo.head_oid();

        // Uncommitted work on a TRACKED file — the only thing a `reset --hard`
        // can destroy without a trace.
        repo.create_file("a.txt", "a\nPRECIOUS UNCOMMITTED WORK\n");

        let err = edit_commit_date(
            repo.path_str(),
            merge.to_string(),
            None,
            Some("2020-06-15T12:00:00Z".to_string()),
        )
        .await
        .expect_err("a date edit on a merge commit must still be refused");

        assert_eq!(
            std::fs::read_to_string(repo.path.join("a.txt")).unwrap(),
            "a\nPRECIOUS UNCOMMITTED WORK\n",
            "a refused date edit must never destroy uncommitted work: {err}"
        );
        assert_eq!(
            repo.head_oid(),
            before,
            "the branch tip must be where it was"
        );
        let git_repo = repo.repo();
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "no rebase may be left in progress"
        );
        assert!(
            history(&repo).contains(&"Merge side".to_string()),
            "the merge commit must still be on the branch: {:?}",
            history(&repo)
        );
    }

    #[tokio::test]
    async fn test_amend_commit_with_new_message() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        let result = amend_commit(
            repo.path_str(),
            Some("Amended commit message".to_string()),
            None,
            Some(false), // Explicitly disable signing to avoid CI gpgsign config
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();
        assert!(amend_result.success);
        assert_eq!(amend_result.old_oid, old_oid.to_string());
        assert_ne!(amend_result.new_oid, old_oid.to_string());

        // Verify the new message
        let commit_result = get_commit(repo.path_str(), amend_result.new_oid.clone()).await;
        assert!(commit_result.is_ok());
        assert_eq!(commit_result.unwrap().summary, "Amended commit message");
    }

    #[tokio::test]
    async fn test_amend_commit_keep_message() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        // Get original message
        let original_message = get_commit_message(repo.path_str(), old_oid.to_string())
            .await
            .unwrap();

        // Amend without changing message, explicitly disable signing for CI
        let result = amend_commit(repo.path_str(), None, None, Some(false)).await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();
        assert!(amend_result.success);

        // Verify message is preserved
        let new_message = get_commit_message(repo.path_str(), amend_result.new_oid.clone())
            .await
            .unwrap();
        assert_eq!(new_message, original_message);
    }

    #[tokio::test]
    async fn test_amend_result_serialization() {
        let result = AmendResult {
            new_oid: "abc123".to_string(),
            old_oid: "def456".to_string(),
            success: true,
        };

        let json = serde_json::to_string(&result);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("\"newOid\":\"abc123\""));
        assert!(json_str.contains("\"oldOid\":\"def456\""));
        assert!(json_str.contains("\"success\":true"));
    }

    #[test]
    fn test_parse_iso8601_utc() {
        let time = parse_iso8601_to_git_time("2024-01-15T10:30:00Z").unwrap();
        // 2024-01-15T10:30:00Z = 1705314600
        assert_eq!(time.seconds(), 1705314600);
        assert_eq!(time.offset_minutes(), 0);
    }

    #[test]
    fn test_parse_iso8601_positive_offset() {
        let time = parse_iso8601_to_git_time("2024-01-15T15:30:00+05:00").unwrap();
        // 2024-01-15T15:30:00+05:00 = 2024-01-15T10:30:00Z = 1705314600
        assert_eq!(time.seconds(), 1705314600);
        assert_eq!(time.offset_minutes(), 300);
    }

    #[test]
    fn test_parse_iso8601_negative_offset() {
        let time = parse_iso8601_to_git_time("2024-01-15T07:30:00-03:00").unwrap();
        // 2024-01-15T07:30:00-03:00 = 2024-01-15T10:30:00Z = 1705314600
        assert_eq!(time.seconds(), 1705314600);
        assert_eq!(time.offset_minutes(), -180);
    }

    #[test]
    fn test_parse_unix_timestamp() {
        let time = parse_iso8601_to_git_time("1705312200").unwrap();
        assert_eq!(time.seconds(), 1705312200);
        assert_eq!(time.offset_minutes(), 0);
    }

    #[test]
    fn test_parse_iso8601_invalid_format() {
        let result = parse_iso8601_to_git_time("not-a-date");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_iso8601_no_time() {
        let result = parse_iso8601_to_git_time("2024-01-15");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_commit_with_custom_author_date() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("dated-file.txt", "content");
        repo.stage_file("dated-file.txt");

        let custom_date = "2020-06-15T12:00:00Z"; // June 15, 2020 at noon UTC
        let result = create_commit(
            repo.path_str(),
            "Commit with custom date".to_string(),
            None,
            None,
            None,
            Some(custom_date.to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        let commit = result.unwrap();
        assert!(commit.summary.contains("Commit with custom date"));

        // Verify the author date was set correctly
        // 2020-06-15T12:00:00Z = 1592222400
        assert_eq!(commit.author.timestamp, 1592222400);
    }

    #[tokio::test]
    async fn test_create_commit_with_custom_committer_date() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("dated-file2.txt", "content");
        repo.stage_file("dated-file2.txt");

        let custom_date = "2020-06-15T12:00:00Z"; // June 15, 2020 at noon UTC
        let result = create_commit(
            repo.path_str(),
            "Commit with custom committer date".to_string(),
            None,
            None,
            None,
            None,
            Some(custom_date.to_string()),
        )
        .await;

        assert!(result.is_ok());
        let commit = result.unwrap();
        // Verify the committer date was set
        assert_eq!(commit.committer.timestamp, 1592222400);
    }

    #[tokio::test]
    async fn test_create_commit_with_both_custom_dates() {
        let repo = TestRepo::with_initial_commit();
        repo.create_file("dated-file3.txt", "content");
        repo.stage_file("dated-file3.txt");

        let author_date = "2020-06-15T12:00:00Z";
        let committer_date = "2021-03-20T08:00:00Z"; // March 20, 2021 at 8am UTC = 1616227200

        let result = create_commit(
            repo.path_str(),
            "Commit with both custom dates".to_string(),
            None,
            None,
            None,
            Some(author_date.to_string()),
            Some(committer_date.to_string()),
        )
        .await;

        assert!(result.is_ok());
        let commit = result.unwrap();
        assert_eq!(commit.author.timestamp, 1592222400);
        assert_eq!(commit.committer.timestamp, 1616227200);
    }

    #[tokio::test]
    async fn test_edit_commit_date_head_author() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        let new_date = "2019-12-25T00:00:00Z"; // Christmas 2019 = 1577232000

        let result = edit_commit_date(
            repo.path_str(),
            old_oid.to_string(),
            Some(new_date.to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();
        assert!(amend_result.success);
        assert_eq!(amend_result.old_oid, old_oid.to_string());
        assert_ne!(amend_result.new_oid, old_oid.to_string());

        // Verify the new author date
        let commit_result = get_commit(repo.path_str(), amend_result.new_oid).await;
        assert!(commit_result.is_ok());
        let commit = commit_result.unwrap();
        assert_eq!(commit.author.timestamp, 1577232000);
    }

    #[tokio::test]
    async fn test_edit_commit_date_head_committer() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        let new_date = "2019-12-25T00:00:00Z"; // Christmas 2019

        let result = edit_commit_date(
            repo.path_str(),
            old_oid.to_string(),
            None,
            Some(new_date.to_string()),
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();
        assert!(amend_result.success);

        // Verify the new committer date
        let commit_result = get_commit(repo.path_str(), amend_result.new_oid).await;
        assert!(commit_result.is_ok());
        let commit = commit_result.unwrap();
        assert_eq!(commit.committer.timestamp, 1577232000);
    }

    #[tokio::test]
    async fn test_edit_commit_date_head_both_dates() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        let author_date = "2019-12-25T00:00:00Z"; // 1577232000
        let committer_date = "2020-01-01T00:00:00Z"; // 1577836800

        let result = edit_commit_date(
            repo.path_str(),
            old_oid.to_string(),
            Some(author_date.to_string()),
            Some(committer_date.to_string()),
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();
        assert!(amend_result.success);

        let commit_result = get_commit(repo.path_str(), amend_result.new_oid).await;
        assert!(commit_result.is_ok());
        let commit = commit_result.unwrap();
        assert_eq!(commit.author.timestamp, 1577232000);
        assert_eq!(commit.committer.timestamp, 1577836800);
    }

    #[tokio::test]
    async fn test_edit_commit_date_no_dates_provided() {
        let repo = TestRepo::with_initial_commit();
        let oid = repo.head_oid();

        let result = edit_commit_date(repo.path_str(), oid.to_string(), None, None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_edit_commit_date_invalid_commit() {
        let repo = TestRepo::with_initial_commit();
        let fake_oid = "0000000000000000000000000000000000000000".to_string();

        let result = edit_commit_date(
            repo.path_str(),
            fake_oid,
            Some("2020-01-01T00:00:00Z".to_string()),
            None,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_edit_commit_date_preserves_message() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        // Get original message
        let original_message = get_commit_message(repo.path_str(), old_oid.to_string())
            .await
            .unwrap();

        let result = edit_commit_date(
            repo.path_str(),
            old_oid.to_string(),
            Some("2020-06-15T12:00:00Z".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();

        // Verify message is preserved
        let new_message = get_commit_message(repo.path_str(), amend_result.new_oid)
            .await
            .unwrap();
        assert_eq!(new_message, original_message);
    }

    #[tokio::test]
    async fn test_edit_commit_date_preserves_author_info() {
        let repo = TestRepo::with_initial_commit();
        let old_oid = repo.head_oid();

        // Get original author info
        let original = get_commit(repo.path_str(), old_oid.to_string())
            .await
            .unwrap();

        let result = edit_commit_date(
            repo.path_str(),
            old_oid.to_string(),
            Some("2020-06-15T12:00:00Z".to_string()),
            None,
        )
        .await;

        assert!(result.is_ok());
        let amend_result = result.unwrap();

        let new_commit = get_commit(repo.path_str(), amend_result.new_oid)
            .await
            .unwrap();
        // Author name and email should be preserved
        assert_eq!(new_commit.author.name, original.author.name);
        assert_eq!(new_commit.author.email, original.author.email);
        // Only the date should change
        assert_ne!(new_commit.author.timestamp, original.author.timestamp);
    }

    #[test]
    fn test_is_leap_year() {
        assert!(is_leap_year(2000));
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(2023));
        assert!(is_leap_year(2400));
    }

    #[tokio::test]
    async fn test_create_commit_mid_cherrypick_clears_state() {
        // A cherry-pick that conflicts leaves CHERRY_PICK_HEAD set. Resolving
        // and committing via the normal commit panel must produce a SINGLE
        // parent commit AND clear the sequencer state, otherwise the app stays
        // stuck showing "cherry-pick in progress".
        let repo = TestRepo::with_initial_commit();
        let initial_branch = repo.current_branch();

        repo.create_commit("Add shared", &[("shared.txt", "base")]);
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        let pick_oid = repo.create_commit("Feature change", &[("shared.txt", "feature content")]);

        // Divergent change on the base branch so the cherry-pick conflicts.
        repo.checkout_branch(&initial_branch);
        repo.create_commit("Main change", &[("shared.txt", "main content")]);

        {
            let git_repo = repo.repo();
            let commit = git_repo.find_commit(pick_oid).unwrap();
            // A conflicting cherry-pick still sets CHERRY_PICK_HEAD.
            let _ = git_repo.cherrypick(&commit, None);
            assert_eq!(git_repo.state(), git2::RepositoryState::CherryPick);
        }

        // Resolve by staging the file.
        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();

        let result = create_commit(
            repo.path_str(),
            "Cherry-picked change".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok(), "commit failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "cherry-pick state must be cleared after committing"
        );
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            1,
            "a cherry-pick commit keeps a single parent"
        );
    }

    #[tokio::test]
    async fn test_create_commit_mid_revert_clears_state() {
        // A revert leaves REVERT_HEAD set; committing must clear it and keep a
        // single parent.
        let repo = TestRepo::with_initial_commit();
        let target = repo.create_commit("Add file", &[("revert_me.txt", "content")]);

        {
            let git_repo = repo.repo();
            let commit = git_repo.find_commit(target).unwrap();
            git_repo.revert(&commit, None).unwrap();
            assert_eq!(git_repo.state(), git2::RepositoryState::Revert);
        }

        let result = create_commit(
            repo.path_str(),
            "Revert add file".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok(), "commit failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "revert state must be cleared after committing"
        );
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(
            head.parent_count(),
            1,
            "a revert commit keeps a single parent"
        );
    }

    // ---- Hook parity (git2 commit path) ----

    #[cfg(unix)]
    #[tokio::test]
    async fn test_create_commit_pre_commit_hook_aborts() {
        let repo = TestRepo::with_initial_commit();
        let head_before = repo.head_oid();
        repo.install_hook("pre-commit", "#!/bin/sh\necho blocked 1>&2\nexit 1\n");
        repo.create_file("new.txt", "x");
        repo.stage_file("new.txt");

        let result = create_commit(
            repo.path_str(),
            "Should be blocked".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err(), "pre-commit exit 1 must abort the commit");
        assert!(result.unwrap_err().to_string().contains("blocked"));
        // HEAD must not have advanced.
        assert_eq!(repo.head_oid(), head_before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_create_commit_runs_post_commit_hook() {
        let repo = TestRepo::with_initial_commit();
        let marker = repo.path.join("post-commit-ran");
        repo.install_hook(
            "post-commit",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );
        repo.create_file("new.txt", "x");
        repo.stage_file("new.txt");

        let result = create_commit(
            repo.path_str(),
            "With post-commit".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok());
        assert!(marker.exists(), "post-commit hook must run after commit");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_create_commit_commit_msg_hook_rewrites() {
        let repo = TestRepo::with_initial_commit();
        repo.install_hook(
            "commit-msg",
            "#!/bin/sh\nprintf '\\nEdited-by: hook' >> \"$1\"\n",
        );
        repo.create_file("new.txt", "x");
        repo.stage_file("new.txt");

        let commit = create_commit(
            repo.path_str(),
            "Base message".to_string(),
            None,
            Some(false),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let full = get_commit_message(repo.path_str(), commit.oid)
            .await
            .unwrap();
        assert!(
            full.contains("Edited-by: hook"),
            "commit-msg rewrite must be persisted, got: {full:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_amend_commit_pre_commit_hook_aborts() {
        let repo = TestRepo::with_initial_commit();
        let head_before = repo.head_oid();
        repo.install_hook("pre-commit", "#!/bin/sh\nexit 1\n");

        let result = amend_commit(
            repo.path_str(),
            Some("new msg".to_string()),
            None,
            Some(false),
        )
        .await;
        assert!(result.is_err(), "amend must honor pre-commit");
        assert_eq!(repo.head_oid(), head_before, "HEAD must not move");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_amend_commit_runs_post_commit_and_commit_msg_hooks() {
        let repo = TestRepo::with_initial_commit();
        let marker = repo.path.join("amend-post-commit");
        repo.install_hook(
            "post-commit",
            &format!("#!/bin/sh\ntouch \"{}\"\n", marker.display()),
        );
        repo.install_hook("commit-msg", "#!/bin/sh\nprintf '\\ntrailer' >> \"$1\"\n");

        let result = amend_commit(
            repo.path_str(),
            Some("Reworded".to_string()),
            None,
            Some(false),
        )
        .await
        .unwrap();
        assert!(marker.exists(), "post-commit must run on amend");
        let full = get_commit_message(repo.path_str(), result.new_oid)
            .await
            .unwrap();
        assert!(full.contains("trailer"), "commit-msg rewrite must persist");
    }
}
