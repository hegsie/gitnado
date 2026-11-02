/**
 * Stacked pull requests (roadmap 4.3, #616): one request per level of a stack,
 * each based on the branch below it, each carrying a stack table that links
 * the whole stack.
 *
 * Planning is read-only (it lists the provider's open requests). Syncing then
 * creates the missing requests bottom-up, retargets any whose base no longer
 * matches the stack (e.g. after the bottom one merged and a restack moved the
 * next branch onto `main`), and rewrites the stack table in every one.
 */
import * as gitService from './git.service.ts';
import {
  createPullRequestFor,
  getPullRequestBody,
  listOpenPullRequests,
  updatePullRequestFor,
  type PullRequestProviderTarget,
  type SidebarPullRequest,
} from './pull-request.service.ts';
import { renderStackSection, spliceStackSection, type StackPrRef } from '../utils/stack-pr-table.ts';
import type { Branch, Stack } from '../types/git.types.ts';
import type { CommandResult } from '../types/api.types.ts';

export type StackPrAction = 'create' | 'retarget' | 'refresh' | 'skip';

export interface StackPrStep {
  branch: string;
  /** The base the request should have: the branch's stack parent. */
  base: string;
  action: StackPrAction;
  /** The existing request, when there is one. */
  existing?: SidebarPullRequest;
  /** Why a branch is skipped. */
  reason?: string;
}

export interface StackPrOutcome {
  branch: string;
  action: StackPrAction;
  ok: boolean;
  number?: number;
  url?: string;
  error?: string;
}

/** What syncing would do, without changing anything on the provider. */
export async function planStackPullRequests(
  stack: Stack,
  branches: Map<string, Branch>,
  target: PullRequestProviderTarget,
  token: string | null,
): Promise<CommandResult<StackPrStep[]>> {
  const open = await listOpenPullRequests(target, token);
  if (!open.success) return { success: false, error: open.error };
  const requests = open.data ?? [];

  const skipped = new Set<string>();
  const steps = stack.branches.map((entry): StackPrStep => {
    const skip = (reason: string): StackPrStep => {
      skipped.add(entry.name);
      return { branch: entry.name, base: entry.parent, action: 'skip', reason };
    };
    if (entry.parentMissing) return skip(`its parent ${entry.parent} no longer exists`);
    if (skipped.has(entry.parent)) return skip(`${entry.parent} below it has no ${target.itemNoun}`);
    if (!branches.get(entry.name)?.upstream) return skip('it has not been pushed yet');
    const existing = requests.find((r) => r.sourceBranch === entry.name);
    if (!existing) return { branch: entry.name, base: entry.parent, action: 'create' };
    return {
      branch: entry.name,
      base: entry.parent,
      action: existing.targetBranch === entry.parent ? 'refresh' : 'retarget',
      existing,
    };
  });
  return { success: true, data: steps };
}

async function titleFor(repoPath: string, branch: Branch | undefined, fallback: string): Promise<string> {
  if (!branch?.targetOid) return fallback;
  const commit = await gitService.getCommit(repoPath, branch.targetOid);
  return commit.success && commit.data?.summary ? commit.data.summary : fallback;
}

/** Carry out a plan: create, retarget and refresh the stack table everywhere. */
export async function syncStackPullRequests(
  repoPath: string,
  stack: Stack,
  branches: Map<string, Branch>,
  steps: StackPrStep[],
  target: PullRequestProviderTarget,
  token: string | null,
): Promise<StackPrOutcome[]> {
  const refPrefix = target.provider === 'gitlab' ? '!' : '#';
  const known = new Map<string, StackPrRef & { title: string }>();
  for (const s of steps) {
    if (s.existing) known.set(s.branch, { number: s.existing.number, url: s.existing.url, title: s.existing.title });
  }
  const outcomes = new Map<string, StackPrOutcome>();

  // 1. Create the missing requests bottom-up, so each one's base exists.
  for (const s of steps) {
    if (s.action === 'skip') {
      outcomes.set(s.branch, { branch: s.branch, action: 'skip', ok: true, error: s.reason });
      continue;
    }
    if (s.action !== 'create') continue;
    const title = await titleFor(repoPath, branches.get(s.branch), s.branch);
    const created = await createPullRequestFor(target, token, {
      head: s.branch,
      base: s.base,
      title,
      body: renderStackSection(stack, known, s.branch, refPrefix),
    });
    if (created.success && created.data) {
      known.set(s.branch, { ...created.data, title });
      outcomes.set(s.branch, { branch: s.branch, action: 'create', ok: true, ...created.data });
    } else {
      outcomes.set(s.branch, { branch: s.branch, action: 'create', ok: false, error: created.error?.message ?? 'Unknown error' });
    }
  }

  // 2. Every request now known gets the complete table; existing ones also
  //    get their base corrected.
  for (const s of steps) {
    const pr = known.get(s.branch);
    if (!pr || s.action === 'skip') continue;
    const prior = outcomes.get(s.branch);
    if (prior && !prior.ok) continue;
    const current = await getPullRequestBody(target, token, pr.number);
    const fail = (message: string) =>
      outcomes.set(s.branch, { branch: s.branch, action: s.action, ok: false, number: pr.number, url: pr.url, error: message });
    if (!current.success) {
      fail(current.error?.message ?? 'Could not read the description');
      continue;
    }
    const body = spliceStackSection(current.data, renderStackSection(stack, known, s.branch, refPrefix));
    const updated = await updatePullRequestFor(target, token, pr, {
      body,
      base: s.action === 'retarget' ? s.base : undefined,
    });
    if (!updated.success) {
      fail(updated.error?.message ?? 'Unknown error');
      continue;
    }
    if (!prior) outcomes.set(s.branch, { branch: s.branch, action: s.action, ok: true, number: pr.number, url: pr.url });
  }

  return steps.map((s) => outcomes.get(s.branch) ?? { branch: s.branch, action: s.action, ok: true });
}

/** One-line summary of a sync for a toast. */
export function summarizeStackSync(outcomes: StackPrOutcome[], noun: string): { message: string; ok: boolean } {
  const count = (a: StackPrAction) => outcomes.filter((o) => o.ok && o.action === a).length;
  const failed = outcomes.filter((o) => !o.ok);
  const skipped = outcomes.filter((o) => o.ok && o.action === 'skip');
  const parts: string[] = [];
  const created = count('create');
  const retargeted = count('retarget');
  const refreshed = count('refresh');
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (created) parts.push(`created ${plural(created)}`);
  if (retargeted) parts.push(`retargeted ${plural(retargeted)}`);
  if (refreshed) parts.push(`updated ${plural(refreshed)}`);
  if (skipped.length) parts.push(`skipped ${skipped.map((o) => `${o.branch} (${o.error})`).join(', ')}`);
  if (failed.length) parts.push(`failed: ${failed.map((o) => `${o.branch}: ${o.error}`).join('; ')}`);
  const text = parts.length ? parts.join(', ') : 'nothing to do';
  return { message: `Stack ${noun}s: ${text}`, ok: failed.length === 0 };
}
