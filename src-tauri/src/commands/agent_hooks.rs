//! Agent hooks bridge (roadmap 4.1, issue #608).
//!
//! Installs Claude Code hooks into a repository so every agent turn is
//! bracketed by working-tree checkpoints (see `commands::checkpoint`) and every
//! commit the agent makes is attributed to its session.
//!
//! - `UserPromptSubmit` runs the managed script with `before`, `Stop` with
//!   `after`. Both hooks are matcher-free turn boundaries; `PostToolUse` on
//!   Edit/Write would miss files changed by shell commands.
//! - The script lives in the repository's git dir, so it is never committed,
//!   and talks to git directly — checkpoints are taken even while Gitnado is
//!   closed.
//! - It can never block the agent: every path exits 0 and prints nothing
//!   (stdout from a UserPromptSubmit hook would be injected into the prompt).
//! - Hooks go into `.claude/settings.local.json` (personal, not shared). Other
//!   hooks in that file are preserved, and the file is git-ignored through
//!   `.git/info/exclude` when nothing already ignores it.

use std::path::{Path, PathBuf};

use git2::Repository;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::command;

use crate::error::{GitnadoError, Result};

/// Name of the managed script; also the marker identifying our hook entries.
const SCRIPT_NAME: &str = "agent-checkpoint.sh";
const SCRIPT_DIR: &str = "gitnado";
const SETTINGS_REL: &str = ".claude/settings.local.json";
/// Notes ref holding agent attribution. `git notes` only writes under
/// refs/notes/, so it lives in refs/notes/gitnado/, which
/// `utils::internal_refs` hides from the graph and the notes-ref picker.
pub const AGENT_NOTES_REF: &str = "refs/notes/gitnado/agents";
const HOOK_EVENTS: [(&str, &str); 2] = [("UserPromptSubmit", "before"), ("Stop", "after")];

const SCRIPT: &str = r#"#!/bin/sh
# Managed by Gitnado: takes a working-tree checkpoint around each agent turn
# and attributes the agent's commits to its session. Remove it from Gitnado
# (Checkpoints > Claude Code hooks) rather than editing it.
#
# Never blocks the agent: every path exits 0 and nothing is printed.
phase="$1"
input=$(cat 2>/dev/null)
sid=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,64\}\)".*/\1/p')
[ -n "$sid" ] || sid=unknown

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

if ! git var GIT_COMMITTER_IDENT >/dev/null 2>&1; then
  GIT_AUTHOR_NAME=Gitnado GIT_AUTHOR_EMAIL=gitnado@localhost
  GIT_COMMITTER_NAME=Gitnado GIT_COMMITTER_EMAIL=gitnado@localhost
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
fi

head=$(git rev-parse -q --verify HEAD 2>/dev/null)
branch=$(git symbolic-ref -q --short HEAD 2>/dev/null)
statedir="$gitdir/gitnado"
state="$statedir/turn-$sid"

# Snapshot the working tree through a throwaway index: the real index is
# never touched.
tmp="$gitdir/gitnado-checkpoint-index.$$"
trap 'rm -f "$tmp"' EXIT
if [ -f "$gitdir/index" ]; then cp "$gitdir/index" "$tmp" 2>/dev/null || exit 0; fi
if GIT_INDEX_FILE="$tmp" git add -A >/dev/null 2>&1; then
  tree=$(GIT_INDEX_FILE="$tmp" git write-tree 2>/dev/null)
fi

if [ -n "$tree" ]; then
  last=$(git for-each-ref --sort=-refname --count=1 --format='%(objectname)' refs/gitnado/checkpoints/ 2>/dev/null)
  last_tree=""
  [ -n "$last" ] && last_tree=$(git rev-parse -q --verify "$last^{tree}" 2>/dev/null)
  # Skip a snapshot identical to the newest one (a turn that changed nothing).
  if [ "$tree" != "$last_tree" ]; then
    if [ "$phase" = before ]; then label="Before agent turn"; else label="After agent turn"; fi
    msg=$(printf '%s\n\nAgent: Claude Code\nSession: %s\n' "$label" "$sid")
    [ -n "$head" ] && msg=$(printf '%s\nHead: %s' "$msg" "$head")
    [ -n "$branch" ] && msg=$(printf '%s\nBranch: %s' "$msg" "$branch")
    if [ -n "$head" ]; then
      commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" -p "$head" 2>/dev/null)
    else
      commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" 2>/dev/null)
    fi
    if [ -n "$commit" ]; then
      git update-ref "refs/gitnado/checkpoints/$(date +%s)000-$$" "$commit" >/dev/null 2>&1
    fi
  fi
