//! Embedding index orchestrator
//!
//! Ties together the embedding engine, commit walking, code-aware diff/symbol
//! extraction, SQLite FTS5 BM25 lexical index, and sqlite-vec vector store to
//! build and query a hybrid semantic + lexical search index for a repository.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::embedding_model;
use super::onnx_engine::OnnxEmbeddingEngine;
use super::vector_store::EmbeddingIndexStatus;

/// Maximum number of changed files inspected per commit diff.
const MAX_DIFF_FILES: usize = 30;
/// Maximum number of diff patch bytes inspected per commit.
const MAX_DIFF_BYTES: usize = 64 * 1024;
/// Maximum number of extracted symbol identifiers stored per commit.
const MAX_EXTRACTED_SYMBOLS: usize = 64;

/// Reciprocal Rank Fusion rank constant `k`.
const RRF_K: f32 = 60.0;
/// Base vector rank weight in RRF.
const RRF_WEIGHT_VEC: f32 = 1.0;
/// Base BM25 lexical rank weight in RRF.
const RRF_WEIGHT_BM25: f32 = 1.15;

/// Register sqlite-vec as an auto-extension (idempotent across calls).
#[allow(clippy::missing_transmute_annotations)]
fn ensure_sqlite_vec_registered() {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

/// Hybrid semantic + BM25 search result for a commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchResult {
    pub oid: String,
    pub distance: f32,
    pub summary: String,
    #[serde(default)]
    pub similarity: f32,
    #[serde(default)]
    pub matched_files: Vec<String>,
    #[serde(default)]
    pub matched_symbols: Vec<String>,
    #[serde(default)]
    pub match_sources: Vec<String>,
}

/// Commit payload prepared for indexing into the hybrid vector + FTS5 store.
#[derive(Debug, Clone)]
pub struct IndexedCommitRecord {
    pub oid: String,
    pub summary: String,
    pub message: String,
    pub files: Vec<String>,
    pub symbols: Vec<String>,
    pub embedding: Vec<f32>,
}

/// Collected commit metadata prior to vector embedding.
#[derive(Debug, Clone)]
struct CollectedCommit {
    oid: String,
    embedding_text: String,
    summary: String,
    message: String,
    files: Vec<String>,
    symbols: Vec<String>,
}

/// Format commit message, changed file paths, and extracted symbols into the
/// text embedded by the MiniLM vector model.
pub fn format_commit_embedding_text(message: &str, files: &[String], symbols: &[String]) -> String {
    let files_joined = files.join(", ");
    let symbols_joined = symbols.join(", ");
    format!(
        "{}\nFiles: {}\nSymbols: {}",
        message.trim(),
        files_joined,
        symbols_joined
    )
}

static SYMBOL_DECL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:\b(?:pub(?:\([^)]*\))?|export|default|async|unsafe|const|static|abstract|final|sealed|partial|public|private|protected|internal)\s+)*\b(?:fn|function|def|class|struct|enum|trait|interface|type|record)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .expect("valid SYMBOL_DECL_RE")
});

static GO_FUNC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)").expect("valid GO_FUNC_RE")
});

static CONST_DECL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:^\s*|\b(?:export|pub(?:\([^)]*\))?)\s+)\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\b")
        .expect("valid CONST_DECL_RE")
});

static TYPED_METHOD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|final|synchronized|async)\s+)+(?:[A-Za-z_][A-Za-z0-9_<>?,\[\].]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(",
    )
    .expect("valid TYPED_METHOD_RE")
});

fn is_ignored_symbol_keyword(ident: &str) -> bool {
    matches!(
        ident,
        "if" | "for"
            | "while"
            | "switch"
            | "catch"
            | "return"
            | "match"
            | "new"
            | "typeof"
            | "sizeof"
            | "where"
            | "in"
            | "await"
            | "super"
            | "this"
            | "self"
            | "Self"
            | "true"
            | "false"
            | "null"
            | "None"
            | "Some"
            | "Ok"
            | "Err"
    )
}

fn push_symbol(ident: &str, symbols: &mut Vec<String>, seen: &mut HashSet<String>) {
    if symbols.len() >= MAX_EXTRACTED_SYMBOLS {
        return;
    }
    if ident.len() < 2 || is_ignored_symbol_keyword(ident) {
        return;
    }
    if seen.insert(ident.to_string()) {
        symbols.push(ident.to_string());
    }
}

/// Extract function, struct, class, interface, type, and method identifiers from a diff line.
pub fn extract_symbols_from_line(
    line: &str,
    symbols: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with('#')
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
    {
        return;
    }

    for caps in SYMBOL_DECL_RE.captures_iter(trimmed) {
        if let Some(m) = caps.get(1) {
            push_symbol(m.as_str(), symbols, seen);
        }
    }
    for caps in GO_FUNC_RE.captures_iter(trimmed) {
        if let Some(m) = caps.get(1) {
            push_symbol(m.as_str(), symbols, seen);
        }
    }
    for caps in CONST_DECL_RE.captures_iter(trimmed) {
        if let Some(m) = caps.get(1) {
            push_symbol(m.as_str(), symbols, seen);
        }
    }
    if let Some(caps) = TYPED_METHOD_RE.captures(trimmed) {
        if let Some(m) = caps.get(1) {
            push_symbol(m.as_str(), symbols, seen);
        }
    }
}

