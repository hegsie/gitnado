/**
 * gn-file-status keyboard shortcuts must not swallow modifier chords.
 *
 * The host row carries tabindex="0", so clicking a file puts real keyboard
 * focus on it. Its local handler switched on `e.key` alone: the save reflex
 * Ctrl+S ran "stage selected" and Ctrl+U ran "unstage selected", both
 * silently, and Ctrl/Alt + j/k moved the focused row.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-file-status.ts';
import type { GnFileStatus } from '../gn-file-status.ts';
import type { StatusEntry } from '../../../types/git.types.ts';

const REPO_PATH = '/test/repo';

function makeEntry(overrides: Partial<StatusEntry> = {}): StatusEntry {
  return {
    path: 'src/main.ts',
    status: 'modified',
    isStaged: false,
    isConflicted: false,
    ...overrides,
  };
}

interface FileStatusInternal {
  stagedFiles: StatusEntry[];
  unstagedFiles: StatusEntry[];
  selectedFiles: Set<string>;
  focusedIndex: number;
}

function internalOf(el: GnFileStatus): FileStatusInternal {
  return el as unknown as FileStatusInternal;
}

const UNSTAGED = makeEntry({ path: 'unstaged.txt' });
const STAGED = makeEntry({ path: 'staged.txt', isStaged: true });

async function renderFileStatus(): Promise<GnFileStatus> {
  mockInvoke = async (command: string) => {
    if (command === 'get_status') return [UNSTAGED, STAGED];
    return null;
  };

  const el = await fixture<GnFileStatus>(html`
    <gn-file-status .repositoryPath=${REPO_PATH}></gn-file-status>
  `);
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;

  const internal = internalOf(el);
  internal.unstagedFiles = [UNSTAGED];
  internal.stagedFiles = [STAGED];
  internal.selectedFiles = new Set([UNSTAGED.path, STAGED.path]);
  internal.focusedIndex = 0;
  await el.updateComplete;
  invokeHistory.length = 0;
  return el;
}

function press(el: GnFileStatus, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function commandsNamed(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

describe('gn-file-status modifier chords', () => {
  it('Ctrl+S does not stage the selection', async () => {
    const el = await renderFileStatus();

    const event = press(el, { key: 's', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(commandsNamed('stage_files'), 'no stage_files reached the backend').to.have.length(0);
    expect(event.defaultPrevented, 'Ctrl+S is left for the app-level shortcut').to.be.false;
  });

  it('Cmd+S does not stage the selection', async () => {
    const el = await renderFileStatus();

    press(el, { key: 's', metaKey: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(commandsNamed('stage_files')).to.have.length(0);
  });

  it('Ctrl+U does not unstage the selection', async () => {
    const el = await renderFileStatus();

    const event = press(el, { key: 'u', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(commandsNamed('unstage_files'), 'no unstage_files reached the backend').to.have.length(0);
    expect(event.defaultPrevented).to.be.false;
  });

  it('Ctrl+J and Alt+K do not move the focused row', async () => {
    const el = await renderFileStatus();
    const internal = internalOf(el);
    internal.focusedIndex = 0;

    press(el, { key: 'j', ctrlKey: true });
    await el.updateComplete;
    expect(internal.focusedIndex, 'Ctrl+J left the focus row alone').to.equal(0);

    internal.focusedIndex = 1;
    press(el, { key: 'k', altKey: true });
    await el.updateComplete;
    expect(internal.focusedIndex, 'Alt+K left the focus row alone').to.equal(1);
  });

  it('still stages on a bare s', async () => {
    const el = await renderFileStatus();

    const event = press(el, { key: 's' });
    await new Promise((r) => setTimeout(r, 50));

    expect(commandsNamed('stage_files'), 'bare s still stages').to.have.length(1);
    expect(event.defaultPrevented).to.be.true;
  });

  it('still unstages on a bare u, and arrows still move with no modifier', async () => {
    const el = await renderFileStatus();
    const internal = internalOf(el);

    press(el, { key: 'u' });
    await new Promise((r) => setTimeout(r, 50));
    expect(commandsNamed('unstage_files'), 'bare u still unstages').to.have.length(1);

    internal.focusedIndex = 0;
    press(el, { key: 'ArrowDown' });
    await el.updateComplete;
    expect(internal.focusedIndex, 'ArrowDown still navigates').to.equal(1);
  });
});
