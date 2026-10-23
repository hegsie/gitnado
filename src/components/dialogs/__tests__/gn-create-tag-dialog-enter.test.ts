/**
 * Enter inside the tag MESSAGE must insert a newline, not create the tag.
 *
 * handleKeyDown is bound on the whole form, so a plain Enter submitted from
 * anywhere. An annotated tag message is exactly the multi-line case — the
 * placeholder invites "Release notes or description..." — and canCreate is
 * already true once the name and first line exist. So pressing Enter to start
 * line two created the tag with a one-line message, with nothing hinting that
 * Shift+Enter was required, and the tag may be pushed before the user notices.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeCalls: Array<{ command: string; args?: unknown }> = [];
const mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

import { expect, fixture, html } from '@open-wc/testing';
import type { GnCreateTagDialog } from '../gn-create-tag-dialog.ts';
import '../gn-create-tag-dialog.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** An open dialog with a name and the first line of a message typed. */
async function armedDialog(): Promise<GnCreateTagDialog> {
  const el = await fixture<GnCreateTagDialog>(
    html`<gn-create-tag-dialog .repositoryPath=${'/test/repo'}></gn-create-tag-dialog>`,
  );
  await el.updateComplete;
  el.open();
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 20));

  (el as any).name = 'v1.0.0';
  (el as any).message = 'First line of the release notes';
  (el as any).isAnnotated = true;
  await el.updateComplete;
  expect((el as any).canCreate, 'the dialog must be armed to submit').to.be.true;
  return el;
}

/** Dispatch a keydown as though it came from `target`. */
function pressEnter(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** handleCreate is async and not awaited by the key handler. */
async function waitForCreateTag(): Promise<void> {
  for (let i = 0; i < 50 && !invokeCalls.some((c) => c.command === 'create_tag'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('gn-create-tag-dialog Enter handling', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
  });

  it('lets Enter insert a newline in the message textarea', async () => {
    const el = await armedDialog();
    const textarea = el.shadowRoot!.querySelector('textarea')!;
    expect(textarea, 'the message textarea is rendered').to.exist;

    const event = pressEnter(textarea);
    await el.updateComplete;

    expect(
      event.defaultPrevented,
      'Enter in the message must not be swallowed — it types a newline',
    ).to.be.false;
    expect(
      invokeCalls.some((c) => c.command === 'create_tag'),
      'a half-written message must not create the tag',
    ).to.be.false;
  });

  it('still submits on Ctrl+Enter from the textarea', async () => {
    const el = await armedDialog();
    const textarea = el.shadowRoot!.querySelector('textarea')!;

    const event = pressEnter(textarea, { ctrlKey: true });
    await el.updateComplete;
    await waitForCreateTag();

    expect(event.defaultPrevented, 'Ctrl+Enter is the deliberate submit').to.be.true;
    // preventDefault alone would still pass with submission broken, and a
    // shortcut that swallows the key without creating the tag is worse than no
    // shortcut at all.
    expect(
      invokeCalls.some((c) => c.command === 'create_tag'),
      'Ctrl+Enter must actually create the tag',
    ).to.be.true;
  });

  it('still submits on Enter from the name input', async () => {
    const el = await armedDialog();
    const input = el.shadowRoot!.querySelector('input')!;

    const event = pressEnter(input);
    await el.updateComplete;
    await waitForCreateTag();

    expect(
      event.defaultPrevented,
      'Enter from a single-line field still means submit',
    ).to.be.true;
    expect(
      invokeCalls.some((c) => c.command === 'create_tag'),
      'Enter from the name input must actually create the tag',
    ).to.be.true;
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