fi

if [ "$phase" = before ]; then
  mkdir -p "$statedir" 2>/dev/null && printf '%s' "$head" > "$state" 2>/dev/null
elif [ -f "$state" ]; then
  base=$(cat "$state" 2>/dev/null)
  rm -f "$state"
  if [ -n "$head" ] && [ "$head" != "$base" ]; then
    if [ -n "$base" ]; then range="$base..$head"; else range="$head"; fi
    git rev-list --max-count=200 "$range" 2>/dev/null | while read -r c; do
      git notes --ref=refs/notes/gitnado/agents add -f -m "Agent: Claude Code" -m "Session: $sid" "$c" >/dev/null 2>&1
    done
  fi
fi
exit 0
"#;

/// Installation state of the hooks bridge for one repository.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHooksStatus {
    /// Both hooks are registered and the script exists.
    pub installed: bool,
    /// Some but not all pieces are present (e.g. the script was deleted).
    pub partial: bool,
    pub settings_path: String,
    pub script_path: String,
}

/// Which agent session wrote a commit.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttribution {
    pub agent: String,
    pub session_id: Option<String>,
}

fn open(path: &str) -> Result<Repository> {
    Ok(Repository::open(Path::new(path))?)
}

fn workdir(repo: &Repository) -> Result<PathBuf> {
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| GitnadoError::OperationFailed("Agent hooks need a working tree".to_string()))
}

fn script_path(repo: &Repository) -> PathBuf {
    repo.path().join(SCRIPT_DIR).join(SCRIPT_NAME)
}

fn settings_path(repo: &Repository) -> Result<PathBuf> {
    Ok(workdir(repo)?.join(SETTINGS_REL))
}

/// POSIX single-quote a path for the hook command line. Backslashes become
/// forward slashes: Claude Code runs hooks through a POSIX shell everywhere,
/// including Git Bash on Windows.
fn shell_quote(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn hook_command(script: &Path, phase: &str) -> String {
    format!("sh {} {phase}", shell_quote(script))
}

fn is_ours(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(&format!("{SCRIPT_DIR}/{SCRIPT_NAME}")))
}

fn read_settings(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(GitnadoError::OperationFailed(format!(
                "{} is not a valid JSON object — fix or remove it, then try again",
                path.display()
            ))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.into()),
    }
}

fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(settings.clone()))?;
    std::fs::write(path, format!("{text}\n"))?;
    Ok(())
}

/// Whether `event` has one of our handlers registered.
fn event_has_ours(settings: &Map<String, Value>, event: &str) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get(event))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|hs| hs.iter().any(is_ours))
            })
        })
}

fn status_in(repo: &Repository) -> Result<AgentHooksStatus> {
    let settings_file = settings_path(repo)?;
    let script = script_path(repo);
    let settings = read_settings(&settings_file).unwrap_or_default();
    let registered = HOOK_EVENTS
        .iter()
        .filter(|(event, _)| event_has_ours(&settings, event))
        .count();
    let script_exists = script.is_file();
    let installed = registered == HOOK_EVENTS.len() && script_exists;
    let partial = !installed && (registered > 0 || script_exists);
    Ok(AgentHooksStatus {
        installed,
        partial,
        settings_path: settings_file.to_string_lossy().into_owned(),
        script_path: script.to_string_lossy().into_owned(),
    })
}

/// Keep `.claude/settings.local.json` out of commits when nothing already
/// ignores it (Claude Code only does this itself for files it created).
fn ensure_settings_ignored(repo: &Repository) -> Result<()> {
    if repo
        .is_path_ignored(Path::new(SETTINGS_REL))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let exclude = repo.commondir().join("info").join("exclude");
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("# Added by Gitnado: personal Claude Code settings (agent hooks)\n");
    text.push_str("/.claude/settings.local.json\n");
    std::fs::write(&exclude, text)?;
    Ok(())
}

