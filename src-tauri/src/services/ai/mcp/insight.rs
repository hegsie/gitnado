//! Higher-level MCP read tools (roadmap 4.2, issue #611).
//!
//! Expose Gitnado's analysis features to any MCP client:
//!
//! - `get_conflicts` — files currently in conflict in the working tree
//! - `predict_rebase_conflicts` — the "Ghost Rebase" dry run
//! - `semantic_search_history` — meaning-based commit search (embedding index)
//! - `explain_commit` — a plain-language explanation from the configured AI
//! - `get_pr_comments` — review and discussion comments on a GitHub PR
//!
//! The AI service and embedding index live in Tauri state; the app hands them
//! to the MCP server through [`McpContext`] at startup. Every tool degrades to
//! a clear error when its feature is unavailable (no AI provider, no embedding
//! model, no GitHub remote) rather than failing obscurely. AI and network
//! access go through the same paranoid-mode guards as the UI.

use std::sync::RwLock as StdRwLock;

use serde_json::{json, Value};

use super::tools::McpTool;
use crate::services::ai::AiState;
use crate::services::embedding::embedding_index::SharedEmbeddingIndex;

pub const INSIGHT_TOOLS: [&str; 5] = [
    "get_conflicts",
    "predict_rebase_conflicts",
    "semantic_search_history",
    "explain_commit",
    "get_pr_comments",
];

pub fn is_insight_tool(name: &str) -> bool {
    INSIGHT_TOOLS.contains(&name)
}

/// App services the MCP server can call into. Each is optional so the server
/// (and its tests) work without them.
#[derive(Default)]
pub struct McpContext {
    ai: StdRwLock<Option<AiState>>,
    embeddings: StdRwLock<Option<SharedEmbeddingIndex>>,
}

impl McpContext {
    pub fn set_ai(&self, ai: AiState) {
        *self.ai.write().unwrap_or_else(|e| e.into_inner()) = Some(ai);
    }

    pub fn set_embeddings(&self, index: SharedEmbeddingIndex) {
        *self.embeddings.write().unwrap_or_else(|e| e.into_inner()) = Some(index);
    }

    fn ai(&self) -> Option<AiState> {
        self.ai.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn embeddings(&self) -> Option<SharedEmbeddingIndex> {
        self.embeddings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

const EXPLAIN_SYSTEM_PROMPT: &str = "You explain git commits to developers. Given a commit's \
metadata and diff, explain in plain language what changed and why it likely changed. Start \
with a one-sentence summary, then a short list of the notable changes. Mention risks or \
follow-ups only if the diff clearly suggests them. Do not invent details not in the diff.";

const MAX_EXPLAIN_DIFF_CHARS: usize = 12_000;

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing required argument: {key}"))
}

fn err_string(e: crate::error::GitnadoError) -> String {
    e.to_string()
}

/// Commit metadata and a truncated patch for the explanation prompt.
pub fn commit_explain_prompt(repo_path: &str, oid: &str) -> Result<(String, String), String> {
    let repo = git2::Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let commit = repo
        .revparse_single(oid)
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| format!("Commit not found: {oid}"))?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(
            commit
                .parent(0)
                .and_then(|p| p.tree())
                .map_err(|e| e.message().to_string())?,
        ),
    };
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.message().to_string())?;
    let mut patch = String::new();
    match diff.print(git2::DiffFormat::Patch, |_, _, line| {
        if patch.len() >= MAX_EXPLAIN_DIFF_CHARS {
            return false;
        }
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin());
        }
        patch.push_str(&String::from_utf8_lossy(line.content()));
        patch.len() < MAX_EXPLAIN_DIFF_CHARS
    }) {
        Ok(()) => (),
        Err(e) if e.code() == git2::ErrorCode::User => (),
        Err(e) => return Err(e.message().to_string()),
    }
    let truncated = patch.len() >= MAX_EXPLAIN_DIFF_CHARS;
    let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
    let author = commit.author();
    let mut prompt = format!(
        "Commit {}\nAuthor: {}\nMessage:\n{}\n\nDiff{}:\n{}",
        commit.id(),
        author.name().ok().unwrap_or("unknown"),
        commit.message().ok().unwrap_or(""),
        if truncated { " (truncated)" } else { "" },
        patch
    );
    if parent_tree.is_none() {
        prompt.push_str("\n(This is the repository's first commit.)");
    }
    Ok((summary, prompt))
}

/// Owner and name of the GitHub repository behind `repo_path`'s remotes.
async fn github_repo(repo_path: &str) -> Result<(String, String), String> {
    match crate::commands::github::detect_github_repo(repo_path.to_string(), None)
        .await
        .map_err(err_string)?
    {
        Some(d) => Ok((d.owner, d.repo)),
        None => Err(
            "get_pr_comments supports GitHub repositories; no GitHub remote was found".to_string(),
        ),
    }
}

