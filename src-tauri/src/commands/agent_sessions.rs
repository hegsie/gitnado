//! Agent Sessions (roadmap 4.1, issue #604).
//!
//! Detects terminal coding agents — Claude Code, Codex CLI, Copilot CLI,
//! Gemini CLI, Aider and friends — whose working directory is inside an open
//! repository or any of its worktrees, so Gitnado can show what each one is
//! doing.
//!
//! Detection is purely local: one snapshot of the process table (name, command
//! line, working directory, start time). Nothing is sent anywhere.
//!
//! Turn state comes from the agent hooks bridge when it is installed in that
//! worktree (`<gitdir>/gitnado/turn-*` exists while a turn runs). Without the
//! bridge a live process is reported as `running`, because nothing else can
//! tell "thinking" from "waiting for you".

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::command;

use crate::error::Result;

const MAX_COMMAND_LEN: usize = 200;

/// One process as seen by the detector (decoupled from sysinfo for tests).
#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub cmd: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Unix seconds.
    pub start_time: u64,
}

/// A worktree of the repository being inspected.
#[derive(Debug, Clone)]
pub struct WorktreeInfo {
    /// Canonical working directory.
    pub path: PathBuf,
    pub git_dir: PathBuf,
    pub branch: Option<String>,
    pub is_main: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// A turn is in progress (hooks bridge reports it).
    Working,
    /// Between turns, waiting for the user (hooks bridge reports it).
    Waiting,
    /// Alive, turn state unknown (no hooks bridge in that worktree).
    Running,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub pid: u32,
    /// Display name of the agent, e.g. "Claude Code".
    pub agent: String,
    /// The command line, truncated.
    pub command: String,
    pub cwd: String,
    /// Working directory of the worktree the agent runs in.
    pub worktree_path: String,
    pub is_main_worktree: bool,
    pub branch: Option<String>,
    pub state: AgentState,
    /// Unix seconds.
    pub started_at: u64,
    pub elapsed_secs: u64,
    /// Files with uncommitted changes in that worktree, when it could be read.
    pub changed_files: Option<usize>,
}

/// Known agents: (display name, executable basenames, package path markers).
const AGENTS: &[(&str, &[&str], &[&str])] = &[
    ("Claude Code", &["claude"], &["@anthropic-ai/claude-code"]),
    ("Codex CLI", &["codex"], &["@openai/codex"]),
    ("Copilot CLI", &["copilot"], &["@github/copilot"]),
    ("Gemini CLI", &["gemini"], &["@google/gemini-cli"]),
    ("Aider", &["aider", "aider-chat"], &["/aider/", "\\aider\\"]),
    ("opencode", &["opencode"], &["opencode-ai"]),
    ("Cursor Agent", &["cursor-agent"], &[]),
];

fn basename(token: &str) -> String {
    let name = token
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(token)
        .to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".js", ".mjs", ".cjs", ".py"] {
        if let Some(stripped) = name.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    name
}

/// Which agent, if any, a process is.
///
/// Only the executable and the script it runs are inspected — never later
/// arguments — so `grep claude` or `vim codex.md` are not agents.
pub fn classify_agent(name: &str, cmd: &[String]) -> Option<&'static str> {
    let mut candidates: Vec<&str> = vec![name];
    candidates.extend(cmd.iter().take(2).map(String::as_str));
    // `python -m aider`
    if cmd.get(1).is_some_and(|a| a == "-m") {
        if let Some(module) = cmd.get(2) {
            candidates.push(module);
        }
    }
    for (display, bins, markers) in AGENTS {
        for token in &candidates {
            if bins.contains(&basename(token).as_str()) {
                return Some(display);
            }
            let lower = token.to_lowercase();
            if markers.iter().any(|m| lower.contains(m)) {
                return Some(display);
            }
        }
    }
    None
}

/// The worktree containing `cwd`, preferring the deepest match (a worktree
/// nested inside the main checkout wins over the main checkout).
fn worktree_for<'a>(cwd: &Path, worktrees: &'a [WorktreeInfo]) -> Option<&'a WorktreeInfo> {
    worktrees
        .iter()
        .filter(|w| cwd.starts_with(&w.path))
        .max_by_key(|w| w.path.components().count())
}

fn state_for(worktree: &WorktreeInfo) -> AgentState {
    let dir = worktree.git_dir.join("gitnado");
    let turn_running = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("turn-"))
        })
        .unwrap_or(false);
    if turn_running {
        AgentState::Working
    } else if dir.join("agent-checkpoint.sh").is_file() {
        AgentState::Waiting
    } else {
        AgentState::Running
    }
}

