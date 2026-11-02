/**
 * Agent guardrails before push (#609): the decision itself, and that the push
 * runner honours it — no push IPC when it says stop, and the push lock is
 * released so the next push can run.
 */
const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];
let responses: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invoked.push({ command, args });
    if (command in responses) {
      const value = responses[command];
      if (value instanceof Error) return Promise.reject({ code: 'COMMAND_ERROR', message: value.message });
      return Promise.resolve(typeof value === 'function' ? (value as () => unknown)() : value);
    }
    if (command === 'get_remote_status') return Promise.resolve({ ahead: 0, behind: 0 });
    return Promise.resolve(null);
  },
  transformCallback: () => 0,
};

import { expect, waitUntil } from '@open-wc/testing';
import { branchMatchesPattern, checkPushGuardrail } from '../push-guardrail.service.ts';
import { runPush } from '../remote-operations.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';
import { repositoryStore } from '../../stores/repository.store.ts';
import { uiStore } from '../../stores/ui.store.ts';
import { resetRefOpLocks, isPushRunning } from '../../utils/ref-lock.ts';

const REPO = '/repo/g';
const LEAK = {
  branch: 'agent/fix',
  commits: 2,
  findings: [{ category: 'secret', severity: 'error', message: 'Possible AWS Access Key ID detected', filePath: 'cfg/aws.env' }],
  riskLevel: 'high',
  truncated: false,
};
const CLEAN = { ...LEAK, findings: [], riskLevel: 'low' };

function openRepoOn(branch: string | null): void {
  repositoryStore.setState({
    openRepositories: [{
      repository: { path: REPO, name: 'g', isValid: true, isBare: false },
      branches: [],
      currentBranch: branch ? { name: branch, shorthand: branch, isHead: true, isRemote: false, upstream: null } : null,
      remotes: [{ name: 'origin', url: 'https://example.test/g.git' }],
      remotesLoaded: true,
      tags: [],
      stashes: [],
    }],
    activeIndex: 0,
  } as never);
}

const toasts = () => uiStore.getState().toasts.map((t) => `${t.type}:${t.message}`);
const count = (command: string) => invoked.filter((c) => c.command === command).length;
const confirmText = () => JSON.stringify(invoked.find((c) => c.command === 'plugin:dialog|message')?.args ?? '');

describe('push guardrail', () => {
  beforeEach(() => {
    invoked.length = 0;
    responses = {};
    resetRefOpLocks();
    uiStore.setState({ toasts: [] });
    settingsStore.setState({
      pushGuardrail: 'warn', pushGuardrailScope: 'agent', agentBranchPattern: 'agent/*',
      offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [],
    });
    openRepoOn('agent/fix');
  });

  afterEach(() => {
    resetRefOpLocks();
    repositoryStore.setState({ openRepositories: [], activeIndex: 0 } as never);
  });

  it('matches comma-separated globs', () => {
    expect(branchMatchesPattern('agent/fix', 'agent/*')).to.be.true;
    expect(branchMatchesPattern('claude/x', 'agent/*, claude/*')).to.be.true;
    expect(branchMatchesPattern('feature/agent', 'agent/*')).to.be.false;
    expect(branchMatchesPattern('a.b', 'a?b')).to.be.true;
    expect(branchMatchesPattern('axb', 'a.b')).to.be.false;
    expect(branchMatchesPattern('x', ' , ')).to.be.false;
  });

  it('does not scan when off, outside the agent pattern, or detached', async () => {
    settingsStore.setState({ pushGuardrail: 'off' });
    expect(await checkPushGuardrail(REPO)).to.be.true;
    settingsStore.setState({ pushGuardrail: 'block' });
    openRepoOn('feature/mine');
    expect(await checkPushGuardrail(REPO)).to.be.true;
    openRepoOn(null);
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(count('scan_outgoing_changes')).to.equal(0);
  });

  it('scans every branch when the scope is all', async () => {
    settingsStore.setState({ pushGuardrailScope: 'all' });
    openRepoOn('feature/mine');
    responses.scan_outgoing_changes = CLEAN;
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(invoked.find((c) => c.command === 'scan_outgoing_changes')!.args).to.deep.equal({ path: REPO, branch: 'feature/mine' });
  });

  it('lets a clean push through silently', async () => {
    responses.scan_outgoing_changes = CLEAN;
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(count('plugin:dialog|message')).to.equal(0);
    expect(toasts()).to.deep.equal([]);
  });

  it('warns about a push too large to scan fully', async () => {
    responses.scan_outgoing_changes = { ...CLEAN, truncated: true };
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(toasts()).to.deep.equal(['warning:agent/fix: the push was too large to scan completely']);
  });

  it('warn mode asks, naming each finding and file, and follows the answer', async () => {
    responses.scan_outgoing_changes = LEAK;
    responses['plugin:dialog|message'] = 'Ok';
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(confirmText()).to.contain('agent/fix would publish 1 possible secret');
    expect(confirmText()).to.contain('Possible AWS Access Key ID detected (cfg/aws.env)');

    responses['plugin:dialog|message'] = 'Cancel';
    expect(await checkPushGuardrail(REPO)).to.be.false;
  });

  it('block mode refuses with an error that says how to proceed', async () => {
    settingsStore.setState({ pushGuardrail: 'block' });
    responses.scan_outgoing_changes = LEAK;
    expect(await checkPushGuardrail(REPO)).to.be.false;
    expect(toasts()[0]).to.match(/^error:Push blocked: 1 possible secret in agent\/fix\. .*Possible AWS Access Key ID detected \(cfg\/aws\.env\).*Settings → Agent Guardrails/);
    expect(count('plugin:dialog|message')).to.equal(0);
  });

  it('a failed scan asks in warn mode and blocks in block mode', async () => {
    responses.scan_outgoing_changes = new Error('git not found');
    responses['plugin:dialog|message'] = 'Ok';
    expect(await checkPushGuardrail(REPO)).to.be.true;
    expect(confirmText()).to.contain('could not be scanned for secrets (git not found)');

    settingsStore.setState({ pushGuardrail: 'block' });
    expect(await checkPushGuardrail(REPO)).to.be.false;
    expect(toasts()).to.include('error:Push blocked: the guardrail could not scan agent/fix (git not found)');
  });

  describe('in the push runner', () => {
    it('a blocked push never reaches git and releases the push lock', async () => {
      settingsStore.setState({ pushGuardrail: 'block' });
      responses.scan_outgoing_changes = LEAK;
      await runPush(REPO);
      expect(count('push')).to.equal(0);
      expect(isPushRunning(REPO)).to.be.false;
      // The lock is free: a second attempt scans again.
      await runPush(REPO);
      expect(count('scan_outgoing_changes')).to.equal(2);
    });

    it('a declined warning stops the push; an accepted one pushes', async () => {
      responses.scan_outgoing_changes = LEAK;
      responses['plugin:dialog|message'] = 'Cancel';
      await runPush(REPO);
      expect(count('push')).to.equal(0);

      responses['plugin:dialog|message'] = 'Ok';
      await runPush(REPO);
      await waitUntil(() => count('push') === 1, 'push sent');
    });

    it('a clean agent branch pushes after one scan', async () => {
      responses.scan_outgoing_changes = CLEAN;
      await runPush(REPO);
      await waitUntil(() => count('push') === 1, 'push sent');
      const scanAt = invoked.findIndex((c) => c.command === 'scan_outgoing_changes');
      const pushAt = invoked.findIndex((c) => c.command === 'push');
      expect(scanAt).to.be.lessThan(pushAt);
    });
  });
});