/// Run an insight tool. `repo_path` has already been validated against the
/// open repositories by the caller.
pub async fn call(
    name: &str,
    args: &Value,
    repo_path: &str,
    ctx: &McpContext,
) -> Result<Value, String> {
    match name {
        "get_conflicts" => {
            let files = crate::commands::merge::get_conflicts(repo_path.to_string())
                .await
                .map_err(err_string)?;
            let list: Vec<Value> = files
                .iter()
                .map(|f| {
                    json!({
                        "path": f.path,
                        "inBase": f.ancestor.is_some(),
                        "inOurs": f.ours.is_some(),
                        "inTheirs": f.theirs.is_some(),
                    })
                })
                .collect();
            Ok(json!({ "count": list.len(), "files": list }))
        }
        "predict_rebase_conflicts" => {
            let onto = str_arg(args, "onto")?.to_string();
            let preview = crate::commands::merge::preview_rebase(repo_path.to_string(), onto)
                .await
                .map_err(err_string)?;
            serde_json::to_value(preview).map_err(|e| e.to_string())
        }
        "semantic_search_history" => {
            let query = str_arg(args, "query")?.to_string();
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 50) as usize;
            let index = ctx.embeddings().ok_or_else(|| {
                "Semantic search is not available in this Gitnado session".to_string()
            })?;
            let results = crate::services::embedding::embedding_index::semantic_search(
                &index,
                repo_path.to_string(),
                query,
                limit,
            )
            .await
            .map_err(|e| {
                format!("Semantic search failed ({e}). Build the semantic index in Gitnado first.")
            })?;
            serde_json::to_value(results).map_err(|e| e.to_string())
        }
        "explain_commit" => {
            let oid = str_arg(args, "oid")?.to_string();
            let path = repo_path.to_string();
            let (summary, prompt) =
                tokio::task::spawn_blocking(move || commit_explain_prompt(&path, &oid))
                    .await
                    .map_err(|e| e.to_string())??;
            let ai = ctx
                .ai()
                .ok_or_else(|| "AI is not available in this Gitnado session".to_string())?;
            let service = ai.read().await;
            if let Some(endpoint) = service.active_provider_endpoint() {
                crate::services::security::guard_endpoint(&endpoint).map_err(err_string)?;
            }
            let explanation = service
                .generate_text(EXPLAIN_SYSTEM_PROMPT, &prompt, Some(600))
                .await
                .map_err(|e| format!("No AI provider could explain the commit: {e}"))?;
            Ok(json!({ "summary": summary, "explanation": explanation.trim() }))
        }
        "get_pr_comments" => {
            let number = args
                .get("pr_number")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0 && *n <= u32::MAX as u64)
                .ok_or_else(|| "Missing required argument: pr_number".to_string())?;
            let (owner, repo) = github_repo(repo_path).await?;
            let comments =
                crate::commands::github::get_github_pr_comments(owner, repo, number as u32, None)
                    .await
                    .map_err(err_string)?;
            serde_json::to_value(comments).map_err(|e| e.to_string())
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn repo_prop() -> Value {
    json!({ "type": "string", "description": "Absolute path of the repository (must be open in Gitnado)" })
}

pub fn insight_tool_list() -> Vec<McpTool> {
    let tool = |name: &str, description: &str, properties: Value, required: Vec<&str>| McpTool {
        name: name.to_string(),
        description: description.to_string(),
        input_schema: json!({ "type": "object", "properties": properties, "required": required }),
    };
    vec![
        tool(
            "get_conflicts",
            "List files currently in a merge/rebase conflict, with which sides (base/ours/theirs) exist.",
            json!({ "repo_path": repo_prop() }),
            vec!["repo_path"],
        ),
        tool(
            "predict_rebase_conflicts",
            "Dry-run rebasing the current branch onto a ref in a throwaway worktree and report which commits and files would conflict. Changes nothing.",
            json!({ "repo_path": repo_prop(), "onto": { "type": "string", "description": "Branch or commit to rebase onto" } }),
            vec!["repo_path", "onto"],
        ),
        tool(
            "semantic_search_history",
            "Find commits by meaning rather than exact words, using Gitnado's local semantic index.",
            json!({ "repo_path": repo_prop(), "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "maximum": 50 } }),
            vec!["repo_path", "query"],
        ),
        tool(
            "explain_commit",
            "Explain a commit in plain language using the AI provider configured in Gitnado.",
            json!({ "repo_path": repo_prop(), "oid": { "type": "string", "description": "Commit SHA or ref" } }),
            vec!["repo_path", "oid"],
        ),
        tool(
            "get_pr_comments",
            "Get the discussion and review comments of a GitHub pull request for this repository.",
            json!({ "repo_path": repo_prop(), "pr_number": { "type": "integer", "minimum": 1 } }),
            vec!["repo_path", "pr_number"],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn conflicted_repo() -> TestRepo {
        let t = TestRepo::with_initial_commit();
        t.create_branch("other");
        t.create_commit("main edit", &[("README.md", "main side")]);
        t.checkout_branch("other");
        t.create_commit("other edit", &[("README.md", "other side")]);
        t.checkout_branch("main");
        let repo = t.repo();
        let other = repo
            .find_annotated_commit(repo.revparse_single("other").unwrap().id())
            .unwrap();
        repo.merge(&[&other], None, None).unwrap();
        t
    }

    #[tokio::test]
    async fn get_conflicts_lists_conflicted_files() {
        let t = conflicted_repo();
        let ctx = McpContext::default();
        let out = call("get_conflicts", &json!({}), &t.path_str(), &ctx)
            .await
            .unwrap();
        assert_eq!(out["count"], 1);
        assert_eq!(out["files"][0]["path"], "README.md");
        assert_eq!(out["files"][0]["inOurs"], true);
        assert_eq!(out["files"][0]["inTheirs"], true);

        let clean = TestRepo::with_initial_commit();
        let out = call("get_conflicts", &json!({}), &clean.path_str(), &ctx)
            .await
            .unwrap();
        assert_eq!(out["count"], 0);
    }

    #[tokio::test]
    async fn predict_rebase_conflicts_reports_the_dry_run() {
        let t = TestRepo::with_initial_commit();
        t.create_branch("base");
        t.create_commit("mine", &[("README.md", "mine")]);
        t.checkout_branch("base");
        t.create_commit("theirs", &[("README.md", "theirs")]);
        t.checkout_branch("main");
        let ctx = McpContext::default();
        let out = call(
            "predict_rebase_conflicts",
            &json!({ "onto": "base" }),
            &t.path_str(),
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(out["totalCommits"], 1, "{out}");
        assert_eq!(out["conflictingCommits"], 1, "{out}");
        assert_eq!(t.current_branch(), "main", "the real checkout is untouched");
        assert!(
            call("predict_rebase_conflicts", &json!({}), &t.path_str(), &ctx)
                .await
                .unwrap_err()
                .contains("onto")
        );
    }

    #[tokio::test]
    async fn unavailable_features_fail_clearly() {
        let t = TestRepo::with_initial_commit();
        let ctx = McpContext::default();
        let err = call(
            "semantic_search_history",
            &json!({ "query": "x" }),
            &t.path_str(),
            &ctx,
        )
        .await
        .unwrap_err();
        assert!(err.contains("not available"), "{err}");

        let head = t.head_oid().to_string();
        let err = call(
            "explain_commit",
            &json!({ "oid": head }),
            &t.path_str(),
            &ctx,
        )
        .await
        .unwrap_err();
        assert!(err.contains("AI is not available"), "{err}");

        let err = call(
            "explain_commit",
            &json!({ "oid": "deadbeef" }),
            &t.path_str(),
            &ctx,
        )
        .await
        .unwrap_err();
        assert!(err.contains("Commit not found"), "{err}");

        let err = call(
            "get_pr_comments",
            &json!({ "pr_number": 3 }),
            &t.path_str(),
            &ctx,
        )
        .await
        .unwrap_err();
        assert!(err.contains("no GitHub remote"), "{err}");
        let err = call("get_pr_comments", &json!({}), &t.path_str(), &ctx)
            .await
            .unwrap_err();
        assert!(err.contains("pr_number"), "{err}");
    }

    #[test]
    fn explain_prompt_contains_message_and_patch() {
        let t = TestRepo::with_initial_commit();
        let oid = t.create_commit(
            "Add greeting\n\nBecause users asked.",
            &[("hello.txt", "hi there")],
        );
        let (summary, prompt) = commit_explain_prompt(&t.path_str(), &oid.to_string()).unwrap();
        assert_eq!(summary, "Add greeting");
        assert!(prompt.contains("Because users asked."));
        assert!(prompt.contains("+hi there"), "{prompt}");
        assert!(prompt.contains("hello.txt"));

        let (_, first) = commit_explain_prompt(&t.path_str(), "HEAD~1").unwrap();
        assert!(first.contains("first commit"));

        let large_body = "line of content\n".repeat(1000);
        let large_oid = t.create_commit("Large diff commit", &[("big.txt", &large_body)]);
        let (large_summary, large_prompt) =
            commit_explain_prompt(&t.path_str(), &large_oid.to_string()).unwrap();
        assert_eq!(large_summary, "Large diff commit");
        assert!(large_prompt.contains("Diff (truncated):"));
    }

    #[test]
    fn tool_list_covers_every_insight_tool() {
        let names: Vec<String> = insight_tool_list().into_iter().map(|t| t.name).collect();
        assert_eq!(names, INSIGHT_TOOLS.to_vec());
    }
}
