//! Integration test for cherry-pick timestamp handling
//!
//! This test verifies that cherry-picked commits (which can have different
//! author and committer timestamps) are handled correctly for graph sorting.
//!
//! These tests call the actual Tauri commands to verify the full interface.

use git2::{Repository, Signature, Time};
use gitnado_lib::commands::commit::get_commit_history;
use gitnado_lib::models::commit::Commit;
use std::path::Path;
use tempfile::TempDir;

/// Create a test repository with a cherry-pick scenario
fn setup_cherry_pick_repo() -> (TempDir, Repository) {
    let dir = TempDir::new().expect("Failed to create temp dir");
    let repo = Repository::init(dir.path()).expect("Failed to init repo");

    // Configure user
    let mut config = repo.config().expect("Failed to get config");
    config
        .set_str("user.name", "Test User")
        .expect("Failed to set user.name");
    config
        .set_str("user.email", "test@example.com")
        .expect("Failed to set user.email");

    (dir, repo)
}

/// Create a commit with specific author and committer times
fn create_commit_with_times(
    repo: &Repository,
    path: &Path,
    message: &str,
    author_time: i64,
    committer_time: i64,
    parent: Option<git2::Oid>,
) -> git2::Oid {
    // Create a file
    let file_path = path.join(format!("{}.txt", message.replace(' ', "_")));
    std::fs::write(&file_path, message).expect("Failed to write file");

    // Stage the file
    let mut index = repo.index().expect("Failed to get index");
    index
        .add_path(Path::new(file_path.file_name().unwrap()))
        .expect("Failed to stage file");
    index.write().expect("Failed to write index");

    // Create tree
    let tree_oid = index.write_tree().expect("Failed to write tree");
    let tree = repo.find_tree(tree_oid).expect("Failed to find tree");

    // Create signatures with specific times
    let author_sig = Signature::new("Author", "author@example.com", &Time::new(author_time, 0))
        .expect("Failed to create author signature");
    let committer_sig = Signature::new(
        "Committer",
        "committer@example.com",
        &Time::new(committer_time, 0),
    )
    .expect("Failed to create committer signature");

    // Get parent commits
    let parents: Vec<git2::Commit> = parent
        .map(|oid| repo.find_commit(oid).expect("Failed to find parent"))
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    repo.commit(
        Some("HEAD"),
        &author_sig,
        &committer_sig,
        message,
        &tree,
        &parent_refs,
    )
    .expect("Failed to create commit")
}

#[test]
fn test_cherry_pick_uses_max_timestamp() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Create initial commit (base)
    let base_oid = create_commit_with_times(&repo, dir.path(), "Base commit", 1000, 1000, None);

    // Create a commit that simulates a cherry-pick
    // In a real cherry-pick:
    // - Author time is preserved from the original commit (old)
    // - Committer time is when the cherry-pick was performed (new)
    let cherry_pick_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Cherry-picked commit",
        2000, // Old author time (from original commit)
        4000, // New committer time (when cherry-pick was done)
        Some(base_oid),
    );

    // Now test that our Commit model uses the MAX of the two timestamps
    let cherry_pick_commit = repo
        .find_commit(cherry_pick_oid)
        .expect("Failed to find cherry-pick commit");
    let commit_model = Commit::from_git2(&cherry_pick_commit);

    // The timestamp should be 4000 (the max of author=2000 and committer=4000)
    assert_eq!(
        commit_model.timestamp, 4000,
        "Cherry-pick commit should use max(author_time, committer_time) = 4000, but got {}",
        commit_model.timestamp
    );

    // Verify author time is preserved correctly in the signature
    assert_eq!(commit_model.author.timestamp, 2000);
    assert_eq!(commit_model.committer.timestamp, 4000);
}

#[test]
fn test_revert_uses_max_timestamp() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Create initial commit
    let base_oid = create_commit_with_times(&repo, dir.path(), "Base commit", 1000, 1000, None);

    // Create a commit to be reverted
    let to_revert_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Commit to revert",
        2000,
        2000,
        Some(base_oid),
    );

    // Simulate a revert: in some cases, the revert might have unusual timestamp ordering
    // Committer time: 1500 (somehow older - edge case)
    // Author time: 3000 (when revert was authored)
    let revert_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Revert commit",
        3000, // Author time (newer)
        1500, // Committer time (older - unusual but possible)
        Some(to_revert_oid),
    );

    let revert_commit = repo
        .find_commit(revert_oid)
        .expect("Failed to find revert commit");
    let commit_model = Commit::from_git2(&revert_commit);

    // Should use max of 3000 and 1500 = 3000
    assert_eq!(
        commit_model.timestamp, 3000,
        "Revert commit should use max(author_time, committer_time) = 3000, but got {}",
        commit_model.timestamp
    );
}