fn truncate(s: String) -> String {
    if s.chars().count() <= MAX_COMMAND_LEN {
        return s;
    }
    let mut out: String = s.chars().take(MAX_COMMAND_LEN - 1).collect();
    out.push('…');
    out
}

/// Pure core of the detector.
pub fn collect_sessions(
    worktrees: &[WorktreeInfo],
    procs: &[ProcInfo],
    now: u64,
    changed_files: &dyn Fn(&WorktreeInfo) -> Option<usize>,
) -> Vec<AgentSession> {
    let detected: Vec<(&ProcInfo, &'static str, &WorktreeInfo)> = procs
        .iter()
        .filter_map(|p| {
            let agent = classify_agent(&p.name, &p.cmd)?;
            let cwd = p.cwd.as_deref()?;
            let worktree = worktree_for(cwd, worktrees)?;
            Some((p, agent, worktree))
        })
        .collect();

    // A wrapper and the runtime it starts (`claude` -> `node cli.js`) are one
    // session: keep only the outermost process of each agent.
    let ids: HashSet<(u32, &str)> = detected.iter().map(|(p, a, _)| (p.pid, *a)).collect();

    let mut sessions: Vec<AgentSession> = detected
        .iter()
        .filter(|(p, agent, _)| {
            !p.parent
                .is_some_and(|parent| ids.contains(&(parent, *agent)))
        })
        .map(|(p, agent, worktree)| AgentSession {
            pid: p.pid,
            agent: agent.to_string(),
            command: truncate(if p.cmd.is_empty() {
                p.name.clone()
            } else {
                p.cmd.join(" ")
            }),
            cwd: p
                .cwd
                .as_deref()
                .map(|c| c.to_string_lossy().into_owned())
                .unwrap_or_default(),
            worktree_path: worktree.path.to_string_lossy().into_owned(),
            is_main_worktree: worktree.is_main,
            branch: worktree.branch.clone(),
            state: state_for(worktree),
            started_at: p.start_time,
            elapsed_secs: now.saturating_sub(p.start_time),
            changed_files: changed_files(worktree),
        })
        .collect();
    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.pid.cmp(&b.pid)));
    sessions
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn branch_of(repo: &git2::Repository) -> Option<String> {
    repo.head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string))
}

/// The repository's main checkout plus every linked worktree.
pub fn repo_worktrees(path: &str) -> Result<Vec<WorktreeInfo>> {
    let repo = git2::Repository::open(path)?;
    // Work from the main repository so every linked worktree is listed even
    // when `path` is itself a linked worktree.
    let main = git2::Repository::open(repo.commondir())?;
    let mut out = Vec::new();
    if let Some(workdir) = main.workdir() {
        out.push(WorktreeInfo {
            path: canonical(workdir),
            git_dir: main.path().to_path_buf(),
            branch: branch_of(&main),
            is_main: true,
        });
    }
    if let Ok(names) = main.worktrees() {
        for name in names.iter().flatten().flatten() {
            let Ok(wt) = main.find_worktree(name) else {
                continue;
            };
            let Ok(wt_repo) = git2::Repository::open_from_worktree(&wt) else {
                continue;
            };
            out.push(WorktreeInfo {
                path: canonical(wt.path()),
                git_dir: wt_repo.path().to_path_buf(),
                branch: branch_of(&wt_repo),
                is_main: false,
            });
        }
    }
    Ok(out)
}

fn count_changed(worktree: &WorktreeInfo) -> Option<usize> {
    let repo = git2::Repository::open(&worktree.path).ok()?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);
    repo.statuses(Some(&mut opts)).ok().map(|s| s.len())
}

fn snapshot_processes() -> Vec<ProcInfo> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let Ok(mut sys) = System::new() else {
        return Vec::new();
    };
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    sys.processes()
        .values()
        .map(|p| ProcInfo {
            pid: p.pid().as_u32(),
            parent: p.parent().map(|pp| pp.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cmd: p
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            cwd: p.cwd().map(canonical),
            start_time: p.start_time(),
        })
        .collect()
}

