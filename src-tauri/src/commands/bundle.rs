//! Bundle command handlers
//! Create and manage Git bundles for offline object transfer

use std::path::Path;
use std::process::{Command, Stdio};
use tauri::command;

use crate::error::{GitnadoError, Result};
use crate::utils::reject_flag_like;

/// Reference in a bundle
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BundleRef {
    pub name: String,
    pub oid: String,
}

/// Result of creating a bundle
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCreateResult {
    pub bundle_path: String,
    pub refs_count: u32,
    pub objects_count: u32,
}

/// Result of verifying a bundle
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleVerifyResult {
    pub is_valid: bool,
    pub refs: Vec<BundleRef>,
    pub requires: Vec<String>,
    pub message: Option<String>,
}

/// Create a bundle file from repository refs
#[command]
pub async fn bundle_create(
    path: String,
    bundle_path: String,
    refs: Vec<String>,
    all: bool,
) -> Result<BundleCreateResult> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    reject_flag_like(&bundle_path, "Bundle path")?;
    for ref_spec in &refs {
        reject_flag_like(ref_spec, "Refspec")?;
    }

    // `git bundle create [<bundle-create options>] <file> <rev-list args>`.
    // We place `--` directly before `<file>` to defend the file path from
    // being parsed as a bundle-create option. `--all` and explicit refs are
    // rev-list arguments and must come AFTER `<file>`.
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path).arg("bundle").arg("create");

    if !all && refs.is_empty() {
        return Err(GitnadoError::OperationFailed(
            "Either refs must be provided or 'all' must be true".to_string(),
        ));
    }

    cmd.arg("--").arg(&bundle_path);

    if all {
        cmd.arg("--all");
    } else {
        for ref_spec in &refs {
            cmd.arg(ref_spec);
        }
    }

    let output = cmd.output().map_err(|e| {
        GitnadoError::OperationFailed(format!("Failed to execute git bundle create: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git bundle create failed: {}",
            stderr
        )));
    }

    // Parse the output to get counts
    // The output typically shows the number of objects written
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    let mut objects_count = 0u32;
    // Parse lines like "Counting objects: 123, done."
    for line in combined.lines() {
        if line.contains("Counting objects:") || line.contains("Total") {
            if let Some(num_str) = line.split(':').nth(1) {
                if let Some(num) = num_str.trim().split(|c: char| !c.is_ascii_digit()).next() {
                    if let Ok(n) = num.parse::<u32>() {
                        objects_count = n;
                    }
                }
            }
        }
    }

    // Get refs count by listing the bundle
    let refs_count = if all {
        // Get all refs from the repo
        let list_output = Command::new("git")
            .current_dir(repo_path)
            .arg("show-ref")
            .output()
            .ok();

        list_output
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .count()
                    .try_into()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    } else {
        refs.len() as u32
    };

    Ok(BundleCreateResult {
        bundle_path,
        refs_count,
        objects_count,
    })
}

