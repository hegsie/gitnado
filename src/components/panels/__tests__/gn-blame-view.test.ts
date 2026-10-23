/**
 * Unit tests for gn-blame-view component.
 *
 * Renders the REAL gn-blame-view, mocks only the Tauri invoke layer, and
 * verifies:
 *   - a failed CommandResult surfaces the backend error MESSAGE (not a generic
 *     fallback) — the old `typeof result.error === 'string'` check was always
 *     false and discarded the real message.
 *   - clipboard copy failures show an error toast instead of failing silently.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { uiStore } from '../../../stores/ui.store.ts';
import type { BlameResult } from '../../../types/git.types.ts';
import type { GnBlameView } from '../gn-blame-view.ts';
import '../gn-blame-view.ts';

const REPO_PATH = '/test/repo';

async function renderBlame(): Promise<GnBlameView> {
  const el = await fixture<GnBlameView>(
    html`<gn-blame-view
      .repositoryPath=${REPO_PATH}
      .filePath=${'src/main.ts'}
    ></gn-blame-view>`
  );
  await el.updateComplete;
  const start = Date.now();
  while (Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;
    if (!(el as unknown as { isLoading: boolean }).isLoading) break;
  }
  await el.updateComplete;
  return el;
}

/** A blame result whose single group is `secondsAgo` old. */
function blameResultAged(secondsAgo: number): BlameResult {
  const timestamp = Math.floor(Date.now() / 1000) - secondsAgo;
  return {
    path: 'src/main.ts',
    lines: [
      {
        lineNumber: 1,
        content: 'const a = 1;',
        commitOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        commitShortId: 'deadbee',
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        timestamp,
        summary: 'Add a',
        isBoundary: false,
      },
    ],
    totalLines: 1,
  };
}

describe('gn-blame-view', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
  });

  describe('error handling', () => {
    it('surfaces the backend error message from a failed CommandResult', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_file_blame') {
          throw { code: 'BLAME_ERROR', message: 'Cannot blame a binary file' };
        }
        return null;
      };

      const el = await renderBlame();

      const errorDiv = el.shadowRoot!.querySelector('.error');
      expect(errorDiv).to.not.be.null;
      expect(errorDiv!.textContent).to.include('Cannot blame a binary file');
    });

  });

  describe('clipboard error feedback', () => {
    it('shows an error toast when copying a hash fails', async () => {
      mockInvoke = async () => null;
      const el = await renderBlame();

      // Force clipboard write to reject (clipboard is a read-only accessor).
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (el as any).contextMenu = { visible: true, x: 0, y: 0, group: { commitOid: 'deadbeef' }, line: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleContextCopyHash();

      const toasts = uiStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error' && /copy hash/i.test(t.message))).to.be.true;
    });
  });

  // ── Relative dates ───────────────────────────────────────────────────────
  describe('commit age', () => {
    it('shows a real age for an old commit, not "just now"', async () => {
      // BlameLine.timestamp is Unix SECONDS, and formatRelativeTime multiplies
      // by 1000 itself. Passing milliseconds made every diff hugely negative, so
      // "seconds < 60" always won and every group read "just now" — defeating
      // the whole point of blame.
      const threeYears = 3 * 365 * 24 * 60 * 60;
      mockInvoke = async (command: string) => {
        if (command === 'get_file_blame') return blameResultAged(threeYears);
        return null;
      };

      const el = await renderBlame();
      const date = el.shadowRoot!.querySelector('.commit-date');
      expect(date, 'a blame group should render').to.not.be.null;

      const text = date!.textContent!.trim();
      expect(text, `a three-year-old commit rendered as "${text}"`).to.not.equal('just now');
      expect(text, 'should read as years old').to.match(/\b3\s*y(ears?)?\b/);
    });

    it('still says "just now" for a commit made seconds ago', async () => {
      mockInvoke = async (command: string) => {
        if (command === 'get_file_blame') return blameResultAged(5);
        return null;
      };

      const el = await renderBlame();
      const date = el.shadowRoot!.querySelector('.commit-date');
      expect(date!.textContent!.trim()).to.equal('just now');
    });

    it('agrees with the tooltip on the same group', async () => {
      const oneYear = 365 * 24 * 60 * 60;
      mockInvoke = async (command: string) => {
        if (command === 'get_file_blame') return blameResultAged(oneYear);
        return null;
      };

      const el = await renderBlame();
      const info = el.shadowRoot!.querySelector('.group-info')!;

      // Compared against the component's OWN formatting rather than a bare year
      // string: toLocaleString() can render digits in a non-Latin numbering
      // system depending on the environment's locale, which would make a
      // String(year) check flaky.
      const shownTimestamp = (el as unknown as { groups: Array<{ timestamp: number }> })
        .groups[0].timestamp;
      const expectedTooltipDate = new Date(shownTimestamp * 1000).toLocaleString();

      // The tooltip always formatted the timestamp correctly; the header did not.
      expect(info.getAttribute('title')).to.contain(expectedTooltipDate);
      expect(el.shadowRoot!.querySelector('.commit-date')!.textContent!.trim()).to.not.equal(
        'just now',
      );
    });
  });
});
