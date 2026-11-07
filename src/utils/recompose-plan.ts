import type { RecomposeGroup, RecomposeSource } from '../services/git/merge-rebase.ts';

/** A group being edited in the composer (an id keeps rows stable). */
export interface DraftGroup extends RecomposeGroup {
  id: number;
}

let nextId = 1;
export function newGroup(message = '', files: string[] = []): DraftGroup {
  return { id: nextId++, message, files };
}

/**
 * The starting plan without AI: one commit per original commit for a range
 * (each file goes to the LAST original commit that touched it, so the plan
 * reproduces the history it replaces), or a single commit for uncommitted
 * changes.
 */
export function initialPlan(source: RecomposeSource): DraftGroup[] {
  if (source.mode === 'worktree') {
    return source.files.length ? [newGroup('', source.files.map((f) => f.path))] : [];
  }
  const changed = new Set(source.files.map((f) => f.path));
  const owner = new Map<string, number>();
  source.commits.forEach((c, i) => c.files.forEach((f) => { if (changed.has(f)) owner.set(f, i); }));
  const groups = source.commits.map((c) => newGroup(c.summary, []));
  for (const [file, i] of owner) groups[i].files.push(file);
  // A file changed and then changed back is in no commit's net change but
  // may still differ from the base; give anything unowned to the last group.
  const kept = groups.filter((g) => g.files.length > 0);
  const unowned = [...changed].filter((f) => !owner.has(f));
  if (unowned.length) {
    if (kept.length) kept[kept.length - 1].files.push(...unowned);
    else kept.push(newGroup(source.commits.at(-1)?.summary ?? '', unowned));
  }
  return kept.map((g) => ({ ...g, files: [...g.files].sort() }));
}

/**
 * Turn an AI suggestion into a valid plan: unknown paths dropped, each file
 * kept in its first group only, empty groups removed, and anything the model
 * left out put into a trailing "Remaining changes" commit.
 */
export function planFromSuggestion(
  source: RecomposeSource,
  groups: Array<{ files: string[]; suggestedMessage: string; label?: string }>,
): DraftGroup[] {
  const changed = new Set(source.files.map((f) => f.path));
  const used = new Set<string>();
  const plan: DraftGroup[] = [];
  for (const g of groups) {
    const files = g.files.filter((f) => changed.has(f) && !used.has(f));
    files.forEach((f) => used.add(f));
    if (files.length) plan.push(newGroup(g.suggestedMessage || g.label || '', files));
  }
  const rest = [...changed].filter((f) => !used.has(f)).sort();
  if (rest.length) plan.push(newGroup('chore: remaining changes', rest));
  return plan;
}

/** Files not yet in any commit. */
export function unassignedFiles(source: RecomposeSource, groups: RecomposeGroup[]): string[] {
  const used = new Set(groups.flatMap((g) => g.files));
  return source.files.map((f) => f.path).filter((f) => !used.has(f));
}

/** Move `file` into group `toId` (or out of every group when toId is null). */
export function moveFile(groups: DraftGroup[], file: string, toId: number | null): DraftGroup[] {
  return groups.map((g) => {
    const without = g.files.filter((f) => f !== file);
    return g.id === toId ? { ...g, files: [...without, file].sort() } : { ...g, files: without };
  });
}

/** Why the plan cannot be applied yet, or null. Mirrors the backend's checks. */
export function planProblem(source: RecomposeSource, groups: RecomposeGroup[]): string | null {
  if (groups.length === 0) return 'Add at least one commit';
  for (const [i, g] of groups.entries()) {
    if (!g.message.trim()) return `Commit ${i + 1} needs a message`;
    if (g.files.length === 0) return `Commit ${i + 1} has no files`;
  }
  if (source.mode === 'range') {
    const left = unassignedFiles(source, groups);
    if (left.length) return `Put every changed file in a commit (${left.length} left)`;
  }
  return null;
}
