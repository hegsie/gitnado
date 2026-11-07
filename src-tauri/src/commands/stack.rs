//! Stacked branches (roadmap 4.3, issue #614).
//!
//! A branch can be declared as stacked on another ("parent") branch. The
//! relationship is stored in the repository's own config —
//! `branch.<name>.gitnado-parent = <parent>` — so it needs no extra files,
//! moves with `git branch -m` like the rest of a branch's config section, and
//! is removed with the branch.
//!
//! `get_stacks` returns every stack as a tree flattened bottom-to-top, with
//! each branch's position relative to its parent: commits it adds, and
//! whether the parent has moved on since (it then needs a restack).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use git2::{BranchType, Repository};
use serde::Serialize;
use tauri::command;

use crate::error::{GitnadoError, Result};

const PARENT_KEY: &str = "gitnado-parent";

fn parent_key(branch: &str) -> String {
    format!("branch.{branch}.{PARENT_KEY}")
}

/// One branch in a stack.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StackBranch {
    pub name: String,
    /// The branch this one is stacked on.
    pub parent: String,
    /// 1 for a branch directly on the stack's base, 2 above that, …
    pub depth: usize,
    /// Commits on this branch that its parent does not have.
    pub ahead: usize,
    /// Commits on the parent that this branch does not have yet: when > 0
    /// the branch needs a restack.
    pub behind: usize,
    pub is_head: bool,
    /// The parent branch no longer exists (deleted or renamed).
    pub parent_missing: bool,
}

/// A stack: a base branch and the branches stacked on it, bottom to top.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    /// The branch the bottom of the stack is based on (e.g. `main`).
    pub base: String,
    pub branches: Vec<StackBranch>,
}

fn local_branch_exists(repo: &Repository, name: &str) -> bool {
    repo.find_branch(name, BranchType::Local).is_ok()
}

/// Every declared parent, keyed by child branch.
fn read_parents(repo: &Repository) -> Result<BTreeMap<String, String>> {
    let config = repo.config()?;
    let mut parents = BTreeMap::new();
    let mut entries = config.entries(Some(r"^branch\..*\.gitnado-parent$"))?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        let (Ok(name), Ok(value)) = (entry.name(), entry.value()) else {
            continue;
        };
        let branch = name
            .strip_prefix("branch.")
            .and_then(|n| n.strip_suffix(&format!(".{PARENT_KEY}")))
            .unwrap_or("");
        if !branch.is_empty() && !value.is_empty() {
            parents.insert(branch.to_string(), value.to_string());
        }
    }
    // A stale entry for a branch that no longer exists is not part of any stack.
    parents.retain(|branch, _| local_branch_exists(repo, branch));
    Ok(parents)
}

pub fn set_parent_in(repo: &Repository, branch: &str, parent: &str) -> Result<()> {
    if branch == parent {
        return Err(GitnadoError::OperationFailed(
            "A branch cannot be stacked on itself".to_string(),
        ));
    }
    for name in [branch, parent] {
        if !local_branch_exists(repo, name) {
            return Err(GitnadoError::BranchNotFound(name.to_string()));
        }
    }
    // Refuse a cycle: walking up from the new parent must never reach `branch`.
    let parents = read_parents(repo)?;
    let mut seen = HashSet::new();
    let mut cursor = Some(parent.to_string());
    while let Some(current) = cursor {
        if current == branch {
            return Err(GitnadoError::OperationFailed(format!(
                "{parent} is already stacked on {branch}; stacking {branch} on it would make a loop"
            )));
        }
        if !seen.insert(current.clone()) {
            break;
        }
        cursor = parents.get(&current).cloned();
    }
    repo.config()?.set_str(&parent_key(branch), parent)?;
    Ok(())
}

pub fn clear_parent_in(repo: &Repository, branch: &str) -> Result<()> {
    let mut config = repo.config()?;
    match config.remove(&parent_key(branch)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn ahead_behind(repo: &Repository, branch: &str, parent: &str) -> (usize, usize) {
    let tip = |name: &str| {
        repo.find_branch(name, BranchType::Local)
            .ok()
            .and_then(|b| b.get().target())
    };
    match (tip(branch), tip(parent)) {
        (Some(b), Some(p)) => repo.graph_ahead_behind(b, p).unwrap_or((0, 0)),
        _ => (0, 0),
    }
}

pub fn stacks_in(repo: &Repository) -> Result<Vec<Stack>> {
    let parents = read_parents(repo)?;
    if parents.is_empty() {
        return Ok(Vec::new());
    }
    let head = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));

    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for (child, parent) in &parents {
        children
            .entry(parent.as_str())
            .or_default()
            .push(child.as_str());
    }
    for list in children.values_mut() {
        list.sort();
    }

    // A stack's base is a parent that is not itself stacked (or whose own
    // parent chain loops, which set_parent prevents but config edits might not).
    let mut bases: Vec<&str> = parents
        .values()
        .map(String::as_str)
        .filter(|p| !parents.contains_key(*p))
        .collect();
    bases.sort();
    bases.dedup();

    let mut stacks = Vec::new();
    let mut placed = HashSet::new();
    for base in bases {
        let mut branches = Vec::new();
        let mut stack: Vec<(&str, usize)> = children
            .get(base)
            .map(|c| c.iter().rev().map(|n| (*n, 1)).collect())
            .unwrap_or_default();
        while let Some((name, depth)) = stack.pop() {
            if !placed.insert(name.to_string()) {
                continue;
            }
            let parent = parents[name].clone();
            let (ahead, behind) = ahead_behind(repo, name, &parent);
            branches.push(StackBranch {
                name: name.to_string(),
                parent_missing: !local_branch_exists(repo, &parent),
                parent,
                depth,
                ahead,
                behind,
                is_head: head.as_deref() == Some(name),
            });
            if let Some(kids) = children.get(name) {
                for kid in kids.iter().rev() {
                    stack.push((kid, depth + 1));
                }
            }
        }
        stacks.push(Stack {
            base: base.to_string(),
            branches,
        });
    }
    Ok(stacks)
}