/// Inspect a commit's tree diff against its first parent (bounded to
/// `MAX_DIFF_FILES` files and `MAX_DIFF_BYTES` bytes) and extract:
/// 1. Changed file paths (`files`)
/// 2. Added/modified symbol identifiers (`symbols`)
pub fn extract_commit_code_context(
    repo: &git2::Repository,
    commit: &git2::Commit,
) -> (Vec<String>, Vec<String>) {
    let tree = match commit.tree() {
        Ok(t) => t,
        Err(_) => return (Vec::new(), Vec::new()),
    };

    let parent_tree = if commit.parent_count() > 0 {
        commit.parent(0).ok().and_then(|p| p.tree().ok())
    } else {
        None
    };

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.context_lines(0);

    let diff = match repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut diff_opts))
    {
        Ok(d) => d,
        Err(_) => return (Vec::new(), Vec::new()),
    };

    let mut files = Vec::new();
    let mut files_seen = HashSet::new();

    for delta in diff.deltas() {
        if files.len() >= MAX_DIFF_FILES {
            break;
        }
        let path_opt = delta.new_file().path().or_else(|| delta.old_file().path());
        if let Some(path) = path_opt {
            let path_str = path.to_string_lossy().into_owned();
            if !path_str.is_empty() && files_seen.insert(path_str.clone()) {
                files.push(path_str);
            }
        }
    }

    let mut symbols = Vec::new();
    let mut symbols_seen = HashSet::new();
    let mut bytes_processed: usize = 0;

    let _ = diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
        if bytes_processed >= MAX_DIFF_BYTES || symbols.len() >= MAX_EXTRACTED_SYMBOLS {
            return true;
        }

        let file_allowed = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| files_seen.contains(p.to_string_lossy().as_ref()))
            .unwrap_or(false);
        if !file_allowed {
            return true;
        }

        if let Some(h) = hunk {
            if let Ok(header) = std::str::from_utf8(h.header()) {
                if let Some(idx) = header.rfind("@@") {
                    let context_hint = &header[idx + 2..];
                    extract_symbols_from_line(context_hint, &mut symbols, &mut symbols_seen);
                }
            }
        }

        let origin = line.origin();
        if origin == '+' || origin == '-' {
            let content = line.content();
            bytes_processed = bytes_processed.saturating_add(content.len());
            if bytes_processed <= MAX_DIFF_BYTES {
                if let Ok(text) = std::str::from_utf8(content) {
                    extract_symbols_from_line(text, &mut symbols, &mut symbols_seen);
                }
            }
        }

        true
    });

    (files, symbols)
}

/// Hybrid SQLite store managing `commit_meta`, `commit_fts` (FTS5 BM25),
/// `commit_embeddings`, and `vec_commits` (sqlite-vec KNN).
pub struct EmbeddingIndex {
    conn: Connection,
}

