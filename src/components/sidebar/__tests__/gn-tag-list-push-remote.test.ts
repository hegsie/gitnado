/**
 * The tag context menu's push destination.
 *
 * "Push to Remote" sent no `remote` at all, so the backend fell back to a
 * hard-coded "origin": a repo whose only remote is named something else could
 * never push a tag, and a fork checkout (origin + upstream) could only ever
 * push to origin from a menu item that named no destination at all.
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
import { uiStore } from '../../../stores/ui.store.ts';
import { isRefOpRunning } from '../../../utils/ref-lock.ts';

// ── Helpers ────────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';
const TAG = { name: 'v1.0.0', targetOid: 'abc123', message: null, tagger: null, isAnnotated: false };

function remote(name: string) {
  return { name, url: `https://example.test/${name}.git`, pushUrl: null };
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface PushCall {
  path?: string;
  name?: string;
  remote?: string;
}

let pushCalls: PushCall[] = [];
/** When set, push_tag rejects with this instead of succeeding. */
let pushFailure: { code: string; message: string } | null = null;
/** When set, get_push_remote rejects with this instead of resolving. */
let pushRemoteFailure: { code: string; message: string } | null = null;
/** The in-flight get_remotes call for the most recent context-menu open. */
let remotesCall: Promise<unknown> | null = null;

/**
 * @param remotes what get_remotes resolves to, or 'fail' to reject it.
 */
