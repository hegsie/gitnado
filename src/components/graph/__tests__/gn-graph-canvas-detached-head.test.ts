/**
 * A detached HEAD label must not behave like an actionable ref.
 *
 * The graph now emits a synthetic `detachedHead` ref so HEAD is visible and the
 * mainline stays pinned. But the right-click handler let every non-pullRequest
 * ref through to `ref-context-menu`, and app-shell renders that menu for
 * branches and tags — so a detached HEAD offered Checkout, Delete, Merge and
 * Rename against the label "HEAD (detached)", which names no ref git would
 * accept.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-graph-canvas.ts';
import type { GnGraphCanvas } from '../gn-graph-canvas.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RefLabelHit {
  label: string;
  fullName: string;
  refType: string;
  isHead: boolean;
}

/** Right-click the canvas with the renderer reporting `hit` under the cursor. */
async function contextMenuOver(hit: RefLabelHit | null): Promise<CustomEvent[]> {
  const el = await fixture<GnGraphCanvas>(html`<gn-graph-canvas></gn-graph-canvas>`);
  await el.updateComplete;

  // firstUpdated() is async and awaits updateComplete BEFORE it creates the
  // renderer and attaches the contextmenu listener, so one tick is not enough:
  // the stub below could land on an undefined renderer, or the event could be
  // dispatched before anything is listening. Wait for the renderer to exist.
  const deadline = Date.now() + 2000;
  while (!(el as any).renderer) {
    if (Date.now() > deadline) throw new Error('renderer was never created');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  (el as any).renderer.getRefLabelAtPoint = () => hit;

  const events: CustomEvent[] = [];
  el.addEventListener('ref-context-menu', (e) => events.push(e as CustomEvent));

  const canvas = el.shadowRoot!.querySelector('canvas');
  expect(canvas, 'the canvas must be rendered').to.not.be.null;
  canvas!.dispatchEvent(
    new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }),
  );
  await el.updateComplete;

  return events;
}

describe('gn-graph-canvas detached HEAD label', () => {
  it('opens no ref context menu for a detached HEAD', async () => {
    const events = await contextMenuOver({
      label: 'HEAD (detached)',
      fullName: 'HEAD',
      refType: 'detachedHead',
      isHead: true,
    });

    expect(
      events.length,
      'a detached HEAD names no ref, so branch and tag actions must not be offered',
    ).to.equal(0);
  });

  it('still opens the menu for a local branch', async () => {
    const events = await contextMenuOver({
      label: 'feature',
      fullName: 'refs/heads/feature',
      refType: 'localBranch',
      isHead: false,
    });

    expect(events.length, 'real refs must keep their context menu').to.equal(1);
    expect((events[0].detail as { refName: string }).refName).to.equal('feature');
  });

  it('gives the detached HEAD badge its own class, not the branch one', async () => {
    // getRefClass returned '' for any type it did not know, so the badge
    // rendered unstyled — indistinguishable from no badge at all.
    const { GnCommitDetails } = await import('../../panels/gn-commit-details.ts');
    const details = new GnCommitDetails();
    const getRefClass = (details as any).getRefClass.bind(details);

    expect(getRefClass('detachedHead')).to.equal('detached-head');
    expect(getRefClass('localBranch'), 'a branch keeps its own class').to.equal('local-branch');
    expect(getRefClass('somethingElse'), 'unknown types still fall through').to.equal('');
  });

  it('still opens no menu for a pull request label', async () => {
    const events = await contextMenuOver({
      label: '#42',
      fullName: '#42',
      refType: 'pullRequest',
      isHead: false,
    });

    expect(events.length).to.equal(0);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
