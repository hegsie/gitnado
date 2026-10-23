/**
 * Tests for operationInProgress guards in gn-tag-list.
 *
 * Verifies that async handlers (checkoutTag, deleteTag, pushTag)
 * are protected against double-click / re-entry while an operation is
 * already in progress.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnTagList } from '../gn-tag-list.ts';

// Import the actual component
import '../gn-tag-list.ts';
import { repositoryStore } from '../../../stores/repository.store.ts';
import type { Repository } from '../../../types/git.types.ts';
import {
  tryAcquireRefOp,
  resetRefOpLocks,
  tryAcquirePush,
  releasePush,
  pushTagKey,
} from '../../../utils/ref-lock.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

function mockRepo(path: string, name: string): Repository {
  return {
    path,
    name,
    isValid: true,
    isBare: false,
    headRef: 'main',
    detachedHeadOid: null,
    state: 'clean',
    isShallow: false,
    isPartialClone: false,
    cloneFilter: null,
  };
}

function makeTag(overrides: Partial<{
  name: string;
  targetOid: string;
  message: string | null;
  tagger: null;
  isAnnotated: boolean;
}> = {}) {
  return {
    name: overrides.name ?? 'v1.0.0',
    targetOid: overrides.targetOid ?? 'abc123',
    message: overrides.message ?? null,
    tagger: overrides.tagger ?? null,
    isAnnotated: overrides.isAnnotated ?? false,
  };
}

function defaultMockInvoke(command: string): Promise<unknown> {
  if (command === 'get_tags') {
    return Promise.resolve([]);
  }
  if (command === 'get_tag_sort_mode') {
    return Promise.resolve('name');
  }
  if (command === 'get_push_remote') {
    return Promise.resolve('origin');
  }
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

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-tag-list operationInProgress guards', () => {
  beforeEach(() => {
    resetRefOpLocks();
    invokeCalls.length = 0;
  });

  it('should have operationInProgress initially false', async () => {
    const el = await createComponent();
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('mounts no create-tag dialog of its own', async () => {
    // Two live copies meant two independent `isOpen` guards: opening from this
    // list's context menu and then from the command palette stacked two
    // dialogs with different pinned targets. app-shell owns the only instance.
    const el = await createComponent();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('gn-create-tag-dialog')).to.be.null;
  });

  it('asks the host to open create-tag, carrying the tag it was invoked on', async () => {
    const el = await createComponent();
    const tag = makeTag({ name: 'v1.0.0' });
    let targetRef: string | undefined;
    let fired = 0;
    el.addEventListener('create-tag', (e) => {
      fired++;
      targetRef = (e as CustomEvent<{ targetRef?: string }>).detail?.targetRef;
    });

    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };
    (el as unknown as { handleCreateTagFromContext: () => void }).handleCreateTagFromContext();

    expect(fired, 'create-tag dispatched to the host').to.equal(1);
    expect(targetRef).to.equal(tag.targetOid);
  });

  it('handleCheckoutTag should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const tag = makeTag({ name: 'v1.0.0' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleCheckoutTag: () => Promise<void> }).handleCheckoutTag();

    const checkoutCalls = invokeCalls.filter(c => c.command === 'checkout_with_autostash');
    expect(checkoutCalls).to.have.length(0);
  });

  it('handleDeleteTag should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const tag = makeTag({ name: 'v2.0.0' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handleDeleteTag: () => Promise<void> }).handleDeleteTag();

    const deleteCalls = invokeCalls.filter(c => c.command === 'delete_tag');
    expect(deleteCalls).to.have.length(0);
  });

  it('handlePushTag should skip when operationInProgress is true', async () => {
    const el = await createComponent();

    const tag = makeTag({ name: 'v3.0.0' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };
    tryAcquireRefOp(REPO_PATH);

    invokeCalls.length = 0;

    await (el as unknown as { handlePushTag: () => Promise<void> }).handlePushTag();

    const pushCalls = invokeCalls.filter(c => c.command === 'push_tag');
    expect(pushCalls).to.have.length(0);
  });

  it('handlePushTag should set and clear operationInProgress', async () => {
    const el = await createComponent();

    let resolvePush!: (v: unknown) => void;
    mockInvoke = (command: string) => {
      if (command === 'push_tag') {
        return new Promise((resolve) => { resolvePush = resolve; });
      }
      return defaultMockInvoke(command);
    };

    const tag = makeTag({ name: 'v4.0.0' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };

    // Start push (won't resolve yet)
    const promise = (el as unknown as { handlePushTag: () => Promise<void> }).handlePushTag();

    // Should be in progress now
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(true);

    // pushTag resolves a credential token before it invokes push_tag, so the
    // hanging promise above is created a few microtasks in.
    for (let i = 0; i < 50 && !resolvePush; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Resolve
    resolvePush({ success: true });
    await promise;

    // Should be cleared
    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  it('handlePushTag should clear operationInProgress even on error', async () => {
    const el = await createComponent();

    mockInvoke = (command: string) => {
      if (command === 'push_tag') {
        return Promise.reject(new Error('push failed'));
      }
      return defaultMockInvoke(command);
    };

    const tag = makeTag({ name: 'v5.0.0' });
    (el as unknown as { contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null } }).contextMenu = {
      visible: true, x: 0, y: 0, tag,
    };

    try {
      await (el as unknown as { handlePushTag: () => Promise<void> }).handlePushTag();
    } catch {
      // expected
    }

    expect((el as unknown as { operationInProgress: boolean }).operationInProgress).to.equal(false);
  });

  // The tag-push slot is SEPARATE from the working-tree lock, so
  // operationInProgress cannot see it: Force Push Tag — from the rejected-push
  // suggestion toast — holds only the push slot, and holds it across its
  // confirm. Without observing it, Push stayed lit through that window and the
  // click did nothing but raise a refusal toast.
  it('greys out Push while a force push holds the same tag', async () => {
    const el = await createComponent();
    const tag = makeTag({ name: 'v1.0.0' });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, tag };
    await el.updateComplete;

    const pushBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find((b) =>
      /push/i.test(b.textContent ?? '')
    ) as HTMLButtonElement;
    expect(pushBtn, 'the Push item must be rendered').to.not.be.undefined;
    expect(pushBtn.disabled, 'clickable while the tag is idle').to.equal(false);

    const key = pushTagKey(REPO_PATH, 'v1.0.0');
    tryAcquirePush(key);
    await el.updateComplete;
    expect(pushBtn.disabled, 'a force push on this tag must grey it out').to.equal(true);

    releasePush(key);
    await el.updateComplete;
    expect(pushBtn.disabled, 'and the release must revive it').to.equal(false);
  });

  it('leaves Push clickable while a DIFFERENT tag is being pushed', async () => {
    const el = await createComponent();
    const tag = makeTag({ name: 'v1.0.0' });
    (
      el as unknown as {
        contextMenu: { visible: boolean; x: number; y: number; tag: typeof tag | null };
      }
    ).contextMenu = { visible: true, x: 0, y: 0, tag };
    await el.updateComplete;

    const pushBtn = Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')).find((b) =>
      /push/i.test(b.textContent ?? '')
    ) as HTMLButtonElement;

    const other = pushTagKey(REPO_PATH, 'v2.0.0');
    tryAcquirePush(other);
    await el.updateComplete;
    expect(pushBtn.disabled, 'pushing another tag is unrelated').to.equal(false);
    releasePush(other);
  });
});
