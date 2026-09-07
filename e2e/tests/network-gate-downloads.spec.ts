import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { startCommandCaptureWithMocks, findCommand } from '../fixtures/test-helpers';

/**
 * Offline Mode and the remote allowlist, applied to the AI model download.
 *
 * `download_model` fetches multiple gigabytes of model weights from
 * huggingface.co and returns the instant the transfer is spawned, so an ungated
 * click gave no refusal, no toast and no way to stop it — the app said it was
 * offline while it downloaded. The backend refuses it too
 * (`services/security.rs`), but only this half can answer the click.
 */

const mockSystemCapabilities = {
  totalRamBytes: 16_000_000_000,
  availableRamBytes: 8_000_000_000,
  gpuInfo: null,
  recommendedTier: 'ultra_light',
  gpuAccelerationAvailable: false,
};

const mockAvailableModels = [
  {
    id: 'gemma-3-1b-q4km',
    displayName: 'Gemma 3 1B (Q4_K_M)',
    hfRepo: 'unsloth/gemma-3-1b-it-GGUF',
    hfFilename: 'gemma-3-1b-it-Q4_K_M.gguf',
    sha256: '',
    sizeBytes: 700_000_000,
    minRamBytes: 8_000_000_000,
    tier: 'ultra_light',
    architecture: 'gemma3',
    contextLength: 8192,
  },
];

function localAiMocks(overrides: Record<string, unknown> = {}) {
  return {
    get_ai_providers: [],
    get_active_ai_provider: null,
    get_system_capabilities: mockSystemCapabilities,
    get_available_models: mockAvailableModels,
    get_downloaded_models: [],
    get_recommended_model: mockAvailableModels[0],
    get_model_status: 'unloaded',
    get_loaded_model_name: null,
    is_ai_available: false,
    download_model: null,
    ...overrides,
  };
}

interface SettingsStoreWindow {
  __GITNADO_STORES__?: {
    settingsStore?: {
      getState: () => {
        setOfflineMode: (on: boolean) => void;
        setRemoteAllowlist: (list: string[]) => void;
      };
    };
  };
}

/** Set the security settings through the store, the way the app itself does. */
async function setSecurity(
  page: Page,
  security: { offlineMode?: boolean; remoteAllowlist?: string[] },
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as SettingsStoreWindow).__GITNADO_STORES__?.settingsStore !==
      'undefined',
  );
  await page.evaluate((s) => {
    const store = (
      window as unknown as SettingsStoreWindow
    ).__GITNADO_STORES__!.settingsStore!.getState();
    if (s.offlineMode !== undefined) store.setOfflineMode(s.offlineMode);
    if (s.remoteAllowlist !== undefined) store.setRemoteAllowlist(s.remoteAllowlist);
  }, security);
}

async function openSettings(page: Page) {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('lv-settings-dialog')).toBeVisible();
}

/** The registry row for the one model these mocks offer. */
function modelRow(page: Page) {
  return page.locator('lv-settings-dialog .setting-row', { hasText: 'Ultra-Light' });
}

test.describe('Settings Dialog — model download respects the network gate', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('Offline Mode refuses the download and says why', async ({ page }) => {
    await startCommandCaptureWithMocks(page, localAiMocks());
    await setSecurity(page, { offlineMode: true });
    await openSettings(page);

    await modelRow(page).getByRole('button', { name: 'Download' }).click();

    const error = page.locator('lv-settings-dialog .error-text');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Offline mode');
    await expect(error).toContainText('Settings > Security');

    // Refused before the request is ever made — the point of the gate.
    expect(await findCommand(page, 'download_model')).toHaveLength(0);
  });

  test('an allowlist without huggingface.co refuses the download', async ({ page }) => {
    await startCommandCaptureWithMocks(page, localAiMocks());
    await setSecurity(page, { remoteAllowlist: ['github.com'] });
    await openSettings(page);

    await modelRow(page).getByRole('button', { name: 'Download' }).click();

    const error = page.locator('lv-settings-dialog .error-text');
    await expect(error).toBeVisible();
    await expect(error).toContainText('huggingface.co');
    await expect(error).toContainText('allowlist');

    expect(await findCommand(page, 'download_model')).toHaveLength(0);
  });

  test('an allowlist that names huggingface.co lets the download start', async ({ page }) => {
    await startCommandCaptureWithMocks(page, localAiMocks());
    await setSecurity(page, { remoteAllowlist: ['huggingface.co'] });
    await openSettings(page);

    await modelRow(page).getByRole('button', { name: 'Download' }).click();

    await expect
      .poll(async () => (await findCommand(page, 'download_model')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('lv-settings-dialog .error-text')).toHaveCount(0);
  });

  test('with no policy in force the download starts as before', async ({ page }) => {
    await startCommandCaptureWithMocks(page, localAiMocks());
    await openSettings(page);

    await modelRow(page).getByRole('button', { name: 'Download' }).click();

    await expect
      .poll(async () => (await findCommand(page, 'download_model')).length)
      .toBeGreaterThan(0);
    await expect(page.locator('lv-settings-dialog .error-text')).toHaveCount(0);
  });
});
