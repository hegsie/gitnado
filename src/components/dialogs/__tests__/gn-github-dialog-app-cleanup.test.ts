/**
 * Disconnecting a GitHub App must remove its stored config.
 *
 * An App keeps its credentials in their own keyring entry, separate from the
 * per-account token. Deleting only the account token therefore left the App
 * able to keep authenticating requests after the user pressed Disconnect — a
 * zombie config the UI gave no way to clear.
 *
 * The cleanup must also stay off PAT and OAuth accounts, which have no App
 * config to remove, and must report its own failure rather than pretending the
 * disconnect was clean.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args: unknown }> = [];

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
};

import { expect, fixture, html } from '@open-wc/testing';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { createEmptyIntegrationAccount } from '../../../types/unified-profile.types.ts';
import type { IntegrationAccount } from '../../../types/unified-profile.types.ts';
import '../gn-github-dialog.ts';
import type { GnGitHubDialog } from '../gn-github-dialog.ts';

interface DialogInternals {
  selectedAccountId: string | null;
  connectionStatus: { connected: boolean; user: unknown; scopes: string[] } | null;
  handleDisconnect: () => Promise<void>;
}

function account(id: string, name: string): IntegrationAccount {
  return {
    ...createEmptyIntegrationAccount('github'),
    id,
    name,
  } as IntegrationAccount;
}

const APP_ACCOUNT = account('github-app-4242', 'GitHub App 4242');
const PAT_ACCOUNT = account('gh-acc-1', 'octocat');

async function openDialog(): Promise<GnGitHubDialog> {
  const el = await fixture<GnGitHubDialog>(html`<gn-github-dialog .open=${true}></gn-github-dialog>`);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

function removeAppConfigCalls(): number {
  return invokeHistory.filter((h) => h.command === 'remove_github_app_config').length;
}

describe('gn-github-dialog GitHub App cleanup on disconnect', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    mockInvoke = () => Promise.resolve(null);
    uiStore.setState({ toasts: [] });
  });

  it('removes the stored App config when disconnecting an App account', async () => {
    unifiedProfileStore.getState().setAccounts([APP_ACCOUNT]);
    const el = await openDialog();
    const internals = el as unknown as DialogInternals;

    internals.selectedAccountId = APP_ACCOUNT.id;
    internals.connectionStatus = { connected: true, user: null, scopes: ['app-installation'] };
    await el.updateComplete;

    invokeHistory.length = 0;
    await internals.handleDisconnect();

    expect(removeAppConfigCalls(), 'App config must be cleared on disconnect').to.equal(1);
  });

  it('leaves the App config alone when disconnecting a token-backed account', async () => {
    unifiedProfileStore.getState().setAccounts([PAT_ACCOUNT]);
    const el = await openDialog();
    const internals = el as unknown as DialogInternals;

    internals.selectedAccountId = PAT_ACCOUNT.id;
    internals.connectionStatus = { connected: true, user: null, scopes: ['repo', 'read:user'] };
    await el.updateComplete;

    invokeHistory.length = 0;
    await internals.handleDisconnect();

    expect(
      removeAppConfigCalls(),
      'a PAT/OAuth disconnect must not touch App config',
    ).to.equal(0);
  });

  it('warns the user when the App config cannot be removed', async () => {
    unifiedProfileStore.getState().setAccounts([APP_ACCOUNT]);
    const el = await openDialog();
    const internals = el as unknown as DialogInternals;

    internals.selectedAccountId = APP_ACCOUNT.id;
    internals.connectionStatus = { connected: true, user: null, scopes: ['app-installation'] };
    await el.updateComplete;

    // The token deletion succeeds, the App cleanup does not.
    mockInvoke = (command) => {
      if (command === 'remove_github_app_config') {
        return Promise.reject(new Error('keyring locked'));
      }
      return Promise.resolve(null);
    };

    invokeHistory.length = 0;
    await internals.handleDisconnect();

    const toasts = uiStore.getState().toasts;
    expect(toasts.length, 'a failed cleanup must not be silent').to.be.greaterThan(0);
    expect(
      toasts.some((t) => /GitHub App configuration could not be removed/i.test(t.message)),
      `expected a cleanup warning, got: ${toasts.map((t) => t.message).join(' | ')}`,
    ).to.be.true;
  });
});
