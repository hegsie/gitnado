import type { RestackPlan } from '../types/git.types.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first conflict in a plan, as a sentence, or null when it applies cleanly. */
export function restackConflictMessage(plan: RestackPlan): string | null {
  const step = plan.steps.find((s) => s.status === 'conflict');
  if (!step) return null;
  const where = step.conflictCommit ? ` at "${step.conflictCommit}"` : '';
  const blocked = plan.steps.filter((s) => s.status === 'blocked').map((s) => s.branch);
  const tail = blocked.length > 0 ? ` (${blocked.join(', ')} above it would wait on it)` : '';
  return `Restacking would conflict: ${step.branch}${where} in ${step.conflictFiles.join(', ')}${tail}. `
    + `Nothing was changed — rebase ${step.branch} onto ${step.onto} to resolve it, then restack again.`;
}

/** One line per branch that would change, for the confirmation dialog. */
export function restackSummaryLines(plan: RestackPlan): string[] {
  return plan.steps.flatMap((s) => {
    switch (s.status) {
      case 'restacked':
        return [`• ${s.branch} → onto ${s.onto} (${plural(s.commits, 'commit')})`];
      case 'merged':
        return [`• ${s.branch} is already merged into ${s.onto} — skipped; branches above it move onto ${s.onto}`];
      default:
        return [];
    }
  });
}

/** Branches a successful restack moved. */
export function restackedCount(plan: RestackPlan): number {
  return plan.steps.filter((s) => s.status === 'restacked').length;
}
