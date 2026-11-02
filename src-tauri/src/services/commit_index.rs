//! Background commit index for fast searching

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::Result;

/// An indexed commit for fast search
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub message_lower: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: i64,
    pub parent_count: usize,
}

/// In-memory commit index for a repository
/// Ceiling on how many commits an index holds, shared by the full build and the
/// incremental refresh so one cannot outgrow the other.
const MAX_INDEXED_COMMITS: usize = 100_000;

/// The index is kept newest-first by author date.
///
/// This is not cosmetic: `search` scans in stored order and returns the first
/// `limit` matches, so the ORDER IS THE RANKING. Anything that disturbs it
/// changes which results a capped search returns.
fn sort_newest_first(commits: &mut [IndexedCommit]) {
    commits.sort_by_key(|c| std::cmp::Reverse(c.author_date));
}

/// Rebuild the oid -> position map. Positions are only meaningful against the
/// vector they were built from, so this runs after anything that reorders it.
fn index_by_oid(commits: &[IndexedCommit]) -> HashMap<String, usize> {
    commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.oid.clone(), i))
        .collect()
}

pub struct CommitIndex {
    commits: Vec<IndexedCommit>,
    oid_map: HashMap<String, usize>,
    repo_path: String,
}

impl CommitIndex {
    /// Build an index from a repository path
    pub fn build(repo_path: &str) -> Result<Self> {
        let repo = git2::Repository::open(repo_path)?;
        let mut revwalk = repo.revwalk()?;

        // Walk all refs
        crate::utils::push_visible_refs(&repo, &mut revwalk)?;
        revwalk.set_sorting(git2::Sort::TIME)?;

        let mut commits = Vec::new();
        let mut oid_map = HashMap::new();
        let max_commits = MAX_INDEXED_COMMITS;

        for oid_result in revwalk {
            if commits.len() >= max_commits {
                break;
            }

            let oid = match oid_result {
                Ok(o) => o,
                Err(_) => continue,
            };

            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let oid_str = oid.to_string();
            let short_oid = oid_str[..7.min(oid_str.len())].to_string();
            let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
            let message = commit.message().ok().unwrap_or("").to_lowercase();
            let author = commit.author();

            let indexed = IndexedCommit {
                oid: oid_str.clone(),
                short_oid,
                summary,
                message_lower: message,
                author_name: author.name().ok().unwrap_or("").to_string(),
                author_email: author.email().ok().unwrap_or("").to_string(),
                author_date: author.when().seconds(),
                parent_count: commit.parent_count(),
            };

            oid_map.insert(oid_str, commits.len());
            commits.push(indexed);
        }

        // State the ordering rather than inheriting it from the walk, so the
        // incremental path has something definite to preserve.
        sort_newest_first(&mut commits);
        let oid_map = index_by_oid(&commits);

        Ok(Self {
            commits,
            oid_map,
            repo_path: repo_path.to_string(),
        })
    }

    /// Search the index with filters
    pub fn search(
        &self,
        query: Option<&str>,
        author: Option<&str>,
        date_from: Option<i64>,
        date_to: Option<i64>,
        limit: Option<usize>,
    ) -> Vec<&IndexedCommit> {
        let query_lower = query.map(|q| q.to_lowercase());
        let author_lower = author.map(|a| a.to_lowercase());
        let limit = limit.unwrap_or(500);

        self.commits
            .iter()
            .filter(|c| {
                // Query filter: search in message and short_oid
                if let Some(ref q) = query_lower {
                    if !c.message_lower.contains(q.as_str())
                        && !c.short_oid.starts_with(q.as_str())
                        && !c.oid.starts_with(q.as_str())
                    {
                        return false;
                    }
                }

                // Author filter
                if let Some(ref a) = author_lower {
                    if !c.author_name.to_lowercase().contains(a.as_str())
                        && !c.author_email.to_lowercase().contains(a.as_str())
                    {
                        return false;
                    }
                }

                // Date filters
                if let Some(from) = date_from {
                    if c.author_date < from {
                        return false;
                    }
                }
                if let Some(to) = date_to {
                    if c.author_date > to {
                        return false;
                    }
                }

                true
            })
            .take(limit)
            .collect()
    }