fn open(path: &str) -> Result<Repository> {
    Ok(Repository::open(Path::new(path))?)
}

/// Declare `branch` as stacked on `parent`.
#[command]
pub async fn set_branch_parent(path: String, branch: String, parent: String) -> Result<()> {
    crate::utils::blocking_git(move || set_parent_in(&open(&path)?, &branch, &parent)).await
}

/// Take `branch` out of its stack. Branches stacked on it stay stacked on it.
#[command]
pub async fn clear_branch_parent(path: String, branch: String) -> Result<()> {
    crate::utils::blocking_git(move || clear_parent_in(&open(&path)?, &branch)).await
}

/// Every stack in the repository, bottom to top.
#[command]
pub async fn get_stacks(path: String) -> Result<Vec<Stack>> {
    crate::utils::blocking_git(move || stacks_in(&open(&path)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// main -> a -> b, plus main -> c
    fn stacked_repo() -> TestRepo {
        let t = TestRepo::with_initial_commit();
        t.create_branch("a");
        t.checkout_branch("a");
        t.create_commit("a1", &[("a.txt", "a")]);
        t.create_branch("b");
        t.checkout_branch("b");
        t.create_commit("b1", &[("b.txt", "b")]);
        t.create_commit("b2", &[("b.txt", "bb")]);
        t.checkout_branch("main");
        t.create_branch("c");
        let repo = t.repo();
        set_parent_in(&repo, "a", "main").unwrap();
        set_parent_in(&repo, "b", "a").unwrap();
        set_parent_in(&repo, "c", "main").unwrap();
        t
    }

    #[tokio::test]
    async fn stacks_are_listed_bottom_to_top_with_depth() {
        let t = stacked_repo();
        let stacks = get_stacks(t.path_str()).await.unwrap();
        assert_eq!(stacks.len(), 1);
        assert_eq!(stacks[0].base, "main");
        let names: Vec<(&str, usize)> = stacks[0]
            .branches
            .iter()
            .map(|b| (b.name.as_str(), b.depth))
            .collect();
        assert_eq!(names, vec![("a", 1), ("b", 2), ("c", 1)]);
        let b = &stacks[0].branches[1];
        assert_eq!(b.parent, "a");
        assert_eq!(b.ahead, 2);
        assert_eq!(b.behind, 0);
        assert!(!b.parent_missing);
    }

    #[tokio::test]
    async fn a_moved_parent_marks_the_child_as_needing_restack() {
        let t = stacked_repo();
        t.checkout_branch("a");
        t.create_commit("a2 after b branched", &[("a2.txt", "x")]);
        let stacks = get_stacks(t.path_str()).await.unwrap();
        let b = stacks[0].branches.iter().find(|b| b.name == "b").unwrap();
        assert_eq!(b.behind, 1, "b is behind its moved parent");
        let a = stacks[0].branches.iter().find(|b| b.name == "a").unwrap();
        assert!(a.is_head);
    }

    #[tokio::test]
    async fn cycles_self_and_unknown_branches_are_refused() {
        let t = stacked_repo();
        let err = set_branch_parent(t.path_str(), "a".into(), "b".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("loop"), "{err}");
        assert!(set_branch_parent(t.path_str(), "a".into(), "a".into())
            .await
            .is_err());
        assert!(set_branch_parent(t.path_str(), "a".into(), "nope".into())
            .await
            .is_err());
        assert!(
            set_branch_parent(t.path_str(), "nope".into(), "main".into())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn clearing_a_parent_removes_only_that_link() {
        let t = stacked_repo();
        clear_branch_parent(t.path_str(), "a".into()).await.unwrap();
        clear_branch_parent(t.path_str(), "a".into()).await.unwrap();
        let stacks = get_stacks(t.path_str()).await.unwrap();
        // b is still stacked on a, which is now itself the base of a stack.
        let bases: Vec<&str> = stacks.iter().map(|s| s.base.as_str()).collect();
        assert_eq!(bases, vec!["a", "main"]);
        assert_eq!(stacks[0].branches[0].name, "b");
        assert_eq!(
            stacks[1]
                .branches
                .iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>(),
            vec!["c"]
        );
    }

    #[tokio::test]
    async fn deleted_branches_drop_out_and_orphans_are_flagged() {
        let t = stacked_repo();
        // Deleting a removes its own config entry; b is left pointing at it.
        t.repo()
            .find_branch("a", BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
        let stacks = get_stacks(t.path_str()).await.unwrap();
        let b = stacks
            .iter()
            .flat_map(|s| &s.branches)
            .find(|b| b.name == "b")
            .unwrap();
        assert!(b.parent_missing);
        assert_eq!(b.parent, "a");
    }

    #[tokio::test]
    async fn no_stacks_without_declared_parents() {
        let t = TestRepo::with_initial_commit();
        assert!(get_stacks(t.path_str()).await.unwrap().is_empty());
    }

    #[test]
    fn stack_serializes_camel_case() {
        let s = Stack {
            base: "main".into(),
            branches: vec![StackBranch {
                name: "a".into(),
                parent: "main".into(),
                depth: 1,
                ahead: 1,
                behind: 0,
                is_head: false,
                parent_missing: false,
            }],
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("isHead") && json.contains("parentMissing"));
    }
}