impl EmbeddingIndex {
    /// Open or create the hybrid embedding index at `db_path`, running
    /// automatic schema migrations for legacy indexes.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        ensure_sqlite_vec_registered();

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create embedding index directory: {}", e))?;
        }

        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open embedding database: {}", e))?;

        Self::from_connection(conn)
    }

    /// Open an in-memory hybrid embedding index.
    pub fn open_in_memory() -> Result<Self, String> {
        ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory database: {}", e))?;
        Self::from_connection(conn)
    }

    /// Initialize or migrate an existing SQLite connection.
    pub fn from_connection(conn: Connection) -> Result<Self, String> {
        let index = Self { conn };
        index.init_and_migrate_schema()?;
        Ok(index)
    }

    /// Initialize tables and migrate legacy `commit_meta` / `commit_embeddings` schemas.
    fn init_and_migrate_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS commit_embeddings (
                    oid TEXT PRIMARY KEY,
                    summary TEXT NOT NULL,
                    embedding BLOB NOT NULL,
                    indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS vec_commits USING vec0(
                    embedding float[384]
                );

                CREATE TABLE IF NOT EXISTS commit_meta (
                    oid TEXT PRIMARY KEY,
                    message TEXT NOT NULL DEFAULT '',
                    files_text TEXT NOT NULL DEFAULT '',
                    symbols_text TEXT NOT NULL DEFAULT ''
                );
                ",
            )
            .map_err(|e| format!("Failed to initialize base schema: {}", e))?;

        let existing_cols = self.table_columns("commit_meta")?;
        if !existing_cols.contains("files_text") {
            self.conn
                .execute(
                    "ALTER TABLE commit_meta ADD COLUMN files_text TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|e| format!("Failed to add files_text column to commit_meta: {}", e))?;
        }
        if !existing_cols.contains("symbols_text") {
            self.conn
                .execute(
                    "ALTER TABLE commit_meta ADD COLUMN symbols_text TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(|e| format!("Failed to add symbols_text column to commit_meta: {}", e))?;
        }

        self.conn
            .execute_batch(
                "
                CREATE VIRTUAL TABLE IF NOT EXISTS commit_fts USING fts5(
                    oid UNINDEXED,
                    message,
                    files_text,
                    symbols_text
                );

                INSERT OR IGNORE INTO commit_meta (oid, message, files_text, symbols_text)
                SELECT oid, summary, '', '' FROM commit_embeddings;

                INSERT INTO commit_fts (rowid, oid, message, files_text, symbols_text)
                SELECT cm.rowid, cm.oid, cm.message, cm.files_text, cm.symbols_text
                FROM commit_meta cm
                WHERE NOT EXISTS (
                    SELECT 1 FROM commit_fts f WHERE f.rowid = cm.rowid
                );
                ",
            )
            .map_err(|e| format!("Failed to initialize FTS5 schema: {}", e))?;

        Ok(())
    }

    fn table_columns(&self, table: &str) -> Result<HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!("PRAGMA table_info({})", table))
            .map_err(|e| format!("Failed to inspect table_info({}): {}", table, e))?;

        let cols = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to read columns for {}: {}", table, e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(cols)
    }

    /// Return all indexed commit OIDs that already have code-aware metadata or embeddings.
    pub fn get_indexed_oids(&self) -> Result<HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT oid FROM commit_embeddings")
            .map_err(|e| format!("Failed to prepare indexed OIDs query: {}", e))?;

        let oids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query OIDs: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(oids)
    }

    /// Total count of indexed commits.
    pub fn count(&self) -> Result<usize, String> {
        let emb_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM commit_embeddings", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to count commit_embeddings: {}", e))?;
        let meta_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM commit_meta", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count commit_meta: {}", e))?;
        Ok(emb_count.max(meta_count) as usize)
    }

    /// Upsert a batch of commits into `commit_embeddings`, `vec_commits`,
    /// `commit_meta`, and `commit_fts` within a single transaction.
    pub fn upsert_commits_batch(&self, items: &[IndexedCommitRecord]) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        for item in items {
            let blob = embedding_to_blob(&item.embedding);
            let files_text = item.files.join("\n");
            let symbols_text = item.symbols.join("\n");
            let message_text = if item.message.trim().is_empty() {
                item.summary.as_str()
            } else {
                item.message.as_str()
            };

            let existing_emb_rowid: Option<i64> = tx
                .query_row(
                    "SELECT rowid FROM commit_embeddings WHERE oid = ?1",
                    params![item.oid],
                    |row| row.get(0),
                )
                .ok();

            if let Some(rowid) = existing_emb_rowid {
                tx.execute(
                    "UPDATE commit_embeddings SET summary = ?1, embedding = ?2, indexed_at = unixepoch() WHERE oid = ?3",
                    params![item.summary, blob, item.oid],
                )
                .map_err(|e| format!("Failed to update commit_embeddings: {}", e))?;

                tx.execute(
                    "UPDATE vec_commits SET embedding = ?1 WHERE rowid = ?2",
                    params![blob, rowid],
                )
                .map_err(|e| format!("Failed to update vec_commits: {}", e))?;
            } else {
                tx.execute(
                    "INSERT INTO commit_embeddings (oid, summary, embedding) VALUES (?1, ?2, ?3)",
                    params![item.oid, item.summary, blob],
                )
                .map_err(|e| format!("Failed to insert into commit_embeddings: {}", e))?;

                let rowid = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO vec_commits (rowid, embedding) VALUES (?1, ?2)",
                    params![rowid, blob],
                )
                .map_err(|e| format!("Failed to insert into vec_commits: {}", e))?;
            }

            let existing_meta_rowid: Option<i64> = tx
                .query_row(
                    "SELECT rowid FROM commit_meta WHERE oid = ?1",
                    params![item.oid],
                    |row| row.get(0),
                )
                .ok();

            let meta_rowid = if let Some(rowid) = existing_meta_rowid {
                tx.execute(
                    "UPDATE commit_meta SET message = ?1, files_text = ?2, symbols_text = ?3 WHERE rowid = ?4",
                    params![message_text, files_text, symbols_text, rowid],
                )
                .map_err(|e| format!("Failed to update commit_meta: {}", e))?;

                tx.execute("DELETE FROM commit_fts WHERE rowid = ?1", params![rowid])
                    .map_err(|e| format!("Failed to delete stale commit_fts row: {}", e))?;

                rowid
            } else {
                tx.execute(
                    "INSERT INTO commit_meta (oid, message, files_text, symbols_text) VALUES (?1, ?2, ?3, ?4)",
                    params![item.oid, message_text, files_text, symbols_text],
                )
                .map_err(|e| format!("Failed to insert into commit_meta: {}", e))?;

                tx.last_insert_rowid()
            };

            tx.execute(
                "INSERT INTO commit_fts (rowid, oid, message, files_text, symbols_text) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![meta_rowid, item.oid, message_text, files_text, symbols_text],
            )
            .map_err(|e| format!("Failed to insert into commit_fts: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit batch transaction: {}", e))?;

        Ok(())
    }

    /// Hybrid search combining sqlite-vec KNN search and FTS5 BM25 ranking via
    /// Reciprocal Rank Fusion (RRF), normalized into a `[0.0, 1.0]` similarity score.
    pub fn search(
        &self,
        query: &str,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<SemanticSearchResult>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let candidate_k = (limit * 3).max(50);

        // 1. Vector KNN search (when a 384-dim query embedding is provided)
        let mut vec_hits: Vec<(String, String, f32)> = Vec::new();
        if query_embedding.len() == 384 {
            let query_blob = embedding_to_blob(query_embedding);
            let max_distance: f32 = 0.85; // min_similarity = 0.15

            let mut stmt = self
                .conn
                .prepare(
                    "
                    SELECT
                        ce.oid,
                        ce.summary,
                        vc.distance
                    FROM vec_commits vc
                    JOIN commit_embeddings ce ON ce.rowid = vc.rowid
                    WHERE vc.embedding MATCH ?1
                        AND k = ?2
                        AND vc.distance <= ?3
                    ORDER BY vc.distance ASC
                    ",
                )
                .map_err(|e| format!("Failed to prepare vector search query: {}", e))?;

            vec_hits = stmt
                .query_map(
                    params![query_blob, candidate_k as i64, max_distance],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f32>(2)?,
                        ))
                    },
                )
                .map_err(|e| format!("Failed to execute vector search: {}", e))?
                .filter_map(|r| r.ok())
                .collect();
        }

        // 2. FTS5 BM25 lexical search over commit_fts (message, files_text, symbols_text)
        let query_tokens = extract_query_tokens(query);
        let mut bm25_hits: Vec<(String, String, String, String, f64)> = Vec::new();

        if let Some(fts_query) = build_fts5_match_expr(&query_tokens) {
            if let Ok(mut stmt) = self.conn.prepare(
                "
                SELECT
                    cm.oid,
                    cm.message,
                    cm.files_text,
                    cm.symbols_text,
                    bm25(commit_fts, 1.0, 2.5, 3.5) AS bm25_rank
                FROM commit_fts
                JOIN commit_meta cm ON cm.rowid = commit_fts.rowid
                WHERE commit_fts MATCH ?1
                ORDER BY bm25_rank ASC
                LIMIT ?2
                ",
            ) {
                if let Ok(rows) = stmt.query_map(params![fts_query, candidate_k as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, f64>(4)?,
                    ))
                }) {
                    bm25_hits = rows.filter_map(|r| r.ok()).collect();
                }
            }
        }

        // 3. Fuse vector and BM25 rankings with Reciprocal Rank Fusion (RRF)
        #[derive(Default)]
        struct Candidate {
            oid: String,
            summary: String,
            files_text: String,
            symbols_text: String,
            vec_rank: Option<usize>,
            vec_similarity: Option<f32>,
            bm25_rank: Option<usize>,
        }

        let mut candidates: HashMap<String, Candidate> = HashMap::new();

        for (idx, (oid, summary, distance)) in vec_hits.into_iter().enumerate() {
            let sim = (1.0 - distance).clamp(0.0, 1.0);
            let entry = candidates.entry(oid.clone()).or_insert_with(|| Candidate {
                oid,
                summary,
                ..Default::default()
            });
            entry.vec_rank = Some(idx + 1);
            entry.vec_similarity = Some(sim);
        }

        for (idx, (oid, message, files_text, symbols_text, _bm25)) in
            bm25_hits.into_iter().enumerate()
        {
            let first_line = message.lines().next().unwrap_or("").to_string();
            let entry = candidates.entry(oid.clone()).or_insert_with(|| Candidate {
                oid,
                summary: first_line.clone(),
                ..Default::default()
            });
            if entry.summary.is_empty() {
                entry.summary = first_line;
            }
            entry.files_text = files_text;
            entry.symbols_text = symbols_text;
            entry.bm25_rank = Some(idx + 1);
        }

        // Enrich vector-only hits with commit_meta (files_text, symbols_text) if not yet loaded
        for candidate in candidates.values_mut() {
            if candidate.files_text.is_empty() && candidate.symbols_text.is_empty() {
                if let Ok((msg, files_t, symbols_t)) = self.conn.query_row(
                    "SELECT message, files_text, symbols_text FROM commit_meta WHERE oid = ?1",
                    params![candidate.oid],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                ) {
                    if candidate.summary.is_empty() {
                        candidate.summary = msg.lines().next().unwrap_or("").to_string();
                    }
                    candidate.files_text = files_t;
                    candidate.symbols_text = symbols_t;
                }
            }
        }

        let max_rrf = (RRF_WEIGHT_VEC + RRF_WEIGHT_BM25) / (RRF_K + 1.0);
        let mut results: Vec<SemanticSearchResult> = candidates
            .into_values()
            .map(|c| {
                let mut rrf_score = 0.0f32;
                let mut match_sources = Vec::new();

                if let Some(r_vec) = c.vec_rank {
                    rrf_score += RRF_WEIGHT_VEC / (RRF_K + r_vec as f32);
                    match_sources.push("vector".to_string());
                }
                if let Some(r_bm25) = c.bm25_rank {
                    rrf_score += RRF_WEIGHT_BM25 / (RRF_K + r_bm25 as f32);
                    match_sources.push("bm25".to_string());
                }

                let (matched_files, exact_file_hit) =
                    select_matched_items(&c.files_text, &query_tokens, 5);
                let (matched_symbols, exact_symbol_hit) =
                    select_matched_items(&c.symbols_text, &query_tokens, 5);

                // Boost exact symbol/file matches in RRF normalization so exact code
                // identifier queries rank above tangentially similar vector matches.
                if exact_symbol_hit || exact_file_hit {
                    rrf_score += 0.25 * (RRF_WEIGHT_BM25 / (RRF_K + 1.0));
                }

                let normalized_rrf = (rrf_score / max_rrf).clamp(0.0, 1.0);
                // Blend a small tie-breaker from raw vector cosine similarity so items
                // at identical RRF ranks preserve dense similarity ordering.
                let vec_tiebreak = c.vec_similarity.unwrap_or(normalized_rrf);
                let similarity = (0.92 * normalized_rrf + 0.08 * vec_tiebreak).clamp(0.0, 1.0);
                let distance = (1.0 - similarity).clamp(0.0, 1.0);

                SemanticSearchResult {
                    oid: c.oid,
                    distance,
                    summary: c.summary,
                    similarity,
                    matched_files,
                    matched_symbols,
                    match_sources,
                }
            })
            .collect();

        results.sort_by(|a, b| {
            b.similarity
                .partial_cmp(&a.similarity)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.oid.cmp(&b.oid))
        });
        results.truncate(limit);

        Ok(results)
    }
}

