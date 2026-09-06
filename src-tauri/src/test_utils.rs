//! Test utilities for creating temporary git repositories

#![cfg(test)]

use crate::services::security::test_support::{self, GlobalSettingsGuard};
use std::path::PathBuf;
use std::sync::OnceLock;
use tempfile::TempDir;

/// Empty directory the isolated config search paths point at. Held for the
/// process lifetime: dropping it would let libgit2 fall back to a real path.
static CONFIG_SANDBOX: OnceLock<TempDir> = OnceLock::new();

/// Point libgit2's global/system/XDG config search at an empty directory.
///
/// Without this, every test that asserts a git DEFAULT is really asserting
/// something about whoever's machine it runs on. This container's global
/// gitconfig sets `commit.gpgsign=true`, `gpg.format=ssh` and a signing key,
/// so the signing, gpg and jira config tests failed here while passing
/// elsewhere — a suite that is green or red depending on the host is not
/// telling you anything.
///
/// Process-global by nature, so it runs once and covers every test in the
/// binary; each TestRepo still sets its own repo-local user.name/email.
fn isolate_git_config() {
    let dir =
        CONFIG_SANDBOX.get_or_init(|| TempDir::new().expect("Failed to create git config sandbox"));
    // SAFETY: libgit2 documents these as process-global and not thread-safe
    // against concurrent repository use. OnceLock makes the write happen
    // exactly once, and it happens before this thread opens any repository.
    unsafe {
        for level in [
            git2::ConfigLevel::System,
            git2::ConfigLevel::Global,
            git2::ConfigLevel::XDG,
            git2::ConfigLevel::ProgramData,
        ] {
            let _ = git2::opts::set_search_path(level, dir.path());
        }
    }
}

/// A temporary git repository for testing
pub struct TestRepo {
    /// Held, never read: this is an RAII guard. Dropping the TempDir deletes
    /// the repository directory, so the field must outlive every test that
    /// uses `path`. Removing it to satisfy dead-code analysis would delete the
    /// repo the moment TestRepo is constructed.
    #[allow(dead_code)]
    pub dir: TempDir,
    pub path: PathBuf,
    /// Pins the permissive network policy for as long as the repository
    /// exists, and takes a turn against the tests that switch a policy on.
    ///
    /// The backend gate reads a process-global setting, and a test that
    /// expects a fetch, push, prune or submodule update to go through would
    /// otherwise be refused whenever it happened to overlap a test that put
    /// the process in offline mode. Every test that touches a remote goes
    /// through here, so this is where the guard is taken by default rather
    /// than remembered per test. Held, never read.
    #[allow(dead_code)]
    _policy: GlobalSettingsGuard,
}

impl TestRepo {
    /// Create a new empty git repository
    pub fn new() -> Self {
        Self::new_in_subdir(None)
    }

    /// Create a new empty git repository in a subdirectory with the given name.
    ///
    /// TempDir only ever produces alphanumeric names, so it cannot exercise the
    /// paths users actually have. Anything the code interpolates into a shell
    /// command or a script has to survive a directory called `re$po "x"`.
    pub fn new_named(dir_name: &str) -> Self {
        Self::new_in_subdir(Some(dir_name))
    }

    fn new_in_subdir(dir_name: Option<&str>) -> Self {
        isolate_git_config();
        let policy = test_support::no_policy();
        let dir = TempDir::new().expect("Failed to create temp dir");
        let path = match dir_name {
            Some(name) => {
                let nested = dir.path().join(name);
                std::fs::create_dir_all(&nested).expect("Failed to create repo dir");
                nested
            }
            None => dir.path().to_path_buf(),
        };

        let repo = git2::Repository::init(&path).expect("Failed to init repo");

        // Configure user for commits
        let mut config = repo.config().expect("Failed to get config");
        config
            .set_str("user.name", "Test User")
            .expect("Failed to set user.name");
        config
            .set_str("user.email", "test@example.com")
            .expect("Failed to set user.email");

        Self {
            dir,
            path,
            _policy: policy,
        }
    }

    /// Create a repository with an initial commit on the "main" branch
    pub fn with_initial_commit() -> Self {
        Self::with_initial_commit_in(Self::new())
    }

    /// `with_initial_commit`, in a subdirectory with the given name.
    pub fn with_initial_commit_named(dir_name: &str) -> Self {
        Self::with_initial_commit_in(Self::new_named(dir_name))
    }

    fn with_initial_commit_in(test_repo: Self) -> Self {
        test_repo.create_commit("Initial commit", &[("README.md", "# Test Repo")]);

        // Rename the default branch to "main" for consistency
        let repo = test_repo.repo();
        if let Ok(mut head) = repo.find_branch("master", git2::BranchType::Local) {
            let _ = head.rename("main", false);
        }

        test_repo
    }

    /// Get the repository path as a string
    pub fn path_str(&self) -> String {
        self.path.to_string_lossy().to_string()
    }

    /// Get the git2 repository
    pub fn repo(&self) -> git2::Repository {
        git2::Repository::open(&self.path).expect("Failed to open repo")
    }