pub fn install_in(repo: &Repository) -> Result<AgentHooksStatus> {
    let settings_file = settings_path(repo)?;
    // Parse before writing anything: never clobber a file we cannot read.
    let mut settings = read_settings(&settings_file)?;

    let script = script_path(repo);
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&script, SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    }

    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(hooks) = hooks else {
        return Err(GitnadoError::OperationFailed(format!(
            "\"hooks\" in {} is not an object",
            settings_file.display()
        )));
    };
    for (event, phase) in HOOK_EVENTS {
        let groups = hooks
            .entry(event)
            .or_insert_with(|| Value::Array(Vec::new()));
        let Value::Array(groups) = groups else {
            return Err(GitnadoError::OperationFailed(format!(
                "\"hooks.{event}\" in {} is not a list",
                settings_file.display()
            )));
        };
        // Drop a stale entry (e.g. the repo moved) before adding the current one.
        for group in groups.iter_mut() {
            if let Some(Value::Array(handlers)) = group.get_mut("hooks") {
                handlers.retain(|h| !is_ours(h));
            }
        }
        groups.retain(|g| {
            g.get("hooks")
                .and_then(Value::as_array)
                .map_or(true, |hs| !hs.is_empty())
        });
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": hook_command(&script, phase),
                "timeout": 30
            }]
        }));
    }

    write_settings(&settings_file, &settings)?;
    ensure_settings_ignored(repo)?;
    status_in(repo)
}

pub fn uninstall_in(repo: &Repository) -> Result<AgentHooksStatus> {
    let settings_file = settings_path(repo)?;
    if settings_file.exists() {
        let mut settings = read_settings(&settings_file)?;
        let mut changed = false;
        if let Some(Value::Object(hooks)) = settings.get_mut("hooks") {
            for (event, _) in HOOK_EVENTS {
                if let Some(Value::Array(groups)) = hooks.get_mut(event) {
                    for group in groups.iter_mut() {
                        if let Some(Value::Array(handlers)) = group.get_mut("hooks") {
                            let before = handlers.len();
                            handlers.retain(|h| !is_ours(h));
                            changed |= handlers.len() != before;
                        }
                    }
                    groups.retain(|g| {
                        g.get("hooks")
                            .and_then(Value::as_array)
                            .map_or(true, |hs| !hs.is_empty())
                    });
                    if groups.is_empty() {
                        hooks.remove(event);
                    }
                }
            }
            if hooks.is_empty() {
                settings.remove("hooks");
            }
        }
        if changed {
            write_settings(&settings_file, &settings)?;
        }
    }
    let script = script_path(repo);
    if script.exists() {
        std::fs::remove_file(&script)?;
    }
    status_in(repo)
}

