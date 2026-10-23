/**
 * A toast action button survives its own click.
 *
 * Dismissal is animated: `dismissToast` marks the toast `.exiting` and removes
 * it from the store 200ms later, and `.exiting` drives a slideOut animation
 * without `pointer-events: none`. So the button stays rendered and clickable
 * after the first click. For the three destructive actions that live only on
 * toasts — Force Push, Force Push Tag, Force Delete — firing twice meant two
 * native confirms for one gesture, the second acting on a branch already
 * deleted or a remote already moved, contradicting the success message the user
 * had just read.
 */

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => 0,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-toast-container.ts';
import { uiStore } from '../../../stores/ui.store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Mount FIRST, then add. The container learns about toasts only through the
 * uiStore subscription it sets up in connectedCallback, so anything added
 * beforehand is invisible to it.
 */
async function containerWith(
  toasts: Array<{ message: string; action: { label: string; callback: () => void } }>,
): Promise<any> {
  const el = await fixture<any>(html`<gn-toast-container></gn-toast-container>`);
  await el.updateComplete;
  for (const t of toasts) {
    uiStore.getState().addToast({ message: t.message, type: 'error', action: t.action });
  }
  await el.updateComplete;
  return el;
}

describe('toast action buttons', () => {
  beforeEach(() => {
    uiStore.setState({ toasts: [] });
  });

  it('a double-click runs the action once', async () => {
    let fired = 0;
    const el = await containerWith([
      {
        message: 'Remote has newer changes.',
        action: { label: 'Force Push', callback: () => { fired++; } },
      },
    ]);

    const btn = el.shadowRoot!.querySelector('.toast-action-btn') as HTMLButtonElement;
    expect(btn, 'the action is rendered').to.not.be.null;
    btn.click();
    // Still in the DOM for the 200ms exit animation.
    btn.click();

    expect(fired, 'one gesture, one destructive operation').to.equal(1);
  });

  it('a second, different toast can still fire its own action', async () => {
    let first = 0;
    let second = 0;
    const el = await containerWith([
      { message: 'one', action: { label: 'Force Push', callback: () => { first++; } } },
      { message: 'two', action: { label: 'Force Push', callback: () => { second++; } } },
    ]);

    const buttons = el.shadowRoot!.querySelectorAll('.toast-action-btn');
    expect(buttons.length).to.equal(2);
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();

    expect(first, 'the guard is per toast, not global').to.equal(1);
    expect(second).to.equal(1);
  });

  it('dismissing is not acting', async () => {
    let fired = 0;
    const el = await containerWith([
      { message: 'dismiss me', action: { label: 'Force Push', callback: () => { fired++; } } },
    ]);

    (el.shadowRoot!.querySelector('.toast-close') as HTMLButtonElement).click();
    await el.updateComplete;

    expect(fired).to.equal(0);
  });
});
