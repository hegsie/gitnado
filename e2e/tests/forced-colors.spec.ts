import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';

// =========================================================================
// Forced colors / high contrast
//
// The commit graph is painted into a <canvas>, so Windows High Contrast Mode
// cannot recolor it — the app has to pick the high-contrast palette itself.
// It does that automatically while the user has not pinned a scheme, and stops
// the moment they choose one in Settings.
// =========================================================================

/** The scheme the store applied, as the graph renderer reads it. */
function appliedScheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-graph-scheme'));
}

function storedScheme(page: Page): Promise<{ scheme: string; auto: boolean }> {
  return page.evaluate(() => {
    const stores = (window as unknown as Record<string, unknown>).__GITNADO_STORES__ as {
      settingsStore: {
        getState: () => { graphColorScheme: string; graphColorSchemeAuto: boolean };
      };
    };
    const state = stores.settingsStore.getState();
    return { scheme: state.graphColorScheme, auto: state.graphColorSchemeAuto };
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(page.locator('lv-settings-dialog')).toBeVisible();
}

function schemeSelect(page: Page) {
  return page.locator('lv-settings-dialog select[aria-label="Graph color scheme"]');
}

function autoNote(page: Page) {
  return page.locator('lv-settings-dialog [data-testid="graph-scheme-auto-note"]');
}

test.describe('Forced colors', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('switches the graph to the high-contrast palette when forced colors turn on', async ({
    page,
  }) => {
    expect(await appliedScheme(page)).toBe('default');

    await page.emulateMedia({ forcedColors: 'active' });

    await expect.poll(() => appliedScheme(page)).toBe('high-contrast');
    expect(await storedScheme(page)).toEqual({ scheme: 'high-contrast', auto: true });
  });

  test('reverts to the default palette when forced colors turn off again', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await expect.poll(() => appliedScheme(page)).toBe('high-contrast');

    await page.emulateMedia({ forcedColors: 'none' });

    await expect.poll(() => appliedScheme(page)).toBe('default');
    expect(await storedScheme(page)).toEqual({ scheme: 'default', auto: true });
  });

  test('Settings says the scheme is automatic, and picking one pins it', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await expect.poll(() => appliedScheme(page)).toBe('high-contrast');

    await openSettings(page);
    await expect(autoNote(page)).toHaveText('Auto (high contrast)');
    await expect(schemeSelect(page)).toHaveValue('high-contrast');

    await schemeSelect(page).selectOption('pastel');

    await expect(autoNote(page)).toHaveCount(0);
    await expect.poll(() => appliedScheme(page)).toBe('pastel');
    expect(await storedScheme(page)).toEqual({ scheme: 'pastel', auto: false });

    // A pinned choice survives the OS setting changing underneath it.
    await page.emulateMedia({ forcedColors: 'none' });
    await page.emulateMedia({ forcedColors: 'active' });

    await expect(schemeSelect(page)).toHaveValue('pastel');
    expect(await appliedScheme(page)).toBe('pastel');
  });

  test('shows no automatic note while the OS is not forcing colors', async ({ page }) => {
    await openSettings(page);

    await expect(schemeSelect(page)).toHaveValue('default');
    await expect(autoNote(page)).toHaveCount(0);
  });
});
