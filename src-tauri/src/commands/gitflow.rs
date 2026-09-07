//! Git Flow command handlers
//! Implements the git-flow branching model

use std::path::Path;

use sha2::{Digest, Sha256};
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::Branch;

/// Git Flow configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFlowConfig {
    pub initialized: bool,
    pub master_branch: String,
    pub develop_branch: String,
    pub feature_prefix: String,
    pub release_prefix: String,
    pub hotfix_prefix: String,
    pub support_prefix: String,
    pub version_tag_prefix: String,
}

impl Default for GitFlowConfig {
    fn default() -> Self {
        Self {
            initialized: false,
            master_branch: "main".to_string(),
            develop_branch: "develop".to_string(),
            feature_prefix: "feature/".to_string(),
            release_prefix: "release/".to_string(),
            hotfix_prefix: "hotfix/".to_string(),
            support_prefix: "support/".to_string(),
            version_tag_prefix: "v".to_string(),
        }
    }
}

/// Get the current git flow configuration
#[command]
pub async fn get_gitflow_config(path: String) -> Result<GitFlowConfig> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let config = repo.config()?;

    let initialized = config.get_string("gitflow.branch.master").is_ok();

    if !initialized {
        return Ok(GitFlowConfig::default());
    }

    Ok(GitFlowConfig {
        initialized: true,
        master_branch: config
            .get_string("gitflow.branch.master")
            .unwrap_or_else(|_| "main".to_string()),
        develop_branch: config
            .get_string("gitflow.branch.develop")
            .unwrap_or_else(|_| "develop".to_string()),
        feature_prefix: config
            .get_string("gitflow.prefix.feature")
            .unwrap_or_else(|_| "feature/".to_string()),
        release_prefix: config
            .get_string("gitflow.prefix.release")
            .unwrap_or_else(|_| "release/".to_string()),
        hotfix_prefix: config
            .get_string("gitflow.prefix.hotfix")
            .unwrap_or_else(|_| "hotfix/".to_string()),
        support_prefix: config
            .get_string("gitflow.prefix.support")
            .unwrap_or_else(|_| "support/".to_string()),
        version_tag_prefix: config
            .get_string("gitflow.prefix.versiontag")
            .unwrap_or_else(|_| "v".to_string()),
    })
}

/// Initialize git flow in the repository
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn init_gitflow(
    path: String,
    master_branch: Option<String>,
    develop_branch: Option<String>,
    feature_prefix: Option<String>,
    release_prefix: Option<String>,
    hotfix_prefix: Option<String>,
    support_prefix: Option<String>,
    version_tag_prefix: Option<String>,
) -> Result<GitFlowConfig> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // The local level specifically. set_str already landed here, but the
    // rollback below also has to READ what .git/config holds: repo.config()
    // resolves through the user's global and system files too, so a snapshot
    // taken from it would "restore" an inherited value by writing it into the
    // repository, inventing a local key that was never there.
    let mut config = repo.config()?.open_level(git2::ConfigLevel::Local)?;

    let develop = develop_branch.unwrap_or_else(|| "develop".to_string());
    let feature = feature_prefix.unwrap_or_else(|| "feature/".to_string());
    let release = release_prefix.unwrap_or_else(|| "release/".to_string());
    let hotfix = hotfix_prefix.unwrap_or_else(|| "hotfix/".to_string());
    let support = support_prefix.unwrap_or_else(|| "support/".to_string());
    let version_tag = version_tag_prefix.unwrap_or_else(|| "v".to_string());

    // gitflow.branch.master must name a branch that EXISTS. Every hotfix start
    // and every release/hotfix finish resolves it and fails with
    // BranchNotFound when it does not, and get_gitflow_config keys
    // `initialized` off this very entry — so once a wrong name is written the
    // panel never offers the init section again and there is no way back
    // inside the app. Writing the "main" default on a repository whose default
    // branch is "master" did exactly that: develop was cut from master through
    // the fallback below, but the name the fallback resolved was thrown away.
    let master = match master_branch {
        // An explicitly requested branch is honoured or refused — never
        // silently swapped for a different one.
        Some(requested) => {
            if repo
                .find_branch(&requested, git2::BranchType::Local)
                .is_err()
            {
                return Err(GitnadoError::BranchNotFound(requested));
            }
            requested
        }
        None => ["main", "master"]
            .into_iter()
            .find(|name| repo.find_branch(name, git2::BranchType::Local).is_ok())
            .map(str::to_string)
            .ok_or_else(|| {
                GitnadoError::OperationFailed(
                    "Cannot find a main or master branch to base Git Flow on".to_string(),
                )
            })?,
    };

    // Ensure develop branch exists. Whether THIS call created it matters: if
    // the config below cannot be persisted the branch has to go back, or a
    // retry would silently reuse a develop cut from a base the user may no
    // longer have selected. A develop that was already there is left alone.
    let mut created_develop = false;
    if repo.find_branch(&develop, git2::BranchType::Local).is_err() {
        // Create develop from the resolved master
        let base = repo
            .find_branch(&master, git2::BranchType::Local)
            .map_err(|_| GitnadoError::BranchNotFound(master.clone()))?;
        let commit = base.get().peel_to_commit()?;
        repo.branch(&develop, &commit, false)?;
        created_develop = true;
    }

    // Written last, once every branch this config names is known to exist. A
    // half-written gitflow config still reads as initialized, so an init that
    // errored after this point used to leave the repository permanently stuck
    // with a config pointing at branches that were never created.
    //
    // Each set_str is its own write to .git/config, so the sequence is not
    // atomic: any of them can fail on its own (a lock held by another process,
    // a disk that just filled, a key a hand-edit left as a multivar). Persist
    // them as a unit instead — snapshot what the local config holds now, and
    // on the first failure put every key back the way this call found it and
    // drop a develop this call created, so a failed init leaves the repository
    // as it was rather than half-configured.
    //
    // gitflow.branch.master is the key get_gitflow_config keys `initialized`
    // off, so it goes LAST — writing the marker before the six values it
    // vouches for would let a failure part-way through leave the repository
    // flagged initialized while develop and the prefixes silently fall back to
    // defaults at read time, and the panel would never offer the init section
    // again.
    let entries = [
        ("gitflow.branch.develop", develop.as_str()),
        ("gitflow.prefix.feature", feature.as_str()),
        ("gitflow.prefix.release", release.as_str()),
        ("gitflow.prefix.hotfix", hotfix.as_str()),
        ("gitflow.prefix.support", support.as_str()),
        ("gitflow.prefix.versiontag", version_tag.as_str()),
        ("gitflow.branch.master", master.as_str()),
    ];
    let snapshot: Vec<(&str, Option<String>)> = entries
        .iter()
        .map(|(key, _)| (*key, config.get_string(key).ok()))
        .collect();

    if let Err(err) = entries
        .iter()
        .try_for_each(|(key, value)| config.set_str(key, value))
    {
        // Best effort, and deliberately so: the write error is what the user
        // needs to see, and a rollback step that also fails must not mask it.
        for (key, previous) in snapshot {
            let _ = match previous {
                Some(value) => config.set_str(key, &value),
                None => config.remove(key),
            };
        }
        if created_develop {
            if let Ok(mut branch) = repo.find_branch(&develop, git2::BranchType::Local) {
                let _ = branch.delete();
            }
        }
        return Err(err.into());
    }

    Ok(GitFlowConfig {
        initialized: true,
        master_branch: master,
        develop_branch: develop,
        feature_prefix: feature,
        release_prefix: release,
        hotfix_prefix: hotfix,
        support_prefix: support,
        version_tag_prefix: version_tag,
    })
}

/// Start a git flow feature branch
#[command]
pub async fn gitflow_start_feature(path: String, name: String) -> Result<Branch> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // Every gitflow start/finish switches branches (checkout_tree + set_head)
    // without being called checkout, so the hand-placed ensure_checkoutable
    // calls in branch.rs missed all six. Switching out of a paused rebase or
    // an unresolved merge orphans the state on disk: the still-visible Abort
    // then yanks the user back to the original branch, discarding whatever
    // they did on the new one.
    crate::commands::branch::ensure_checkoutable(&repo)?;
    let config = repo.config()?;

    let develop = config
        .get_string("gitflow.branch.develop")
        .unwrap_or_else(|_| "develop".to_string());
    let prefix = config
        .get_string("gitflow.prefix.feature")
        .unwrap_or_else(|_| "feature/".to_string());

    let branch_name = format!("{}{}", prefix, name);

    // Create branch from develop
    let develop_branch = repo
        .find_branch(&develop, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(develop.clone()))?;

    let commit = develop_branch.get().peel_to_commit()?;
    let branch = repo.branch(&branch_name, &commit, false)?;
    let reference = branch.get();

    // Checkout the new branch. The checkout is fallible — a dirty file whose
    // content differs between the two branches conflicts — and the ref already
    // exists by now, so a failure is rolled back: otherwise the panel shows an
    // error while the refs watcher makes the branch appear in the sidebar, and
    // a retry dead-ends on "already exists". create_branch does the same.
    //
    // No ensure_not_checked_out_elsewhere here (unlike the finishes, which
    // hoist one per branch they switch to): `repo.branch(.., false)` above
    // already failed if the name existed, so a BRAND NEW branch cannot be held
    // by another worktree. Calling it would in fact be wrong — the guard falls
    // back to the segment after the first '/' when the full name has no local
    // branch, so a fresh `feature/x` would be tested as `x` and a worktree
    // holding an unrelated `x` would block the start.
    //
    // libgit2 runs no hooks; canonical `git flow` shells out to git checkout,
    // so post-checkout fires there. branch.rs fires it for every checkout.
    let old_head = crate::commands::hooks::head_oid_string(&repo);
    let switch = (|| -> Result<()> {
        let obj = reference.peel(git2::ObjectType::Commit)?;
        repo.checkout_tree(&obj, None)?;
        repo.set_head(reference.name().map_err(|_| {
            GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
        })?)?;
        Ok(())
    })();
    if let Err(e) = switch {
        if let Ok(mut created) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = created.delete();
        }
        return Err(e);
    }
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    Ok(Branch {
        name: branch_name.clone(),
        shorthand: branch_name,
        is_head: true,
        is_remote: false,
        upstream: None,
        target_oid: commit.id().to_string(),
        ahead_behind: None,
        last_commit_timestamp: Some(commit.time().seconds()),
        is_stale: false,
    })
}

/// Outcome of a git-flow finish.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFlowFinishResult {
    /// True when the source branch was deleted as part of the finish.
    pub branch_deleted: bool,
    /// Set when deletion was requested but skipped, explaining why.
    pub branch_kept_reason: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct GitFlowSquashMarker {
    feature_oid: String,
    squash_oid: String,
}