/// Verify a bundle file against a repository
#[command]
pub async fn bundle_verify(path: String, bundle_path: String) -> Result<BundleVerifyResult> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    reject_flag_like(&bundle_path, "Bundle path")?;
    let bundle_file = Path::new(&bundle_path);
    if !bundle_file.exists() {
        return Err(GitnadoError::OperationFailed(format!(
            "Bundle file not found: {}",
            bundle_path
        )));
    }

    // Run git bundle verify. `--` keeps a malicious bundle_path from being
    // parsed as a flag, mirroring bundle_list_heads / bundle_unbundle.
    let output = Command::new("git")
        .current_dir(repo_path)
        .arg("bundle")
        .arg("verify")
        .arg("--")
        .arg(&bundle_path)
        .output()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to execute git bundle verify: {}", e))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    let is_valid = output.status.success();

    // Parse refs and prerequisites from output. `git bundle verify` groups
    // its output into sections: "The bundle contains …" lists the refs the
    // bundle provides (each line is "<oid> <refname>"), while "The bundle
    // requires …" lists prerequisite commits the target must already have
    // (each line is a bare "<oid>" with no refname). We must track the current
    // section because a bare prerequisite oid is otherwise indistinguishable
    // from a ref line, and older parsers that keyed off a "-" prefix never
    // matched modern git output — leaving `requires` permanently empty.
    let mut refs = Vec::new();
    let mut requires = Vec::new();

    #[derive(PartialEq)]
    enum Section {
        None,
        Contains,
        Requires,
    }
    let mut section = Section::None;

    for line in combined.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_lowercase();
        if lower.contains("the bundle requires") {
            section = Section::Requires;
            continue;
        }
        if lower.contains("the bundle contains") {
            section = Section::Contains;
            continue;
        }

        let first = line.split_whitespace().next().unwrap_or("");
        let is_oid = (first.len() == 40 || first.len() == 64)
            && first.chars().all(|c| c.is_ascii_hexdigit());
        if !is_oid {
            continue;
        }

        if section == Section::Requires {
            // Prerequisite lines carry only the bare oid.
            requires.push(first.to_string());
        } else {
            // A ref line: "<oid> <refname>". Skip the bundle's HEAD pseudo-ref
            // so it isn't reported as a real branch.
            let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
            if parts.len() == 2 {
                let name = parts[1].trim().to_string();
                if name != "HEAD" {
                    refs.push(BundleRef {
                        oid: parts[0].to_string(),
                        name,
                    });
                }
            }
        }
    }

    let message = if !is_valid {
        Some(stderr.to_string())
    } else {
        None
    };

    Ok(BundleVerifyResult {
        is_valid,
        refs,
        requires,
        message,
    })
}

