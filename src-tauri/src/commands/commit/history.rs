//! Commit history, walk cache, search, and file history commands

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::models::{Commit, FileHistoryEntry};

/// Cached full revwalk (OIDs only) per repository for the all-branches graph
/// walk. Paging a raw revwalk with `skip` is O(skip) per request and re-walks
/// from the roots on every page; caching the walked order makes each page
/// O(page size). Entries are fingerprinted by every ref tip plus HEAD, so any
/// commit, fetch, branch move, or tag change invalidates them.
struct WalkCache {
    fingerprint: u64,
    oids: Vec<git2::Oid>,
    /// Recency marker for LRU eviction — refreshed on every hit
    last_used: std::time::Instant,
}

const WALK_CACHE_MAX_ENTRIES: usize = 8;

fn walk_cache() -> &'static Mutex<HashMap<String, WalkCache>> {
    static CACHE: OnceLock<Mutex<HashMap<String, WalkCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One consistent snapshot of the repository's ref state: the fingerprint
/// and the walk tips come from the SAME enumeration, so a ref changing
/// between "compute fingerprint" and "seed the walk" can't produce a cache
/// entry whose fingerprint matches a different ref state than its walk.
fn refs_snapshot(repo: &git2::Repository) -> (u64, Vec<git2::Oid>) {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut tips: Vec<git2::Oid> = Vec::new();

    // HEAD is a pseudo-ref that references() does NOT enumerate. It must be
    // a walk tip too: commits created on a detached HEAD are reachable from
    // nothing else and would otherwise vanish from the graph and the total.
    if let Ok(head) = repo.head() {
        head.name().unwrap_or("").hash(&mut hasher);
        if let Some(oid) = head.target() {
            oid.as_bytes().hash(&mut hasher);
            tips.push(oid);
        }
    }

    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            // Checkpoints are Gitnado's bookkeeping, not history the user made.
            if reference.name().is_ok_and(crate::utils::is_internal_ref) {
                continue;
            }
            reference.name().unwrap_or("").hash(&mut hasher);
            if let Some(oid) = reference.target() {
                oid.as_bytes().hash(&mut hasher);
                tips.push(oid);
            }
        }
    }
    (hasher.finish(), tips)
}

/// Get one page of the all-branches walk plus the true total commit count,
/// (re)building the cached walk when the repo's refs changed
fn cached_walk_page(
    repo: &git2::Repository,
    path: &str,
    skip: usize,
    limit: usize,
) -> Result<(Vec<git2::Oid>, usize)> {
    let (fingerprint, tips) = refs_snapshot(repo);

    // Fast path: serve a warm entry under a short lock
    {
        let mut cache = walk_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get_mut(path) {
            if entry.fingerprint == fingerprint {
                entry.last_used = std::time::Instant::now();
                let total = entry.oids.len();
                let page = entry.oids.iter().skip(skip).take(limit).copied().collect();
                return Ok((page, total));
            }
        }
    }

    // Cold or stale: walk WITHOUT holding the lock — a multi-second walk on
    // a large repository must not block history/total calls for every OTHER
    // open repository whose entry is warm. A concurrent duplicate walk of
    // the same repo is possible and acceptable (last writer wins with an
    // identical result).
    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;
    // Seed from the SAME snapshot the fingerprint was computed from
    for tip in &tips {
        let _ = revwalk.push(*tip);
    }
    let oids: Vec<git2::Oid> = revwalk.flatten().collect();
    let total = oids.len();
    let page = oids.iter().skip(skip).take(limit).copied().collect();

    let mut cache = walk_cache().lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= WALK_CACHE_MAX_ENTRIES && !cache.contains_key(path) {
        // Evict the least-recently-used entry (HashMap iteration order is
        // arbitrary, so recency is tracked explicitly)
        if let Some(lru_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&lru_key);
        }
    }
    cache.insert(
        path.to_string(),
        WalkCache {
            fingerprint,
            oids,
            last_used: std::time::Instant::now(),
        },
    );

    Ok((page, total))
}

