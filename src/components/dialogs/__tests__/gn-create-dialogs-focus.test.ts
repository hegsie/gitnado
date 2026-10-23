/**
 * Deferred-focus tests for the create-tag and create-branch dialogs.
 *
 * Both dialogs focus their name field shortly after open(). That focus pass must
 * not fire unconditionally: the user can click or Tab into another field in the
 * meantime, and yanking the caret back into the name box drops the rest of what
 * they type into the wrong input (the tag Message stayed empty and Create Tag
 * stayed disabled).
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { LitElement } from 'lit';
import type { GnCreateTagDialog } from '../gn-create-tag-dialog.ts';
import type { GnCreateBranchDialog } from '../gn-create-branch-dialog.ts';
import '../gn-create-tag-dialog.ts';
import '../gn-create-branch-dialog.ts';
import { deepActiveElement } from '../../../utils/focus.ts';

/**
 * Resolve well after the dialogs' focus pass. Long enough to also cover the
 * 100ms timer this replaced, so a revert to that code fails these tests rather
 * than finishing before it could steal anything.
 */
function afterFocusPass(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 150));
  });
}

/**
 * Advance to the point where the modal is visible but the dialog's deferred
 * focus pass has not yet run — the window in which a real user can click into
 * another field. `open()` reveals the modal from a `updateComplete.then`, and
 * the reveal only takes effect once <gn-modal> has reflected `open`; both are
 * microtasks, so they all land before the pending frame.
 */
async function openAndSettleBeforeFocusPass(el: LitElement): Promise<void> {
  (el as unknown as { open: () => void }).open();
  await el.updateComplete;
  await el.updateComplete;
  const modal = el.shadowRoot!.querySelector('gn-modal') as LitElement & { open: boolean };
  expect(modal.open).to.equal(true);
  await modal.updateComplete;
}

describe('create-tag / create-branch deferred focus', () => {
  it('create-tag focuses the name field when the user has not taken focus', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${'/repo'}></gn-create-tag-dialog>`,
    );
    await openAndSettleBeforeFocusPass(el);
    await afterFocusPass();

    expect(deepActiveElement()?.id).to.equal('tag-name-input');
  });

  it('create-tag does not steal focus back from a field the user moved to', async () => {
    const el = await fixture<GnCreateTagDialog>(
      html`<gn-create-tag-dialog .repositoryPath=${'/repo'}></gn-create-tag-dialog>`,
    );
    await openAndSettleBeforeFocusPass(el);

    // The user clicks into Message before the deferred focus pass runs.
    el.shadowRoot!.querySelector<HTMLTextAreaElement>('#message-input')!.focus();
    expect(deepActiveElement()?.id).to.equal('message-input');

    await afterFocusPass();

    expect(deepActiveElement()?.id).to.equal('message-input');
  });

  it('create-branch focuses the name field when the user has not taken focus', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${'/repo'}></gn-create-branch-dialog>`,
    );
    await openAndSettleBeforeFocusPass(el);
    await afterFocusPass();

    expect(deepActiveElement()?.id).to.equal('branch-name-input');
  });

  it('create-branch does not steal focus back from a field the user moved to', async () => {
    const el = await fixture<GnCreateBranchDialog>(
      html`<gn-create-branch-dialog .repositoryPath=${'/repo'}></gn-create-branch-dialog>`,
    );
    await openAndSettleBeforeFocusPass(el);

    // The user tabs to the "check out after create" toggle before the pass runs.
    el.shadowRoot!.querySelector<HTMLInputElement>('#checkout-after')!.focus();
    expect(deepActiveElement()?.id).to.equal('checkout-after');

    await afterFocusPass();

    expect(deepActiveElement()?.id).to.equal('checkout-after');
  });
});
