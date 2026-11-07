/**
 * Agent guardrails before push (roadmap 4.1, #609).
 *
 * Before a push leaves the machine, the commits it would publish are run
 * through the Vibe Check's local secret scan. Depending on Settings → Agent
 * Guardrails it warns (asks to push anyway) or blocks, for agent branches only
 * (matched by `agentBranchPattern`) or for every branch.
 */
import * as gitService from './git.service.ts';
import { showConfirm } from './dialog.service.ts';
import { showToast } from './notification.service.ts';
import { settingsStore } from '../stores/settings.store.ts';
import { repositoryStore } from '../stores/repository.store.ts';
import type { OutgoingScan } from './git/repository.ts';

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Whether `branch` matches any of the comma-separated globs in `patterns`. */
export function branchMatchesPattern(branch: string, patterns: string): boolean {
  return patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => globToRegExp(p).test(branch));
}

/** The findings of a scan as lines for a dialog or toast. */
export function describeFindings(scan: OutgoingScan): string[] {
  return scan.findings.map((f) => `• ${f.message}${f.filePath ? ` (${f.filePath})` : ''}`);
}

function currentBranchOf(repoPath: string): string | null {
  const repo = repositoryStore.getState().openRepositories.find((r) => r.repository.path === repoPath);
  const branch = repo?.currentBranch;
  return branch && !branch.isRemote ? branch.name : null;
}

/**
 * Decide whether a push of `repoPath`'s current branch may go ahead.
 * Resolves true to push, false when the guardrail stopped it (the user has
 * already been told why).
 */
export async function checkPushGuardrail(repoPath: string, branchOverride?: string): Promise<boolean> {
  const { pushGuardrail, pushGuardrailScope, agentBranchPattern } = settingsStore.getState();
  if (pushGuardrail === 'off') return true;
  const branch = branchOverride ?? currentBranchOf(repoPath);
  if (!branch) return true;
  if (pushGuardrailScope === 'agent' && !branchMatchesPattern(branch, agentBranchPattern)) return true;

  const blocking = pushGuardrail === 'block';
  const result = await gitService.scanOutgoingChanges(repoPath, branch);
  if (!result.success || !result.data) {
    const reason = result.error?.message ?? 'Unknown error';
    if (blocking) {
      showToast(`Push blocked: the guardrail could not scan ${branch} (${reason})`, 'error');
      return false;
    }
    return showConfirm(
      'Push guardrail',
      `The commits on ${branch} could not be scanned for secrets (${reason}).\n\nPush anyway?`,
      'warning',
    );
  }

  const scan = result.data;
  if (scan.findings.length === 0) {
    if (scan.truncated) showToast(`${branch}: the push was too large to scan completely`, 'warning');
    return true;
  }

  const count = scan.findings.length;
  const what = `${count} possible secret${count === 1 ? '' : 's'}`;
  const lines = describeFindings(scan).join('\n');
  if (blocking) {
    showToast(
      `Push blocked: ${what} in ${branch}. ${describeFindings(scan).join(' ')} Remove them (or change Settings → Agent Guardrails) and push again.`,
      'error',
    );
    return false;
  }
  return showConfirm(
    'Possible secrets in this push',
    `${branch} would publish ${what}:\n\n${lines}\n\nPush anyway?`,
    'warning',
  );
}
