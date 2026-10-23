import { test, expect, type Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';

/**
 * Keyboard focus visibility and the OS "reduce motion" setting.
 *
 * Both are asserted through real browser behaviour rather than through the
 * stylesheet text: Tab really moves focus (so :focus-visible really matches),
 * and Playwright's emulateMedia really flips prefers-reduced-motion — the only
 * way to prove the rules landed inside the component shadow roots, which a
 * light-DOM stylesheet can never reach.
 */

interface FocusInfo {
  tag: string;
  className: string;
  outlineStyle: string;
  outlineWidth: number;
  outlineColorAlpha: number;
}

/**
 * The genuinely focused element, following focus down through shadow roots.
 *
 * Read through expect.poll, never once: several controls carry
 * `transition: all var(--transition-fast)`, so outline-width is mid-transition
 * (still 0) for the first ~100ms after focus lands.
 */
async function deepActiveElement(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    // rgb(r, g, b) has no alpha component and is fully opaque; rgba(...) does.
    const alphaMatch = /rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(style.outlineColor.trim());
    return {
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className : '',
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth) || 0,
      outlineColorAlpha: alphaMatch ? parseFloat(alphaMatch[1]) : 1,
    };
  });
}

/** Waits for the focused control to paint a solid, opaque ring of >= 2px. */
async function expectVisibleFocusRing(page: Page): Promise<FocusInfo> {
  await expect
    .poll(async () => {
      const focused = await deepActiveElement(page);
      if (!focused) return 'nothing focused';
      return `${focused.outlineStyle} ${focused.outlineWidth >= 2} ${focused.outlineColorAlpha > 0}`;
    })
    .toBe('solid true true');

  return (await deepActiveElement(page)) as FocusInfo;
}

/** Focus starts nowhere in particular; click a dead area of the chrome first. */
async function resetFocus(page: Page): Promise<void> {
  await page.locator('gn-app-shell').click({ position: { x: 5, y: 5 } });
}

test.describe('Accessibility — keyboard focus ring', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
  });

  test('the first Tab lands on a control with a visible focus ring', async ({ page }) => {
    await resetFocus(page);
    await page.keyboard.press('Tab');

    const focused = await expectVisibleFocusRing(page);
    expect(focused.tag, 'Tab did not reach a control').not.toBe('body');
  });

  test('every control reached by tabbing keeps a visible ring', async ({ page }) => {
    await resetFocus(page);

    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      if (!(await deepActiveElement(page))) continue;
      const focused = await expectVisibleFocusRing(page);
      seen.push(`${focused.tag}.${focused.className}`);
    }

    // Guards the test itself: without this the loop above could pass vacuously.
    expect(seen.length, 'tabbing reached no controls at all').toBeGreaterThan(2);
  });

  test('the focus ring is visible in the dark theme too', async ({ page }) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await resetFocus(page);
    await page.keyboard.press('Tab');

    await expectVisibleFocusRing(page);
  });
});

test.describe('Accessibility — reduced motion', () => {
  /** Computed style of the first matching element anywhere in the shadow tree. */
  async function computedInShadowTree(
    page: Page,
    selector: string,
    property: string
  ): Promise<string | null> {
    return page.evaluate(
      ({ selector, property }) => {
        const search = (root: Document | ShadowRoot): Element | null => {
          const direct = root.querySelector(selector);
          if (direct) return direct;
          for (const el of Array.from(root.querySelectorAll('*'))) {
            if (el.shadowRoot) {
              const found = search(el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        };
        const el = search(document);
        return el ? getComputedStyle(el).getPropertyValue(property) : null;
      },
      { selector, property }
    );
  }

  // The clamp lives in sharedStyles, adopted into every component's shadow
  // root — a rule in the light-DOM stylesheet could not reach these elements.
  test('component transitions are clamped inside shadow roots', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setupOpenRepository(page);

    const duration = await computedInShadowTree(page, '.menu-btn', 'transition-duration');
    expect(duration, 'could not find a transitioned toolbar control').not.toBeNull();
    // 0.01ms — near-zero rather than exactly 0, so transitionend still fires.
    for (const part of duration!.split(',')) {
      expect(parseFloat(part)).toBeLessThan(0.001);
    }
  });

  test('transitions still run when motion is not reduced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setupOpenRepository(page);

    const duration = await computedInShadowTree(page, '.menu-btn', 'transition-duration');
    expect(duration).not.toBeNull();
    expect(parseFloat(duration!.split(',')[0])).toBeGreaterThan(0.001);
  });

  test('an infinite spinner stops animating when motion is reduced', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setupOpenRepository(page);

    // gn-progress-indicator is always mounted by app-shell and owns one of the
    // app's infinite spinners (.progress-icon.spinning). Probe its already
    // adopted styles so the assertion does not depend on an operation being in
    // flight.
    const result = await page.evaluate(() => {
      const shell = document.querySelector('gn-app-shell')?.shadowRoot;
      const root = shell?.querySelector('gn-progress-indicator')?.shadowRoot;
      if (!root) return null;
      const probe = document.createElement('div');
      probe.className = 'progress-icon spinning';
      root.appendChild(probe);
      const style = getComputedStyle(probe);
      const out = {
        duration: style.animationDuration,
        iterations: style.animationIterationCount,
      };
      probe.remove();
      return out;
    });

    expect(result, 'gn-progress-indicator is not mounted').not.toBeNull();
    expect(parseFloat(result!.duration)).toBeLessThan(0.001);
    expect(result!.iterations).toBe('1');
  });
});
