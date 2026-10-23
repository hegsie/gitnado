/**
 * A merged pull request must be badged "merged", not "closed".
 *
 * GitHub's REST API reports a merged PR with `state: "closed"` — merged-ness
 * lives in `merged_at`, which the backend already carries through as
 * `mergedAt`. getPrState() read only `state`, so every merged PR got the red
 * "closed" badge under the Closed and All filters, saying the work had been
 * abandoned when it had actually landed. The `.pr-state.merged` style existed
 * and nothing could reach it.
 */

// Mock Tauri API before importing any modules that use it
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let cbId = 0;
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-github-dialog.ts';
import type { GnGitHubDialog } from '../gn-github-dialog.ts';
import type { PullRequestSummary } from '../../../services/git.service.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

function pr(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    number: 1,
    title: 'A change',
    state: 'open',
    user: { login: 'octocat', id: 1, avatarUrl: '', name: null, email: null } as any,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergedAt: null,
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    draft: false,
    mergeable: true,
    htmlUrl: 'https://github.com/o/r/pull/1',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  } as PullRequestSummary;
}

async function stateOf(summary: PullRequestSummary): Promise<string> {
  const el = await fixture<GnGitHubDialog>(html`<gn-github-dialog></gn-github-dialog>`);
  return (el as any).getPrState(summary);
}

describe('gn-github-dialog pull request state badge', () => {
  it('badges a merged PR as merged, though GitHub calls its state closed', async () => {
    const state = await stateOf(
      pr({ state: 'closed', mergedAt: '2026-01-02T00:00:00Z' }),
    );
    expect(state, 'merged-ness comes from mergedAt, not state').to.equal('merged');
  });

  it('still badges a genuinely closed PR as closed', async () => {
    const state = await stateOf(pr({ state: 'closed', mergedAt: null }));
    expect(state).to.equal('closed');
  });

  it('badges an open PR as open', async () => {
    expect(await stateOf(pr({ state: 'open' }))).to.equal('open');
  });

  it('badges an open draft as draft', async () => {
    expect(await stateOf(pr({ state: 'open', draft: true }))).to.equal('draft');
  });

  // GitHub leaves `draft` set on a draft that was closed without merging, so
  // checking it first would label a dead PR "draft" forever.
  it('badges a closed draft as closed, not draft', async () => {
    const state = await stateOf(pr({ state: 'closed', draft: true, mergedAt: null }));
    expect(state).to.equal('closed');
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
