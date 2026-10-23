/**
 * Picking an auth method must swap the connect form, not stack two of them.
 *
 * The connection tab rendered the Personal Access Token form in the *else*
 * branch of `authMethod === 'oauth' ? ... : ...`, and the GitHub App form in a
 * separate `authMethod === 'app'` block. Because the else branch was
 * unconditional, choosing "GitHub App" (which is simply not 'oauth') painted
 * the PAT password box, its "Delete Integration" button and its primary
 * "Connect to GitHub" button directly above the App ID / private key form.
 *
 * The user was shown two competing connect flows with two primary buttons, and
 * could press "Connect to GitHub" — saving an empty token — while filling in
 * App credentials. Each method must render exactly one form.
 *
 * Assertions below compare counts and text rather than element references:
 * a failed assertion holding a live DOM node cannot be serialised back to the
 * test runner, which turns a plain failure into a hung run.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
};

import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import '../gn-github-dialog.ts';
import type { GnGitHubDialog } from '../gn-github-dialog.ts';

interface DialogInternals {
  authMethod: 'oauth' | 'pat' | 'app';
  selectedAccountId: string | null;
}

async function openDisconnectedDialog(): Promise<GnGitHubDialog> {
  const el = await fixture<GnGitHubDialog>(html`<gn-github-dialog .open=${true}></gn-github-dialog>`);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

/** How many buttons in the dialog carry this label. */
function buttonCount(el: GnGitHubDialog, text: string): number {
  return Array.from(el.shadowRoot!.querySelectorAll('button')).filter((b) =>
    b.textContent?.includes(text),
  ).length;
}

function count(el: GnGitHubDialog, selector: string): number {
  return el.shadowRoot!.querySelectorAll(selector).length;
}

function primaryButtonLabels(el: GnGitHubDialog): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.btn-primary')).map((b) =>
    (b.textContent ?? '').trim(),
  );
}

function clickAuthMethod(el: GnGitHubDialog, text: string): void {
  const buttons = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.auth-method-btn'));
  const match = buttons.find((b) => b.textContent?.trim() === text);
  expect(
    match === undefined,
    `auth method button "${text}" must exist, saw: ${buttons.map((b) => (b.textContent ?? '').trim()).join(' | ')}`,
  ).to.be.false;
  match!.click();
}

const PAT_INPUT = 'input[type="password"]';
const APP_KEY_INPUT = 'textarea';

describe('gn-github-dialog auth method switching', () => {
  beforeEach(() => {
    mockInvoke = (command: string) => {
      if (command === 'check_github_connection') {
        return Promise.resolve({ connected: false, user: null, scopes: [] });
      }
      return Promise.resolve(null);
    };
    unifiedProfileStore.getState().setAccounts([]);
  });

  it('hides the Personal Access Token form when the GitHub App method is selected', async () => {
    const el = await openDisconnectedDialog();
    const internals = el as unknown as DialogInternals;

    internals.authMethod = 'app';
    await el.updateComplete;

    expect(count(el, PAT_INPUT), 'the PAT token box must not render in App mode').to.equal(0);
    expect(
      buttonCount(el, 'Connect to GitHub'),
      'the PAT connect button must not render in App mode',
    ).to.equal(0);
    expect(
      count(el, APP_KEY_INPUT),
      'the App private key field must render in App mode',
    ).to.equal(1);
  });

  it('shows a single primary action and no PAT delete button in GitHub App mode', async () => {
    const el = await openDisconnectedDialog();
    const internals = el as unknown as DialogInternals;

    internals.selectedAccountId = 'gh-acc-1';
    internals.authMethod = 'app';
    await el.updateComplete;

    expect(
      count(el, '.btn-row'),
      'App mode must show one button row, not two stacked flows',
    ).to.equal(1);
    expect(
      primaryButtonLabels(el),
      'App mode must offer exactly one primary action',
    ).to.deep.equal(['Connect via GitHub App']);
    expect(
      buttonCount(el, 'Delete Integration'),
      'the PAT delete button belongs to the PAT form only',
    ).to.equal(0);
  });

  it('renders only the PAT form for the Personal Access Token method', async () => {
    const el = await openDisconnectedDialog();
    const internals = el as unknown as DialogInternals;

    internals.authMethod = 'pat';
    await el.updateComplete;

    expect(count(el, PAT_INPUT), 'the PAT token box must render in PAT mode').to.equal(1);
    expect(buttonCount(el, 'Connect to GitHub'), 'the PAT connect button must render').to.equal(1);
    expect(count(el, APP_KEY_INPUT), 'the App form must not render in PAT mode').to.equal(0);
    expect(buttonCount(el, 'Connect via GitHub App')).to.equal(0);
  });

  it('switching App -> PAT -> App swaps the forms instead of stacking them', async () => {
    const el = await openDisconnectedDialog();

    clickAuthMethod(el, 'GitHub App');
    await el.updateComplete;
    expect(count(el, PAT_INPUT), 'App mode must not stack the PAT form').to.equal(0);
    expect(count(el, APP_KEY_INPUT), 'App mode must show the App form').to.equal(1);

    clickAuthMethod(el, 'Personal Access Token');
    await el.updateComplete;
    expect(count(el, PAT_INPUT), 'PAT mode must show the token box').to.equal(1);
    expect(count(el, APP_KEY_INPUT), 'PAT mode must not show the App form').to.equal(0);

    clickAuthMethod(el, 'GitHub App');
    await el.updateComplete;
    expect(count(el, APP_KEY_INPUT), 'switching back must show the App form').to.equal(1);
    expect(count(el, PAT_INPUT), 'switching back must not bring the PAT form along').to.equal(0);
  });

  it('OAuth method shows neither the PAT nor the App form', async () => {
    const el = await openDisconnectedDialog();
    const internals = el as unknown as DialogInternals;

    internals.authMethod = 'oauth';
    await el.updateComplete;

    expect(count(el, '.oauth-section'), 'OAuth mode must show the sign-in section').to.equal(1);
    expect(count(el, PAT_INPUT), 'OAuth mode must not show the PAT form').to.equal(0);
    expect(count(el, APP_KEY_INPUT), 'OAuth mode must not show the App form').to.equal(0);
  });
});