async function createComponent(remotes: ReturnType<typeof remote>[] | 'fail'): Promise<GnTagList> {
  pushCalls = [];
  mockInvoke = (command: string, args?: unknown) => {
    if (command === 'get_tags') return Promise.resolve([TAG]);
    if (command === 'get_tag_sort_mode') return Promise.resolve('name');
    if (command === 'get_remotes') {
      remotesCall =
        remotes === 'fail'
          ? Promise.reject({ code: 'COMMAND_ERROR', message: 'bad config' })
          : Promise.resolve(remotes);
      return remotesCall;
    }
    if (command === 'get_push_remote') {
      if (pushRemoteFailure) return Promise.reject(pushRemoteFailure);
      return Promise.resolve('origin');
    }
    if (command === 'push_tag') {
      pushCalls.push(args as PushCall);
      if (pushFailure) return Promise.reject(pushFailure);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  };

  const el = await fixture<GnTagList>(
    html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`
  );
  await el.updateComplete;
  await waitUntil(
    () => el.shadowRoot!.querySelector('.tag-item') !== null,
    'the tag row to render'
  );
  return el;
}

function menuItems(el: GnTagList): HTMLButtonElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll('.context-menu-item')) as HTMLButtonElement[];
}

function pushItem(el: GnTagList): HTMLButtonElement | undefined {
  return menuItems(el).find((b) => /^Push to /.test(b.textContent!.trim()));
}

/**
 * Open the context menu and wait for its remote read to land.
 *
 * The menu's label and behaviour both depend on the async get_remotes, so
 * every test must settle it before asserting or clicking.
 */
async function openMenu(el: GnTagList): Promise<void> {
  remotesCall = null;
  el.shadowRoot!
    .querySelector('.tag-item')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  await el.updateComplete;
  await waitUntil(() => pushItem(el) !== undefined, 'the push menu item');
  await waitUntil(() => remotesCall !== null, 'get_remotes to be issued');
  // A rejection is one of the cases under test; either way, let the
  // component's own continuation and the re-render run.
  await remotesCall!.catch(() => undefined);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

function pushLabel(el: GnTagList): string {
  return pushItem(el)!.textContent!.trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-tag-list push destination', () => {
  beforeEach(() => {
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
    pushFailure = null;
    pushRemoteFailure = null;
  });

  it('names the sole remote in the menu and pushes to it', async () => {
    const el = await createComponent([remote('upstream')]);
    await openMenu(el);

    // Not "Push to Remote": with one remote there is a destination to name.
    expect(pushLabel(el)).to.equal('Push to upstream');

    pushItem(el)!.click();
    await waitUntil(() => pushCalls.length === 1, 'push_tag to be invoked');

    expect(pushCalls[0].path).to.equal(REPO_PATH);
    expect(pushCalls[0].name).to.equal('v1.0.0');
    expect(pushCalls[0].remote, 'the named remote is sent, not left to an origin default')
      .to.equal('upstream');

    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.type === 'success'),
      'the success toast'
    );
    const toast = uiStore.getState().toasts.find((t) => t.type === 'success');
    expect(toast!.message).to.equal('Pushed tag v1.0.0 to upstream');
  });

  it('asks which remote when the repo has several, and pushes to the one chosen', async () => {
    const el = await createComponent([remote('origin'), remote('upstream')]);
    await openMenu(el);

    expect(pushLabel(el)).to.equal('Push to Remote');

    pushItem(el)!.click();
    await el.updateComplete;

    // Picking one silently is how a fork's tag ends up on the canonical repo.
    expect(pushCalls, 'clicking must offer a choice, not push immediately').to.have.length(0);

    const choices = Array.from(
      el.shadowRoot!.querySelectorAll('.push-remote-item')
    ) as HTMLButtonElement[];
    expect(choices.map((b) => b.textContent!.trim())).to.deep.equal(['origin', 'upstream']);

    choices[1].click();
    await waitUntil(() => pushCalls.length === 1, 'push_tag to be invoked');
    expect(pushCalls[0].remote).to.equal('upstream');

    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.type === 'success'),
      'the success toast'
    );
    const toast = uiStore.getState().toasts.find((t) => t.type === 'success');
    expect(toast!.message).to.equal('Pushed tag v1.0.0 to upstream');
  });

  it('a repo with no remotes is told to add one instead of failing on "origin"', async () => {
    const el = await createComponent([]);
    await openMenu(el);
    expect(pushLabel(el)).to.equal('Push to Remote');

    pushItem(el)!.click();
    await el.updateComplete;

    expect(pushCalls, 'nothing is pushed when there is nowhere to push').to.have.length(0);

    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.type === 'error'),
      'the error toast'
    );
    const toast = uiStore.getState().toasts.find((t) => t.type === 'error');
    expect(toast!.message).to.match(/No remotes configured/);

    // The early return must close the menu and leak no lock.
    expect(
      (el as unknown as { contextMenu: { visible: boolean } }).contextMenu.visible
    ).to.equal(false);
    expect(isRefOpRunning(REPO_PATH), 'the working-tree lock is not held').to.equal(false);
  });

  it('an unreadable remote list resolves and names the backend destination', async () => {
    const el = await createComponent('fail');
    await openMenu(el);
    expect(pushLabel(el)).to.equal('Push to Remote');

    pushItem(el)!.click();
    await waitUntil(() => pushCalls.length === 1, 'push_tag to be invoked');

    expect(pushCalls[0].name).to.equal('v1.0.0');
    expect(pushCalls[0].remote).to.equal('origin');

    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.type === 'success'),
      'the success toast'
    );
    const toast = uiStore.getState().toasts.find((t) => t.type === 'success');
    expect(toast!.message).to.equal('Pushed tag v1.0.0 to origin');
  });

  it('an unresolvable destination is reported instead of pushing blind', async () => {
    // The unreadable-remote-list path leans entirely on the backend resolver.
    // When that fails too there is no destination to name in the toast or to
    // hand the Force Push Tag retry, so nothing may be pushed.
    pushRemoteFailure = { code: 'REMOTE_NOT_FOUND', message: 'Remote not found: origin' };
    const el = await createComponent('fail');
    await openMenu(el);

    pushItem(el)!.click();
    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.type === 'error'),
      'the error toast'
    );

    const toast = uiStore.getState().toasts.find((t) => t.type === 'error');
    expect(toast!.message).to.contain('Could not determine the tag destination');
    expect(toast!.message).to.contain('Remote not found: origin');
    expect(pushCalls, 'nothing is pushed to a destination nobody could name').to.have.length(0);
    // The early return must leak no lock.
    await waitUntil(() => !isRefOpRunning(REPO_PATH), 'the working-tree lock to be released');
  });

  it('a push clicked before the remote read lands still asks which remote', async () => {
    // The read is fired when the menu opens and the menu paints immediately,
    // so a click can land first. Pushing then leaves the destination to the
    // backend resolver — `origin` in a fork checkout — and the picker the menu
    // was about to render is never offered.
    pushCalls = [];
    let landRemotes: (value: unknown) => void = () => undefined;
    let remoteReads = 0;
    mockInvoke = (command: string, args?: unknown) => {
      if (command === 'get_tags') return Promise.resolve([TAG]);
      if (command === 'get_tag_sort_mode') return Promise.resolve('name');
      if (command === 'get_remotes') {
        remoteReads++;
        if (remoteReads > 1) {
          return Promise.resolve([remote('origin'), remote('upstream')]);
        }
        return new Promise((resolvePending) => {
          landRemotes = resolvePending;
        });
      }
      if (command === 'get_push_remote') return Promise.resolve('origin');
      if (command === 'push_tag') {
        pushCalls.push(args as PushCall);
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    };

    const el = await fixture<GnTagList>(
      html`<gn-tag-list .repositoryPath=${REPO_PATH}></gn-tag-list>`
    );
    await el.updateComplete;
    await waitUntil(
      () => el.shadowRoot!.querySelector('.tag-item') !== null,
      'the tag row to render'
    );

    el.shadowRoot!
      .querySelector('.tag-item')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await el.updateComplete;
    await waitUntil(() => pushItem(el) !== undefined, 'the push menu item');

    pushItem(el)!.click();
    await el.updateComplete;
    expect(pushCalls, 'nothing is pushed while the destination is unknown').to.have.length(0);

    landRemotes([remote('origin'), remote('upstream')]);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(pushCalls, 'the waiting click resolves into the picker, not a push')
      .to.have.length(0);
    const choices = Array.from(
      el.shadowRoot!.querySelectorAll('.push-remote-item')
    ) as HTMLButtonElement[];
    expect(choices.map((b) => b.textContent!.trim())).to.deep.equal(['origin', 'upstream']);

    choices[1].click();
    await waitUntil(() => pushCalls.length === 1, 'push_tag to be invoked');
    expect(pushCalls[0].remote).to.equal('upstream');
  });

  it('a rejected push offers a force retry to the same remote it was aimed at', async () => {
    // Without the remote the retry re-resolves the destination and force-moves
    // the tag on `origin` — a destructive write to a remote the user never
    // aimed at, reported as success.
    pushFailure = {
      code: 'COMMAND_ERROR',
      message: 'cannot push non-fastforwardable reference',
    };
    const el = await createComponent([remote('origin'), remote('upstream')]);
    await openMenu(el);

    pushItem(el)!.click();
    await el.updateComplete;
    const choices = Array.from(
      el.shadowRoot!.querySelectorAll('.push-remote-item')
    ) as HTMLButtonElement[];
    choices[1].click();
    await waitUntil(() => pushCalls.length === 1, 'push_tag to be invoked');
    expect(pushCalls[0].remote).to.equal('upstream');

    await waitUntil(
      () => uiStore.getState().toasts.some((t) => t.action?.label === 'Force Push Tag'),
      'the force-retry action'
    );
    const toast = uiStore.getState().toasts.find((t) => t.action?.label === 'Force Push Tag');

    let detail: { tagName?: string; remote?: string } | null = null;
    const handler = (e: Event): void => {
      detail = (e as CustomEvent<{ tagName?: string; remote?: string }>).detail;
    };
    window.addEventListener('force-push-tag', handler);
    try {
      toast!.action!.callback();
    } finally {
      window.removeEventListener('force-push-tag', handler);
    }
    expect(detail!.tagName).to.equal('v1.0.0');
    expect(detail!.remote, 'the retry goes back to the remote the user picked')
      .to.equal('upstream');
  });
});