/// Agent processes running in `path`'s repository or any of its worktrees.
#[command]
pub async fn list_agent_sessions(path: String) -> Result<Vec<AgentSession>> {
    crate::utils::blocking_git(move || {
        let worktrees = repo_worktrees(&path)?;
        let procs = snapshot_processes();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Count changes once per worktree, only for worktrees with an agent.
        let cache = std::cell::RefCell::new(std::collections::HashMap::new());
        let changed = |w: &WorktreeInfo| {
            *cache
                .borrow_mut()
                .entry(w.path.clone())
                .or_insert_with(|| count_changed(w))
        };
        Ok(collect_sessions(&worktrees, &procs, now, &changed))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn classifies_known_agents() {
        assert_eq!(
            classify_agent("claude", &s(&["claude"])),
            Some("Claude Code")
        );
        assert_eq!(
            classify_agent(
                "node",
                &s(&[
                    "node",
                    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
                    "--resume"
                ])
            ),
            Some("Claude Code")
        );
        assert_eq!(
            classify_agent("codex", &s(&["codex", "exec"])),
            Some("Codex CLI")
        );
        assert_eq!(
            classify_agent(
                "node",
                &s(&["node", "/opt/n/lib/node_modules/@openai/codex/bin/codex.js"])
            ),
            Some("Codex CLI")
        );
        assert_eq!(
            classify_agent("copilot", &s(&["copilot"])),
            Some("Copilot CLI")
        );
        assert_eq!(
            classify_agent("gemini", &s(&["gemini"])),
            Some("Gemini CLI")
        );
        assert_eq!(
            classify_agent("python3", &s(&["python3", "-m", "aider"])),
            Some("Aider")
        );
        assert_eq!(
            classify_agent("python3", &s(&["/home/u/.local/bin/aider", "--model", "x"])),
            Some("Aider")
        );
        assert_eq!(
            classify_agent("claude.exe", &s(&["C:\\Tools\\claude.exe"])),
            Some("Claude Code")
        );
    }

    #[test]
    fn ignores_lookalikes_and_arguments() {
        assert_eq!(
            classify_agent("grep", &s(&["grep", "-r", "claude", "."])),
            None
        );
        assert_eq!(classify_agent("vim", &s(&["vim", "codex.md"])), None);
        assert_eq!(
            classify_agent("node", &s(&["node", "server.js", "gemini"])),
            None
        );
        assert_eq!(
            classify_agent(
                "copilot-language-server",
                &s(&["copilot-language-server", "--stdio"])
            ),
            None
        );
        assert_eq!(classify_agent("bash", &s(&["bash"])), None);
    }

    fn wt(path: &str, is_main: bool, branch: &str) -> WorktreeInfo {
        WorktreeInfo {
            path: PathBuf::from(path),
            git_dir: PathBuf::from(format!("{path}/.git-does-not-exist")),
            branch: Some(branch.to_string()),
            is_main,
        }
    }

    fn proc(
        pid: u32,
        parent: Option<u32>,
        name: &str,
        cmd: &[&str],
        cwd: &str,
        start: u64,
    ) -> ProcInfo {
        ProcInfo {
            pid,
            parent,
            name: name.into(),
            cmd: s(cmd),
            cwd: Some(PathBuf::from(cwd)),
            start_time: start,
        }
    }

    #[test]
    fn collects_agents_inside_the_repo_and_its_worktrees_only() {
        let worktrees = vec![
            wt("/r/main", true, "main"),
            wt("/r/main/.wt/feat", false, "feat"),
        ];
        let procs = vec![
            proc(10, None, "claude", &["claude"], "/r/main/src", 1000),
            proc(
                11,
                Some(10),
                "node",
                &["node", "/x/@anthropic-ai/claude-code/cli.js"],
                "/r/main/src",
                1001,
            ),
            proc(20, None, "codex", &["codex"], "/r/main/.wt/feat", 1100),
            proc(30, None, "claude", &["claude"], "/elsewhere", 900),
            proc(40, None, "bash", &["bash"], "/r/main", 800),
        ];
        let sessions = collect_sessions(&worktrees, &procs, 1200, &|w| {
            Some(if w.is_main { 3 } else { 1 })
        });

        assert_eq!(sessions.len(), 2, "{sessions:?}");
        assert_eq!(sessions[0].pid, 10, "the wrapper, not its node child");
        assert_eq!(sessions[0].agent, "Claude Code");
        assert!(sessions[0].is_main_worktree);
        assert_eq!(sessions[0].branch.as_deref(), Some("main"));
        assert_eq!(sessions[0].elapsed_secs, 200);
        assert_eq!(sessions[0].changed_files, Some(3));
        assert_eq!(sessions[0].state, AgentState::Running);

        assert_eq!(sessions[1].agent, "Codex CLI");
        assert_eq!(
            sessions[1].worktree_path, "/r/main/.wt/feat",
            "deepest worktree wins"
        );
        assert!(!sessions[1].is_main_worktree);
        assert_eq!(sessions[1].branch.as_deref(), Some("feat"));
    }

    #[test]
    fn processes_without_a_cwd_are_skipped() {
        let worktrees = vec![wt("/r", true, "main")];
        let mut p = proc(1, None, "claude", &["claude"], "/r", 0);
        p.cwd = None;
        assert!(collect_sessions(&worktrees, &[p], 10, &|_| None).is_empty());
    }

    #[test]
    fn long_commands_are_truncated() {
        let worktrees = vec![wt("/r", true, "main")];
        let long = "x".repeat(500);
        let p = proc(1, None, "claude", &["claude", &long], "/r", 0);
        let sessions = collect_sessions(&worktrees, &[p], 10, &|_| None);
        assert_eq!(sessions[0].command.chars().count(), MAX_COMMAND_LEN);
        assert!(sessions[0].command.ends_with('…'));
    }

    #[test]
    fn state_comes_from_the_hooks_bridge_when_installed() {
        let dir = tempfile::TempDir::new().unwrap();
        let w = WorktreeInfo {
            path: dir.path().to_path_buf(),
            git_dir: dir.path().join(".git"),
            branch: None,
            is_main: true,
        };
        assert_eq!(state_for(&w), AgentState::Running);
        std::fs::create_dir_all(w.git_dir.join("gitnado")).unwrap();
        std::fs::write(w.git_dir.join("gitnado/agent-checkpoint.sh"), "#!/bin/sh").unwrap();
        assert_eq!(state_for(&w), AgentState::Waiting);
        std::fs::write(w.git_dir.join("gitnado/turn-abc"), "deadbeef").unwrap();
        assert_eq!(state_for(&w), AgentState::Working);
    }

    #[test]
    fn repo_worktrees_lists_main_and_linked_worktrees() {
        let t = TestRepo::with_initial_commit();
        let repo = t.repo();
        let wt_dir = tempfile::TempDir::new().unwrap();
        let wt_path = wt_dir.path().join("feature-wt");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let branch = repo.branch("feature", &head, false).unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(branch.get()));
        repo.worktree("feature-wt", &wt_path, Some(&opts)).unwrap();

        // Asking from the linked worktree still lists both.
        let list = repo_worktrees(&wt_path.to_string_lossy()).unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        assert!(list[0].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch.as_deref(), Some("feature"));
        assert_eq!(list[1].path, canonical(&wt_path));
    }

    #[test]
    fn session_serializes_camel_case() {
        let session = AgentSession {
            pid: 1,
            agent: "Claude Code".into(),
            command: "claude".into(),
            cwd: "/r".into(),
            worktree_path: "/r".into(),
            is_main_worktree: true,
            branch: None,
            state: AgentState::Waiting,
            started_at: 1,
            elapsed_secs: 2,
            changed_files: Some(0),
        };
        let json = serde_json::to_string(&session).unwrap();
        for key in [
            "worktreePath",
            "isMainWorktree",
            "startedAt",
            "elapsedSecs",
            "changedFiles",
            "\"waiting\"",
        ] {
            assert!(json.contains(key), "{json}");
        }
    }

    /// End to end against the real process table: a program named `claude`
    /// started inside the repository is found.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn detects_a_real_agent_process_in_the_repo() {
        let t = TestRepo::with_initial_commit();
        let bin_dir = tempfile::TempDir::new().unwrap();
        let fake = bin_dir.path().join("claude");
        std::fs::copy("/bin/sleep", &fake).unwrap();
        let mut child = std::process::Command::new(&fake)
            .arg("30")
            .current_dir(&t.path)
            .spawn()
            .unwrap();
        // Give /proc a moment to publish the new process.
        let mut found = Vec::new();
        for _ in 0..20 {
            found = list_agent_sessions(t.path_str()).await.unwrap();
            if found.iter().any(|s| s.pid == child.id()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();

        let session = found
            .iter()
            .find(|s| s.pid == child.id())
            .unwrap_or_else(|| panic!("fake claude not detected: {found:?}"));
        assert_eq!(session.agent, "Claude Code");
        assert!(session.is_main_worktree);
        assert_eq!(session.branch.as_deref(), Some("main"));
        assert_eq!(session.changed_files, Some(0));
    }
}
