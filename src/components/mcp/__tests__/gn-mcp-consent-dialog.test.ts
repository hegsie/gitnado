/**
 * MCP write approval dialog tests (fixture-based). Only Tauri invoke is mocked.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let cbId = 0;
let pending: unknown[] = [];
let respondError: string | null = null;

const mockInvoke: MockInvoke = async (command) => {
  switch (command) {
    case 'get_pending_mcp_consents':
      return pending;
    case 'respond_mcp_consent':
      if (respondError) throw new Error(respondError);
      return null;
    case 'plugin:notification|is_permission_granted':
      return false;
    default:
      return null;
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../gn-mcp-consent-dialog.ts';
import type { GnMcpConsentDialog } from '../gn-mcp-consent-dialog.ts';
import type { McpConsentRequest } from '../../../services/mcp.service.ts';
import { uiStore } from '../../../stores/ui.store.ts';

function req(id: number, extra: Partial<McpConsentRequest> = {}): McpConsentRequest {
  return {
    id,
    tool: 'commit',
    repoPath: '/repo/app',
    branch: 'agent/fix',
    summary: 'Commit 2 staged files on agent/fix',
    details: ['Message: fix login', '  src/a.ts', '  src/b.ts'],
    requestedAt: 0,
    timeoutSecs: 120,
    ...extra,
  };
}

async function render(): Promise<GnMcpConsentDialog> {
  const el = await fixture<GnMcpConsentDialog>(html`<gn-mcp-consent-dialog></gn-mcp-consent-dialog>`);
  await waitUntil(() => invokeCalls.some((c) => c.command === 'get_pending_mcp_consents'));
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const $ = (el: GnMcpConsentDialog, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const toasts = (type: string) => uiStore.getState().toasts.filter((t) => t.type === type).map((t) => t.message);
const modalOpen = (el: GnMcpConsentDialog) =>
  (el.shadowRoot!.querySelector('gn-modal') as HTMLElement & { open: boolean }).open;
const respondCalls = () => invokeCalls.filter((c) => c.command === 'respond_mcp_consent').map((c) => c.args);

describe('gn-mcp-consent-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    pending = [];
    respondError = null;
    uiStore.setState({ toasts: [] });
  });

  it('renders nothing while no agent is asking', async () => {
    const el = await render();
    expect(modalOpen(el)).to.be.false;
  });

  it('shows a waiting request with its preview, including ones from before a reload', async () => {
    pending = [req(1)];
    const el = await render();
    expect($(el, '.summary')!.textContent).to.contain('Commit 2 staged files');
    expect($(el, '.where')!.textContent).to.contain('app');
    expect($(el, '.where code')!.textContent).to.equal('agent/fix');
    expect($(el, '.details')!.textContent).to.contain('src/b.ts');
  });

  it('approves the request', async () => {
    const el = await render();
    el.enqueue(req(5));
    await el.updateComplete;
    $(el, '.approve-btn')!.click();
    await waitUntil(() => respondCalls().length === 1);
    expect(respondCalls()[0]).to.deep.equal({ id: 5, approve: true, alwaysAllowPattern: undefined });
    await waitUntil(() => !modalOpen(el), 'modal did not close');
  });

  it('approves and saves an always-allow rule with an edited pattern', async () => {
    const el = await render();
    el.enqueue(req(6));
    await el.updateComplete;
    const pattern = $(el, '.pattern-input') as HTMLInputElement;
    expect(pattern.value).to.equal('agent/fix', 'defaults to the exact branch');
    ($(el, '.remember-check') as HTMLInputElement).click();
    pattern.value = 'agent/*';
    pattern.dispatchEvent(new Event('input'));
    $(el, '.approve-btn')!.click();
    await waitUntil(() => respondCalls().length === 1);
    expect(respondCalls()[0]).to.deep.equal({ id: 6, approve: true, alwaysAllowPattern: 'agent/*' });
  });

  it('denies and says so', async () => {
    const el = await render();
    el.enqueue(req(7));
    await el.updateComplete;
    ($(el, '.remember-check') as HTMLInputElement).click();
    $(el, '.deny-btn')!.click();
    await waitUntil(() => respondCalls().length === 1);
    expect(respondCalls()[0]).to.deep.equal({ id: 7, approve: false, alwaysAllowPattern: undefined });
    await waitUntil(() => toasts('info').length > 0, 'no declined toast');
    expect(toasts('info')[0]).to.contain('Declined');
    await waitUntil(() => !modalOpen(el));
  });

  it('works through a queue in order and shows how many are waiting', async () => {
    const el = await render();
    el.enqueue(req(1, { summary: 'first' }));
    el.enqueue(req(2, { summary: 'second', branch: 'agent/other' }));
    el.enqueue(req(1, { summary: 'duplicate' }));
    await el.updateComplete;
    expect($(el, '.summary')!.textContent).to.equal('first');
    expect($(el, '.queue')!.textContent).to.contain('1 more waiting');

    $(el, '.approve-btn')!.click();
    await waitUntil(() => $(el, '.summary')?.textContent === 'second');
    expect(($(el, '.pattern-input') as HTMLInputElement).value).to.equal('agent/other');
    expect($(el, '.queue')).to.be.null;
  });

  it('drops a request that expired and tells the user', async () => {
    const el = await render();
    el.enqueue(req(9, { summary: 'Stash 3 changed files' }));
    await el.updateComplete;
    el.resolved({ id: 9, approved: false, expired: true });
    await el.updateComplete;
    expect(($(el, 'gn-modal') as HTMLElement & { open: boolean }).open).to.be.false;
    expect(toasts('warning')[0]).to.contain('expired');
  });

  it('hides the always-allow option without a branch', async () => {
    const el = await render();
    el.enqueue(req(3, { branch: null }));
    await el.updateComplete;
    expect($(el, '.remember-check')).to.be.null;
    expect($(el, '.where')!.textContent).to.contain('detached HEAD');
  });

  it('reports a failed answer and moves on', async () => {
    respondError = 'This request is no longer waiting for an answer';
    const el = await render();
    el.enqueue(req(4));
    await el.updateComplete;
    $(el, '.approve-btn')!.click();
    await waitUntil(() => toasts('error').length > 0);
    expect(toasts('error')[0]).to.contain('no longer waiting');
    await waitUntil(() => !modalOpen(el));
  });

  it('announces applied writes and asks the shell to refresh the repository', async () => {
    const el = await render();
    const events: CustomEvent[] = [];
    el.addEventListener('mcp-write-applied', (e) => events.push(e as CustomEvent));
    el.applied({ tool: 'commit', repoPath: '/repo/app', summary: 'Commit 1 staged file on agent/x', byPolicy: true });
    expect(toasts('info')[0]).to.contain('Agent: Commit 1 staged file');
    expect(toasts('info')[0]).to.contain('always allowed');
    expect(events[0].detail).to.deep.equal({ repositoryPath: '/repo/app', tool: 'commit' });
  });
});
