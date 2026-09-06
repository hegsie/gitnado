/**
 * Tests for the welcome screen's drop affordance and its "Scan" action: the
 * two entry points added so a repository can be opened by dropping a folder on
 * the window, or found on disk instead of typed into a picker.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];
const mockResponses: Record<string, (args: Record<string, unknown>) => unknown> = {};

let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: Record<string, unknown>) => {
    invokeCallArgs.push({ command, args: args || {} });
    const handler = mockResponses[command];
    try {
      return Promise.resolve(handler ? handler(args || {}) : null);
    } catch (err) {
      return Promise.reject(err);
    }
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-welcome.ts';
import type { LvWelcome } from '../lv-welcome.ts';
import { repositoryStore, uiStore } from '../../../stores/index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

function actionButton(el: LvWelcome, label: string): HTMLButtonElement {
  const match = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.action-btn')).find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!match) throw new Error(`no action button labelled "${label}"`);
  return match;
}

describe('lv-welcome drop affordance and scan action', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
    for (const key of Object.keys(mockResponses)) {
      delete mockResponses[key];
    }
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  it('shows the drop affordance only while a drag is over the window', async () => {
    const el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);
    expect(el.shadowRoot!.querySelector('.drop-overlay')).to.equal(null);

    el.dragActive = true;
    await el.updateComplete;
    const overlay = el.shadowRoot!.querySelector('.drop-overlay');
    expect(overlay).to.not.equal(null);
    expect(overlay!.textContent).to.contain('Drop a folder');

    el.dragActive = false;
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.drop-overlay')).to.equal(null);
  });

  it('asks the shell to scan the folder the user picked', async () => {
    mockResponses['plugin:dialog|open'] = () => '/code';
    const el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);

    const events: Array<{ path: string; mode: string }> = [];
    el.addEventListener('open-repository-scan', (e) => {
      events.push((e as CustomEvent<{ path: string; mode: string }>).detail);
    });

    actionButton(el, 'Scan').click();
    await waitUntil(() => events.length > 0, 'the scan request');

    expect(events[0]).to.deep.equal({ path: '/code', mode: 'scan' });
  });

  it('does nothing when the folder picker is cancelled', async () => {
    mockResponses['plugin:dialog|open'] = () => null;
    const el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);

    let requested = false;
    el.addEventListener('open-repository-scan', () => {
      requested = true;
    });

    actionButton(el, 'Scan').click();
    await waitUntil(
      () => invokeCallArgs.some((c) => c.command === 'plugin:dialog|open'),
      'the folder picker',
    );
    await el.updateComplete;

    expect(requested).to.equal(false);
    // Cancelling a picker is not an error and must not toast.
    expect(uiStore.getState().toasts.length).to.equal(0);
  });

  it('surfaces a folder picker failure', async () => {
    mockResponses['plugin:dialog|open'] = () => {
      throw new Error('no file dialog available');
    };
    const el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);

    actionButton(el, 'Scan').click();
    await waitUntil(() => uiStore.getState().toasts.length > 0, 'the failure toast');

    const toasts = uiStore.getState().toasts;
    expect(toasts[0].type).to.equal('error');
    expect(toasts[0].message).to.contain('no file dialog available');
  });

  it('opens the init dialog pre-filled with a dropped folder', async () => {
    const el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);

    el.openInitDialog('/projects/new-thing');
    await el.updateComplete;

    const initDialog = el.shadowRoot!.querySelector('lv-init-dialog') as any;
    await initDialog.updateComplete;
    expect(initDialog.path).to.equal('/projects/new-thing');
    const input = initDialog.shadowRoot.querySelector('input') as HTMLInputElement;
    expect(input.value).to.equal('/projects/new-thing');
  });
});
