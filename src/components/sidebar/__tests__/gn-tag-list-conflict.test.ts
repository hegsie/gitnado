/**
 * Tests for gn-tag-list stash-conflict handling.
 *
 * When checking out a tag auto-stashes uncommitted changes and the stash pop
 * conflicts, the component must open the conflict resolution dialog (previously
 * it only showed a toast, leaving the user stuck).
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
import type { GnTagList } from '../gn-tag-list.ts';
import '../gn-tag-list.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function makeTag(name = 'v1.0.0') {
  return { name, targetOid: 'abc123', message: null, tagger: null, isAnnotated: false };
}

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_tags') return Promise.resolve([]);
  if (command === 'get_tag_sort_mode') return Promise.resolve('name');
  if (command === 'plugin:dialog|message') return Promise.resolve('Ok');
  return Promise.resolve(null);
}

async function createComponent(): Promise<GnTagList> {
  mockInvoke = defaultMockInvoke;
  const el = await fixture<GnTagList>(
    html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`
  );
  await el.updateComplete;
  return el;
}

interface ConflictDetail {
  operationType: string;
  stashIndex: number;
  dropStashOnComplete: boolean;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-tag-list stash conflict handling', () => {
  it('opens the conflict dialog when a tag checkout auto-stash pop conflicts', async () => {
    const el = await createComponent();

    let detail: ConflictDetail | null = null;
    el.addEventListener('open-conflict-dialog', (e) => {
      detail = (e as CustomEvent<ConflictDetail>).detail;
    });

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: true,
          stashApplied: false,
          stashConflict: true,
          message: 'stash conflict',
        });
      }
      return defaultMockInvoke(command);
    };

    const tag = makeTag('v1.0.0');
    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };

    await (el as unknown as { handleCheckoutTag: () => Promise<void> }).handleCheckoutTag();

    expect(detail, 'open-conflict-dialog dispatched').to.not.be.null;
    expect(detail!.operationType).to.equal('stash');
    expect(detail!.stashIndex).to.equal(0);
    expect(detail!.dropStashOnComplete).to.be.true;
  });

  it('does NOT open the conflict dialog on a clean tag checkout', async () => {
    const el = await createComponent();

    let dispatched = false;
    el.addEventListener('open-conflict-dialog', () => { dispatched = true; });

    mockInvoke = (command: string) => {
      if (command === 'checkout_with_autostash') {
        return Promise.resolve({
          success: true,
          stashed: false,
          stashApplied: false,
          stashConflict: false,
          message: 'ok',
        });
      }
      return defaultMockInvoke(command);
    };

    const tag = makeTag('v2.0.0');
    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };

    await (el as unknown as { handleCheckoutTag: () => Promise<void> }).handleCheckoutTag();

    expect(dispatched, 'no conflict dialog on clean checkout').to.be.false;
  });
});