    /// Incrementally update the index with new commits
    pub fn update_incremental(&mut self, repo_path: &str) -> Result<usize> {
        // An incremental walk stops at the first already-known commit. If this
        // index was built from a DIFFERENT repository, no commit ever matches
        // and the entire other history would be prepended into this index.
        // Rebuild from scratch instead.
        if self.repo_path != repo_path {
            let rebuilt = Self::build(repo_path)?;
            let count = rebuilt.len();
            *self = rebuilt;
            return Ok(count);
        }
        let repo = git2::Repository::open(repo_path)?;
        let mut revwalk = repo.revwalk()?;

        crate::utils::push_visible_refs(&repo, &mut revwalk)?;
        revwalk.set_sorting(git2::Sort::TIME)?;

        let mut new_commits = Vec::new();

        for oid_result in revwalk {
            let oid = match oid_result {
                Ok(o) => o,
                Err(_) => continue,
            };

            let oid_str = oid.to_string();

            // SKIP a known commit — do not stop.
            //
            // The walk is TIME-sorted across every ref, so the newest commit
            // anywhere is visited first. That is almost always a local commit
            // this index already has, and breaking there ended the walk
            // immediately. Commits that arrived on OTHER refs with older
            // timestamps — the normal case after a fetch, where upstream work
            // predates your latest local commit — were never indexed at all,
            // so search silently could not find them until a full rebuild.
            //
            // Skipping instead of stopping means the walk enumerates the whole
            // history each refresh. Known commits cost only a hash lookup, and
            // correctness here is worth more than the walk: an index that
            // quietly lacks the commits you just fetched is worse than a slower
            // refresh.
            if self.oid_map.contains_key(&oid_str) {
                continue;
            }

            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let short_oid = oid_str[..7.min(oid_str.len())].to_string();
            let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
            let message = commit.message().ok().unwrap_or("").to_lowercase();
            let author = commit.author();

            new_commits.push(IndexedCommit {
                oid: oid_str,
                short_oid,
                summary,
                message_lower: message,
                author_name: author.name().ok().unwrap_or("").to_string(),
                author_email: author.email().ok().unwrap_or("").to_string(),
                author_date: author.when().seconds(),
                parent_count: commit.parent_count(),
            });
        }

        let count = new_commits.len();

        if count > 0 {
            // MERGE and re-sort — do not prepend.
            //
            // Prepending assumed everything new was newer than everything
            // known, which was true only while the walk stopped at the first
            // known commit. Now that it continues, the new commits are mostly
            // BACKFILL: fetched work older than the local tip. Putting those at
            // the front broke the newest-first order that search() relies on —
            // it returns the first `limit` matches it finds, so the order is
            // the ranking, and a fetch could bury recent commits behind old
            // ones.
            self.commits.append(&mut new_commits);
            sort_newest_first(&mut self.commits);

            // Same ceiling build() applies. Without it an index built from a
            // shallow or partial history could grow past the cap now that the
            // walk enumerates everything; the oldest go first, matching how
            // build() truncates.
            self.commits.truncate(MAX_INDEXED_COMMITS);
            self.oid_map = index_by_oid(&self.commits);
        }

        self.repo_path = repo_path.to_string();
        Ok(count)
    }

    /// Number of indexed commits
    pub fn len(&self) -> usize {
        self.commits.len()
    }

    /// Whether the index is empty
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
    }
}

/// Commit index store: the per-path indexes plus a per-path generation
/// counter. The generation is bumped whenever a path is dropped, so a build
/// or refresh that started before a drop can detect (on completion) that its
/// result is stale and must not overwrite a fresher index inserted after the
/// drop (e.g. by a rebuild for a reopened tab).
#[derive(Default)]
pub struct CommitIndexStore {
    indexes: HashMap<String, CommitIndex>,
    generations: HashMap<String, u64>,
}

impl CommitIndexStore {
    /// Current generation for a path (0 if never dropped).
    pub fn generation(&self, path: &str) -> u64 {
        self.generations.get(path).copied().unwrap_or(0)
    }

    /// Insert an index for a path only if `expected_generation` still matches
    /// the current generation — i.e. the path was not dropped while this
    /// index was being built. Returns true if the index was stored.
    pub fn insert_if_current(
        &mut self,
        path: String,
        index: CommitIndex,
        expected_generation: u64,
    ) -> bool {
        if self.generation(&path) != expected_generation {
            return false;
        }
        self.indexes.insert(path, index);
        true
    }

    /// Take a path's index out for updating (used by incremental refresh).
    pub fn take(&mut self, path: &str) -> Option<CommitIndex> {
        self.indexes.remove(path)
    }

    /// Look up a path's index (for searching).
    pub fn get(&self, path: &str) -> Option<&CommitIndex> {
        self.indexes.get(path)
    }

    /// Drop a path's index and bump its generation so any in-flight build or
    /// refresh for that path discards its result on completion.
    pub fn drop_index(&mut self, path: &str) {
        self.indexes.remove(path);
        *self.generations.entry(path.to_string()).or_insert(0) += 1;
    }
}