/// List the heads (refs) contained in a bundle file
#[command]
pub async fn bundle_list_heads(bundle_path: String) -> Result<Vec<BundleRef>> {
    reject_flag_like(&bundle_path, "Bundle path")?;
    let bundle_file = Path::new(&bundle_path);
    if !bundle_file.exists() {
        return Err(GitnadoError::OperationFailed(format!(
            "Bundle file not found: {}",
            bundle_path
        )));
    }

    // Run git bundle list-heads
    let output = Command::new("git")
        .arg("bundle")
        .arg("list-heads")
        .arg("--")
        .arg(&bundle_path)
        .output()
        .map_err(|e| {
            GitnadoError::OperationFailed(format!("Failed to execute git bundle list-heads: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "git bundle list-heads failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut refs = Vec::new();

    // Parse output: each line is "<oid> <refname>"
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        if parts.len() == 2 {
            refs.push(BundleRef {
                oid: parts[0].to_string(),
                name: parts[1].trim().to_string(),
            });
        }
    }

    Ok(refs)
}

/// Extract (unbundle) a bundle file into a repository
#[command]
pub async fn bundle_unbundle(path: String, bundle_path: String) -> Result<Vec<BundleRef>> {
    let repo_path = Path::new(&path);
    if !repo_path.exists() {
        return Err(GitnadoError::RepositoryNotFound(path));
    }

    reject_flag_like(&bundle_path, "Bundle path")?;
    let bundle_file = Path::new(&bundle_path);
    if !bundle_file.exists() {
        return Err(GitnadoError::OperationFailed(format!(
            "Bundle file not found: {}",
            bundle_path
        )));
    }

    // First verify the bundle is valid for this repository
    let verify_output = Command::new("git")
        .current_dir(repo_path)
        .arg("bundle")
        .arg("verify")
        .arg("--")
        .arg(&bundle_path)
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to verify bundle: {}", e)))?;

    if !verify_output.status.success() {
        let stderr = String::from_utf8_lossy(&verify_output.stderr);
        return Err(GitnadoError::OperationFailed(format!(
            "Bundle verification failed: {}. The repository may be missing prerequisite commits.",
            stderr
        )));
    }

    // Use git fetch to unbundle - this fetches all refs from the bundle.
    // `--` terminates options so a malicious bundle_path cannot be parsed
    // as a flag like `--upload-pack=`.
    let output = Command::new("git")
        .current_dir(repo_path)
        .arg("fetch")
        .arg("--")
        .arg(&bundle_path)
        .arg("*:*") // Fetch all refs
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output()
        .map_err(|e| GitnadoError::OperationFailed(format!("Failed to unbundle: {}", e)))?;

    // git fetch from bundle may fail with "*:*" on some versions, try alternative approach
    if !output.status.success() {
        // Get list of refs in the bundle first
        let list_output = Command::new("git")
            .arg("bundle")
            .arg("list-heads")
            .arg("--")
            .arg(&bundle_path)
            .output()
            .map_err(|e| {
                GitnadoError::OperationFailed(format!("Failed to list bundle heads: {}", e))
            })?;

        if !list_output.status.success() {
            let stderr = String::from_utf8_lossy(&list_output.stderr);
            return Err(GitnadoError::OperationFailed(format!(
                "Failed to list bundle heads: {}",
                stderr
            )));
        }

        let stdout = String::from_utf8_lossy(&list_output.stdout);
        let mut fetched_refs = Vec::new();
        let mut refused_refs: Vec<(String, String)> = Vec::new();

        // Fetch each ref individually
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
            if parts.len() == 2 {
                let oid = parts[0];
                let refname = parts[1].trim();

                // Skip the bundle's HEAD pseudo-ref and anything that is not a
                // real ref. Fetching "HEAD:HEAD" would create a bogus local
                // branch refs/heads/HEAD and make every later "HEAD" lookup
                // ambiguous. Flag-like names originate from the untrusted
                // bundle and are rejected for the same reason.
                if refname == "HEAD" || !refname.starts_with("refs/") || refname.starts_with('-') {
                    continue;
                }
                let fetch_result = Command::new("git")
                    .current_dir(repo_path)
                    .arg("fetch")
                    .arg("--")
                    .arg(&bundle_path)
                    .arg(format!("{}:{}", refname, refname))
                    .output();

                match fetch_result {
                    Ok(result) if result.status.success() => {
                        fetched_refs.push(BundleRef {
                            oid: oid.to_string(),
                            name: refname.to_string(),
                        });
                    }
                    Ok(result) => {
                        // git refuses to update a checked-out branch and rejects
                        // non-fast-forward updates. Record why so the user is
                        // told the ref was not updated instead of it silently
                        // vanishing from the result.
                        let stderr = String::from_utf8_lossy(&result.stderr);
                        let reason = stderr
                            .lines()
                            .rev()
                            .find(|l| !l.trim().is_empty())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        refused_refs.push((refname.to_string(), reason));
                    }
                    Err(e) => {
                        refused_refs.push((refname.to_string(), e.to_string()));
                    }
                }
            }
        }

        // Surface refused refs rather than reporting success while the ref the
        // user most likely wanted (e.g. the checked-out branch) was never
        // updated.
        if !refused_refs.is_empty() {
            let detail = refused_refs
                .iter()
                .map(|(name, reason)| {
                    if reason.is_empty() {
                        name.clone()
                    } else {
                        format!("{} ({})", name, reason)
                    }
                })
                .collect::<Vec<_>>()
                .join("; ");
            return Err(GitnadoError::OperationFailed(format!(
                "Some refs from the bundle could not be updated: {}. This usually means the branch is currently checked out or the update was not a fast-forward.",
                detail
            )));
        }

        if fetched_refs.is_empty() {
            return Err(GitnadoError::OperationFailed(
                "Failed to fetch any refs from bundle".to_string(),
            ));
        }

        return Ok(fetched_refs);
    }

    // Parse the fetched refs from the bundle. The "*:*" refspec only updates
    // refs/*, so exclude the bundle's HEAD pseudo-ref from the reported result.
    let heads = bundle_list_heads(bundle_path).await?;
    Ok(heads
        .into_iter()
        .filter(|r| r.name.starts_with("refs/"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    #[tokio::test]
    async fn test_bundle_create_all_refs() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);
        repo.create_branch("feature");

        let bundle_file = repo.path.join("test.bundle");

        let result = bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![],
            true,
        )
        .await;

        assert!(result.is_ok(), "bundle_create failed: {:?}", result.err());
        assert!(bundle_file.exists());
    }

    #[tokio::test]
    async fn test_bundle_create_specific_refs() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Second commit", &[("file.txt", "content")]);

        let bundle_file = repo.path.join("specific.bundle");

        let result = bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec!["HEAD".to_string()],
            false,
        )
        .await;

        assert!(result.is_ok(), "bundle_create failed: {:?}", result.err());
        assert!(bundle_file.exists());
    }

    #[tokio::test]
    async fn test_bundle_create_no_refs_fails() {
        let repo = TestRepo::with_initial_commit();
        let bundle_file = repo.path.join("empty.bundle");

        let result = bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![],
            false,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bundle_verify_valid() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("file.txt", "content")]);

        let bundle_file = repo.path.join("verify.bundle");

        // Create bundle
        bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec!["HEAD".to_string()],
            false,
        )
        .await
        .unwrap();

        // Verify it
        let result =
            bundle_verify(repo.path_str(), bundle_file.to_string_lossy().to_string()).await;

        assert!(result.is_ok());
        let verify_result = result.unwrap();
        assert!(verify_result.is_valid);
    }

    #[tokio::test]
    async fn test_bundle_verify_nonexistent_file() {
        let repo = TestRepo::with_initial_commit();

        let result = bundle_verify(
            repo.path_str(),
            "/nonexistent/path/bundle.bundle".to_string(),
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bundle_list_heads() {
        let repo = TestRepo::with_initial_commit();
        repo.create_commit("Add file", &[("file.txt", "content")]);
        repo.create_branch("feature");

        let bundle_file = repo.path.join("list.bundle");

        // Create bundle with all refs
        bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![],
            true,
        )
        .await
        .unwrap();

        // List heads
        let result = bundle_list_heads(bundle_file.to_string_lossy().to_string()).await;

        assert!(result.is_ok());
        let heads = result.unwrap();
        assert!(!heads.is_empty());
        // Should have at least master/main and feature branches
        assert!(heads
            .iter()
            .any(|r| r.name.contains("master") || r.name.contains("main")));
    }

    #[tokio::test]
    async fn test_bundle_list_heads_nonexistent_file() {
        let result = bundle_list_heads("/nonexistent/bundle.bundle".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bundle_unbundle() {
        // Create source repo with some commits
        let source = TestRepo::with_initial_commit();
        source.create_commit("Second commit", &[("file.txt", "hello")]);

        let bundle_file = source.path.join("transfer.bundle");

        // Create bundle from source
        bundle_create(
            source.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec!["HEAD".to_string()],
            false,
        )
        .await
        .unwrap();

        // Create a new empty repo to unbundle into
        // Note: For unbundle to work, the target repo needs to have the prerequisite commits
        // or we need a complete bundle. Let's create a complete bundle instead.
        let _target = TestRepo::new();

        // Create initial commit to match source's initial state is complex
        // Instead, test that unbundle works on the source repo itself
        let result =
            bundle_unbundle(source.path_str(), bundle_file.to_string_lossy().to_string()).await;

        // Should succeed since source already has all the commits
        assert!(result.is_ok(), "unbundle failed: {:?}", result.err());
    }

    #[tokio::test]
    async fn test_bundle_unbundle_nonexistent_bundle() {
        let repo = TestRepo::with_initial_commit();

        let result =
            bundle_unbundle(repo.path_str(), "/nonexistent/bundle.bundle".to_string()).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bundle_create_with_range() {
        let repo = TestRepo::with_initial_commit();
        let first_oid = repo.head_oid();
        repo.create_commit("Second", &[("a.txt", "a")]);
        repo.create_commit("Third", &[("b.txt", "b")]);

        let bundle_file = repo.path.join("range.bundle");

        // Create bundle with a range (commits since first)
        let result = bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![format!("{}..HEAD", first_oid)],
            false,
        )
        .await;

        assert!(
            result.is_ok(),
            "bundle_create with range failed: {:?}",
            result.err()
        );
        assert!(bundle_file.exists());
    }

    // Finding 71: a partial bundle's prerequisites must be reported.
    #[tokio::test]
    async fn test_bundle_verify_reports_prerequisites() {
        let repo = TestRepo::with_initial_commit();
        let base = repo.head_oid();
        repo.create_commit("Second", &[("a.txt", "a")]);
        repo.create_commit("Third", &[("b.txt", "b")]);

        // A bundle of just the last two commits requires `base` as a
        // prerequisite (partial history).
        let bundle_file = repo.path.join("partial.bundle");
        bundle_create(
            repo.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![format!("{}..HEAD", base)],
            false,
        )
        .await
        .unwrap();

        let result = bundle_verify(repo.path_str(), bundle_file.to_string_lossy().to_string())
            .await
            .unwrap();

        assert!(result.is_valid);
        assert!(
            !result.requires.is_empty(),
            "partial bundle must report prerequisites, got {:?}",
            result.requires
        );
        assert!(
            result.requires.iter().any(|o| o == &base.to_string()),
            "prerequisite should be the base commit {}, got {:?}",
            base,
            result.requires
        );
        // The prerequisite oid must not leak into the refs list.
        assert!(
            result.refs.iter().all(|r| r.oid != base.to_string()),
            "prerequisite must not appear as a ref: {:?}",
            result.refs
        );
    }

    // Findings 69 and 70: unbundling a --all bundle into a repo whose
    // checked-out branch it contains must (a) not create a bogus refs/heads/HEAD
    // branch and (b) surface the refused checked-out branch as an error rather
    // than silently reporting success.
    #[tokio::test]
    async fn test_bundle_unbundle_reports_refused_checked_out_branch() {
        let source = TestRepo::with_initial_commit();
        source.create_commit("c2", &[("f.txt", "2")]);
        source.create_branch("feature");
        source.create_commit("c3", &[("f.txt", "3")]);

        let bundle_file = source.path.join("all.bundle");
        bundle_create(
            source.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![],
            true,
        )
        .await
        .unwrap();

        // Target has `main` checked out; the bundle contains refs/heads/main.
        let target = TestRepo::with_initial_commit();
        let result =
            bundle_unbundle(target.path_str(), bundle_file.to_string_lossy().to_string()).await;

        assert!(
            result.is_err(),
            "refused checked-out branch must surface an error, got {:?}",
            result
        );
        let msg = format!("{:?}", result.err().unwrap());
        assert!(
            msg.contains("main") || msg.to_lowercase().contains("checked out"),
            "error should name the refused ref: {}",
            msg
        );

        // Finding 70: no bogus refs/heads/HEAD branch created.
        let git = target.repo();
        assert!(
            git.find_branch("HEAD", git2::BranchType::Local).is_err(),
            "must not create a local branch named HEAD"
        );
    }

    #[tokio::test]
    async fn test_bundle_roundtrip() {
        // Create source repo
        let source = TestRepo::with_initial_commit();
        source.create_commit("Feature work", &[("feature.txt", "feature content")]);

        let bundle_file = source.path.join("roundtrip.bundle");

        // Create a complete bundle
        let create_result = bundle_create(
            source.path_str(),
            bundle_file.to_string_lossy().to_string(),
            vec![],
            true,
        )
        .await;
        assert!(create_result.is_ok());

        // Verify the bundle
        let verify_result =
            bundle_verify(source.path_str(), bundle_file.to_string_lossy().to_string()).await;
        assert!(verify_result.is_ok());
        assert!(verify_result.unwrap().is_valid);

        // List heads
        let heads = bundle_list_heads(bundle_file.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!heads.is_empty());
    }
}