    /// Create a file with content
    pub fn create_file(&self, name: &str, content: &str) {
        let file_path = self.path.join(name);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).expect("Failed to create parent dirs");
        }
        std::fs::write(&file_path, content).expect("Failed to write file");
    }

    /// Stage a file
    pub fn stage_file(&self, name: &str) {
        let repo = self.repo();
        let mut index = repo.index().expect("Failed to get index");
        index
            .add_path(std::path::Path::new(name))
            .expect("Failed to stage file");
        index.write().expect("Failed to write index");
    }

    /// Create a commit with the given files
    pub fn create_commit(&self, message: &str, files: &[(&str, &str)]) -> git2::Oid {
        let repo = self.repo();

        // Create and stage files
        for (name, content) in files {
            self.create_file(name, content);
            self.stage_file(name);
        }

        // Create commit
        let mut index = repo.index().expect("Failed to get index");
        let tree_oid = index.write_tree().expect("Failed to write tree");
        let tree = repo.find_tree(tree_oid).expect("Failed to find tree");
        let sig = repo.signature().expect("Failed to get signature");

        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.as_ref().into_iter().collect();

        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .expect("Failed to create commit")
    }

    /// Create a branch at the current HEAD
    pub fn create_branch(&self, name: &str) -> git2::Oid {
        let repo = self.repo();
        let head = repo.head().expect("Failed to get HEAD");
        let commit = head.peel_to_commit().expect("Failed to get commit");
        repo.branch(name, &commit, false)
            .expect("Failed to create branch");
        commit.id()
    }

    /// Checkout a branch
    pub fn checkout_branch(&self, name: &str) {
        let repo = self.repo();
        let branch = repo
            .find_branch(name, git2::BranchType::Local)
            .expect("Failed to find branch");
        let obj = branch
            .get()
            .peel(git2::ObjectType::Commit)
            .expect("Failed to peel");
        repo.checkout_tree(&obj, None).expect("Failed to checkout");
        repo.set_head(branch.get().name().unwrap())
            .expect("Failed to set HEAD");
    }

    /// Get the current branch name
    pub fn current_branch(&self) -> String {
        let repo = self.repo();
        let head = repo.head().expect("Failed to get HEAD");
        head.shorthand().unwrap_or("").to_string()
    }

    /// Get the HEAD commit OID
    pub fn head_oid(&self) -> git2::Oid {
        let repo = self.repo();
        let head = repo.head().expect("Failed to get HEAD");
        head.target().expect("Failed to get target")
    }

    /// Add a remote
    pub fn add_remote(&self, name: &str, url: &str) {
        let repo = self.repo();
        repo.remote(name, url).expect("Failed to add remote");
    }

    /// Create a tag
    pub fn create_tag(&self, name: &str) -> git2::Oid {
        let repo = self.repo();
        let head = repo.head().expect("Failed to get HEAD");
        let commit = head.peel_to_commit().expect("Failed to get commit");
        let sig = repo.signature().expect("Failed to get signature");
        repo.tag(
            name,
            commit.as_object(),
            &sig,
            &format!("Tag {}", name),
            false,
        )
        .expect("Failed to create tag")
    }

    /// Create a lightweight tag
    pub fn create_lightweight_tag(&self, name: &str) {
        let repo = self.repo();
        let head = repo.head().expect("Failed to get HEAD");
        let commit = head.peel_to_commit().expect("Failed to get commit");
        repo.tag_lightweight(name, commit.as_object(), false)
            .expect("Failed to create lightweight tag");
    }

    /// Install an executable hook into `.git/hooks/<name>` with the given
    /// script body. On non-unix the executable bit cannot be set, so tests
    /// that assert hook execution are unix-only.
    #[cfg(unix)]
    pub fn install_hook(&self, name: &str, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let hooks_dir = self.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).expect("Failed to create hooks dir");
        let hook_path = hooks_dir.join(name);
        std::fs::write(&hook_path, script).expect("Failed to write hook");
        std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o755))
            .expect("Failed to chmod hook");
    }

    /// Create a fake remote branch ref (simulates `origin/branch-name`).
    /// This creates a ref at `refs/remotes/origin/<name>` pointing at `target_oid`.
    pub fn create_remote_branch(&self, name: &str, target_oid: git2::Oid) {
        let repo = self.repo();
        let commit = repo.find_commit(target_oid).expect("Failed to find commit");
        let refname = format!("refs/remotes/origin/{}", name);
        repo.reference(
            &refname,
            commit.id(),
            false,
            "create remote branch for test",
        )
        .expect("Failed to create remote branch ref");
    }
}

impl Default for TestRepo {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_repo() {
        let repo = TestRepo::new();
        assert!(repo.path.exists());
        assert!(repo.path.join(".git").exists());
    }

    #[test]
    fn test_create_commit() {
        let repo = TestRepo::with_initial_commit();
        let git_repo = repo.repo();
        let head = git_repo.head().expect("No HEAD");
        assert!(head.target().is_some());
    }

    #[test]
    fn test_create_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");
        let git_repo = repo.repo();
        let branch = git_repo.find_branch("feature", git2::BranchType::Local);
        assert!(branch.is_ok());
    }

    #[test]
    fn test_checkout_branch() {
        let repo = TestRepo::with_initial_commit();
        repo.create_branch("feature");
        repo.checkout_branch("feature");
        assert_eq!(repo.current_branch(), "feature");
    }
}
