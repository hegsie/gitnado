//! Test harness for commit message generation pipeline.
//!
//! Captures `git diff HEAD` from the real repo and runs it through the
//! extract_file_diffs → batch summarize → synthesize pipeline, printing
//! each stage so we can inspect quality.
//!
//! Run with:
//! ```sh
//! cd src-tauri && cargo test --test commit_message_harness -- --nocapture
//! ```

use std::process::Command;

// We can't access private functions directly, so we duplicate the extraction
// logic here for testing purposes.

struct FileDiff {
    path: String,
    content: String,
}

fn extract_file_diffs(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ b/") {
            if let Some(path) = current_path.take() {
                files.push(FileDiff {
                    path,
                    content: std::mem::take(&mut current_lines).join("\n"),
                });
            }
            current_path = Some(path.to_string());
        } else if line.starts_with("--- ") || line.starts_with("diff ") {
            continue;
        } else if current_path.is_some() {
            current_lines.push(line.to_string());
        }
    }

    if let Some(path) = current_path {
        files.push(FileDiff {
            path,
            content: current_lines.join("\n"),
        });
    }

    // Truncate each file's content
    let max_chars_per_file = if files.len() > 10 { 1500 } else { 2500 };
    for file in &mut files {
        if file.content.len() > max_chars_per_file {
            file.content = file.content[..max_chars_per_file].to_string();
            file.content.push_str("\n[truncated]");
        }
    }

    files
}

#[test]
fn test_extract_file_diffs_on_real_repo() {
    // Capture the real git diff
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let output = Command::new("git")
        .args(["diff", "HEAD", "--no-color"])
        .current_dir(&repo_root)
        .output()
        .expect("Failed to run git diff");

    let diff = String::from_utf8_lossy(&output.stdout);

    if diff.is_empty() {
        eprintln!("No uncommitted changes — nothing to test.");
        return;
    }

    eprintln!("═══════════════════════════════════════════════════════════");
    eprintln!("  COMMIT MESSAGE GENERATION HARNESS");
    eprintln!("═══════════════════════════════════════════════════════════");
    eprintln!();
    eprintln!(
        "Raw diff: {} bytes, {} lines",
        diff.len(),
        diff.lines().count()
    );
    eprintln!();

    // Stage 1: Extract per-file diffs
    let file_diffs = extract_file_diffs(&diff);
    eprintln!("───────────────────────────────────────────────────────────");
    eprintln!("  STAGE 1: Extracted {} file diffs", file_diffs.len());
    eprintln!("───────────────────────────────────────────────────────────");
    for (i, fd) in file_diffs.iter().enumerate() {
        eprintln!("  [{:>2}] {} ({} chars)", i + 1, fd.path, fd.content.len());
    }
    eprintln!();

    // Stage 2: Show what each per-file prompt would look like (ALL files)
    eprintln!("───────────────────────────────────────────────────────────");
    eprintln!(
        "  STAGE 2: Per-file summarization ({} files, {} inference calls)",
        file_diffs.len(),
        file_diffs.len()
    );
    eprintln!("───────────────────────────────────────────────────────────");

    for (i, file_diff) in file_diffs.iter().enumerate() {
        eprintln!(
            "  [{:>2}] {} — {} chars of diff content",
            i + 1,
            file_diff.path,
            file_diff.content.len()
        );
    }

    // Stage 2b: Show condensing pass info
    if file_diffs.len() > 5 {
        eprintln!();
        eprintln!(
            "  → {} files > 5 — condensing pass will group into 3-6 bullets",
            file_diffs.len()
        );
    }

    // Stage 3: Show what the final synthesis prompt would look like
    // (using placeholder summaries since we don't have a real model here)
    eprintln!();
    eprintln!("───────────────────────────────────────────────────────────");
    eprintln!("  STAGE 3: Final synthesis");
    eprintln!("───────────────────────────────────────────────────────────");

    let placeholder_summaries: Vec<String> = file_diffs
        .iter()
        .map(|f| {
            let has_additions = f.content.contains("\n+");
            let has_deletions = f.content.contains("\n-");
            let action = match (has_additions, has_deletions) {
                (true, true) => "modify",
                (true, false) => "add to",
                (false, true) => "remove from",
                (false, false) => "update",
            };
            format!("- {} code", action)
        })
        .collect();

    let changes_text = placeholder_summaries.join("\n");
    eprintln!("  Placeholder per-file summaries:");
    for s in &placeholder_summaries {
        eprintln!("    {s}");
    }

    let synthesis_prompt = format!(
        "<|start_header_id|>system<|end_header_id|>\n\n\
         Write a git commit message for these changes. Output ONLY the commit message.\n\
         Line 1: type(scope): short summary (under 50 chars)\n\
         Line 2: blank\n\
         Line 3+: bullet points summarizing the key changes (group related items)\n\
         Types: feat, fix, docs, style, refactor, test, chore. Imperative mood. No quotes.<|eot_id|>\
         <|start_header_id|>user<|end_header_id|>\n\n{changes_text}<|eot_id|>\
         <|start_header_id|>assistant<|end_header_id|>\n\n"
    );

    eprintln!();
    eprintln!(
        "  Synthesis prompt size: {} chars (~{} tokens)",
        synthesis_prompt.len(),
        synthesis_prompt.len() / 4
    );

    eprintln!();
    eprintln!("═══════════════════════════════════════════════════════════");
    eprintln!("  SUMMARY");
    eprintln!("═══════════════════════════════════════════════════════════");
    eprintln!("  Files changed:     {}", file_diffs.len());
    let condense_calls = if file_diffs.len() > 5 { 1 } else { 0 };
    eprintln!(
        "  Inference calls:   {} (per-file) + {} (condense) + 1 (summary) = {}",
        file_diffs.len(),
        condense_calls,
        file_diffs.len() + condense_calls + 1
    );
    let total_content: usize = file_diffs.iter().map(|f| f.content.len()).sum();
    eprintln!(
        "  Total diff content: {} chars across batches",
        total_content
    );
    eprintln!();
}

