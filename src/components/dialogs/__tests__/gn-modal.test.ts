/**
 * gn-modal tests — focuses on the header controls (close × vs. back ←).
 */
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-modal.ts';
import type { GnModal } from '../gn-modal.ts';
import { deepActiveElement } from '../../../utils/focus.ts';
import { resetOverlayStack } from '../../../utils/overlay-stack.ts';

/**
 * A host with its own shadow root, standing in for the app behind the modal.
 * `document.activeElement` reports THIS element while its inner button holds
 * focus — which is exactly why the modal cannot use document.activeElement.
 */
class ModalTestHost extends HTMLElement {
  connectedCallback(): void {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.id = 'outside';
    btn.textContent = 'Outside';
    root.appendChild(btn);
  }

  get button(): HTMLButtonElement {
    return this.shadowRoot!.querySelector('button')!;
  }
}
customElements.define('modal-test-host', ModalTestHost);

/** Resolve after the modal's requestAnimationFrame focus pass. */
function afterFocusPass(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe('gn-modal', () => {
  it('shows a close button by default', async () => {
    const el = await fixture<GnModal>(html`<gn-modal .open=${true} modalTitle="Test"></gn-modal>`);
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('button[aria-label="Close"]')).to.not.be.null;
    expect(el.shadowRoot!.querySelector('button[aria-label="Back"]')).to.be.null;
  });

  it('shows a back button (and no close) when backButton is set', async () => {
    const el = await fixture<GnModal>(
      html`<gn-modal .open=${true} ?backButton=${true} modalTitle="Test"></gn-modal>`
    );
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('button[aria-label="Back"]')).to.not.be.null;
    expect(el.shadowRoot!.querySelector('button[aria-label="Close"]')).to.be.null;
  });

  it('dispatches close when the back button is clicked', async () => {
    const el = await fixture<GnModal>(
      html`<gn-modal .open=${true} ?backButton=${true} modalTitle="Test"></gn-modal>`
    );
    await el.updateComplete;

    let closed = false;
    el.addEventListener('close', () => {
      closed = true;
    });
    (el.shadowRoot!.querySelector('button[aria-label="Back"]') as HTMLButtonElement).click();
    expect(closed).to.be.true;
  });
});

describe('gn-modal focus handling', () => {
  beforeEach(() => {
    resetOverlayStack();
    document.body.focus();
  });

  it('wraps Shift+Tab from its own header button back to the last slotted control', async () => {
    const el = await fixture<GnModal>(html`
      <gn-modal .open=${true} modalTitle="Test">
        <button id="body-btn">Body</button>
        <button slot="footer" id="footer-btn">Footer</button>
      </gn-modal>
    `);
    await el.updateComplete;
    await afterFocusPass();

    const closeBtn = el.shadowRoot!.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    const footerBtn = el.querySelector('#footer-btn') as HTMLButtonElement;
    closeBtn.focus();
    // The header button lives in the shadow root, so document.activeElement is
    // <gn-modal> here — the state in which the old comparison never matched.
    expect(document.activeElement === el, 'document.activeElement only ever names the host').to.be.true;
    expect(deepActiveElement() === closeBtn, 'the header button really holds focus').to.be.true;

    const event = pressTab(true);

    expect(event.defaultPrevented, 'the modal swallowed the Tab').to.be.true;
    expect(deepActiveElement() === footerBtn, 'focus wrapped to the last control').to.be.true;
  });

  it('wraps Tab forward when the only control is inside the shadow root', async () => {
    const el = await fixture<GnModal>(html`<gn-modal .open=${true} modalTitle="Test"></gn-modal>`);
    await el.updateComplete;
    await afterFocusPass();

    const closeBtn = el.shadowRoot!.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    closeBtn.focus();

    const event = pressTab();

    expect(event.defaultPrevented, 'Tab cannot leave the modal').to.be.true;
    expect(deepActiveElement() === closeBtn, 'focus stayed on the only control').to.be.true;
  });

  it('restores focus to the element that was focused inside another shadow root', async () => {
    const host = await fixture<ModalTestHost>(html`<modal-test-host></modal-test-host>`);
    const el = await fixture<GnModal>(html`<gn-modal modalTitle="Test"></gn-modal>`);
    await el.updateComplete;

    host.button.focus();
    expect(deepActiveElement() === host.button, 'the outside button holds focus').to.be.true;

    el.open = true;
    await el.updateComplete;
    await afterFocusPass();
    expect(deepActiveElement() === host.button, 'the modal took focus off it').to.be.false;

    el.open = false;
    await el.updateComplete;
    await afterFocusPass();

    expect(deepActiveElement() === host.button, 'focus went back where it came from').to.be.true;
  });
});