/// Convert a float vector to a little-endian byte blob for sqlite-vec.
fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn is_query_stop_word(token: &str) -> bool {
    matches!(
        token,
        "where"
            | "did"
            | "we"
            | "the"
            | "in"
            | "to"
            | "for"
            | "of"
            | "and"
            | "or"
            | "is"
            | "was"
            | "are"
            | "how"
            | "what"
            | "when"
            | "why"
            | "who"
            | "which"
            | "that"
            | "this"
            | "with"
            | "from"
            | "by"
            | "on"
            | "at"
            | "an"
    )
}

/// Extract normalized lexical query tokens for FTS5 and symbol/file matching.
fn extract_query_tokens(query: &str) -> Vec<String> {
    let mut raw_tokens = Vec::new();
    let mut seen = HashSet::new();

    for part in query.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let lower = part.trim().to_lowercase();
        if lower.len() >= 2 && seen.insert(lower.clone()) {
            raw_tokens.push(lower);
        }
    }

    let filtered: Vec<String> = raw_tokens
        .iter()
        .filter(|t| !is_query_stop_word(t.as_str()))
        .cloned()
        .collect();

    if filtered.is_empty() {
        raw_tokens
    } else {
        filtered
    }
}

/// Build a safe FTS5 MATCH expression from lexical tokens.
fn build_fts5_match_expr(tokens: &[String]) -> Option<String> {
    if tokens.is_empty() {
        return None;
    }
    let clauses: Vec<String> = tokens
        .iter()
        .map(|t| {
            let clean: String = t
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            format!("\"{}\"*", clean)
        })
        .collect();
    Some(clauses.join(" OR "))
}