/// Shared commit index state, keyed by repository path so that every open
/// repository keeps its own independent index.
pub type SharedCommitIndex = Arc<RwLock<CommitIndexStore>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn test_build_index() {
        let repo = TestRepo::with_initial_commit();
        let index = CommitIndex::build(&repo.path_str()).unwrap();
        assert!(!index.is_empty());
    }

    /// A fetched commit older than the newest local one must still be indexed.
    ///
    /// The walk is TIME-sorted across every ref, so the newest commit anywhere
    /// is visited first — almost always a local commit already in the index.
    /// Breaking there ended the walk immediately, and commits that arrived on
    /// other refs with older timestamps (the normal case after a fetch, where
    /// upstream work predates your latest local commit) were never indexed.
    /// Search then silently could not find them until a full rebuild.
    #[test]
    fn test_update_incremental_indexes_older_commits_on_other_refs() {
        let test_repo = TestRepo::with_initial_commit();

        // A local commit with a NEW timestamp, indexed first.
        let local_tip = commit_at(&test_repo, "Local latest", "local.txt", 2_000_000_000);
        let mut index = CommitIndex::build(&test_repo.path_str()).unwrap();
        assert!(index.oid_map.contains_key(&local_tip.to_string()));

        // A commit that arrives on another ref with an OLDER timestamp, the way
        // a fetch delivers upstream work committed before your latest local one.
        let fetched = commit_at(&test_repo, "Fetched upstream work", "up.txt", 1_000_000_000);
        {
            let repo = test_repo.repo();
            repo.reference("refs/remotes/origin/main", fetched, true, "test")
                .unwrap();
        }

        let added = index.update_incremental(&test_repo.path_str()).unwrap();

        assert!(
            index.oid_map.contains_key(&fetched.to_string()),
            "a fetched commit older than the local tip must be indexed, \
             otherwise search cannot find what was just fetched"
        );
        assert!(added >= 1, "the refresh must report the commit it added");
    }

    /// Backfilled commits must not jump the queue.
    ///
    /// search() scans in stored order and returns the first `limit` matches, so
    /// the order IS the ranking. The old code prepended everything new, which
    /// was only right while the walk stopped at the first known commit. Once it
    /// continues, the new commits are mostly fetched work OLDER than the local
    /// tip — putting those at the front buried recent commits behind them, so a
    /// capped search returned the wrong set after every fetch.
    #[test]
    fn test_update_incremental_keeps_the_index_newest_first() {
        let test_repo = TestRepo::with_initial_commit();

        let newest = commit_at(&test_repo, "Local latest", "local.txt", 2_000_000_000);
        let mut index = CommitIndex::build(&test_repo.path_str()).unwrap();

        // Arrives on another ref, older than the local tip — what a fetch brings.
        let older = commit_at(&test_repo, "Fetched older work", "up.txt", 1_500_000_000);
        {
            let repo = test_repo.repo();
            repo.reference("refs/remotes/origin/main", older, true, "test")
                .unwrap();
        }

        index.update_incremental(&test_repo.path_str()).unwrap();

        let positions: Vec<usize> = [newest, older]
            .iter()
            .map(|oid| {
                *index
                    .oid_map
                    .get(&oid.to_string())
                    .expect("both commits must be indexed")
            })
            .collect();
        assert!(
            positions[0] < positions[1],
            "the newer local commit must still rank ahead of the older fetched \
             one — search returns the first matches it finds"
        );

        // The stored order itself must be non-increasing by date.
        let dates: Vec<i64> = index.commits.iter().map(|c| c.author_date).collect();
        let mut sorted = dates.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(dates, sorted, "the index must stay newest-first");

        // And the position map must agree with the vector it describes.
        for (i, commit) in index.commits.iter().enumerate() {
            assert_eq!(
                index.oid_map.get(&commit.oid),
                Some(&i),
                "oid_map must point at the right position after a re-sort"
            );
        }
    }

    /// A refresh with nothing new must add nothing.
    #[test]
    fn test_update_incremental_adds_nothing_when_unchanged() {
        let test_repo = TestRepo::with_initial_commit();
        test_repo.create_commit("Second", &[("a.txt", "a")]);

        let mut index = CommitIndex::build(&test_repo.path_str()).unwrap();
        let before = index.len();

        assert_eq!(
            index.update_incremental(&test_repo.path_str()).unwrap(),
            0,
            "skipping known commits must not re-add them"
        );
        assert_eq!(index.len(), before, "the index must not grow or duplicate");
    }

    /// Commit on the current branch with an explicit timestamp.
    fn commit_at(repo: &TestRepo, message: &str, file: &str, seconds: i64) -> git2::Oid {
        let git_repo = repo.repo();
        std::fs::write(repo.path.join(file), "content").unwrap();
        let mut index = git_repo.index().unwrap();
        index.add_path(std::path::Path::new(file)).unwrap();
        index.write().unwrap();
        let tree = git_repo.find_tree(index.write_tree().unwrap()).unwrap();

        let when = git2::Time::new(seconds, 0);
        let sig = git2::Signature::new("Test User", "test@example.com", &when).unwrap();
        let parent = git_repo.head().unwrap().peel_to_commit().unwrap();

        git_repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap()
    }

    #[test]
    fn test_store_insert_if_current_respects_generation() {
        let repo = TestRepo::with_initial_commit();
        let mut store = CommitIndexStore::default();

        // A build that captured generation 0 and finished normally is stored
        let idx0 = CommitIndex::build(&repo.path_str()).unwrap();
        assert!(store.insert_if_current(repo.path_str(), idx0, 0));
        assert!(store.get(&repo.path_str()).is_some());

        // Tab closed: drop bumps the generation to 1
        store.drop_index(&repo.path_str());
        assert!(store.get(&repo.path_str()).is_none());
        assert_eq!(store.generation(&repo.path_str()), 1);

        // Reopen build (started at generation 1) inserts fine
        let reopen = CommitIndex::build(&repo.path_str()).unwrap();
        assert!(store.insert_if_current(repo.path_str(), reopen, 1));
        assert!(store.get(&repo.path_str()).is_some());

        // A STALE pre-drop build (generation 0) finishing late must NOT
        // overwrite the reopened tab's fresh index
        let stale = CommitIndex::build(&repo.path_str()).unwrap();
        assert!(!store.insert_if_current(repo.path_str(), stale, 0));
        assert!(
            store.get(&repo.path_str()).is_some(),
            "the reopen index must survive the stale build's late completion"
        );
    }

    #[test]
    fn test_search_by_message() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add feature X", &[("feature.txt", "content")]);

        let index = CommitIndex::build(&repo.path_str()).unwrap();
        let results = index.search(Some("feature X"), None, None, None, None);
        assert!(!results.is_empty());
        assert!(results[0].summary.contains("feature X"));
    }

    #[test]
    fn test_search_by_author() {
        let repo = TestRepo::with_initial_commit();
        let index = CommitIndex::build(&repo.path_str()).unwrap();
        let results = index.search(None, Some("Test User"), None, None, None);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_search_no_match() {
        let repo = TestRepo::with_initial_commit();
        let index = CommitIndex::build(&repo.path_str()).unwrap();
        let results = index.search(Some("nonexistent_query_12345"), None, None, None, None);
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_with_limit() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second", &[("a.txt", "a")]);
        repo.create_commit("Third", &[("b.txt", "b")]);

        let index = CommitIndex::build(&repo.path_str()).unwrap();
        let results = index.search(None, None, None, None, Some(1));
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_incremental_update() {
        let repo = TestRepo::with_initial_commit();
        let mut index = CommitIndex::build(&repo.path_str()).unwrap();
        let initial_count = index.len();

        // Add a new commit
        repo.create_commit("New commit", &[("new.txt", "new")]);

        let new_count = index.update_incremental(&repo.path_str()).unwrap();
        assert_eq!(new_count, 1);
        assert_eq!(index.len(), initial_count + 1);
    }

    #[test]
    fn test_incremental_update_no_new() {
        let repo = TestRepo::with_initial_commit();
        let mut index = CommitIndex::build(&repo.path_str()).unwrap();

        let new_count = index.update_incremental(&repo.path_str()).unwrap();
        assert_eq!(new_count, 0);
    }

    #[test]
    fn test_incremental_update_different_repo_rebuilds_instead_of_merging() {
        let repo_a = TestRepo::with_initial_commit();
        repo_a.create_commit("Repo A feature", &[("a.txt", "a")]);
        let repo_b = TestRepo::with_initial_commit();
        repo_b.create_commit("Repo B feature", &[("b.txt", "b")]);

        let mut index = CommitIndex::build(&repo_a.path_str()).unwrap();
        assert!(!index
            .search(Some("Repo A feature"), None, None, None, None)
            .is_empty());

        // Refreshing against a DIFFERENT repo must rebuild for that repo,
        // never prepend its whole history into the existing index.
        index.update_incremental(&repo_b.path_str()).unwrap();

        assert!(!index
            .search(Some("Repo B feature"), None, None, None, None)
            .is_empty());
        assert!(
            index
                .search(Some("Repo A feature"), None, None, None, None)
                .is_empty(),
            "index must not contain commits from a different repository"
        );
    }

    #[test]
    fn test_search_by_oid_prefix() {
        let repo = TestRepo::with_initial_commit();
        let index = CommitIndex::build(&repo.path_str()).unwrap();

        // Get the first commit's short oid
        let short_oid = &index.commits[0].short_oid;
        let results = index.search(Some(short_oid), None, None, None, None);
        assert!(!results.is_empty());
    }
}