fn squash_marker_path(repo: &git2::Repository, branch_name: &str) -> std::path::PathBuf {
    let branch_hash = Sha256::digest(branch_name.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    crate::utils::app_paths::repo_dir(repo.commondir())
        .join("gitflow-squash")
        .join(format!("{}.json", branch_hash))
}

fn completed_squash_is_reachable(
    repo: &git2::Repository,
    branch_name: &str,
    feature_oid: git2::Oid,
    develop_oid: git2::Oid,
) -> Result<bool> {
    let Ok(contents) = std::fs::read_to_string(squash_marker_path(repo, branch_name)) else {
        return Ok(false);
    };
    let Ok(marker) = serde_json::from_str::<GitFlowSquashMarker>(&contents) else {
        return Ok(false);
    };
    let (Ok(recorded_feature), Ok(squash_commit)) = (
        git2::Oid::from_str(&marker.feature_oid),
        git2::Oid::from_str(&marker.squash_oid),
    ) else {
        return Ok(false);
    };

    if recorded_feature != feature_oid
        || (develop_oid != squash_commit
            && !repo
                .graph_descendant_of(develop_oid, squash_commit)
                .unwrap_or(false))
    {
        return Ok(false);
    }

    let develop = repo.find_commit(develop_oid)?;
    let feature = repo.find_commit(feature_oid)?;
    let mut merge_index = repo.merge_commits(&develop, &feature, None)?;
    if merge_index.has_conflicts() {
        return Ok(true);
    }

    Ok(merge_index.write_tree_to(repo)? == develop.tree_id())
}

fn record_completed_squash(
    repo: &git2::Repository,
    branch_name: &str,
    feature_oid: git2::Oid,
    squash_oid: git2::Oid,
) -> Result<()> {
    let marker_path = squash_marker_path(repo, branch_name);
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        marker_path,
        serde_json::to_vec(&GitFlowSquashMarker {
            feature_oid: feature_oid.to_string(),
            squash_oid: squash_oid.to_string(),
        })?,
    )?;
    Ok(())
}

/// Delete the finished branch unless a protection rule forbids it.
///
/// Branch rules are enforced here as well as in `delete_branch` because these
/// finishes delete the branch themselves rather than going through that
/// command — without this, a `preventDeletion` rule the UI displays as active
/// is inert on every git-flow finish.
///
/// NO failure here may fail the whole finish. The merge and (for release and
/// hotfix) the tag have already been committed by the time this runs, so
/// deletion is the optional last step — returning `Err` would report a finish
/// that actually succeeded as failed, leave the item listed as active, and
/// invite a retry. Every path therefore degrades to `branch_kept_reason`;
/// squash finishes retain an internal marker so retry only attempts cleanup.
fn delete_finished_branch(
    repo: &git2::Repository,
    repo_path: &str,
    branch_name: &str,
) -> GitFlowFinishResult {
    let kept = |reason: String| GitFlowFinishResult {
        branch_deleted: false,
        branch_kept_reason: Some(reason),
    };

    // Branch rules are enforced here as well as in `delete_branch` because
    // these finishes delete the branch themselves rather than going through
    // that command — without this, a `preventDeletion` rule the UI displays as
    // active is inert on every git-flow finish.
    let rules = match super::branch_rules::load_rules(Path::new(repo_path)) {
        Ok(rules) => rules,
        // Unreadable rules mean we cannot prove the branch is unprotected.
        // Keep it: the merge is already safe, and deleting past an unverifiable
        // protection is the one irreversible mistake available here.
        Err(e) => {
            return kept(format!(
                "The merge completed, but \"{}\" was kept — its branch rules could not be read: {}",
                branch_name, e
            ))
        }
    };

    if super::branch_rules::is_deletion_prevented(&rules, branch_name) {
        return kept(format!(
            "\"{}\" is protected by a branch rule and was kept. The merge completed.",
            branch_name
        ));
    }

    let mut branch = match repo.find_branch(branch_name, git2::BranchType::Local) {
        Ok(branch) => branch,
        Err(e) => {
            return kept(format!(
                "The merge completed, but \"{}\" could not be opened for deletion: {}",
                branch_name, e
            ))
        }
    };

    if let Err(e) = branch.delete() {
        // e.g. the branch is checked out in a linked worktree.
        return kept(format!(
            "The merge completed, but \"{}\" could not be deleted: {}",
            branch_name, e
        ));
    }

    GitFlowFinishResult {
        branch_deleted: true,
        branch_kept_reason: None,
    }
}

/// Finish a git flow feature branch (merge into develop)
#[command]
pub async fn gitflow_finish_feature(
    path: String,
    name: String,
    delete_branch: Option<bool>,
    squash: Option<bool>,
) -> Result<GitFlowFinishResult> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // Every gitflow start/finish switches branches (checkout_tree + set_head)
    // without being called checkout, so the hand-placed ensure_checkoutable
    // calls in branch.rs missed all six. Switching out of a paused rebase or
    // an unresolved merge orphans the state on disk: the still-visible Abort
    // then yanks the user back to the original branch, discarding whatever
    // they did on the new one.
    crate::commands::branch::ensure_checkoutable(&repo)?;
    let config = repo.config()?;

    let develop = config
        .get_string("gitflow.branch.develop")
        .unwrap_or_else(|_| "develop".to_string());
    let prefix = config
        .get_string("gitflow.prefix.feature")
        .unwrap_or_else(|_| "feature/".to_string());

    // Every branch this finish will switch to is validated HERE, before any
    // mutation — see finish_release_like, where the same check sat inline next
    // to the second checkout and so fired only after master had already been
    // merged and tagged. This finish switches once and happens to do it first,
    // so it was safe by accident; the guard is hoisted anyway so the invariant
    // ("worktree ownership is settled before we touch anything") is the same
    // in all three finishes rather than a property of statement order.
    crate::commands::branch::ensure_not_checked_out_elsewhere(&repo, &develop)?;

    let branch_name = format!("{}{}", prefix, name);

    // Get feature branch commit
    let feature_branch = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch_name.clone()))?;
    let feature_commit = feature_branch.get().peel_to_commit()?;

    // Checkout develop
    let develop_branch = repo
        .find_branch(&develop, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(develop.clone()))?;
    let develop_obj = develop_branch.get().peel(git2::ObjectType::Commit)?;
    // libgit2 runs no hooks; canonical `git flow` shells out to git checkout,
    // so post-checkout fires there. branch.rs fires it for every checkout.
    let old_head = crate::commands::hooks::head_oid_string(&repo);
    repo.checkout_tree(&develop_obj, None)?;
    repo.set_head(develop_branch.get().name().map_err(|_| {
        GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
    })?)?;
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    // Merge feature into develop
    let annotated_commit = repo.find_annotated_commit(feature_commit.id())?;

    if squash.unwrap_or(false) {
        // Squash merge: the changes must actually be committed (single
        // parent, no merge commit). Conflicts abort BEFORE any branch
        // deletion so the user can resolve them.
        //
        // An ancestry check handles externally completed merges. The marker
        // handles Gitnado's own squash commit because a squash never makes
        // the feature tip an ancestor of develop, and develop may have moved
        // before the user retries failed branch cleanup.
        let develop_commit = develop_branch.get().peel_to_commit()?;
        let squash_already_finished = completed_squash_is_reachable(
            &repo,
            &branch_name,
            feature_commit.id(),
            develop_commit.id(),
        )?;
        let (analysis, _) = repo.merge_analysis(&[&annotated_commit])?;
        if !squash_already_finished && !analysis.is_up_to_date() {
            repo.merge(&[&annotated_commit], None, None)?;
            if repo.index()?.has_conflicts() {
                return Err(GitnadoError::MergeConflict);
            }
            let mut index = repo.index()?;
            let tree_oid = index.write_tree()?;
            // A previous squash finish leaves the feature tip unmerged by
            // ancestry, so merge_analysis remains normal on retry even though
            // develop already has the exact resulting tree. Do not mint an
            // empty duplicate squash commit; finish the pending cleanup only.
            let created_squash_commit = tree_oid != develop_commit.tree_id();
            if created_squash_commit {
                let tree = repo.find_tree(tree_oid)?;
                let sig = repo.signature()?;
                let message = format!("Squashed branch '{}' into {}", branch_name, develop);
                repo.commit(
                    Some("HEAD"),
                    &sig,
                    &sig,
                    &message,
                    &tree,
                    &[&develop_commit],
                )?;
            }
            let squash_commit = repo.head()?.peel_to_commit()?;
            repo.cleanup_state()?;
            if let Err(error) = record_completed_squash(
                &repo,
                &branch_name,
                feature_commit.id(),
                squash_commit.id(),
            ) {
                tracing::warn!("Failed to record completed GitFlow squash: {}", error);
            }
            // git passes flag 1 to post-merge for a squash merge.
            if created_squash_commit {
                crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["1"]);
            }
        }
    } else {
        // Regular merge (no-ff)
        let (analysis, _) = repo.merge_analysis(&[&annotated_commit])?;
        if analysis.is_fast_forward() || analysis.is_normal() {
            repo.merge(&[&annotated_commit], None, None)?;

            // Conflicts must abort the finish (leaving MERGE_HEAD for the
            // conflict-resolution flow) instead of silently skipping the
            // commit and deleting the branch below.
            if repo.index()?.has_conflicts() {
                return Err(GitnadoError::MergeConflict);
            }

            // Auto-commit merge
            let mut index = repo.index()?;
            let tree_oid = index.write_tree()?;
            let tree = repo.find_tree(tree_oid)?;
            let sig = repo.signature()?;
            let develop_commit = develop_branch.get().peel_to_commit()?;
            let parents = vec![&develop_commit, &feature_commit];
            let message = format!("Merge branch '{}' into {}", branch_name, develop);
            repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
            repo.cleanup_state()?;
            // git runs post-merge after a merge commit (flag 0 = not a squash
            // merge). merge.rs fires it; gitflow reimplements the merge inline
            // and fired nothing.
            crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
        }
    }

    // Delete feature branch if requested
    if delete_branch.unwrap_or(true) {
        let result = delete_finished_branch(&repo, &path, &branch_name);
        if result.branch_deleted {
            let _ = std::fs::remove_file(squash_marker_path(&repo, &branch_name));
        }
        return Ok(result);
    }

    Ok(GitFlowFinishResult {
        branch_deleted: false,
        branch_kept_reason: None,
    })
}

