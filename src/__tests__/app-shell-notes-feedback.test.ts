/**
 * Feedback for note writes made in the commit details panel.
 *
 * gn-commit-details owns the notes UI but has no toast of its own, so — like
 * `copy-sha` before it — it announces a successful write with a bubbling
 * `notes-changed` event and app-shell turns that into the confirmation the
 * user sees. This covers both halves: the handler's wording, and the binding
 * that actually carries the event from the panel to the handler.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, waitUntil } from '@open-wc/testing';
import type { AppShell } from '../app-shell.ts';
import '../app-shell.ts';
import { uiStore, repositoryStore } from '../stores/index.ts';
import type { Repository } from '../types/git.types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

function notesChangedEvent(action: 'added' | 'updated' | 'removed'): CustomEvent {
  return new CustomEvent('notes-changed', {
    detail: { action, commitOid: 'abc123def4567890', notesRef: 'refs/notes/commits' },
    bubbles: true,
    composed: true,
  });
}

function toastMessages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

describe('app-shell note-change feedback', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
    repositoryStore.getState().reset();
  });

  afterEach(() => {
    repositoryStore.getState().reset();
  });

  const cases: Array<[('added' | 'updated' | 'removed'), string]> = [
    ['added', 'Note added to abc123d'],
    ['updated', 'Note updated on abc123d'],
    ['removed', 'Note removed from abc123d'],
  ];

  for (const [action, message] of cases) {
    it(`confirms a note that was ${action}`, () => {
      const el = document.createElement('gn-app-shell') as AppShell;
      (el as any).handleNotesChanged(notesChangedEvent(action));

      expect(toastMessages()).to.deep.equal([message]);
      expect(uiStore.getState().toasts[0].type).to.equal('success');
    });
  }

  it('is wired to the panel: an event from the details panel reaches the handler', async () => {
    const el = document.createElement('gn-app-shell') as AppShell;
    repositoryStore.getState().addRepository(mockRepo('/repo/one', 'one'), { activate: true });
    document.body.appendChild(el);

    try {
      await el.updateComplete;
      (el as any).rightPanelVisible = true;
      await el.updateComplete;
      // The details panel lives inside the right panel's shadow root.
      await waitUntil(
        () => el.shadowRoot!.querySelector('gn-right-panel') !== null,
        'the right panel renders for an open repository',
      );
      const rightPanel = el.shadowRoot!.querySelector('gn-right-panel');
      await (rightPanel as unknown as { updateComplete: Promise<unknown> }).updateComplete;

      const details = rightPanel!.shadowRoot!.querySelector('gn-commit-details');
      expect(details, 'the commit details panel renders').to.exist;

      // Session restore may have toasted on mount; only the note matters here.
      uiStore.setState({ toasts: [] });
      details!.dispatchEvent(notesChangedEvent('added'));

      await waitUntil(
        () => toastMessages().includes('Note added to abc123d'),
        'a toast confirms the note write',
      );
    } finally {
      el.remove();
    }
  });
});