pub fn attribution_in(repo: &Repository, oid: &str) -> Result<Option<AgentAttribution>> {
    let oid = git2::Oid::from_str(oid)?;
    let note = match repo.find_note(Some(AGENT_NOTES_REF), oid) {
        Ok(note) => note,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let message = note.message().unwrap_or("");
    let field = |key: &str| {
        message.lines().find_map(|l| {
            l.strip_prefix(key)
                .and_then(|r| r.strip_prefix(": "))
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
    };
    Ok(Some(AgentAttribution {
        agent: field("Agent").unwrap_or_else(|| "Agent".to_string()),
        session_id: field("Session").filter(|s| s != "unknown"),
    }))
}

#[command]
pub async fn get_agent_hooks_status(path: String) -> Result<AgentHooksStatus> {
    crate::utils::blocking_git(move || status_in(&open(&path)?)).await
}

#[command]
pub async fn install_agent_hooks(path: String) -> Result<AgentHooksStatus> {
    crate::utils::blocking_git(move || install_in(&open(&path)?)).await
}

#[command]
pub async fn uninstall_agent_hooks(path: String) -> Result<AgentHooksStatus> {
    crate::utils::blocking_git(move || uninstall_in(&open(&path)?)).await
}

#[command]
pub async fn get_agent_attribution(path: String, oid: String) -> Result<Option<AgentAttribution>> {
    crate::utils::blocking_git(move || attribution_in(&open(&path)?, &oid)).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::commands::checkpoint::list_checkpoints_in;
    use crate::test_utils::TestRepo;
    use std::fs;
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    fn settings(t: &TestRepo) -> Value {
        serde_json::from_str(&fs::read_to_string(t.path.join(SETTINGS_REL)).unwrap()).unwrap()
    }

    /// Run the installed hook the way Claude Code does.
    fn run_hook(t: &TestRepo, phase: &str, session: &str) -> std::process::Output {
        let script = script_path(&t.repo());
        let mut child = Command::new("sh")
            .arg(&script)
            .arg(phase)
            .env("CLAUDE_PROJECT_DIR", &t.path)
            // Isolate from the machine's git config, like utils::command does.
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", t.path.join(".no-home"))
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run hook");
        let payload = format!(
            r#"{{"session_id":"{session}","cwd":"{}","hook_event_name":"x","prompt":"do \"things\""}}"#,
            t.path.display()
        );
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    fn install_registers_both_hooks_and_is_idempotent() {
        let t = TestRepo::with_initial_commit();
        let repo = t.repo();
        let status = install_in(&repo).unwrap();
        assert!(status.installed);
        assert!(!status.partial);
        install_in(&repo).unwrap();

        let s = settings(&t);
        for (event, phase) in HOOK_EVENTS {
            let groups = s["hooks"][event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event} must not be duplicated");
            let cmd = groups[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(
                cmd.starts_with("sh '") && cmd.ends_with(&format!(" {phase}")),
                "{cmd}"
            );
        }
        let script = script_path(&repo);
        assert!(
            script.starts_with(repo.path()),
            "script must live in the git dir"
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }

    #[test]
    fn install_preserves_existing_settings_and_hooks() {
        let t = TestRepo::with_initial_commit();
        fs::create_dir_all(t.path.join(".claude")).unwrap();
        fs::write(
            t.path.join(SETTINGS_REL),
            r#"{"permissions":{"allow":["Bash(npm test)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify-send done"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"guard.sh"}]}]}}"#,
        )
        .unwrap();

        install_in(&t.repo()).unwrap();
        let s = settings(&t);
        assert_eq!(s["permissions"]["allow"][0], "Bash(npm test)");
        assert_eq!(
            s["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "guard.sh"
        );
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "notify-send done");

        let status = uninstall_in(&t.repo()).unwrap();
        assert!(!status.installed && !status.partial);
        let s = settings(&t);
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            s["hooks"]["Stop"][0]["hooks"][0]["command"],
            "notify-send done"
        );
        assert!(s["hooks"].get("UserPromptSubmit").is_none());
        assert_eq!(s["permissions"]["allow"][0], "Bash(npm test)");
        assert!(!script_path(&t.repo()).exists());
    }

    #[test]
    fn uninstall_leaves_an_empty_object_not_a_deleted_file() {
        let t = TestRepo::with_initial_commit();
        install_in(&t.repo()).unwrap();
        uninstall_in(&t.repo()).unwrap();
        assert_eq!(settings(&t), json!({}));
    }

    #[test]
    fn install_refuses_to_overwrite_invalid_settings() {
        let t = TestRepo::with_initial_commit();
        fs::create_dir_all(t.path.join(".claude")).unwrap();
        fs::write(t.path.join(SETTINGS_REL), "{ not json").unwrap();
        let err = install_in(&t.repo()).unwrap_err().to_string();
        assert!(err.contains("not a valid JSON object"), "{err}");
        assert_eq!(
            fs::read_to_string(t.path.join(SETTINGS_REL)).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn install_git_ignores_the_settings_file_once() {
        let t = TestRepo::with_initial_commit();
        install_in(&t.repo()).unwrap();
        install_in(&t.repo()).unwrap();
        let repo = t.repo();
        assert!(repo.is_path_ignored(Path::new(SETTINGS_REL)).unwrap());
        let exclude = fs::read_to_string(repo.path().join("info/exclude")).unwrap();
        assert_eq!(exclude.matches("/.claude/settings.local.json").count(), 1);
        // Nothing new shows up as untracked.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts)).unwrap();
        let paths: Vec<String> = statuses
            .iter()
            .map(|s| s.path().unwrap_or("").to_string())
            .collect();
        assert!(paths.iter().all(|p| !p.starts_with(".claude")), "{paths:?}");
    }

    #[test]
    fn status_reports_partial_installs() {
        let t = TestRepo::with_initial_commit();
        assert!(!status_in(&t.repo()).unwrap().partial);
        install_in(&t.repo()).unwrap();
        fs::remove_file(script_path(&t.repo())).unwrap();
        let status = status_in(&t.repo()).unwrap();
        assert!(!status.installed);
        assert!(status.partial);
    }

    #[test]
    fn hook_checkpoints_each_turn_and_attributes_agent_commits() {
        let t = TestRepo::with_initial_commit();
        install_in(&t.repo()).unwrap();
        let human_head = t.head_oid();

        // Turn 1: agent edits and commits one file, leaves another uncommitted.
        let out = run_hook(&t, "before", "sess-abc");
        assert!(out.status.success());
        assert!(
            out.stdout.is_empty(),
            "a UserPromptSubmit hook must print nothing"
        );
        fs::write(t.path.join("README.md"), "agent was here").unwrap();
        let agent_commit = t.create_commit("agent: tweak", &[("agent.txt", "a")]);
        fs::write(t.path.join("wip.txt"), "uncommitted").unwrap();
        let out = run_hook(&t, "after", "sess-abc");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty());

        let repo = t.repo();
        let checkpoints = list_checkpoints_in(&repo).unwrap();
        assert_eq!(checkpoints.len(), 2, "{checkpoints:?}");
        let after = &checkpoints[0];
        assert_eq!(after.label, "After agent turn");
        assert_eq!(after.session_id.as_deref(), Some("sess-abc"));
        assert_eq!(after.branch.as_deref(), Some("main"));
        assert_eq!(after.head_oid, Some(agent_commit.to_string()));
        assert_eq!(checkpoints[1].label, "Before agent turn");
        assert_eq!(checkpoints[1].head_oid, Some(human_head.to_string()));

        // The agent's commit is attributed; the human's is not.
        let attr = attribution_in(&repo, &agent_commit.to_string())
            .unwrap()
            .unwrap();
        assert_eq!(attr.agent, "Claude Code");
        assert_eq!(attr.session_id.as_deref(), Some("sess-abc"));
        assert_eq!(
            attribution_in(&repo, &human_head.to_string()).unwrap(),
            None
        );

        // The real index was never touched: wip.txt is still untracked.
        let st = repo.status_file(Path::new("wip.txt")).unwrap();
        assert!(st.contains(git2::Status::WT_NEW));

        // A turn that changes nothing adds no checkpoints.
        run_hook(&t, "before", "sess-abc");
        run_hook(&t, "after", "sess-abc");
        assert_eq!(list_checkpoints_in(&repo).unwrap().len(), 2);
    }

    #[test]
    fn hook_never_fails_outside_a_repository() {
        let t = TestRepo::with_initial_commit();
        install_in(&t.repo()).unwrap();
        let script = script_path(&t.repo());
        let dir = tempfile::TempDir::new().unwrap();
        let out = Command::new("sh")
            .arg(&script)
            .arg("before")
            .env("CLAUDE_PROJECT_DIR", dir.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
    }

    #[test]
    fn shell_quote_handles_spaces_quotes_and_backslashes() {
        assert_eq!(shell_quote(Path::new("/a b/c")), "'/a b/c'");
        assert_eq!(shell_quote(Path::new("/it's")), r"'/it'\''s'");
        assert_eq!(shell_quote(Path::new(r"C:\repo\x")), "'C:/repo/x'");
    }

    #[test]
    fn attribution_serializes_camel_case() {
        let json = serde_json::to_string(&AgentAttribution {
            agent: "Claude Code".into(),
            session_id: Some("s".into()),
        })
        .unwrap();
        assert!(json.contains("sessionId"));
        let json = serde_json::to_string(&AgentHooksStatus {
            installed: true,
            partial: false,
            settings_path: "a".into(),
            script_path: "b".into(),
        })
        .unwrap();
        assert!(json.contains("settingsPath") && json.contains("scriptPath"));
    }
}