/// Record that a squash finish's commit has landed on develop.
///
/// A squash finish whose merge CONFLICTS returns `MergeConflict` before
/// `gitflow_finish_feature` ever reaches its own recorder — the squash commit
/// is then created by the conflict-resolution flow instead. Without a marker
/// for that commit, a retry after a failed branch delete finds neither an
/// ancestry match nor a marker, re-merges the same divergence, and mints a
/// SECOND squash commit. The conflict flow therefore records the marker itself
/// once its commit has landed and before it attempts the branch delete.
#[command]
pub async fn gitflow_record_squash_finish(path: String, name: String) -> Result<()> {
    let repo = git2::Repository::open(Path::new(&path))?;
    let config = repo.config()?;

    let develop = config
        .get_string("gitflow.branch.develop")
        .unwrap_or_else(|_| "develop".to_string());
    let prefix = config
        .get_string("gitflow.prefix.feature")
        .unwrap_or_else(|_| "feature/".to_string());
    let branch_name = format!("{}{}", prefix, name);

    let feature_commit = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch_name.clone()))?
        .get()
        .peel_to_commit()?;
    let develop_commit = repo
        .find_branch(&develop, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(develop.clone()))?
        .get()
        .peel_to_commit()?;

    record_completed_squash(
        &repo,
        &branch_name,
        feature_commit.id(),
        develop_commit.id(),
    )
}

/// Start a git flow release branch
#[command]
pub async fn gitflow_start_release(path: String, version: String) -> Result<Branch> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // Every gitflow start/finish switches branches (checkout_tree + set_head)
    // without being called checkout, so the hand-placed ensure_checkoutable
    // calls in branch.rs missed all six. Switching out of a paused rebase or
    // an unresolved merge orphans the state on disk: the still-visible Abort
    // then yanks the user back to the original branch, discarding whatever
    // they did on the new one.
    crate::commands::branch::ensure_checkoutable(&repo)?;
    let config = repo.config()?;

    let develop = config
        .get_string("gitflow.branch.develop")
        .unwrap_or_else(|_| "develop".to_string());
    let prefix = config
        .get_string("gitflow.prefix.release")
        .unwrap_or_else(|_| "release/".to_string());

    let branch_name = format!("{}{}", prefix, version);

    let develop_branch = repo
        .find_branch(&develop, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(develop))?;

    let commit = develop_branch.get().peel_to_commit()?;
    let branch = repo.branch(&branch_name, &commit, false)?;
    let reference = branch.get();

    // Rolled back on a failed checkout, and fires post-checkout — see
    // gitflow_start_feature.
    let old_head = crate::commands::hooks::head_oid_string(&repo);
    let switch = (|| -> Result<()> {
        let obj = reference.peel(git2::ObjectType::Commit)?;
        repo.checkout_tree(&obj, None)?;
        repo.set_head(reference.name().map_err(|_| {
            GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
        })?)?;
        Ok(())
    })();
    if let Err(e) = switch {
        if let Ok(mut created) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = created.delete();
        }
        return Err(e);
    }
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    Ok(Branch {
        name: branch_name.clone(),
        shorthand: branch_name,
        is_head: true,
        is_remote: false,
        upstream: None,
        target_oid: commit.id().to_string(),
        ahead_behind: None,
        last_commit_timestamp: Some(commit.time().seconds()),
        is_stale: false,
    })
}

/// Finish a git flow release branch (merge into master and develop, tag)
#[command]
pub async fn gitflow_finish_release(
    path: String,
    version: String,
    tag_message: Option<String>,
    delete_branch: Option<bool>,
) -> Result<GitFlowFinishResult> {
    finish_release_like(
        path,
        version,
        tag_message,
        delete_branch,
        "gitflow.prefix.release",
        "release/",
    )
    .await
}

/// Shared implementation for release/hotfix finish: merge into master (with
/// tag), merge into develop, delete the branch. The two flows differ only in
/// which branch prefix they use.
async fn finish_release_like(
    path: String,
    version: String,
    tag_message: Option<String>,
    delete_branch: Option<bool>,
    prefix_key: &str,
    prefix_default: &str,
) -> Result<GitFlowFinishResult> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // Backs both gitflow_finish_release and gitflow_finish_hotfix, and switches
    // branches twice — see the comment on the start commands above.
    crate::commands::branch::ensure_checkoutable(&repo)?;
    let config = repo.config()?;

    let master = config
        .get_string("gitflow.branch.master")
        .unwrap_or_else(|_| "main".to_string());
    let develop = config
        .get_string("gitflow.branch.develop")
        .unwrap_or_else(|_| "develop".to_string());
    let prefix = config
        .get_string(prefix_key)
        .unwrap_or_else(|_| prefix_default.to_string());
    let tag_prefix = config
        .get_string("gitflow.prefix.versiontag")
        .unwrap_or_else(|_| "v".to_string());

    // BOTH branches this finish will switch to are validated up front, before
    // any mutation. The develop check used to sit inline next to the
    // develop-side checkout, which is reached only AFTER master has been
    // checked out, merged, committed and tagged — so on the standard setup of
    // a dedicated `develop` worktree the finish half-applied itself and then
    // refused, with the release branch still alive, HEAD parked on master and
    // no in-app way forward (the obvious retry skips the up-to-date master
    // merge and the existing tag and refuses at the same line, forever).
    // Refusing here leaves the repository exactly as it was.
    crate::commands::branch::ensure_not_checked_out_elsewhere(&repo, &master)?;
    crate::commands::branch::ensure_not_checked_out_elsewhere(&repo, &develop)?;

    let branch_name = format!("{}{}", prefix, version);
    let tag_name = format!("{}{}", tag_prefix, version);

    let release_branch = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch_name.clone()))?;
    let release_commit = release_branch.get().peel_to_commit()?;

    // A version tag left behind by an EARLIER pass of this same finish is
    // expected — the develop side conflicted, the user resolved it and re-ran —
    // and the tag block below adopts it. Any OTHER pre-existing tag belongs to
    // someone else: a teammate's tag, an old cycle reusing the number, or the
    // release/hotfix collision both flows produce because they share
    // gitflow.prefix.versiontag. Adopting one of those merges, deletes the
    // branch and reports success while the release ships untagged and the
    // version resolves to unrelated code. A tag from our own pass always
    // CONTAINS the release tip (it sits on the master merge commit, or on a
    // master tip that already merged it); anything else is refused here, before
    // any mutation, so the repository is left exactly as it was.
    if let Ok(tag_ref) = repo.find_reference(&format!("refs/tags/{}", tag_name)) {
        let from_this_finish = match tag_ref.peel_to_commit() {
            Ok(tagged) => {
                tagged.id() == release_commit.id()
                    || repo.graph_descendant_of(tagged.id(), release_commit.id())?
            }
            // A tag that does not resolve to a commit is certainly not ours.
            Err(_) => false,
        };
        if !from_this_finish {
            return Err(GitnadoError::OperationFailed(format!(
                "Tag '{}' already exists and does not contain '{}'. \
                 Delete or rename the tag, or finish with a different version.",
                tag_name, branch_name
            )));
        }
    }

    // Merge into master
    let master_branch = repo
        .find_branch(&master, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(master.clone()))?;
    let master_obj = master_branch.get().peel(git2::ObjectType::Commit)?;
    // post-checkout — see gitflow_finish_feature.
    let old_head = crate::commands::hooks::head_oid_string(&repo);
    repo.checkout_tree(&master_obj, None)?;
    repo.set_head(master_branch.get().name().map_err(|_| {
        GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
    })?)?;
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    let annotated = repo.find_annotated_commit(release_commit.id())?;
    let (master_analysis, _) = repo.merge_analysis(&[&annotated])?;

    // Idempotency: on a re-run after resolving a develop-side conflict, master
    // already contains the release, so the analysis is up-to-date. Skip the
    // merge+commit entirely — re-merging would create a junk merge commit and
    // the subsequent re-tag would fail with "tag already exists", stranding the
    // branch. We still need a tag target for the (already-existing) tag below.
    let master_merge_oid = if master_analysis.is_up_to_date() {
        None
    } else {
        repo.merge(&[&annotated], None, None)?;

        // Conflicts must abort the finish here — proceeding would tag nothing,
        // check out develop over a conflicted tree, and delete the branch.
        if repo.index()?.has_conflicts() {
            return Err(GitnadoError::MergeConflict);
        }

        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let sig = repo.signature()?;
        let master_commit = master_branch.get().peel_to_commit()?;
        let parents = vec![&master_commit, &release_commit];
        let message = format!("Merge branch '{}' into {}", branch_name, master);
        let merge_oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
        repo.cleanup_state()?;
        // post-merge — see gitflow_finish_feature.
        crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
        Some(merge_oid)
    };

    // Create the tag on master. Skip when it already exists — validated above
    // as this finish's own tag from an earlier pass (re-run after the
    // develop-side conflict was resolved and tagged on the first pass) so we
    // don't fail with "tag already exists". When it is MISSING we must still
    // tag: on a re-run after a MASTER-side conflict was resolved via the dialog,
    // master is already up-to-date so master_merge_oid is None — tag the current
    // master tip (HEAD is on master here) so the release/hotfix isn't silently
    // completed with no version tag.
    if repo
        .find_reference(&format!("refs/tags/{}", tag_name))
        .is_err()
    {
        let sig = repo.signature()?;
        let target_commit = match master_merge_oid {
            Some(merge_oid) => repo.find_commit(merge_oid)?,
            None => repo.head()?.peel_to_commit()?,
        };
        let tag_msg = tag_message.unwrap_or_else(|| format!("Release {}", version));
        repo.tag(&tag_name, target_commit.as_object(), &sig, &tag_msg, false)?;
    }

    // Merge into develop
    let develop_branch = repo
        .find_branch(&develop, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(develop.clone()))?;
    let develop_obj = develop_branch.get().peel(git2::ObjectType::Commit)?;
    // post-checkout for the develop-side switch too. The master switch above
    // got it and this one did not — the same sibling-missed pattern.
    let old_head_develop = crate::commands::hooks::head_oid_string(&repo);
    repo.checkout_tree(&develop_obj, None)?;
    repo.set_head(develop_branch.get().name().map_err(|_| {
        GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
    })?)?;
    let new_head_develop = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head_develop, &new_head_develop, true);

    // Re-read release commit from the new HEAD context
    let release_branch2 = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(branch_name.clone()))?;
    let release_commit2 = release_branch2.get().peel_to_commit()?;
    let annotated2 = repo.find_annotated_commit(release_commit2.id())?;
    let (develop_analysis, _) = repo.merge_analysis(&[&annotated2])?;

    // Idempotency: on a re-run after the develop conflict was resolved via
    // commit_merge, develop already contains the release, so skip the merge to
    // avoid a duplicate merge commit and let branch deletion proceed.
    if !develop_analysis.is_up_to_date() {
        repo.merge(&[&annotated2], None, None)?;

        // Same as the master merge: a conflicted develop merge must be surfaced
        // (and the branch NOT deleted) so the user can resolve it.
        if repo.index()?.has_conflicts() {
            return Err(GitnadoError::MergeConflict);
        }

        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let sig = repo.signature()?;
        let develop_commit = develop_branch.get().peel_to_commit()?;
        let parents = vec![&develop_commit, &release_commit2];
        let message = format!("Merge branch '{}' into {}", branch_name, develop);
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
        repo.cleanup_state()?;
        // post-merge — see gitflow_finish_feature.
        crate::commands::hooks::run_hook_noblock(&repo, "post-merge", &["0"]);
    }

    // Delete release branch
    if delete_branch.unwrap_or(true) {
        return Ok(delete_finished_branch(&repo, &path, &branch_name));
    }

    Ok(GitFlowFinishResult {
        branch_deleted: false,
        branch_kept_reason: None,
    })
}