#[test]
fn test_normal_commit_timestamp() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Normal commit where author and committer times are the same
    let oid = create_commit_with_times(&repo, dir.path(), "Normal commit", 5000, 5000, None);

    let commit = repo.find_commit(oid).expect("Failed to find commit");
    let commit_model = Commit::from_git2(&commit);

    assert_eq!(
        commit_model.timestamp, 5000,
        "Normal commit should have timestamp 5000"
    );
}

#[test]
fn test_commit_ordering_after_cherry_pick() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Create a commit history where cherry-pick would cause ordering issues
    // without using max(author, committer)

    // Base: timestamp 1000
    let base_oid = create_commit_with_times(&repo, dir.path(), "Base", 1000, 1000, None);

    // Parent: timestamp 3000 (this is the parent of the cherry-pick)
    let parent_oid =
        create_commit_with_times(&repo, dir.path(), "Parent", 3000, 3000, Some(base_oid));

    // Cherry-picked child: author=2000 (old, from original), committer=4000 (now)
    // Without the fix, this would sort AFTER its parent (2000 < 3000)
    // With the fix, it uses 4000 and sorts BEFORE its parent (4000 > 3000)
    let child_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Cherry-picked child",
        2000, // Old author time
        4000, // New committer time
        Some(parent_oid),
    );

    let parent_commit = repo.find_commit(parent_oid).expect("Failed to find parent");
    let child_commit = repo.find_commit(child_oid).expect("Failed to find child");

    let parent_model = Commit::from_git2(&parent_commit);
    let child_model = Commit::from_git2(&child_commit);

    // Child should have a HIGHER timestamp than parent for correct graph ordering
    assert!(
        child_model.timestamp > parent_model.timestamp,
        "Cherry-picked child (timestamp={}) should sort before parent (timestamp={}) in graph",
        child_model.timestamp,
        parent_model.timestamp
    );
}

/// Integration test that calls the actual Tauri command `get_commit_history`
/// to verify the full interface returns commits with correct timestamps.
#[tokio::test]
async fn test_tauri_command_returns_correct_timestamps() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Create base commit
    let base_oid = create_commit_with_times(&repo, dir.path(), "Base commit", 1000, 1000, None);

    // Create a cherry-pick scenario: author time < committer time
    let _cherry_pick_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Cherry-picked via Tauri",
        2000, // Old author time
        4000, // New committer time
        Some(base_oid),
    );

    // Call the actual Tauri command
    let commits = get_commit_history(
        dir.path().to_string_lossy().to_string(),
        None,
        Some(10),
        None,
        None,
    )
    .await
    .expect("get_commit_history should succeed");

    assert_eq!(commits.len(), 2, "Should have 2 commits");

    // Find the cherry-picked commit (should be first due to higher timestamp)
    let cherry_pick = commits
        .iter()
        .find(|c| c.summary == "Cherry-picked via Tauri")
        .expect("Should find cherry-picked commit");

    // Verify the Tauri command returns the max timestamp
    assert_eq!(
        cherry_pick.timestamp, 4000,
        "Tauri command should return max(author, committer) = 4000"
    );

    // Verify it's sorted first (higher timestamp = newer = first in list)
    assert_eq!(
        commits[0].summary, "Cherry-picked via Tauri",
        "Cherry-picked commit should be first (newest) in the list"
    );
}

/// Integration test verifying commit ordering through Tauri command
#[tokio::test]
async fn test_tauri_command_orders_cherry_picks_correctly() {
    let (dir, repo) = setup_cherry_pick_repo();

    // Create commits where ordering would be wrong without the fix
    let base_oid = create_commit_with_times(&repo, dir.path(), "Base", 1000, 1000, None);

    // Parent with timestamp 3000
    let parent_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Parent commit",
        3000,
        3000,
        Some(base_oid),
    );

    // Child with author=2000, committer=4000
    // Without fix: would sort after parent (2000 < 3000) - WRONG
    // With fix: sorts before parent (4000 > 3000) - CORRECT
    let _child_oid = create_commit_with_times(
        &repo,
        dir.path(),
        "Child commit",
        2000,
        4000,
        Some(parent_oid),
    );

    // Call Tauri command
    let commits = get_commit_history(
        dir.path().to_string_lossy().to_string(),
        None,
        Some(10),
        None,
        None,
    )
    .await
    .expect("get_commit_history should succeed");

    // Verify order: child should come before parent (higher timestamp first)
    let child_idx = commits
        .iter()
        .position(|c| c.summary == "Child commit")
        .expect("Should find child");
    let parent_idx = commits
        .iter()
        .position(|c| c.summary == "Parent commit")
        .expect("Should find parent");

    assert!(
        child_idx < parent_idx,
        "Child (idx={}) should come before parent (idx={}) in Tauri response",
        child_idx,
        parent_idx
    );
}