/// Get commit history
#[command]
pub async fn get_commit_history(
    path: String,
    start_oid: Option<String>,
    limit: Option<usize>,
    skip: Option<usize>,
    all_branches: Option<bool>,
) -> Result<Vec<Commit>> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;

        let skip_count = skip.unwrap_or(0);
        let limit_count = limit.unwrap_or(100);

        if all_branches.unwrap_or(false) {
            // All-branches graph walk: served from the cached walk so deep
            // pagination doesn't re-walk from the roots on every page
            let (page, _total) = cached_walk_page(&repo, &path, skip_count, limit_count)?;
            let commits: Vec<Commit> = page
                .into_iter()
                .filter_map(|oid| repo.find_commit(oid).ok().map(|c| Commit::from_git2(&c)))
                .collect();
            return Ok(commits);
        }

        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;

        if let Some(ref oid_str) = start_oid {
            let start = git2::Oid::from_str(oid_str)?;
            revwalk.push(start)?;
        } else {
            let start = repo
                .head()?
                .target()
                .ok_or(GitnadoError::RepositoryNotOpen)?;
            revwalk.push(start)?;
        }

        let commits: Vec<Commit> = revwalk
            .skip(skip_count)
            .take(limit_count)
            .filter_map(|oid_result| {
                oid_result
                    .ok()
                    .and_then(|oid| repo.find_commit(oid).ok().map(|c| Commit::from_git2(&c)))
            })
            .collect();

        Ok(commits)
    })
    .await
}

/// Get the total number of commits reachable from any ref (the size of the
/// all-branches graph walk). Served from the same cached walk as
/// `get_commit_history`, so it is O(1) when the cache is warm.
#[command]
pub async fn get_commit_total(path: String) -> Result<usize> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let (_page, total) = cached_walk_page(&repo, &path, 0, 0)?;
        Ok(total)
    })
    .await
}

/// Get a single commit by OID
#[command]
pub async fn get_commit(path: String, oid: String) -> Result<Commit> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;
        let oid = git2::Oid::from_str(&oid)?;
        let commit = repo
            .find_commit(oid)
            .map_err(|_| GitnadoError::CommitNotFound(oid.to_string()))?;

        Ok(Commit::from_git2(&commit))
    })
    .await
}

/// Search commits with filters
#[command]
#[allow(clippy::too_many_arguments)]
pub async fn search_commits(
    path: String,
    query: Option<String>,
    author: Option<String>,
    date_from: Option<i64>,
    date_to: Option<i64>,
    file_path: Option<String>,
    branch: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Commit>> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;

        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;

        if let Some(ref branch_name) = branch {
            // Push only the specified branch/ref
            let reference = repo
                .resolve_reference_from_short_name(branch_name)
                .map_err(|_| crate::error::GitnadoError::BranchNotFound(branch_name.clone()))?;
            if let Some(oid) = reference.target() {
                revwalk.push(oid)?;
            }
        } else {
            // Push all branch heads for complete search
            for reference in repo.references()?.flatten() {
                if reference.name().is_ok_and(crate::utils::is_internal_ref) {
                    continue;
                }
                if let Some(oid) = reference.target() {
                    let _ = revwalk.push(oid);
                }
            }
        }

        let limit_count = limit.unwrap_or(500);
        let query_lower = query.as_ref().map(|q| q.to_lowercase());
        let author_lower = author.as_ref().map(|a| a.to_lowercase());

        let mut results = Vec::new();

        for oid_result in revwalk {
            if results.len() >= limit_count {
                break;
            }

            let oid = match oid_result {
                Ok(oid) => oid,
                Err(_) => continue,
            };

            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Check query filter (message, SHA)
            if let Some(ref q) = query_lower {
                let message = commit.message().ok().unwrap_or("").to_lowercase();
                let sha = commit.id().to_string().to_lowercase();
                if !message.contains(q) && !sha.starts_with(q) {
                    continue;
                }
            }

            // Check author filter
            if let Some(ref a) = author_lower {
                let author_name = commit.author().name().ok().unwrap_or("").to_lowercase();
                let author_email = commit.author().email().ok().unwrap_or("").to_lowercase();
                if !author_name.contains(a) && !author_email.contains(a) {
                    continue;
                }
            }

            // Check date range
            let commit_time = commit.time().seconds();
            if let Some(from) = date_from {
                if commit_time < from {
                    continue;
                }
            }
            if let Some(to) = date_to {
                if commit_time > to {
                    continue;
                }
            }

            // Check file path filter
            if let Some(ref fp) = file_path {
                let tree = match commit.tree() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

                let mut diff_opts = git2::DiffOptions::new();
                diff_opts.pathspec(fp);

                let diff = match repo.diff_tree_to_tree(
                    parent_tree.as_ref(),
                    Some(&tree),
                    Some(&mut diff_opts),
                ) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                if diff.deltas().count() == 0 {
                    continue;
                }
            }

            results.push(Commit::from_git2(&commit));
        }

        Ok(results)
    })
    .await
}

