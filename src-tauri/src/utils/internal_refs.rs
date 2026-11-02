//! Refs Gitnado keeps for itself.
//!
//! Agent checkpoints (and future bookkeeping) live under `refs/gitnado/` so
//! git's garbage collector keeps their objects alive. They are not branches,
//! tags or anything the user created, so every place that enumerates "all
//! refs" for display or history walking must skip them — otherwise each
//! checkpoint would appear as a dangling commit in the graph and as a ref
//! label in the sidebar.

/// Namespace for Gitnado's internal refs.
pub const INTERNAL_REF_PREFIX: &str = "refs/gitnado/";
/// Gitnado's notes refs. `git notes` refuses to write outside refs/notes/,
/// so these cannot live under [`INTERNAL_REF_PREFIX`].
pub const INTERNAL_NOTES_PREFIX: &str = "refs/notes/gitnado/";

/// True for refs Gitnado owns and never shows the user.
pub fn is_internal_ref(name: &str) -> bool {
    name.starts_with(INTERNAL_REF_PREFIX) || name.starts_with(INTERNAL_NOTES_PREFIX)
}

/// Push every user-visible ref onto `revwalk` — the replacement for
/// `revwalk.push_glob("refs/*")` that leaves internal refs out. Refs that do
/// not peel to a commit (e.g. a tag of a tree) are skipped, as `push_glob`
/// does.
pub fn push_visible_refs(
    repo: &git2::Repository,
    revwalk: &mut git2::Revwalk<'_>,
) -> Result<(), git2::Error> {
    for reference in repo.references()?.flatten() {
        if reference.name().is_ok_and(is_internal_ref) {
            continue;
        }
        if let Ok(commit) = reference.peel_to_commit() {
            revwalk.push(commit.id())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[test]
    fn recognises_internal_refs() {
        assert!(is_internal_ref("refs/gitnado/checkpoints/1"));
        assert!(is_internal_ref("refs/notes/gitnado/agents"));
        assert!(!is_internal_ref("refs/notes/commits"));
        assert!(!is_internal_ref("refs/heads/gitnado/feature"));
        assert!(!is_internal_ref("refs/heads/main"));
    }

    #[test]
    fn push_visible_refs_skips_internal_refs() {
        let t = TestRepo::with_initial_commit();
        let repo = t.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let sig = repo.signature().unwrap();
        let hidden = repo
            .commit(None, &sig, &sig, "hidden", &tree, &[&head])
            .unwrap();
        repo.reference("refs/gitnado/checkpoints/x", hidden, true, "test")
            .unwrap();

        let mut walk = repo.revwalk().unwrap();
        push_visible_refs(&repo, &mut walk).unwrap();
        let oids: Vec<_> = walk.flatten().collect();
        assert!(oids.contains(&head.id()));
        assert!(
            !oids.contains(&hidden),
            "checkpoint commit leaked into the walk"
        );
    }
}
