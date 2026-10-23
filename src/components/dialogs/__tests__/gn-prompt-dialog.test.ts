/**
 * Prompt Dialog Tests
 *
 * Tests the gn-prompt-dialog component that provides a themed replacement
 * for native prompt() calls.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';

import '../gn-prompt-dialog.ts';
import type { GnPromptDialog } from '../gn-prompt-dialog.ts';

describe('gn-prompt-dialog', () => {
  let el: GnPromptDialog;

  beforeEach(async () => {
    el = await fixture<GnPromptDialog>(html`<gn-prompt-dialog></gn-prompt-dialog>`);
  });

  it('settles a superseded prompt instead of orphaning it', async () => {
    // This element is a singleton reused by every showPrompt() call. open()
    // used to overwrite its resolver, so the first promise never settled —
    // and several callers claim the shared working-tree lock BEFORE awaiting a
    // prompt, so the handler never reached its release and the repo's lock was
    // held for the rest of the session. The command palette renders over other
    // dialogs by design and its own actions call showPrompt, so one Ctrl+P away
    // from a focused prompt was enough.
    const first = el.open({ title: 'Rename Branch', message: 'New name:' });

    let settled = false;
    let firstValue: string | null | undefined;
    void first.then((v) => {
      settled = true;
      firstValue = v;
    });

    // A second flow takes the singleton over.
    const second = el.open({ title: 'Smart Undo', message: 'Describe:' });
    await el.updateComplete;
    await Promise.resolve();

    expect(settled, 'the superseded prompt must not hang forever').to.equal(true);
    expect(firstValue, 'it reads as cancelled').to.equal(null);

    // The newer prompt still works.
    (el as unknown as { value: string }).value = 'answer';
    (el as unknown as { handleConfirm: () => void }).handleConfirm();
    expect(await second).to.equal('answer');
  });

  it('opens and shows title and message', async () => {
    // Don't await the promise — just trigger open
    const resultPromise = el.open({
      title: 'Test Title',
      message: 'Test message',
    });

    await el.updateComplete;

    const modal = el.shadowRoot!.querySelector('gn-modal')!;
    expect(modal.modalTitle).to.equal('Test Title');
    expect(modal.open).to.be.true;

    const message = el.shadowRoot!.querySelector('.prompt-message')!;
    expect(message.textContent).to.equal('Test message');

    // Clean up — cancel to resolve the promise
    const cancelBtn = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
    cancelBtn.click();
    const result = await resultPromise;
    expect(result).to.be.null;
  });

  it('pre-fills input with defaultValue', async () => {
    const resultPromise = el.open({
      title: 'Rename',
      message: 'Enter name:',
      defaultValue: 'my-branch',
    });

    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('.prompt-input') as HTMLInputElement;
    expect(input.value).to.equal('my-branch');

    // Clean up
    const cancelBtn = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
    cancelBtn.click();
    await resultPromise;
  });

  it('returns input value on confirm click', async () => {
    const resultPromise = el.open({
      title: 'Name',
      message: 'Enter name:',
      defaultValue: 'hello',
    });

    await el.updateComplete;

    const confirmBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
    confirmBtn.click();

    const result = await resultPromise;
    expect(result).to.equal('hello');
  });

  it('returns null on cancel click', async () => {
    const resultPromise = el.open({
      title: 'Name',
      message: 'Enter name:',
      defaultValue: 'hello',
    });

    await el.updateComplete;

    const cancelBtn = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
    cancelBtn.click();

    const result = await resultPromise;
    expect(result).to.be.null;
  });

  it('returns value on Enter key', async () => {
    const resultPromise = el.open({
      title: 'Name',
      message: 'Enter name:',
      defaultValue: 'test-value',
    });

    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('.prompt-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const result = await resultPromise;
    expect(result).to.equal('test-value');
  });

  it('returns null on modal close event (Escape)', async () => {
    const resultPromise = el.open({
      title: 'Name',
      message: 'Enter name:',
    });

    await el.updateComplete;

    const modal = el.shadowRoot!.querySelector('gn-modal')!;
    modal.close();

    const result = await resultPromise;
    expect(result).to.be.null;
  });

  it('uses custom button labels', async () => {
    const resultPromise = el.open({
      title: 'Confirm',
      message: 'Enter value:',
      confirmLabel: 'Save',
      cancelLabel: 'Dismiss',
    });

    await el.updateComplete;

    const confirmBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
    const cancelBtn = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
    expect(confirmBtn.textContent!.trim()).to.equal('Save');
    expect(cancelBtn.textContent!.trim()).to.equal('Dismiss');

    // Clean up
    cancelBtn.click();
    await resultPromise;
  });

  it('shows placeholder text', async () => {
    const resultPromise = el.open({
      title: 'Feature',
      message: 'Enter feature name:',
      placeholder: 'feature-name',
    });

    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('.prompt-input') as HTMLInputElement;
    expect(input.placeholder).to.equal('feature-name');

    // Clean up
    const cancelBtn = el.shadowRoot!.querySelector('.btn-secondary') as HTMLButtonElement;
    cancelBtn.click();
    await resultPromise;
  });

  it('returns updated input value after user typing', async () => {
    const resultPromise = el.open({
      title: 'Name',
      message: 'Enter name:',
      defaultValue: '',
    });

    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('.prompt-input') as HTMLInputElement;
    input.value = 'new-value';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const confirmBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
    confirmBtn.click();

    const result = await resultPromise;
    expect(result).to.equal('new-value');
  });
});