/// Start a git flow hotfix branch
#[command]
pub async fn gitflow_start_hotfix(path: String, version: String) -> Result<Branch> {
    let repo = git2::Repository::open(Path::new(&path))?;
    // Every gitflow start/finish switches branches (checkout_tree + set_head)
    // without being called checkout, so the hand-placed ensure_checkoutable
    // calls in branch.rs missed all six. Switching out of a paused rebase or
    // an unresolved merge orphans the state on disk: the still-visible Abort
    // then yanks the user back to the original branch, discarding whatever
    // they did on the new one.
    crate::commands::branch::ensure_checkoutable(&repo)?;
    let config = repo.config()?;

    let master = config
        .get_string("gitflow.branch.master")
        .unwrap_or_else(|_| "main".to_string());
    let prefix = config
        .get_string("gitflow.prefix.hotfix")
        .unwrap_or_else(|_| "hotfix/".to_string());

    let branch_name = format!("{}{}", prefix, version);

    let master_branch = repo
        .find_branch(&master, git2::BranchType::Local)
        .map_err(|_| GitnadoError::BranchNotFound(master))?;

    let commit = master_branch.get().peel_to_commit()?;
    let branch = repo.branch(&branch_name, &commit, false)?;
    let reference = branch.get();

    // Rolled back on a failed checkout, and fires post-checkout — see
    // gitflow_start_feature.
    let old_head = crate::commands::hooks::head_oid_string(&repo);
    let switch = (|| -> Result<()> {
        let obj = reference.peel(git2::ObjectType::Commit)?;
        repo.checkout_tree(&obj, None)?;
        repo.set_head(reference.name().map_err(|_| {
            GitnadoError::OperationFailed("Invalid UTF-8 in branch reference name".to_string())
        })?)?;
        Ok(())
    })();
    if let Err(e) = switch {
        if let Ok(mut created) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = created.delete();
        }
        return Err(e);
    }
    let new_head = crate::commands::hooks::head_oid_string(&repo);
    crate::commands::hooks::run_post_checkout(&repo, &old_head, &new_head, true);

    Ok(Branch {
        name: branch_name.clone(),
        shorthand: branch_name,
        is_head: true,
        is_remote: false,
        upstream: None,
        target_oid: commit.id().to_string(),
        ahead_behind: None,
        last_commit_timestamp: Some(commit.time().seconds()),
        is_stale: false,
    })
}