/// Get all commits that modified a specific file, each paired with the path
/// the file had in that commit.
///
/// The path is per-entry, not per-request: following a rename backwards means
/// older entries refer to the file under its old name, and a caller that
/// diffed or blamed them under the file's current name would get
/// "File not found in commit" for a commit this very list says touched it.
#[command]
pub async fn get_file_history(
    path: String,
    file_path: String,
    limit: Option<usize>,
    follow_renames: Option<bool>,
) -> Result<Vec<FileHistoryEntry>> {
    crate::utils::blocking_git(move || {
        let repo = git2::Repository::open(Path::new(&path))?;

        let mut revwalk = repo.revwalk()?;
        // TOPOLOGICAL as well as TIME. Following a rename rewrites current_path
        // when the walk REACHES the renaming commit, so every commit before the
        // rename must be visited after it. Sorting by time alone does not
        // guarantee that — commits made within the same second (a scripted commit,
        // a rebase, an import) tie, and a tie can put the renaming commit last, by
        // which point the pre-rename history has already been tested against the
        // new name and discarded. Topological order makes children precede parents
        // no matter what the timestamps say.
        revwalk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;

        // Start from HEAD
        let head = repo
            .head()?
            .target()
            .ok_or(GitnadoError::RepositoryNotOpen)?;
        revwalk.push(head)?;

        let limit_count = limit.unwrap_or(500);
        let should_follow = follow_renames.unwrap_or(true);
        let mut entries: Vec<FileHistoryEntry> = Vec::new();
        let mut current_path = file_path.clone();

        for oid_result in revwalk {
            if entries.len() >= limit_count {
                break;
            }

            let oid = match oid_result {
                Ok(oid) => oid,
                Err(_) => continue,
            };

            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let tree = match commit.tree() {
                Ok(t) => t,
                Err(_) => continue,
            };

            // Check if file exists in this commit
            let file_in_commit = tree.get_path(std::path::Path::new(&current_path)).is_ok();

            if !file_in_commit && !should_follow {
                continue;
            }

            // Get parent tree for diff
            let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

            // Create diff options
            let mut diff_opts = git2::DiffOptions::new();
            diff_opts.pathspec(&current_path);

            let diff = match repo.diff_tree_to_tree(
                parent_tree.as_ref(),
                Some(&tree),
                Some(&mut diff_opts),
            ) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Check if file was modified in this commit
            let mut file_modified;
            let mut renamed_from: Option<String> = None;

            if should_follow {
                // The pathspec above filters deltas at diff-GENERATION time, so at
                // the commit that renamed old -> current this diff holds only the
                // Added(current) half. find_similar had no Deleted(old) to pair it
                // with, delta.status() was therefore never Renamed, renamed_from
                // was never set, and the walk stopped dead at the rename — the one
                // thing follow_renames exists to get past.
                //
                // Detect the modification from the cheap filtered diff, then pay
                // for an UNFILTERED diff only where a rename could actually be
                // hiding: the commit that introduces the path. That is once per
                // rename, not once per commit.
                let introduced_here = diff.deltas().any(|d| {
                    d.status() == git2::Delta::Added || d.status() == git2::Delta::Renamed
                });
                file_modified = diff.deltas().count() > 0;

                // `if let Ok`, not an early `continue`: the filtered diff has
                // already established the file was touched by this commit. Skipping
                // the iteration on a failed diff dropped the commit from the
                // history entirely — losing a real entry to report a rename we
                // could not look for. Without the unfiltered diff we simply do not
                // detect a rename here, and the walk stops following the path,
                // which is the old behaviour rather than a missing commit.
                if introduced_here {
                    if let Ok(mut unfiltered) =
                        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
                    {
                        let mut find_opts = git2::DiffFindOptions::new();
                        find_opts.renames(true);
                        find_opts.copies(false);
                        let _ = unfiltered.find_similar(Some(&mut find_opts));

                        for delta in unfiltered.deltas() {
                            if delta.status() != git2::Delta::Renamed {
                                continue;
                            }
                            let is_ours = delta
                                .new_file()
                                .path()
                                .is_some_and(|p| p.to_string_lossy() == current_path);
                            if is_ours {
                                file_modified = true;
                                if let Some(old_file) = delta.old_file().path() {
                                    renamed_from = Some(old_file.to_string_lossy().to_string());
                                }
                                break;
                            }
                        }
                    }
                }
            } else {
                file_modified = diff.deltas().count() > 0;
            }

            if file_modified {
                // Recorded BEFORE the rename is followed: at the renaming commit
                // the file already exists in that commit's tree under the NEW
                // name, so the new name is the right path there. Only commits
                // older than the rename get the old name. This is also the
                // historical path a caller restoring the file to this commit must
                // use — the file's CURRENT name is not in that commit's tree at
                // all before the rename.
                entries.push(FileHistoryEntry {
                    commit: Commit::from_git2(&commit),
                    path_at_commit: current_path.clone(),
                });

                // Follow the rename backwards
                if let Some(old_path) = renamed_from {
                    current_path = old_path;
                }
            }
        }

        Ok(entries)
    })
    .await
}
