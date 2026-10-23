/**
 * Welcome Screen Tests
 *
 * Verifies the "Profiles & Accounts" action is reachable without an open
 * repository and dispatches the `open-profile-manager` event that app-shell
 * listens for.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return Promise.resolve(false);
  switch (command) {
    case 'get_recent_repositories':
      return Promise.resolve([]);
    case 'list_workspaces':
      return Promise.resolve([]);
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-welcome.ts';
import type { GnWelcome } from '../gn-welcome.ts';

describe('gn-welcome Profiles & Accounts action', () => {
  let el: GnWelcome;

  beforeEach(async () => {
    el = await fixture<GnWelcome>(html`<gn-welcome></gn-welcome>`);
    await el.updateComplete;
  });

  it('renders a Profiles & Accounts action button', () => {
    const buttons = Array.from(el.shadowRoot?.querySelectorAll('button.action-btn') ?? []);
    const profileBtn = buttons.find((b) => b.textContent?.includes('Profiles & Accounts'));
    expect(profileBtn, 'Profiles & Accounts action button exists').to.exist;
  });

  it('dispatches a bubbling, composed open-profile-manager event when clicked', () => {
    let detail: CustomEvent | null = null;
    el.addEventListener('open-profile-manager', (e) => { detail = e as CustomEvent; });

    const buttons = Array.from(el.shadowRoot?.querySelectorAll('button.action-btn') ?? []);
    const profileBtn = buttons.find((b) => b.textContent?.includes('Profiles & Accounts')) as
      | HTMLButtonElement
      | undefined;
    profileBtn?.click();

    expect(detail, 'open-profile-manager dispatched').to.not.be.null;
    expect(detail!.bubbles, 'bubbles').to.be.true;
    expect(detail!.composed, 'composed').to.be.true;
  });
});