/// Finish a git flow hotfix branch (merge into master and develop, tag)
#[command]
pub async fn gitflow_finish_hotfix(
    path: String,
    version: String,
    tag_message: Option<String>,
    delete_branch: Option<bool>,
) -> Result<GitFlowFinishResult> {
    // Same flow as release finish, but the branch lives under the hotfix
    // prefix — delegating with the release prefix made every hotfix finish
    // fail with BranchNotFound.
    finish_release_like(
        path,
        version,
        tag_message,
        delete_branch,
        "gitflow.prefix.hotfix",
        "hotfix/",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    /// A repository whose default branch is "master" — still the case for any
    /// repo created before git 2.28, and the setup init_gitflow got wrong.
    fn repo_on_master() -> TestRepo {
        let test_repo = TestRepo::with_initial_commit();
        {
            let repo = test_repo.repo();
            let mut main = repo
                .find_branch("main", git2::BranchType::Local)
                .expect("with_initial_commit leaves HEAD on main");
            // libgit2 moves HEAD along with the branch; with_initial_commit
            // relies on the same rename in the other direction.
            main.rename("master", false).expect("rename main -> master");
        }
        assert_eq!(test_repo.current_branch(), "master");
        test_repo
    }

    #[tokio::test]
    async fn test_get_gitflow_config_not_initialized() {
        let repo = TestRepo::with_initial_commit();
        let result = get_gitflow_config(repo.path_str()).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(!config.initialized);
    }

    /// Every gitflow start/finish switches branches without being called
    /// checkout, so the hand-placed ensure_checkoutable calls in branch.rs
    /// missed all of them. Switching out of a paused rebase orphans the state
    /// on disk; the still-visible Abort then discards the new branch's work.
    #[tokio::test]
    async fn test_gitflow_start_refuses_mid_rebase() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        // Pause an interactive rebase the way an `edit` line does.
        let head = repo.repo().head().unwrap().peel_to_commit().unwrap().id();
        std::fs::create_dir_all(repo.path.join(".git/rebase-merge")).unwrap();
        std::fs::write(repo.path.join(".git/rebase-merge/interactive"), "").unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/head-name"),
            "refs/heads/main\n",
        )
        .unwrap();
        std::fs::write(
            repo.path.join(".git/rebase-merge/onto"),
            format!("{}\n", head),
        )
        .unwrap();
        assert_ne!(repo.repo().state(), git2::RepositoryState::Clean);

        for err in [
            gitflow_start_feature(repo.path_str(), "escape".to_string())
                .await
                .expect_err("start feature must refuse mid-rebase"),
            gitflow_start_release(repo.path_str(), "9.9.9".to_string())
                .await
                .expect_err("start release must refuse mid-rebase"),
            gitflow_start_hotfix(repo.path_str(), "9.9.9".to_string())
                .await
                .expect_err("start hotfix must refuse mid-rebase"),
        ] {
            assert!(
                err.to_string().contains("rebase is in progress"),
                "unexpected error: {}",
                err
            );
        }
    }

    /// libgit2 runs no hooks; the app fires them at hand-picked sites.
    /// merge.rs and branch.rs were instrumented, gitflow.rs — which
    /// reimplements both operations inline — was not, so a post-checkout hook
    /// that sets up the environment ran for every checkout EXCEPT the git-flow
    /// ones. Canonical `git flow` shells out to git, so all of these fire.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_gitflow_start_feature_runs_post_checkout_hook() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let marker = repo.path.join("post-checkout.log");
        // Appends rather than overwrites: with `>` a double invocation writes
        // byte-identical content and the assertion still passes, which is how a
        // duplicated hook call went unnoticed.
        repo.install_hook(
            "post-checkout",
            &format!("#!/bin/sh\necho \"$3\" >> \"{}\"\n", marker.display()),
        );

        gitflow_start_feature(repo.path_str(), "hooked".to_string())
            .await
            .expect("start feature");

        let logged = std::fs::read_to_string(&marker).expect("post-checkout must run");
        assert_eq!(
            logged.lines().collect::<Vec<_>>(),
            vec!["1"],
            "post-checkout must fire exactly once, with flag 1 (branch checkout)"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_gitflow_finish_feature_runs_post_merge_hook() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        gitflow_start_feature(repo.path_str(), "hooked".to_string())
            .await
            .unwrap();
        repo.create_commit("feature work", &[("feature.txt", "work\n")]);

        let marker = repo.path.join("post-merge.log");
        // Appends — see the post-checkout test above.
        repo.install_hook(
            "post-merge",
            &format!("#!/bin/sh\necho \"$1\" >> \"{}\"\n", marker.display()),
        );
        let checkout_marker = repo.path.join("post-checkout.log");
        repo.install_hook(
            "post-checkout",
            &format!(
                "#!/bin/sh\necho \"$3\" >> \"{}\"\n",
                checkout_marker.display()
            ),
        );

        gitflow_finish_feature(repo.path_str(), "hooked".to_string(), None, None)
            .await
            .expect("finish feature");

        let logged = std::fs::read_to_string(&marker).expect("post-merge must run");
        assert_eq!(
            logged.lines().collect::<Vec<_>>(),
            vec!["0"],
            "post-merge must fire exactly once, with flag 0 (not a squash merge)"
        );
        let checked_out =
            std::fs::read_to_string(&checkout_marker).expect("post-checkout must run");
        assert_eq!(
            checked_out.lines().collect::<Vec<_>>(),
            vec!["1"],
            "the develop switch must fire post-checkout exactly once"
        );
    }

    /// The ref exists before the fallible checkout. Without a rollback the
    /// panel showed an error while the refs watcher made the branch appear in
    /// the sidebar, and a retry dead-ended on "already exists".
    #[tokio::test]
    async fn test_gitflow_start_rolls_back_when_the_checkout_fails() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        // Put develop and the current branch at different content for one file,
        // then dirty that file so the SAFE checkout conflicts.
        let git = repo.repo();
        let head_name = git.head().unwrap().name().unwrap().to_string();
        git.set_head("refs/heads/develop").unwrap();
        git.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();
        repo.create_commit("develop side", &[("shared.txt", "develop\n")]);

        let git = repo.repo();
        git.set_head(&head_name).unwrap();
        git.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();
        repo.create_file("shared.txt", "my unsaved work\n");

        let result = gitflow_start_feature(repo.path_str(), "rollback".to_string()).await;

        if result.is_err() {
            assert!(
                repo.repo()
                    .find_branch("feature/rollback", git2::BranchType::Local)
                    .is_err(),
                "a failed start must not leave the branch behind"
            );
        }
        assert_eq!(
            std::fs::read_to_string(repo.path.join("shared.txt")).unwrap(),
            "my unsaved work\n",
            "the uncommitted work survives either way"
        );
    }

    /// A preventDeletion rule must survive a git-flow finish. These finishes
    /// delete the branch themselves rather than going through delete_branch, so
    /// without an explicit check the rule is inert on this surface.
    #[tokio::test]
    async fn test_gitflow_finish_feature_respects_branch_rule() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        gitflow_start_feature(repo.path_str(), "protected-work".to_string())
            .await
            .unwrap();

        crate::commands::branch_rules::set_branch_rule(
            repo.path_str(),
            crate::commands::branch_rules::BranchRule {
                pattern: "feature/*".to_string(),
                prevent_deletion: true,
                prevent_force_push: false,
                require_pull_request: false,
                prevent_direct_push: false,
            },
        )
        .await
        .unwrap();

        let result = gitflow_finish_feature(
            repo.path_str(),
            "protected-work".to_string(),
            Some(true),
            None,
        )
        .await;

        // The merge must still succeed — only the optional delete is skipped.
        assert!(result.is_ok(), "finish should complete despite the rule");
        let outcome = result.unwrap();
        assert!(!outcome.branch_deleted, "protected branch must be kept");
        assert!(
            outcome.branch_kept_reason.is_some(),
            "the caller must be told why the branch survived"
        );

        let git_repo = repo.repo();
        assert!(git_repo
            .find_branch("feature/protected-work", git2::BranchType::Local)
            .is_ok());
    }

    /// A delete failure must never fail the whole finish: the merge is already
    /// committed, and a squash finish records a completion marker so a retry
    /// only attempts the pending branch cleanup.
    #[tokio::test]
    async fn test_gitflow_finish_feature_survives_unreadable_branch_rules() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        gitflow_start_feature(repo.path_str(), "work".to_string())
            .await
            .unwrap();

        // save_rules is a non-atomic write, so a crash mid-save can leave this
        // truncated.
        let git_repo = repo.repo();
        let rules_dir = git_repo.path().join("gitnado");
        std::fs::create_dir_all(&rules_dir).unwrap();
        std::fs::write(rules_dir.join("branch_rules.json"), "{ not json").unwrap();

        let result =
            gitflow_finish_feature(repo.path_str(), "work".to_string(), Some(true), None).await;

        assert!(
            result.is_ok(),
            "an unreadable rules file must not fail a finish whose merge already landed"
        );
        let outcome = result.unwrap();
        assert!(!outcome.branch_deleted);
        assert!(
            outcome.branch_kept_reason.is_some(),
            "the caller must be told the branch survived and why"
        );
    }

    #[tokio::test]
    async fn test_gitflow_finish_feature_deletes_unprotected_branch() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        gitflow_start_feature(repo.path_str(), "ordinary".to_string())
            .await
            .unwrap();

        let outcome =
            gitflow_finish_feature(repo.path_str(), "ordinary".to_string(), Some(true), None)
                .await
                .unwrap();

        assert!(outcome.branch_deleted);
        assert!(outcome.branch_kept_reason.is_none());
    }

    #[tokio::test]
    async fn test_init_gitflow() {
        let repo = TestRepo::with_initial_commit();
        let result = init_gitflow(repo.path_str(), None, None, None, None, None, None, None).await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.initialized);
        assert_eq!(config.develop_branch, "develop");

        // Verify develop branch was created
        let git_repo = repo.repo();
        let develop = git_repo.find_branch("develop", git2::BranchType::Local);
        assert!(develop.is_ok());
    }

    /// The name recorded in gitflow.branch.master has to be the branch develop
    /// was actually cut from. Recording the "main" default on a master-default
    /// repository left every later hotfix and finish looking for a branch that
    /// was never there.
    #[tokio::test]
    async fn test_init_gitflow_records_the_master_branch_that_exists() {
        let repo = repo_on_master();

        let config = init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .expect("init must succeed on a repo whose default branch is master");

        assert_eq!(config.master_branch, "master");
        assert_eq!(
            repo.repo()
                .config()
                .unwrap()
                .get_string("gitflow.branch.master")
                .unwrap(),
            "master",
            "the persisted name must be the branch that exists"
        );
        assert!(
            repo.repo()
                .find_branch("develop", git2::BranchType::Local)
                .is_ok(),
            "develop must still be created"
        );
    }

    /// The user-visible consequence: the panel's Initialize button passes no
    /// config at all, so a master-default repo used to end up with a hotfix
    /// button that could only ever fail.
    #[tokio::test]
    async fn test_gitflow_hotfix_works_after_init_on_a_master_repo() {
        let repo = repo_on_master();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let branch = gitflow_start_hotfix(repo.path_str(), "1.0.1".to_string())
            .await
            .expect("hotfix start must work on a repo initialized by the panel");

        assert_eq!(branch.name, "hotfix/1.0.1");
        assert!(branch.is_head);
    }

    /// A gitflow config reads as initialized the moment gitflow.branch.master
    /// exists, so writing the keys before the branch lookup turned a failed
    /// init into a repository permanently stuck on a broken config.
    #[tokio::test]
    async fn test_init_gitflow_failure_leaves_the_repo_uninitialized() {
        // No commit, so there is no branch to base anything on.
        let repo = TestRepo::new();

        let err = init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .expect_err("init must fail with no branch to base on");

        let config = get_gitflow_config(repo.path_str()).await.unwrap();
        assert!(
            !config.initialized,
            "a failed init must not leave the repo looking initialized"
        );
        assert!(
            err.to_string().contains("main or master"),
            "unexpected error: {}",
            err
        );
    }

    /// The seven config writes are seven separate writes to .git/config, so
    /// one of them can fail on its own. gitflow.branch.master is the key
    /// `initialized` is read off, so it has to be the last one written — if it
    /// goes first, a failure part-way through leaves the repo flagged
    /// initialized while develop and the prefixes fall back to defaults, and
    /// the panel never offers the init section again.
    ///
    /// A duplicated key is the cheapest real way to make exactly one write
    /// fail: libgit2 refuses set_str on a multivar.
    #[tokio::test]
    async fn test_init_gitflow_partial_config_write_leaves_the_repo_uninitialized() {
        let repo = TestRepo::with_initial_commit();

        // A hand-edited (or merge-mangled) config with gitflow.prefix.feature
        // listed twice. Every other gitflow write still succeeds.
        let config_path = repo.path.join(".git").join("config");
        let mut existing = std::fs::read_to_string(&config_path).unwrap();
        existing.push_str("[gitflow \"prefix\"]\n\tfeature = a/\n\tfeature = b/\n");
        std::fs::write(&config_path, existing).unwrap();

        let err = init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .expect_err("init must fail when a gitflow config key cannot be written");
        assert!(
            err.to_string().contains("multivar"),
            "expected the multivar write to be what failed, got: {}",
            err
        );

        let config = get_gitflow_config(repo.path_str()).await.unwrap();
        assert!(
            !config.initialized,
            "an init that failed part-way through the config writes must not \
             leave the repo looking initialized — the panel would never offer \
             the init section again"
        );
        assert!(
            repo.repo()
                .config()
                .unwrap()
                .get_string("gitflow.branch.master")
                .is_err(),
            "the initialized marker must not be persisted by a failed init"
        );
        // The keys written before the failure are rolled back, not left
        // lying around: gitflow.branch.develop is written first and succeeds.
        assert!(
            repo.repo()
                .config()
                .unwrap()
                .get_string("gitflow.branch.develop")
                .is_err(),
            "a key this attempt wrote must be removed again when a later write fails"
        );
        // And the branch this attempt cut goes back too. Left behind, a retry
        // would reuse it instead of cutting develop from the selected base.
        assert!(
            repo.repo()
                .find_branch("develop", git2::BranchType::Local)
                .is_err(),
            "a failed init must not leave the develop branch it created behind"
        );
    }

    /// Re-initializing an already-configured repository must not shred the
    /// configuration it already had. The rollback restores each key to the
    /// value this call found rather than deleting it, and leaves a develop it
    /// did not create alone.
    #[tokio::test]
    async fn test_init_gitflow_failed_reinit_restores_the_previous_config() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .expect("first init must succeed");

        // Duplicate gitflow.prefix.release so that exactly one write of the
        // re-init fails — the two keys written before it succeed first.
        let config_path = repo.path.join(".git").join("config");
        let mut existing = std::fs::read_to_string(&config_path).unwrap();
        existing.push_str("[gitflow \"prefix\"]\n\trelease = duplicate/\n");
        std::fs::write(&config_path, existing).unwrap();

        init_gitflow(
            repo.path_str(),
            None,
            None,
            Some("feat/".to_string()),
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("re-init must fail when a gitflow config key cannot be written");

        let config = get_gitflow_config(repo.path_str()).await.unwrap();
        assert!(config.initialized, "the repo stays initialized as it was");
        assert_eq!(
            config.feature_prefix, "feature/",
            "a key the failed attempt overwrote must be restored to its previous value"
        );
        assert_eq!(config.master_branch, "main");
        assert!(
            repo.repo()
                .find_branch("develop", git2::BranchType::Local)
                .is_ok(),
            "a develop this attempt did not create must be left alone"
        );
    }

    #[tokio::test]
    async fn test_init_gitflow_refuses_a_master_branch_that_does_not_exist() {
        let repo = TestRepo::with_initial_commit();

        let err = init_gitflow(
            repo.path_str(),
            Some("nope".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("init must refuse a master branch that does not exist");
        assert!(
            err.to_string().contains("Branch not found: nope"),
            "unexpected error: {}",
            err
        );

        let config = get_gitflow_config(repo.path_str()).await.unwrap();
        assert!(!config.initialized);
        assert!(
            repo.repo()
                .find_branch("develop", git2::BranchType::Local)
                .is_err(),
            "a refused init must not create develop"
        );
    }

    #[tokio::test]
    async fn test_init_gitflow_custom_branches() {
        let repo = TestRepo::with_initial_commit();
        // The custom master must exist — init_gitflow refuses to record a
        // branch that does not.
        repo.create_branch("production");
        let result = init_gitflow(
            repo.path_str(),
            Some("production".to_string()),
            Some("dev".to_string()),
            Some("feat/".to_string()),
            Some("rel/".to_string()),
            Some("fix/".to_string()),
            Some("sup/".to_string()),
            Some("ver".to_string()),
        )
        .await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(config.master_branch, "production");
        assert_eq!(config.develop_branch, "dev");
        assert_eq!(config.feature_prefix, "feat/");
    }

    #[tokio::test]
    async fn test_get_gitflow_config_after_init() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let config = get_gitflow_config(repo.path_str()).await.unwrap();
        assert!(config.initialized);
        assert_eq!(config.feature_prefix, "feature/");
    }

    #[tokio::test]
    async fn test_start_feature() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let result = gitflow_start_feature(repo.path_str(), "my-feature".to_string()).await;
        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "feature/my-feature");
        assert!(branch.is_head);
    }

    #[tokio::test]
    async fn test_finish_feature() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        // Start feature
        gitflow_start_feature(repo.path_str(), "test-feature".to_string())
            .await
            .unwrap();

        // Add a commit on the feature branch
        repo.create_commit("Feature work", &[("feature.txt", "feature content")]);

        // Finish feature
        let result = gitflow_finish_feature(
            repo.path_str(),
            "test-feature".to_string(),
            Some(true),
            None,
        )
        .await;
        assert!(result.is_ok());

        // Verify we're back on develop
        assert_eq!(repo.current_branch(), "develop");

        // Verify feature branch was deleted
        let git_repo = repo.repo();
        let feature = git_repo.find_branch("feature/test-feature", git2::BranchType::Local);
        assert!(feature.is_err());
    }

    #[tokio::test]
    async fn test_start_release() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let result = gitflow_start_release(repo.path_str(), "1.0.0".to_string()).await;
        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "release/1.0.0");
        assert!(branch.is_head);
    }

    #[tokio::test]
    async fn test_start_hotfix() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let result = gitflow_start_hotfix(repo.path_str(), "1.0.1".to_string()).await;
        assert!(result.is_ok());
        let branch = result.unwrap();
        assert_eq!(branch.name, "hotfix/1.0.1");
        assert!(branch.is_head);
    }

    #[tokio::test]
    async fn test_start_feature_without_init_fails() {
        let repo = TestRepo::with_initial_commit();
        // Don't init gitflow - develop branch doesn't exist
        let result = gitflow_start_feature(repo.path_str(), "my-feature".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_finish_feature_with_squash() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "squash-feature".to_string())
            .await
            .unwrap();

        repo.create_commit("Commit 1", &[("file1.txt", "content1")]);
        repo.create_commit("Commit 2", &[("file2.txt", "content2")]);

        let result = gitflow_finish_feature(
            repo.path_str(),
            "squash-feature".to_string(),
            Some(true),
            Some(true),
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_finish_feature_keep_branch() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "keep-feature".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("feature.txt", "content")]);

        let result = gitflow_finish_feature(
            repo.path_str(),
            "keep-feature".to_string(),
            Some(false), // Don't delete branch
            None,
        )
        .await;
        assert!(result.is_ok());

        // Branch should still exist
        let git_repo = repo.repo();
        let feature = git_repo.find_branch("feature/keep-feature", git2::BranchType::Local);
        assert!(feature.is_ok());
    }

    #[tokio::test]
    async fn test_finish_feature_with_conflict_errors_and_keeps_branch() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "conflicting".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature change", &[("shared.txt", "feature content")]);

        // Conflicting change on develop
        repo.checkout_branch("develop");
        repo.create_commit("Develop change", &[("shared.txt", "develop content")]);

        let result =
            gitflow_finish_feature(repo.path_str(), "conflicting".to_string(), Some(true), None)
                .await;

        // Must surface the conflict, NOT report success
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        // Branch must NOT have been deleted, and the merge state must be
        // intact for the conflict-resolution flow
        let git_repo = repo.repo();
        assert!(git_repo
            .find_branch("feature/conflicting", git2::BranchType::Local)
            .is_ok());
        assert_eq!(git_repo.state(), git2::RepositoryState::Merge);
    }

    #[tokio::test]
    async fn test_finish_feature_squash_creates_commit() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "squashed".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("squash.txt", "squash content")]);

        let result = gitflow_finish_feature(
            repo.path_str(),
            "squashed".to_string(),
            Some(true),
            Some(true), // squash
        )
        .await;
        assert!(result.is_ok(), "squash finish failed: {:?}", result.err());

        // The squashed changes must actually be committed on develop as a
        // single-parent commit, with no merge state left behind
        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        assert_eq!(repo.current_branch(), "develop");
        let head = git_repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert!(repo.path.join("squash.txt").exists());
    }

    #[tokio::test]
    async fn test_finish_feature_squash_up_to_date_skips_merge() {
        // The squash block now guards on merge_analysis: when develop already
        // contains the feature (here the feature has no commits beyond develop, so
        // the merge is up-to-date), the squash finish must SKIP the merge+commit —
        // minting no duplicate commit — and still delete the branch. This prevents
        // a re-run (after the squash was completed externally) from re-merging.
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "noop".to_string())
            .await
            .unwrap();
        // No commits on the feature — it points at develop's tip (up-to-date).

        let develop_tip_before = repo.repo().refname_to_id("refs/heads/develop").unwrap();

        let result = gitflow_finish_feature(
            repo.path_str(),
            "noop".to_string(),
            Some(true),
            Some(true), // squash
        )
        .await;
        assert!(result.is_ok(), "squash finish failed: {:?}", result.err());

        let git_repo = repo.repo();
        // Develop tip unchanged — no junk squash commit was created.
        let develop_tip_after = git_repo.refname_to_id("refs/heads/develop").unwrap();
        assert_eq!(
            develop_tip_before, develop_tip_after,
            "up-to-date squash finish must not mint a commit"
        );
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);
        // Branch still deleted.
        assert!(git_repo
            .find_branch("feature/noop", git2::BranchType::Local)
            .is_err());
    }

    #[tokio::test]
    async fn test_finish_feature_squash_retry_does_not_create_empty_commit() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "retry".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("feature.txt", "content\n")]);

        gitflow_finish_feature(
            repo.path_str(),
            "retry".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();
        let first_finish_tip = repo.head_oid();
        repo.create_commit("Later develop work", &[("develop.txt", "later\n")]);
        let develop_tip_before_retry = repo.head_oid();

        let result =
            gitflow_finish_feature(repo.path_str(), "retry".to_string(), Some(true), Some(true))
                .await
                .expect("retry should only finish branch cleanup");

        assert_ne!(develop_tip_before_retry, first_finish_tip);
        assert_eq!(repo.head_oid(), develop_tip_before_retry);
        assert!(result.branch_deleted);
        assert!(repo
            .repo()
            .find_branch("feature/retry", git2::BranchType::Local)
            .is_err());
    }

    #[tokio::test]
    async fn test_finish_feature_squash_retry_reapplies_after_develop_reset() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        let develop_before_squash = repo.head_oid();

        gitflow_start_feature(repo.path_str(), "reset-retry".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("feature.txt", "content\n")]);
        gitflow_finish_feature(
            repo.path_str(),
            "reset-retry".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();

        let git_repo = repo.repo();
        git_repo
            .reference(
                "refs/heads/develop",
                develop_before_squash,
                true,
                "test reset",
            )
            .unwrap();
        git_repo
            .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        let result = gitflow_finish_feature(
            repo.path_str(),
            "reset-retry".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .expect("reset develop must invalidate the completion marker");

        assert_ne!(repo.head_oid(), develop_before_squash);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("feature.txt")).unwrap(),
            "content\n"
        );
        assert!(result.branch_deleted);
    }

    #[tokio::test]
    async fn test_finish_feature_squash_retry_reapplies_reverted_content() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "revert-retry".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("README.md", "# Feature\n")]);
        gitflow_finish_feature(
            repo.path_str(),
            "revert-retry".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();
        repo.create_commit("Revert feature work", &[("README.md", "# Test Repo")]);
        let reverted_tip = repo.head_oid();

        let result = gitflow_finish_feature(
            repo.path_str(),
            "revert-retry".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .expect("reverted squash content must be reapplied");

        assert_ne!(repo.head_oid(), reverted_tip);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
            "# Feature\n"
        );
        assert!(result.branch_deleted);
    }

    #[tokio::test]
    async fn test_finish_feature_squash_new_feature_tip_is_not_treated_as_retry() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "continued".to_string())
            .await
            .unwrap();
        repo.create_commit("First feature work", &[("first.txt", "first\n")]);
        gitflow_finish_feature(
            repo.path_str(),
            "continued".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();
        let first_squash = repo.head_oid();

        repo.checkout_branch("feature/continued");
        repo.create_commit("More feature work", &[("second.txt", "second\n")]);
        gitflow_finish_feature(
            repo.path_str(),
            "continued".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .expect("a changed feature tip must be squashed");

        assert_ne!(repo.head_oid(), first_squash);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("second.txt")).unwrap(),
            "second\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_finish_feature_squash_retry_does_not_rerun_post_merge_hook() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();
        gitflow_start_feature(repo.path_str(), "hook-retry".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("feature.txt", "content\n")]);

        let marker = repo.path.join("post-merge.log");
        repo.install_hook(
            "post-merge",
            &format!("#!/bin/sh\necho \"$1\" >> \"{}\"\n", marker.display()),
        );

        gitflow_finish_feature(
            repo.path_str(),
            "hook-retry".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();
        gitflow_finish_feature(
            repo.path_str(),
            "hook-retry".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .unwrap();

        let logged = std::fs::read_to_string(&marker).expect("post-merge must run once");
        assert_eq!(
            logged.lines().collect::<Vec<_>>(),
            vec!["1"],
            "cleanup retry must not rerun post-merge"
        );
    }

    /// The marker is what makes a retry safe when develop has since moved to
    /// content that CONFLICTS with the feature — `merge_commits` then produces a
    /// conflicted index that has no tree to compare, so the check must answer
    /// "already finished" from the marker alone.
    #[tokio::test]
    async fn test_finish_feature_squash_retry_with_conflicting_develop_only_cleans_up() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "diverge-retry".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("README.md", "# Feature\n")]);
        gitflow_finish_feature(
            repo.path_str(),
            "diverge-retry".to_string(),
            Some(false),
            Some(true),
        )
        .await
        .unwrap();

        // Develop moves on to content that conflicts with the feature tip.
        repo.create_commit("Diverge", &[("README.md", "# Diverged\n")]);
        let diverged_tip = repo.head_oid();

        let result = gitflow_finish_feature(
            repo.path_str(),
            "diverge-retry".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .expect("a finished squash must not re-conflict on retry");

        assert_eq!(
            repo.head_oid(),
            diverged_tip,
            "retry must not commit anything on top of the diverged develop"
        );
        assert!(result.branch_deleted);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
            "# Diverged\n",
            "the retry must not resurrect the squashed content"
        );
    }

    /// A squash finish whose merge conflicts is committed by the
    /// conflict-resolution flow, not by `gitflow_finish_feature`. Without the
    /// marker that flow records, a retry after a blocked branch delete
    /// re-conflicts and mints a SECOND squash commit on develop.
    #[tokio::test]
    async fn test_record_squash_finish_lets_a_conflicted_squash_retry_clean_up_only() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_feature(repo.path_str(), "conflicted".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature work", &[("README.md", "# Feature\n")]);
        repo.checkout_branch("develop");
        repo.create_commit("Develop work", &[("README.md", "# Develop\n")]);

        assert!(
            matches!(
                gitflow_finish_feature(
                    repo.path_str(),
                    "conflicted".to_string(),
                    Some(true),
                    Some(true),
                )
                .await,
                Err(GitnadoError::MergeConflict)
            ),
            "the squash merge must conflict before any commit is made"
        );

        // What the conflict-resolution dialog does: resolve, commit the squash
        // as a single parent, then record the completion.
        repo.create_file("README.md", "# Resolved\n");
        repo.stage_file("README.md");
        crate::commands::merge::commit_merge(repo.path_str(), None, Some(true))
            .await
            .unwrap();
        gitflow_record_squash_finish(repo.path_str(), "conflicted".to_string())
            .await
            .unwrap();
        let squash_tip = repo.head_oid();

        // The delete was blocked (e.g. a preventDeletion rule), so the user
        // retries the whole finish from the Git Flow panel.
        let result = gitflow_finish_feature(
            repo.path_str(),
            "conflicted".to_string(),
            Some(true),
            Some(true),
        )
        .await
        .expect("the recorded squash must make the retry cleanup-only");

        assert_eq!(
            repo.head_oid(),
            squash_tip,
            "retry must not mint a second squash commit"
        );
        assert!(result.branch_deleted);
        assert_eq!(
            std::fs::read_to_string(repo.path.join("README.md")).unwrap(),
            "# Resolved\n",
            "the retry must leave the resolved content alone"
        );
    }

    #[tokio::test]
    async fn test_record_squash_finish_rejects_an_unknown_feature() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        let result = gitflow_record_squash_finish(repo.path_str(), "missing".to_string()).await;

        assert!(matches!(result, Err(GitnadoError::BranchNotFound(_))));
    }

    #[tokio::test]
    async fn test_finish_hotfix_uses_hotfix_prefix() {
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_hotfix(repo.path_str(), "1.0.1".to_string())
            .await
            .unwrap();
        repo.create_commit("Hotfix work", &[("hotfix.txt", "fix")]);

        // Before the fix this failed with BranchNotFound("release/1.0.1")
        let result =
            gitflow_finish_hotfix(repo.path_str(), "1.0.1".to_string(), None, Some(true)).await;
        assert!(result.is_ok(), "hotfix finish failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert!(git_repo.find_reference("refs/tags/v1.0.1").is_ok());
        assert!(git_repo
            .find_branch("hotfix/1.0.1", git2::BranchType::Local)
            .is_err());
    }

    #[tokio::test]
    async fn test_finish_release_with_conflict_keeps_branch() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_release(repo.path_str(), "2.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("shared.txt", "release content")]);

        // Conflicting change on master
        repo.checkout_branch(&master);
        repo.create_commit("Master change", &[("shared.txt", "master content")]);

        let result =
            gitflow_finish_release(repo.path_str(), "2.0.0".to_string(), None, Some(true)).await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        // Branch kept, no tag created, merge state intact for resolution
        let git_repo = repo.repo();
        assert!(git_repo
            .find_branch("release/2.0.0", git2::BranchType::Local)
            .is_ok());
        assert!(git_repo.find_reference("refs/tags/v2.0.0").is_err());
        assert_eq!(git_repo.state(), git2::RepositoryState::Merge);
    }

    fn count_reachable_commits(repo: &TestRepo, branch: &str) -> usize {
        let git_repo = repo.repo();
        let reference = git_repo
            .find_branch(branch, git2::BranchType::Local)
            .expect("branch should exist");
        let oid = reference.get().target().expect("branch should have a tip");
        let mut revwalk = git_repo.revwalk().unwrap();
        revwalk.push(oid).unwrap();
        revwalk.count()
    }

    #[tokio::test]
    async fn test_finish_release_tags_after_master_conflict_resolved() {
        // A MASTER-side conflict is resolved via the dialog (resolve_conflict +
        // commit_merge). On re-run, master is up-to-date (master_merge_oid=None)
        // but the tag was never created on the first pass — finish must still
        // create it, pointing at the master tip, exactly once. Before the fix
        // the tag block was gated on Some(merge_oid) and silently skipped.
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_release(repo.path_str(), "2.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("shared.txt", "release content")]);

        // Conflicting change on master.
        repo.checkout_branch(&master);
        repo.create_commit("Master change", &[("shared.txt", "master content")]);

        // First finish: master merge conflicts, no tag yet.
        let result =
            gitflow_finish_release(repo.path_str(), "2.0.0".to_string(), None, Some(true)).await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));
        assert!(repo.repo().find_reference("refs/tags/v2.0.0").is_err());

        // Resolve the master conflict and complete the merge (HEAD is on master).
        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();
        crate::commands::merge::commit_merge(repo.path_str(), None, None)
            .await
            .unwrap();

        let master_tip = repo
            .repo()
            .refname_to_id(&format!("refs/heads/{}", master))
            .unwrap();

        // Re-run finish: must succeed AND create the tag on the master tip.
        let result =
            gitflow_finish_release(repo.path_str(), "2.0.0".to_string(), None, Some(true)).await;
        assert!(result.is_ok(), "re-run finish failed: {:?}", result.err());

        let git_repo = repo.repo();
        let tag_ref = git_repo.find_reference("refs/tags/v2.0.0");
        assert!(
            tag_ref.is_ok(),
            "version tag must be created after resolving the master conflict"
        );
        let tag_commit = tag_ref.unwrap().peel_to_commit().unwrap();
        assert_eq!(
            tag_commit.id(),
            master_tip,
            "tag must point at the master tip"
        );

        // Branch deleted.
        assert!(git_repo
            .find_branch("release/2.0.0", git2::BranchType::Local)
            .is_err());
    }

    /// Create a linked worktree holding `branch`, named uniquely per test repo.
    ///
    /// `..` from a TestRepo's TempDir is the SHARED system temp dir, so a fixed
    /// directory name collides across parallel tests.
    #[cfg(unix)]
    fn add_worktree_for(repo: &TestRepo, branch: &str, label: &str) -> std::path::PathBuf {
        let unique = repo.path.file_name().unwrap().to_string_lossy().to_string();
        let wt_dir = repo
            .path
            .parent()
            .unwrap()
            .join(format!("{}-{}", label, unique));
        let out = crate::utils::create_command("git")
            .arg("-C")
            .arg(&repo.path)
            .args(["worktree", "add"])
            .arg(&wt_dir)
            .arg(branch)
            .output()
            .expect("git must run");
        assert!(
            out.status.success(),
            "worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        wt_dir
    }

    /// A dedicated `develop` worktree is the standard git-flow setup, and it is
    /// the case the worktree guard was added for. The guard sat inline next to
    /// the DEVELOP checkout, which finish only reaches after master has been
    /// checked out, merged, committed and TAGGED — so the refusal fired on a
    /// half-applied release: master carrying a merge commit and a version tag,
    /// develop untouched, the release branch still alive, HEAD parked on
    /// master, and a plain error toast mentioning none of it. Refusing up front
    /// must leave the repository byte-for-byte as it was.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_finish_release_refuses_before_touching_master_when_develop_is_in_a_worktree() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(
            repo.path_str(),
            Some(master.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        gitflow_start_release(repo.path_str(), "4.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("release.txt", "release")]);
        repo.checkout_branch(&master);

        // develop lives in its own worktree, so this repo cannot check it out.
        let _wt = add_worktree_for(&repo, "develop", "gitflow-develop");

        let master_tip_before = repo
            .repo()
            .refname_to_id(&format!("refs/heads/{}", master))
            .unwrap();

        let result =
            gitflow_finish_release(repo.path_str(), "4.0.0".to_string(), None, Some(true)).await;

        let err = result.expect_err("finish must refuse while develop is held elsewhere");
        assert!(
            err.to_string().contains("already checked out"),
            "message must name the worktree conflict, got: {}",
            err
        );

        let git_repo = repo.repo();
        // NOTHING may have happened: no master merge, no tag, branch intact.
        assert_eq!(
            git_repo
                .refname_to_id(&format!("refs/heads/{}", master))
                .unwrap(),
            master_tip_before,
            "master must not be merged before the refusal"
        );
        assert!(
            git_repo.find_reference("refs/tags/v4.0.0").is_err(),
            "the release must not be tagged before the refusal"
        );
        assert!(
            git_repo
                .find_branch("release/4.0.0", git2::BranchType::Local)
                .is_ok(),
            "the release branch must survive"
        );
        assert_eq!(
            git_repo.state(),
            git2::RepositoryState::Clean,
            "no merge state may be left behind"
        );
    }

    /// Same guard from the other side: MASTER held by another worktree must be
    /// refused too, and equally before anything moves.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_finish_release_refuses_when_master_is_in_a_worktree() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(
            repo.path_str(),
            Some(master.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        gitflow_start_release(repo.path_str(), "5.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("release.txt", "release")]);
        // Sit on develop so master is free to be claimed by the worktree.
        repo.checkout_branch("develop");
        let _wt = add_worktree_for(&repo, &master, "gitflow-master");

        let head_before = repo.head_oid();
        let result =
            gitflow_finish_release(repo.path_str(), "5.0.0".to_string(), None, Some(true)).await;

        let err = result.expect_err("finish must refuse while master is held elsewhere");
        assert!(err.to_string().contains("already checked out"), "{}", err);
        assert_eq!(repo.head_oid(), head_before, "HEAD must not move");
        assert!(repo.repo().find_reference("refs/tags/v5.0.0").is_err());
    }

    /// The hotfix finish shares finish_release_like, so it inherits the same
    /// up-front validation — pinned so a future split cannot regress one side.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_finish_hotfix_refuses_before_touching_master_when_develop_is_in_a_worktree() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(
            repo.path_str(),
            Some(master.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        gitflow_start_hotfix(repo.path_str(), "1.0.1".to_string())
            .await
            .unwrap();
        repo.create_commit("Hotfix change", &[("hotfix.txt", "fix")]);
        repo.checkout_branch(&master);
        let _wt = add_worktree_for(&repo, "develop", "gitflow-hotfix-develop");

        let master_tip_before = repo
            .repo()
            .refname_to_id(&format!("refs/heads/{}", master))
            .unwrap();

        let err = gitflow_finish_hotfix(repo.path_str(), "1.0.1".to_string(), None, Some(true))
            .await
            .expect_err("hotfix finish must refuse while develop is held elsewhere");
        assert!(err.to_string().contains("already checked out"), "{}", err);

        let git_repo = repo.repo();
        assert_eq!(
            git_repo
                .refname_to_id(&format!("refs/heads/{}", master))
                .unwrap(),
            master_tip_before,
            "master must not be merged before the refusal"
        );
        assert!(git_repo.find_reference("refs/tags/v1.0.1").is_err());
        assert!(git_repo
            .find_branch("hotfix/1.0.1", git2::BranchType::Local)
            .is_ok());
    }

    /// The feature finish switches to develop too. It was safe only by accident
    /// (its single checkout happened to be the first mutation); the guard is
    /// hoisted there as well, and this pins that it still refuses.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_finish_feature_refuses_when_develop_is_in_a_worktree() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(
            repo.path_str(),
            Some(master.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        gitflow_start_feature(repo.path_str(), "widget".to_string())
            .await
            .unwrap();
        repo.create_commit("Feature change", &[("widget.txt", "widget")]);
        repo.checkout_branch(&master);
        let _wt = add_worktree_for(&repo, "develop", "gitflow-feature-develop");

        let develop_tip_before = repo.repo().refname_to_id("refs/heads/develop").unwrap();

        let err = gitflow_finish_feature(repo.path_str(), "widget".to_string(), Some(true), None)
            .await
            .expect_err("feature finish must refuse while develop is held elsewhere");
        assert!(err.to_string().contains("already checked out"), "{}", err);

        let git_repo = repo.repo();
        assert_eq!(
            git_repo.refname_to_id("refs/heads/develop").unwrap(),
            develop_tip_before,
            "develop must not be merged"
        );
        assert!(
            git_repo
                .find_branch("feature/widget", git2::BranchType::Local)
                .is_ok(),
            "the feature branch must survive the refusal"
        );
    }

    /// Starting a feature must NOT be blocked by an unrelated worktree branch
    /// whose name matches the part after the prefix. The worktree guard falls
    /// back to the segment after the first '/' when the full name has no local
    /// branch, so hoisting one into the start commands "for symmetry" would
    /// make `feature/x` refuse whenever some worktree held a plain `x`.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_start_feature_is_not_blocked_by_a_worktree_holding_the_bare_name() {
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(
            repo.path_str(),
            Some(master.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        // An unrelated branch literally named `widget`, held by a worktree.
        repo.create_branch("widget");
        let _wt = add_worktree_for(&repo, "widget", "gitflow-bare-name");

        let branch = gitflow_start_feature(repo.path_str(), "widget".to_string())
            .await
            .expect("a new feature/widget must not collide with a worktree holding `widget`");
        assert_eq!(branch.name, "feature/widget");
        assert_eq!(repo.current_branch(), "feature/widget");
    }

    #[tokio::test]
    async fn test_finish_release_idempotent_after_develop_conflict() {
        // The master merge succeeds and the tag is created, but the develop
        // merge conflicts. After resolving that conflict and completing the
        // develop merge, re-running finish must be a clean no-op on master (no
        // duplicate merge commit, no duplicate/failed tag) and must still
        // delete the branch.
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        // Give develop a base version of shared.txt, branch the release off it,
        // change it on the release, then make a DIVERGENT change on develop so
        // the develop-side merge conflicts (master has no shared.txt so its
        // merge stays clean).
        repo.checkout_branch("develop");
        repo.create_commit("Develop base", &[("shared.txt", "develop base")]);
        gitflow_start_release(repo.path_str(), "3.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("shared.txt", "release content")]);
        repo.checkout_branch("develop");
        repo.create_commit("Develop divergent", &[("shared.txt", "develop divergent")]);

        // First finish: master merges + tags cleanly, develop merge conflicts.
        let result =
            gitflow_finish_release(repo.path_str(), "3.0.0".to_string(), None, Some(true)).await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        {
            let git_repo = repo.repo();
            assert_eq!(git_repo.state(), git2::RepositoryState::Merge);
            assert!(
                git_repo.find_reference("refs/tags/v3.0.0").is_ok(),
                "tag should have been created during the clean master merge"
            );
        }

        let master_commits_before = count_reachable_commits(&repo, &master);

        // Resolve the develop conflict and complete the merge.
        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();
        crate::commands::merge::commit_merge(repo.path_str(), None, None)
            .await
            .unwrap();

        // Re-run finish: must succeed and be idempotent.
        let result =
            gitflow_finish_release(repo.path_str(), "3.0.0".to_string(), None, Some(true)).await;
        assert!(result.is_ok(), "re-run finish failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(git_repo.state(), git2::RepositoryState::Clean);

        // No duplicate merge commit added to master.
        let master_commits_after = count_reachable_commits(&repo, &master);
        assert_eq!(
            master_commits_before, master_commits_after,
            "re-run must not add a junk master merge commit"
        );

        // Tag still exists (exactly once — creating it twice would have errored).
        assert!(git_repo.find_reference("refs/tags/v3.0.0").is_ok());

        // Branch was deleted.
        assert!(git_repo
            .find_branch("release/3.0.0", git2::BranchType::Local)
            .is_err());
    }

    #[tokio::test]
    async fn test_finish_release_refuses_a_version_tag_on_an_unrelated_commit() {
        // A tag with the release's version already exists on an UNRELATED
        // commit (a teammate's tag, or an old cycle reusing the number).
        // Finishing must refuse before touching anything — silently adopting
        // it would merge, delete the branch and report success while the
        // version tag still resolves to the old code.
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        // Unrelated work on master, tagged with the version we are about to
        // release.
        repo.checkout_branch(&master);
        repo.create_commit("Unrelated work", &[("other.txt", "x")]);
        let stale = repo.head_oid();
        repo.create_tag("v2.0.0");

        gitflow_start_release(repo.path_str(), "2.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("release.txt", "r")]);

        let master_before = count_reachable_commits(&repo, &master);

        let result =
            gitflow_finish_release(repo.path_str(), "2.0.0".to_string(), None, Some(true)).await;

        match &result {
            Err(GitnadoError::OperationFailed(msg)) => {
                assert!(
                    msg.contains("v2.0.0") && msg.contains("release/2.0.0"),
                    "error must name the colliding tag and branch: {}",
                    msg
                );
            }
            other => panic!("expected the finish to be refused, got {:?}", other),
        }

        let git_repo = repo.repo();
        // Nothing was mutated: branch alive, master untouched, HEAD unmoved,
        // and the tag still points where it did.
        assert!(
            git_repo
                .find_branch("release/2.0.0", git2::BranchType::Local)
                .is_ok(),
            "release branch must survive a refused finish"
        );
        assert_eq!(
            count_reachable_commits(&repo, &master),
            master_before,
            "master must not gain a merge commit"
        );
        assert_eq!(repo.current_branch(), "release/2.0.0", "HEAD must not move");
        assert_eq!(
            git_repo
                .find_reference("refs/tags/v2.0.0")
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            stale,
            "the pre-existing tag must be left alone"
        );
    }

    #[tokio::test]
    async fn test_finish_hotfix_refuses_when_the_release_of_the_same_version_owns_the_tag() {
        // release/1.0.1 and hotfix/1.0.1 both resolve to the tag v1.0.1
        // because the two flows share gitflow.prefix.versiontag. Once the
        // release has claimed it, the hotfix finish must refuse rather than
        // ship the hotfix untagged.
        let repo = TestRepo::with_initial_commit();
        let master = repo.current_branch();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        repo.checkout_branch("develop");
        gitflow_start_release(repo.path_str(), "1.0.1".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("rel.txt", "r")]);
        gitflow_finish_release(repo.path_str(), "1.0.1".to_string(), None, Some(true))
            .await
            .unwrap();

        let tag_before = repo
            .repo()
            .find_reference("refs/tags/v1.0.1")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        let master_before = count_reachable_commits(&repo, &master);

        gitflow_start_hotfix(repo.path_str(), "1.0.1".to_string())
            .await
            .unwrap();
        let hotfix_commit = repo.create_commit("Hotfix change", &[("fix.txt", "f")]);

        let result =
            gitflow_finish_hotfix(repo.path_str(), "1.0.1".to_string(), None, Some(true)).await;

        match &result {
            Err(GitnadoError::OperationFailed(msg)) => {
                assert!(
                    msg.contains("v1.0.1") && msg.contains("hotfix/1.0.1"),
                    "error must name the colliding tag and branch: {}",
                    msg
                );
            }
            other => panic!("expected the hotfix finish to be refused, got {:?}", other),
        }

        let git_repo = repo.repo();
        assert!(
            git_repo
                .find_branch("hotfix/1.0.1", git2::BranchType::Local)
                .is_ok(),
            "hotfix branch must survive a refused finish"
        );
        assert_eq!(
            count_reachable_commits(&repo, &master),
            master_before,
            "master must not gain a merge commit"
        );

        let tag_now = git_repo
            .find_reference("refs/tags/v1.0.1")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(tag_now, tag_before, "the release's tag must be left alone");
        assert!(
            !git_repo
                .graph_descendant_of(tag_now, hotfix_commit)
                .unwrap(),
            "the hotfix must not end up shipped under a tag that does not contain it"
        );
    }

    #[tokio::test]
    async fn test_finish_release_adopts_its_own_tag_from_a_prior_pass() {
        // Same shape as test_finish_release_idempotent_after_develop_conflict:
        // the first pass tags master and then conflicts on develop. The tag
        // left behind IS this finish's own, so the re-run must still adopt it
        // rather than be refused by the collision guard.
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        repo.checkout_branch("develop");
        repo.create_commit("Develop base", &[("shared.txt", "develop base")]);
        gitflow_start_release(repo.path_str(), "3.0.0".to_string())
            .await
            .unwrap();
        repo.create_commit("Release change", &[("shared.txt", "release content")]);
        repo.checkout_branch("develop");
        repo.create_commit("Develop divergent", &[("shared.txt", "develop divergent")]);

        let result =
            gitflow_finish_release(repo.path_str(), "3.0.0".to_string(), None, Some(true)).await;
        assert!(matches!(result, Err(GitnadoError::MergeConflict)));

        let tag_before = repo
            .repo()
            .find_reference("refs/tags/v3.0.0")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();

        crate::commands::merge::resolve_conflict(
            repo.path_str(),
            "shared.txt".to_string(),
            "resolved".to_string(),
            None,
        )
        .await
        .unwrap();
        crate::commands::merge::commit_merge(repo.path_str(), None, None)
            .await
            .unwrap();

        let result =
            gitflow_finish_release(repo.path_str(), "3.0.0".to_string(), None, Some(true)).await;
        assert!(result.is_ok(), "re-run finish failed: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(
            git_repo
                .find_reference("refs/tags/v3.0.0")
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            tag_before,
            "the finish's own tag must be adopted unchanged"
        );
        assert!(git_repo
            .find_branch("release/3.0.0", git2::BranchType::Local)
            .is_err());
    }

    #[tokio::test]
    async fn test_finish_release_accepts_a_lightweight_tag_on_the_release_tip() {
        // The tag sits exactly ON the release tip (and is lightweight, so it
        // peels straight to a commit). That contains the release, so the
        // finish must proceed — the guard is about unrelated tags, not about
        // every pre-existing tag.
        let repo = TestRepo::with_initial_commit();
        init_gitflow(repo.path_str(), None, None, None, None, None, None, None)
            .await
            .unwrap();

        gitflow_start_release(repo.path_str(), "6.0.0".to_string())
            .await
            .unwrap();
        let release_tip = repo.create_commit("Release change", &[("release.txt", "r")]);
        repo.create_lightweight_tag("v6.0.0");

        let result =
            gitflow_finish_release(repo.path_str(), "6.0.0".to_string(), None, Some(true)).await;
        assert!(result.is_ok(), "finish was refused: {:?}", result.err());

        let git_repo = repo.repo();
        assert_eq!(
            git_repo
                .find_reference("refs/tags/v6.0.0")
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id(),
            release_tip,
            "the existing tag must be left where it was"
        );
        assert!(git_repo
            .find_branch("release/6.0.0", git2::BranchType::Local)
            .is_err());
    }
}