/// Select items from newline/whitespace-delimited metadata text, prioritizing
/// entries that match any query token and returning `(items, had_query_match)`.
fn select_matched_items(
    raw_text: &str,
    query_tokens: &[String],
    max_items: usize,
) -> (Vec<String>, bool) {
    let all_items: Vec<String> = raw_text
        .lines()
        .flat_map(|line| {
            if line.contains(',') {
                line.split(',').map(str::trim).collect::<Vec<_>>()
            } else {
                vec![line.trim()]
            }
        })
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    if all_items.is_empty() {
        return (Vec::new(), false);
    }

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();

    for item in all_items {
        let lower = item.to_lowercase();
        let is_hit = !query_tokens.is_empty()
            && query_tokens
                .iter()
                .any(|tok| lower.contains(tok.as_str()) || tok.contains(lower.as_str()));
        if is_hit {
            if !matched.contains(&item) {
                matched.push(item);
            }
        } else if !unmatched.contains(&item) {
            unmatched.push(item);
        }
    }

    let had_query_match = !matched.is_empty();
    for item in unmatched {
        if matched.len() >= max_items {
            break;
        }
        matched.push(item);
    }
    matched.truncate(max_items);

    (matched, had_query_match)
}

/// Shared embedding index state (managed by Tauri)
pub type SharedEmbeddingIndex = Arc<RwLock<EmbeddingIndexState>>;

