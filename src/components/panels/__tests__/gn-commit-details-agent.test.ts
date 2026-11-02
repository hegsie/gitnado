/**
 * Commit details: agent attribution badge (roadmap 4.1, issue #608).
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let cbId = 0;
let attribution: Record<string, unknown> = {};
let attributionFails = false;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

const mockInvoke: MockInvoke = async (command, args) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (command === 'get_agent_attribution') {
    if (attributionFails) throw { code: 'COMMAND_ERROR', message: 'bad note' };
    const oid = (args as { oid: string }).oid;
    return attribution[oid] ?? null;
  }
  if (command === 'get_commit_files') return [];
  return null;
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-commit-details.ts';
import type { GnCommitDetails } from '../gn-commit-details.ts';
import type { Commit } from '../../../types/git.types.ts';

const now = Math.floor(Date.now() / 1000);
function commit(oid: string): Commit {
  return {
    oid,
    shortId: oid.slice(0, 7),
    summary: 'Change',
    message: 'Change',
    body: null,
    timestamp: now,
    author: { name: 'Dev', email: 'dev@example.com', timestamp: now },
    committer: { name: 'Dev', email: 'dev@example.com', timestamp: now },
    parentIds: [],
  };
}

async function render(c: Commit): Promise<GnCommitDetails> {
  const el = await fixture<GnCommitDetails>(
    html`<gn-commit-details .repositoryPath=${'/repo'} .commit=${c}></gn-commit-details>`,
  );
  await el.updateComplete;
  return el;
}

describe('gn-commit-details agent attribution', () => {
  beforeEach(() => {
    attribution = {};
    attributionFails = false;
    invokeHistory.length = 0;
  });

  it('shows which agent session wrote the commit', async () => {
    attribution = { agent123: { agent: 'Claude Code', sessionId: '0f3a9c2e-1111-2222' } };
    const el = await render(commit('agent123'));
    await waitUntil(() => el.shadowRoot!.querySelector('.agent-badge'), 'no agent badge');

    const badge = el.shadowRoot!.querySelector<HTMLElement>('.agent-badge')!;
    expect(badge.textContent).to.contain('Written by Claude Code');
    expect(badge.querySelector('.agent-session')!.textContent).to.equal('0f3a9c2e');
    expect(badge.title).to.contain('0f3a9c2e-1111-2222');
    const call = invokeHistory.find((c) => c.command === 'get_agent_attribution')!;
    expect(call.args).to.deep.equal({ path: '/repo', oid: 'agent123' });
  });

  it('shows no badge for a human commit, and clears it when switching commits', async () => {
    attribution = { agent123: { agent: 'Claude Code', sessionId: null } };
    const el = await render(commit('agent123'));
    await waitUntil(() => el.shadowRoot!.querySelector('.agent-badge'));
    expect(el.shadowRoot!.querySelector('.agent-badge')!.textContent!.trim()).to.equal(
      'Written by Claude Code',
    );

    el.commit = commit('human456');
    await el.updateComplete;
    await waitUntil(
      () => invokeHistory.filter((c) => c.command === 'get_agent_attribution').length === 2,
    );
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.agent-badge')).to.be.null;
  });

  it('shows no badge when the lookup fails', async () => {
    attributionFails = true;
    const el = await render(commit('x1'));
    await waitUntil(() => invokeHistory.some((c) => c.command === 'get_agent_attribution'));
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.agent-badge')).to.be.null;
  });
});
