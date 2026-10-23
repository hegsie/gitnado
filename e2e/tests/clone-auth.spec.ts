import { test, expect } from '@playwright/test';
import {
  setupTauriMocks,
  emptyRepository,
  initializeUnifiedProfileStore,
  type MockUnifiedProfile,
  type MockIntegrationAccount,
} from '../fixtures/tauri-mock';
import { AppPage } from '../pages/app.page';
import { DialogsPage } from '../pages/dialogs.page';
import {
  startCommandCapture,
  findCommand,
  waitForCommand,
  injectCommandMock,
  injectCommandError,
} from '../fixtures/test-helpers';

/**
 * E2E: cloning with a connected account's stored token.
 *
 * The clone dialog has no token field, so a private clone can only succeed if
 * the token of the account that owns the URL's host is attached for the user.
 */

const defaultProfile: MockUnifiedProfile = {
  id: 'profile-1',
  name: 'Default',
  gitName: 'Test User',
  gitEmail: 'test@example.com',
  signingKey: null,
  urlPatterns: [],
  isDefault: true,
  color: '#4f46e5',
  defaultAccounts: { gitlab: 'gl-acc-1' },
};

const gitlabAccount: MockIntegrationAccount = {
  id: 'gl-acc-1',
  name: 'GitLab',
  integrationType: 'gitlab',
  config: { type: 'gitlab', instanceUrl: 'https://gitlab.com' },
  color: '#fc6d26',
  cachedUser: { username: 'gl-user', displayName: 'GitLab User', avatarUrl: null },
  urlPatterns: [],
  isDefault: true,
};

test.describe('Clone Dialog - account token', () => {
  let app: AppPage;
  let dialogs: DialogsPage;

  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page, emptyRepository());
    app = new AppPage(page);
    dialogs = new DialogsPage(page);
    await app.goto();
    await initializeUnifiedProfileStore(page, {
      profiles: [defaultProfile],
      accounts: [gitlabAccount],
      connectedAccounts: ['gl-acc-1'],
    });
    await injectCommandMock(page, {
      get_keyring_token: 'gl-e2e-tok',
      clone_repository: {
        path: '/home/user/projects/proj',
        name: 'proj',
        headRef: null,
        isBare: false,
      },
    });
    await app.cloneButton.click();
    await dialogs.clone.waitForOpen();
  });

  test('passes the connected GitLab account token to clone_repository', async ({ page }) => {
    await dialogs.clone.fillUrl('https://gitlab.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');

    const cloneCmds = await findCommand(page, 'clone_repository');
    expect(cloneCmds.length).toBeGreaterThanOrEqual(1);
    const args = cloneCmds[0].args as { url?: string; token?: string };
    expect(args.url).toBe('https://gitlab.com/group/proj.git');
    expect(args.token).toBe('gl-e2e-tok');
  });

  test('sends no token when no account matches the clone host', async ({ page }) => {
    await dialogs.clone.fillUrl('https://example.com/x/y.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');

    const cloneCmds = await findCommand(page, 'clone_repository');
    expect(cloneCmds.length).toBeGreaterThanOrEqual(1);
    const args = cloneCmds[0].args as { token?: string };
    expect(args.token).toBeUndefined();
  });

  test('sends no token when the clone URL is plaintext http', async ({ page }) => {
    // The token travels as the HTTPS password, so it must never be handed to a
    // remote that would put it on the wire in clear — even one whose host has a
    // connected account.
    await dialogs.clone.fillUrl('http://gitlab.com/group/proj.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await startCommandCapture(page);
    await dialogs.clone.clone();
    await waitForCommand(page, 'clone_repository');

    const cloneCmds = await findCommand(page, 'clone_repository');
    expect(cloneCmds.length).toBeGreaterThanOrEqual(1);
    const args = cloneCmds[0].args as { token?: string };
    expect(args.token).toBeUndefined();
  });

  test('surfaces the auth failure in the dialog when the clone is rejected', async ({ page }) => {
    await dialogs.clone.fillUrl('https://gitlab.com/group/private.git');
    await dialogs.clone.fillPath('/home/user/projects');

    await injectCommandError(page, 'clone_repository', 'authentication required');
    await dialogs.clone.clone();

    const errorMessage = page.locator('gn-clone-dialog .error-message');
    await expect(errorMessage).toBeVisible();
    await expect(errorMessage).toContainText('authentication required');
    await expect(dialogs.clone.dialog).toBeVisible();
  });
});
