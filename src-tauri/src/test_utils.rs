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
        let hooks_dir = self.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks_dir).expect("Failed to create hooks dir");
        write_executable(&hooks_dir.join(name), script);
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

/// Write a script that the test is about to EXECUTE, without this process ever
/// holding the file open for writing.
///
/// Linux refuses to exec a file any process holds open for writing
/// (`ETXTBSY`). `std::fs::write` closes its descriptor before returning, and
/// Rust marks it `O_CLOEXEC`, but neither helps against `fork`/`posix_spawn`:
/// every child another test thread spawns between our `open` and `close`
/// inherits a copy of the descriptor and keeps it until that child's `exec`.
/// Under `--test-threads=32` a git child forked by a sibling test regularly
/// sits in that window long enough for our exec of the hook to fail with
/// "Text file busy". Writing from a short-lived child of our own keeps the
/// write descriptor out of this process's table altogether: no sibling fork
/// can inherit it, and once the child has been waited for nothing holds it.
#[cfg(unix)]
pub fn write_executable(path: &std::path::Path, content: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("sh")
        .arg("-c")
        .arg("cat > \"$1\" && chmod 755 \"$1\"")
        .arg("sh")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("Failed to spawn the script writer");
    {
        let mut stdin = child.stdin.take().expect("script writer stdin");
        stdin
            .write_all(content.as_bytes())
            .expect("Failed to write the script body");
    }
    let status = child.wait().expect("Failed to wait for the script writer");
    assert!(
        status.success(),
        "writing {} failed: {}",
        path.display(),
        status
    );
}

/// Hand out a loopback port for a test whose code under test must bind the
/// port ITSELF (an `McpServer` started on a configured port, a
/// `LoopbackServer` whose port is re-bound after a cancel).
///
/// "Bind port 0, read the number back, drop the listener" is not safe once
/// the listener is dropped: the port is back in the kernel's ephemeral range,
/// where any `connect()` or `bind(0)` on another test thread can take it
/// before the code under test binds it — and, worse, the dropped listener
/// itself can outlive the drop (see [`bind_released_port`]), so the very
/// probe that found the port free is what makes the next bind fail. Ports
/// here are drawn from a block BELOW the ephemeral range (never used for
/// automatic assignment), handed out once per process through a counter (no
/// two tests in this binary get the same one), and checked with a `connect`
/// — which creates no listening socket a forked child could inherit — so a
/// fixed-port bind by some other process is skipped. The counter starts at a
/// pid-derived offset so concurrent test binaries on the same host walk
/// different parts of the block.
pub fn reserve_test_port() -> u16 {
    use std::sync::atomic::{AtomicU16, Ordering};

    static NEXT: OnceLock<AtomicU16> = OnceLock::new();
    let (lo, hi) = test_port_block();
    let span = hi - lo;
    let next = NEXT.get_or_init(|| {
        let offset = (std::process::id() as u64 * 7919 % u64::from(span)) as u16;
        AtomicU16::new(lo + offset)
    });

    for _ in 0..span {
        let raw = next.fetch_add(1, Ordering::Relaxed);
        let port = lo + raw.wrapping_sub(lo) % span;
        if !port_has_a_listener(port) {
            return port;
        }
    }
    panic!("no free loopback port in {}..{}", lo, hi);
}

/// Whether something accepts connections on `127.0.0.1:port` right now.
/// A refused connection is the one outcome that proves nobody is listening;
/// anything else (accepted, timed out, no permission) counts as taken.
/// Unlike a trial `bind`, this leaves no listening socket behind that a
/// child mid-spawn on another thread could inherit.
pub fn port_has_a_listener(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    !matches!(
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused
    )
}

/// Bind `port` after the code under test reports it released — the probe a
/// test uses to show a cancelled OAuth wait, or a shut-down server, really
/// gave its port back.
///
/// The first attempt is allowed to fail. A listening socket this process has
/// closed can stay bound a little longer: every child another test thread is
/// spawning at that moment holds, between its `fork` and its `exec`, a copy
/// of every descriptor this process had open — `SOCK_CLOEXEC` only closes
/// the copy at the `exec`. Measured on a 4-core host with 8 threads spawning
/// `/bin/true`: 0.7% of immediate re-binds fail with `EADDRINUSE`; with no
/// spawning, none in 580k. Nothing about the code under test changes what
/// happens next — the copy dies with the child's `exec`, microseconds to a
/// few scheduler ticks later — so the probe waits that out, bounded, instead
/// of reporting a release that did happen as a leak. A port that is really
/// still held (a wait that never got its cancel) stays bound for the whole
/// 300 s callback timeout, so the assertion still fails when it should.
///
/// That 5 s patience covers the TOTAL-failure regression only. A test that
/// asserts the port was released BEFORE the call under test returned — not
/// merely eventually — must use [`bind_released_port_within`] with a bound
/// below the accept loop's poll tick, or a shutdown that only signals the
/// loop (and frees the port a tick later) passes it anyway.
pub fn bind_released_port(port: u16) -> std::io::Result<std::net::TcpListener> {
    bind_released_port_within(port, std::time::Duration::from_secs(5))
}