/// Progress of an embedding index build
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingIndexProgress {
    pub repo_path: String,
    pub indexed_count: usize,
    pub total_count: usize,
    pub percent: f64,
}

/// State for the embedding index system
pub struct EmbeddingIndexState {
    models_dir: PathBuf,
    indexes_dir: PathBuf,
    engine: Option<OnnxEmbeddingEngine>,
    active_builds: HashMap<String, Arc<AtomicBool>>,
}

impl EmbeddingIndexState {
    /// Create a new embedding index state
    pub fn new(models_dir: PathBuf, indexes_dir: PathBuf) -> Self {
        Self {
            models_dir,
            indexes_dir,
            engine: None,
            active_builds: HashMap::new(),
        }
    }

    /// Check if the embedding model is downloaded
    pub fn is_model_downloaded(&self) -> bool {
        embedding_model::is_model_downloaded(&self.models_dir)
    }

    /// Get the models directory
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Get the database path for a given repository
    pub fn db_path_for_repo(&self, repo_path: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(repo_path.as_bytes());
        let result = hasher.finalize();
        let hash: String = result.iter().map(|b| format!("{:02x}", b)).collect();
        let short_hash = &hash[..16];
        self.indexes_dir.join(format!("{}.db", short_hash))
    }

    /// Ensure the embedding engine is loaded (lazy init).
    fn ensure_engine(&mut self) -> Result<&mut OnnxEmbeddingEngine, String> {
        if self.engine.is_none() {
            if !self.is_model_downloaded() {
                return Err("Embedding model not downloaded. Please download it first.".to_string());
            }

            let model_dir = embedding_model::get_model_dir(&self.models_dir);
            let engine = OnnxEmbeddingEngine::load(&model_dir)?;
            self.engine = Some(engine);
        }

        self.engine
            .as_mut()
            .ok_or_else(|| "Embedding engine failed to initialize".to_string())
    }

    /// Register a build as active
    pub fn register_build(&mut self, repo_path: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.active_builds
            .insert(repo_path.to_string(), cancel.clone());
        cancel
    }

    /// Check if a build is active for a repo
    pub fn is_building(&self, repo_path: &str) -> bool {
        self.active_builds.contains_key(repo_path)
    }

    /// Remove a build from active tracking
    pub fn finish_build(&mut self, repo_path: &str) {
        self.active_builds.remove(repo_path);
    }

