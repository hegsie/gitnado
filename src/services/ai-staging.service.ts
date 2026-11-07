/**
 * AI Staging Service (#619 Hunk-Level AI Staging & #620 AI Fixup Targeting)
 */

import { invokeCommand } from './tauri-api.ts';
import type { CommandResult } from '../types/api.types.ts';

/**
 * Reference to a single diff hunk within a modified file.
 */
export interface HunkRef {
  filePath: string;
  hunkIndex: number;
  header: string;
  summary: string;
}

/**
 * A logical atomic commit group of diff hunks suggested by AI or deterministic clustering.
 */
export interface AiHunkSplitGroup {
  commitMessage: string;
  description: string;
  hunks: HunkRef[];
}

/**
 * Suggested target commit for a `fixup!` commit (`git absorb` + AI rationale).
 */
export interface FixupTargetSuggestion {
  commitOid: string;
  shortOid: string;
  commitSummary: string;
  author: string;
  confidence: number;
  overlappingFiles: string[];
  overlappingHunks: number;
  rationale: string;
}

/**
 * Suggest hunk-level atomic commit splits across modified files in the repository.
 *
 * The Rust backend gates optional AI enrichment behind `guard_ai_request` and
 * falls back to deterministic local hunk grouping when offline or when no AI
 * provider is available.
 */
export async function suggestHunkSplits(
  path: string,
): Promise<CommandResult<AiHunkSplitGroup[]>> {
  return invokeCommand<AiHunkSplitGroup[]>('suggest_hunk_splits', { path });
}

/**
 * Stage the specified hunks into the git index, returning the number of staged hunks.
 */
export async function stageHunkGroup(
  path: string,
  hunks: HunkRef[],
): Promise<CommandResult<number>> {
  return invokeCommand<number>('stage_hunk_group', { path, hunks });
}

/**
 * Suggest target commits for a `fixup!` commit by combining deterministic
 * hunk/line overlap scoring with optional AI rationale enrichment.
 *
 * The Rust backend gates optional AI enrichment behind `guard_ai_request` and
 * returns the deterministic local overlap ranking when offline.
 */
export async function suggestFixupTargets(
  path: string,
  maxCommits?: number,
): Promise<CommandResult<FixupTargetSuggestion[]>> {
  return invokeCommand<FixupTargetSuggestion[]>('suggest_fixup_targets', {
    path,
    maxCommits: maxCommits ?? null,
  });
}