/// [`bind_released_port`] with an explicit bound on how long a lingering
/// copy of the old listener is waited out — and, when that bound is set
/// below the code under test's own release latency, on how late a release
/// still counts as "before the call returned".
pub fn bind_released_port_within(
    port: u16,
    patience: std::time::Duration,
) -> std::io::Result<std::net::TcpListener> {
    let deadline = std::time::Instant::now() + patience;
    loop {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Err(e)
                if e.kind() == std::io::ErrorKind::AddrInUse
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            outcome => return outcome,
        }
    }
}

/// The `[lo, hi)` port block [`reserve_test_port`] draws from: 20000..30000,
/// shifted down to sit just below the kernel's ephemeral range on a Linux host
/// configured with an unusually low one.
fn test_port_block() -> (u16, u16) {
    let (mut lo, mut hi) = (20000u16, 30000u16);
    #[cfg(target_os = "linux")]
    if let Ok(range) = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range") {
        if let Some(low) = range
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u16>().ok())
        {
            if low < hi && low >= 11024 {
                hi = low;
                lo = low - 10000;
            }
        }
    }
    (lo, hi)
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

    #[test]
    fn reserved_ports_are_distinct_bindable_and_outside_the_ephemeral_range() {
        let (lo, hi) = test_port_block();
        let ports: Vec<u16> = (0..8).map(|_| reserve_test_port()).collect();
        for port in &ports {
            assert!((lo..hi).contains(port), "{} outside {}..{}", port, lo, hi);
            assert!(
                std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok(),
                "reserved port {} must be bindable",
                port
            );
        }
        let mut unique = ports.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ports.len(), "ports were handed out twice");
    }

    #[test]
    fn a_listening_port_is_seen_as_taken_and_a_closed_one_as_free() {
        // The predicate `reserve_test_port` skips ports on.
        let port = reserve_test_port();
        assert!(!port_has_a_listener(port), "{} was just found free", port);
        let holder = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert!(port_has_a_listener(port), "{} is listening", port);
        drop(holder);
        assert!(
            bind_released_port(port).is_ok(),
            "{} must be free again once the listener is closed",
            port
        );
    }

    #[test]
    fn a_released_port_can_be_bound_again() {
        let port = reserve_test_port();
        let held = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(held);
        bind_released_port(port).expect("a port nothing holds must bind");
    }

    #[test]
    fn a_port_that_stays_held_is_reported_as_in_use() {
        let port = reserve_test_port();
        let _held = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        // Bounded: the probe gives up rather than waiting on a port that is
        // genuinely still in use.
        let err = bind_released_port_within(port, std::time::Duration::from_millis(200))
            .expect_err("a held port must not bind");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }

    #[test]
    fn test_port_block_sits_below_the_ephemeral_range() {
        let (lo, hi) = test_port_block();
        assert!(lo < hi);
        assert!(hi - lo >= 1000);
        #[cfg(target_os = "linux")]
        {
            let range = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range").unwrap();
            let low: u16 = range.split_whitespace().next().unwrap().parse().unwrap();
            assert!(
                hi <= low,
                "block {}..{} overlaps the ephemeral range from {}",
                lo,
                hi,
                low
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_executable_produces_a_script_that_runs() {
        let dir = TempDir::new().unwrap();
        let script = dir.path().join("say");
        write_executable(&script, "#!/bin/sh\necho \"hello $1\"\n");

        let output = std::process::Command::new(&script)
            .arg("world")
            .output()
            .expect("the script must be executable");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "hello world"
        );

        // Rewriting replaces the body rather than appending to it.
        write_executable(&script, "#!/bin/sh\necho again\n");
        let output = std::process::Command::new(&script).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "again");
    }
}