    /// Cancel an active build
    pub fn cancel_build(&self, repo_path: &str) -> bool {
        if let Some(flag) = self.active_builds.get(repo_path) {
            flag.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

/// Build the full embedding index for a repository.
pub async fn build_embedding_index(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    app_handle: AppHandle,
) -> Result<usize, String> {
    let (cancel_flag, db_path) = {
        let mut guard = state.write().await;
        guard.ensure_engine()?;
        let cancel = guard.register_build(&repo_path);
        let db_path = guard.db_path_for_repo(&repo_path);
        (cancel, db_path)
    };

    let repo_path_clone = repo_path.clone();
    let commits = tokio::task::spawn_blocking(move || collect_commits(&repo_path_clone))
        .await
        .map_err(|e| format!("Failed to walk commits: {}", e))??;

    let total_count = commits.len();
    let store = EmbeddingIndex::open(&db_path)?;
    let indexed_oids = store.get_indexed_oids()?;

    let new_commits: Vec<_> = commits
        .into_iter()
        .filter(|c| !indexed_oids.contains(&c.oid))
        .collect();

    if new_commits.is_empty() {
        let mut guard = state.write().await;
        guard.finish_build(&repo_path);
        return Ok(total_count);
    }

    let batch_size = 32;
    let mut indexed_count = indexed_oids.len();

    for chunk in new_commits.chunks(batch_size) {
        if cancel_flag.load(Ordering::Relaxed) {
            let mut guard = state.write().await;
            guard.finish_build(&repo_path);
            return Err("Build cancelled".to_string());
        }

        let texts: Vec<&str> = chunk.iter().map(|c| c.embedding_text.as_str()).collect();

        let embeddings = {
            let mut guard = state.write().await;
            let engine = guard.ensure_engine()?;
            engine.embed_batch(&texts, batch_size)?
        };

        let items: Vec<IndexedCommitRecord> = chunk
            .iter()
            .zip(embeddings)
            .map(|(c, emb)| IndexedCommitRecord {
                oid: c.oid.clone(),
                summary: c.summary.clone(),
                message: c.message.clone(),
                files: c.files.clone(),
                symbols: c.symbols.clone(),
                embedding: emb,
            })
            .collect();

        store.upsert_commits_batch(&items)?;
        indexed_count += chunk.len();

        let percent = if total_count > 0 {
            (indexed_count as f64 / total_count as f64) * 100.0
        } else {
            100.0
        };

        let _ = app_handle.emit(
            "embedding-index-progress",
            EmbeddingIndexProgress {
                repo_path: repo_path.clone(),
                indexed_count,
                total_count,
                percent,
            },
        );
    }

    let mut guard = state.write().await;
    guard.finish_build(&repo_path);
    Ok(total_count)
}

/// Incrementally update the embedding index with new commits.
pub async fn update_embedding_index(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    app_handle: AppHandle,
) -> Result<usize, String> {
    build_embedding_index(state, repo_path, app_handle).await
}

/// Perform a hybrid semantic + BM25 search on the embedding index.
pub async fn semantic_search(
    state: &SharedEmbeddingIndex,
    repo_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<SemanticSearchResult>, String> {
    let query_embedding = {
        let mut guard = state.write().await;
        let engine = guard.ensure_engine()?;
        engine.embed(&query)?
    };

    let db_path = {
        let guard = state.read().await;
        guard.db_path_for_repo(&repo_path)
    };

    let store = EmbeddingIndex::open(&db_path)?;
    store.search(&query, &query_embedding, limit)
}

/// Get the status of the embedding index for a repository.
pub async fn get_embedding_status(
    state: &SharedEmbeddingIndex,
    repo_path: String,
) -> Result<EmbeddingIndexStatus, String> {
    let guard = state.read().await;
    let model_downloaded = guard.is_model_downloaded();
    let is_building = guard.is_building(&repo_path);
    let db_path = guard.db_path_for_repo(&repo_path);

    let (indexed_commits, total_commits) = if db_path.exists() {
        let store = EmbeddingIndex::open(&db_path)?;
        let count = store.count()?;
        (count, count)
    } else {
        (0, 0)
    };

    Ok(EmbeddingIndexStatus {
        total_commits,
        indexed_commits,
        is_building,
        is_ready: indexed_commits > 0 && model_downloaded && !is_building,
        model_downloaded,
    })
}

/// Collect all commits from a repository along with code-aware diff context
/// (changed file paths and extracted symbol identifiers).
fn collect_commits(repo_path: &str) -> Result<Vec<CollectedCommit>, String> {
    let repo =
        git2::Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;

    crate::utils::push_visible_refs(&repo, &mut revwalk)
        .map_err(|e| format!("Failed to push refs: {}", e))?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| format!("Failed to set sorting: {}", e))?;

    let max_commits = 100_000;
    let mut commits = Vec::new();

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
        let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
        let raw_message = commit.message().ok().unwrap_or("").to_string();

        let message = if raw_message.len() > summary.len() {
            raw_message
        } else {
            summary.clone()
        };

        let (files, symbols) = extract_commit_code_context(&repo, &commit);
        let embedding_text = format_commit_embedding_text(&message, &files, &symbols);

        commits.push(CollectedCommit {
            oid: oid_str,
            embedding_text,
            summary,
            message,
            files,
            symbols,
        });
    }

    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestRepo;

    fn make_test_embedding(seed: f32) -> Vec<f32> {
        let mut v: Vec<f32> = (0..384).map(|i| (i as f32 * seed).sin()).collect();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut v {
                *x /= norm;
            }
        }
        v
    }

    #[test]
    fn test_extract_commit_code_context_multi_language_symbols_and_files() {
        let test_repo = TestRepo::with_initial_commit();
        let oid = test_repo.create_commit(
            "Implement multi-language parsers and UI components",
            &[
                (
                    "src-tauri/src/services/ado.rs",
                    "pub struct AdoRemote {\n    pub org: String,\n}\n\npub fn parse_ado_url(input: &str) -> Option<AdoRemote> {\n    None\n}\n",
                ),
                (
                    "src/components/gn-provider-dialog-base.ts",
                    "export interface ProviderDialogConfig {\n  title: string;\n}\nexport class GnProviderDialogBase {\n  public validateInput(): boolean { return true; }\n}\nexport const DEFAULT_PROVIDER_TIMEOUT = 5000;\n",
                ),
                (
                    "scripts/analyzer.py",
                    "class CommitAnalyzer:\n    pass\n\ndef compute_rrf_fusion(vec_rank, bm25_rank):\n    return 0.0\n",
                ),
                (
                    "pkg/git/walker.go",
                    "type WalkOptions struct {}\nfunc (w *WalkOptions) WalkCommits() error { return nil }\n",
                ),
            ],
        );

        let repo = test_repo.repo();
        let commit = repo.find_commit(oid).expect("find created commit");
        let (files, symbols) = extract_commit_code_context(&repo, &commit);

        assert!(files.contains(&"src-tauri/src/services/ado.rs".to_string()));
        assert!(files.contains(&"src/components/gn-provider-dialog-base.ts".to_string()));
        assert!(files.contains(&"scripts/analyzer.py".to_string()));
        assert!(files.contains(&"pkg/git/walker.go".to_string()));

        assert!(
            symbols.contains(&"AdoRemote".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"parse_ado_url".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"ProviderDialogConfig".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"GnProviderDialogBase".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"DEFAULT_PROVIDER_TIMEOUT".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"CommitAnalyzer".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"compute_rrf_fusion".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"WalkOptions".to_string()),
            "symbols: {:?}",
            symbols
        );
        assert!(
            symbols.contains(&"WalkCommits".to_string()),
            "symbols: {:?}",
            symbols
        );

        let formatted = format_commit_embedding_text("Add parsers", &files, &symbols);
        assert!(formatted.starts_with("Add parsers\nFiles: "));
        assert!(formatted.contains("\nSymbols: "));
        assert!(formatted.contains("parse_ado_url"));
    }

    #[test]
    fn test_hybrid_rrf_search_boosts_symbol_and_file_matches() {
        let index = EmbeddingIndex::open_in_memory().expect("open in-memory index");

        let query_vec = make_test_embedding(1.0);
        // Slightly less aligned vector than commit_generic, but exact symbol & file match
        let mut near_vec = query_vec.clone();
        near_vec[0] += 0.15;
        let norm: f32 = near_vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut near_vec {
            *x /= norm;
        }
        let far_vec = make_test_embedding(3.5);

        index
            .upsert_commits_batch(&[
                IndexedCommitRecord {
                    oid: "1111111111111111".to_string(),
                    summary: "General URL cleanup".to_string(),
                    message: "General URL cleanup across helpers".to_string(),
                    files: vec!["src/utils/url.rs".to_string()],
                    symbols: vec!["normalize_http_url".to_string()],
                    embedding: query_vec.clone(),
                },
                IndexedCommitRecord {
                    oid: "2222222222222222".to_string(),
                    summary: "Support Azure DevOps remotes".to_string(),
                    message: "Support Azure DevOps remotes\n\nHandle SSH and HTTPS URLs"
                        .to_string(),
                    files: vec![
                        "src-tauri/src/services/ado.rs".to_string(),
                        "src/components/dialogs/gn-provider-dialog-base.ts".to_string(),
                    ],
                    symbols: vec![
                        "parse_ado_url".to_string(),
                        "GnProviderDialogBase".to_string(),
                    ],
                    embedding: near_vec,
                },
                IndexedCommitRecord {
                    oid: "3333333333333333".to_string(),
                    summary: "Fix detached HEAD state during rebase".to_string(),
                    message: "Fix detached HEAD state during rebase".to_string(),
                    files: vec!["src-tauri/src/commands/rebase.rs".to_string()],
                    symbols: vec!["recover_detached_head".to_string()],
                    embedding: far_vec,
                },
            ])
            .expect("upsert batch");

        // 1. Exact symbol query `parse_ado_url` ranks commit 2222222222222222 first via RRF (vector + bm25)
        let symbol_results = index
            .search("parse_ado_url", &query_vec, 10)
            .expect("hybrid symbol search");
        assert!(!symbol_results.is_empty());
        assert_eq!(symbol_results[0].oid, "2222222222222222");
        assert!(symbol_results[0]
            .matched_symbols
            .contains(&"parse_ado_url".to_string()));
        assert!(symbol_results[0]
            .match_sources
            .contains(&"vector".to_string()));
        assert!(symbol_results[0]
            .match_sources
            .contains(&"bm25".to_string()));
        assert!(
            (0.0..=1.0).contains(&symbol_results[0].similarity),
            "similarity normalized in [0, 1]"
        );

        // 2. Hyphenated file query `gn-provider-dialog-base` ranks commit 2222222222222222 first
        let file_results = index
            .search("gn-provider-dialog-base", &query_vec, 10)
            .expect("hybrid file search");
        assert!(!file_results.is_empty());
        assert_eq!(file_results[0].oid, "2222222222222222");
        assert_eq!(
            file_results[0].matched_files[0],
            "src/components/dialogs/gn-provider-dialog-base.ts"
        );
    }

    #[test]
    fn test_legacy_commit_meta_schema_migration() {
        ensure_sqlite_vec_registered();
        let conn = Connection::open_in_memory().expect("open in-memory connection");

        // Create legacy commit_meta without files_text or symbols_text
        conn.execute_batch(
            "
            CREATE TABLE commit_meta (
                oid TEXT PRIMARY KEY,
                message TEXT NOT NULL
            );
            INSERT INTO commit_meta (oid, message) VALUES (
                'legacy_oid_001',
                'Fix detached head recovery in worktree'
            );
            ",
        )
        .expect("seed legacy commit_meta");

        // Opening EmbeddingIndex on the legacy database should migrate columns and backfill commit_fts
        let index = EmbeddingIndex::from_connection(conn).expect("migrate legacy schema");
        let cols = index
            .table_columns("commit_meta")
            .expect("read migrated columns");
        assert!(cols.contains("files_text"));
        assert!(cols.contains("symbols_text"));
        assert_eq!(index.count().unwrap(), 1);

        // Searching via BM25 on the migrated legacy row works immediately
        let results = index
            .search("where did we fix detached head", &[], 5)
            .expect("search migrated legacy row");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].oid, "legacy_oid_001");
        assert_eq!(results[0].match_sources, vec!["bm25".to_string()]);
    }
}