/// If we have a model available, run the full pipeline end-to-end.
#[tokio::test]
#[ignore]
async fn test_full_pipeline_with_model() {
    use gitnado_lib::services::ai::providers::InferenceEngine;

    // Check if we have a cached model
    let model_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-models")
        .join("llama-3.2-1b");
    let model_path = model_dir.join("model.gguf");

    if !model_path.exists() {
        eprintln!(
            "No cached model at {} — skipping full pipeline test.",
            model_path.display()
        );
        eprintln!("Run `cargo test --test local_ai_integration -- --ignored` first to download.");
        return;
    }

    // Get real diff
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let output = Command::new("git")
        .args(["diff", "HEAD", "--no-color"])
        .current_dir(&repo_root)
        .output()
        .expect("Failed to run git diff");

    let diff = String::from_utf8_lossy(&output.stdout);
    if diff.is_empty() {
        eprintln!("No uncommitted changes.");
        return;
    }

    // Load model
    eprintln!("Loading model...");
    let mp = model_path.clone();
    let engine = tokio::task::spawn_blocking(move || {
        gitnado_lib::services::ai::local::GgufEngine::load(&mp, "Llama-3.2-1B".to_string(), None)
    })
    .await
    .unwrap()
    .expect("Failed to load model");

    eprintln!(
        "Model loaded. Running pipeline on real diff ({} bytes)...\n",
        diff.len()
    );

    // Extract file diffs
    let file_diffs = extract_file_diffs(&diff);
    eprintln!("Extracted {} file diffs\n", file_diffs.len());

    // Pass 1: Per-file summarization (ALL files, no cap)
    let mut file_summaries = Vec::new();
    for (i, file_diff) in file_diffs.iter().enumerate() {
        let prompt = format!(
            "<|start_header_id|>system<|end_header_id|>\n\n\
             In under 12 words, what is the purpose of this code change? \
             Use imperative mood (e.g. \"add\", \"fix\", \"update\", \"remove\"). \
             Output ONLY the description, no prefixes.<|eot_id|>\
             <|start_header_id|>user<|end_header_id|>\n\n\
             File: {}\n{}<|eot_id|>\
             <|start_header_id|>assistant<|end_header_id|>\n\n",
            file_diff.path, file_diff.content
        );

        eprintln!(
            "── File {}/{}: {} ──",
            i + 1,
            file_diffs.len(),
            file_diff.path
        );
        match engine.generate(&prompt, 25).await {
            Ok(desc) => {
                // Clean: strip preamble, bullets, quotes, capitalize
                let desc = desc.trim();
                let desc = desc
                    .lines()
                    .map(|l| l.trim())
                    .find(|l| {
                        !l.is_empty()
                            && !l.to_lowercase().starts_with("here is")
                            && !l.to_lowercase().starts_with("the purpose")
                            && !l.to_lowercase().starts_with("this code")
                            && !l.ends_with(':')
                    })
                    .unwrap_or("");
                let desc = desc
                    .strip_prefix("- ")
                    .or_else(|| desc.strip_prefix("* "))
                    .unwrap_or(desc);
                let desc = desc.trim_matches('"').trim_matches('\'').trim_matches('`');
                eprintln!("  → {desc}");
                if !desc.is_empty() {
                    file_summaries.push(format!("- {}", desc));
                }
            }
            Err(e) => {
                eprintln!("  ERROR: {e}");
            }
        }
    }

    eprintln!("\n════════════════════════════════════════");
    eprintln!("PASS 1 — PER-FILE SUMMARIES ({}):", file_summaries.len());
    for s in &file_summaries {
        eprintln!("  {s}");
    }
    eprintln!("════════════════════════════════════════\n");

    // Pass 2: If more than 5 summaries, condense into grouped bullets
    let body_bullets = if file_summaries.len() > 5 {
        let raw_list = file_summaries.join("\n");
        let prompt = format!(
            "<|start_header_id|>system<|end_header_id|>\n\n\
             Rewrite this list as 4 bullet points. Group related items together.\n\
             Each line must start with \"- \". Output ONLY the 4 bullets.<|eot_id|>\
             <|start_header_id|>user<|end_header_id|>\n\n{raw_list}<|eot_id|>\
             <|start_header_id|>assistant<|end_header_id|>\n\n"
        );

        eprintln!("Running condensing pass...\n");
        match engine.generate(&prompt, 120).await {
            Ok(response) => {
                let mut condensed: Vec<String> = response
                    .lines()
                    .map(|l| l.trim())
                    .filter(|l| l.starts_with('-') || l.starts_with('*'))
                    .map(|l| {
                        let mut s = l;
                        while let Some(rest) = s.strip_prefix("- ").or_else(|| s.strip_prefix("* "))
                        {
                            s = rest.trim();
                        }
                        format!("- {s}")
                    })
                    .filter(|l| l.len() > 2)
                    .collect();
                condensed.truncate(6);
                if condensed.is_empty() {
                    eprintln!("  Condensing returned no bullets, using first 6 originals");
                    file_summaries.truncate(6);
                    file_summaries
                } else {
                    eprintln!("PASS 2 — CONDENSED TO {} BULLETS:", condensed.len());
                    for s in &condensed {
                        eprintln!("  {s}");
                    }
                    condensed
                }
            }
            Err(e) => {
                eprintln!("  Condensing failed: {e}, using first 6 originals");
                file_summaries.truncate(6);
                file_summaries
            }
        }
    } else {
        eprintln!(
            "(Skipping condensing — {} files <= 5)",
            file_summaries.len()
        );
        file_summaries
    };

    let changes_text = body_bullets.join("\n");
    eprintln!();

    // Pass 3: Generate ONLY the summary line
    let prompt = format!(
        "<|start_header_id|>system<|end_header_id|>\n\n\
         Write ONE git commit summary line that describes ALL these changes together.\n\
         Format: type(scope): what changed overall\n\
         Types: feat, fix, refactor, chore, docs, test.\n\
         Must be under 50 characters. Imperative mood.\n\
         Output ONLY the single summary line.<|eot_id|>\
         <|start_header_id|>user<|end_header_id|>\n\n{changes_text}<|eot_id|>\
         <|start_header_id|>assistant<|end_header_id|>\n\n"
    );

    eprintln!("Running summary generation...\n");
    let response = engine
        .generate(&prompt, 40)
        .await
        .expect("Summary generation failed");
    let summary = response
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.trim_matches('"').trim_matches('`').to_string())
        .unwrap_or_else(|| "chore: update code".to_string());

    eprintln!("════════════════════════════════════════");
    eprintln!("FINAL COMMIT MESSAGE:");
    eprintln!("════════════════════════════════════════");
    eprintln!("{summary}");
    eprintln!();
    eprintln!("{changes_text}");
    eprintln!("════════════════════════════════════════");
}
