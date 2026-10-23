/**
 * gn-toggle — the shared on/off switch.
 *
 * It replaces the `<label class="toggle-switch"><input type="checkbox">`
 * markup that Settings, GPG, Create Tag and Keyboard Shortcuts each carried a
 * copy of. That markup had no accessible name (the visible text was a sibling
 * with no `for`/`id` link) and no keyboard affordance beyond the browser's
 * default checkbox, so the tests below pin the three things that were missing:
 * a name, a `switch` role whose `aria-checked` tracks the state, and Space /
 * Enter activation.
 */

import { expect, fixture, html, oneEvent } from '@open-wc/testing';
import '../gn-toggle.ts';
import type { GnToggle } from '../gn-toggle.ts';

function switchEl(el: GnToggle): HTMLButtonElement {
  const button = el.shadowRoot?.querySelector<HTMLButtonElement>('button.toggle-switch');
  expect(button, 'the switch is rendered').to.exist;
  return button as HTMLButtonElement;
}

/** The accessible name, resolved the way `aria-labelledby` says to. */
function accessibleName(el: GnToggle): string {
  const button = switchEl(el);
  const id = button.getAttribute('aria-labelledby');
  if (id) {
    return el.shadowRoot?.getElementById(id)?.textContent?.trim() ?? '';
  }
  return button.getAttribute('aria-label')?.trim() ?? '';
}

describe('gn-toggle', () => {
  it('exposes the label as its accessible name', async () => {
    const el = await fixture<GnToggle>(
      html`<gn-toggle label="Show Avatars"></gn-toggle>`
    );
    expect(accessibleName(el)).to.equal('Show Avatars');
  });

  it('is a switch whose aria-checked follows the checked property', async () => {
    const el = await fixture<GnToggle>(
      html`<gn-toggle label="Word Wrap"></gn-toggle>`
    );
    expect(switchEl(el).getAttribute('role')).to.equal('switch');
    expect(switchEl(el).getAttribute('aria-checked')).to.equal('false');

    el.checked = true;
    await el.updateComplete;
    expect(switchEl(el).getAttribute('aria-checked')).to.equal('true');
  });

  it('describes itself with the description when one is given', async () => {
    const el = await fixture<GnToggle>(
      html`<gn-toggle
        label="Offline Mode"
        description="Block every operation that leaves this machine"
      ></gn-toggle>`
    );
    const id = switchEl(el).getAttribute('aria-describedby');
    expect(id, 'aria-describedby is set').to.be.a('string');
    expect(el.shadowRoot?.getElementById(id as string)?.textContent?.trim()).to.equal(
      'Block every operation that leaves this machine'
    );
  });

  it('leaves aria-describedby off when there is no description', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Sign tags"></gn-toggle>`);
    expect(switchEl(el).hasAttribute('aria-describedby')).to.equal(false);
  });

  it('reports the requested value on click', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Sign commits"></gn-toggle>`);

    setTimeout(() => switchEl(el).click());
    const event = (await oneEvent(el, 'change')) as CustomEvent<{ checked: boolean }>;
    expect(event.detail).to.deep.equal({ checked: true });
  });

  it('reports the requested value when turning off', async () => {
    const el = await fixture<GnToggle>(
      html`<gn-toggle label="Sign commits" checked></gn-toggle>`
    );
    expect(el.checked).to.equal(true);

    setTimeout(() => switchEl(el).click());
    const event = (await oneEvent(el, 'change')) as CustomEvent<{ checked: boolean }>;
    expect(event.detail).to.deep.equal({ checked: false });
  });

  it('does not write to checked itself — the owner does', async () => {
    // Self-mutating would strand the switch in the wrong position whenever the
    // owner rejects the change (a failed `git config` write), because Lit's
    // property binding would then dirty-check against the value it committed.
    const el = await fixture<GnToggle>(html`<gn-toggle label="Sign tags"></gn-toggle>`);
    switchEl(el).click();
    await el.updateComplete;
    expect(el.checked).to.equal(false);
    expect(switchEl(el).getAttribute('aria-checked')).to.equal('false');
  });

  it('toggles on Space and on Enter', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Vim-style navigation"></gn-toggle>`);
    const seen: boolean[] = [];
    el.addEventListener('change', (e) => {
      seen.push((e as CustomEvent<{ checked: boolean }>).detail.checked);
    });

    for (const key of [' ', 'Enter']) {
      switchEl(el).dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    }
    expect(seen).to.deep.equal([true, true]);
  });

  it('cancels the key event so the browser does not also synthesise a click', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Vim-style navigation"></gn-toggle>`);
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    switchEl(el).dispatchEvent(event);
    expect(event.defaultPrevented).to.equal(true);
  });

  it('ignores keys that are not Space or Enter', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Vim-style navigation"></gn-toggle>`);
    let fired = 0;
    el.addEventListener('change', () => { fired++; });

    switchEl(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    );
    expect(fired).to.equal(0);
  });

  it('stays silent while disabled', async () => {
    const el = await fixture<GnToggle>(
      html`<gn-toggle label="Sign commits" disabled></gn-toggle>`
    );
    let fired = 0;
    el.addEventListener('change', () => { fired++; });

    expect(switchEl(el).disabled).to.equal(true);
    switchEl(el).click();
    switchEl(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    expect(fired).to.equal(0);
  });

  it('bubbles the change out of the host so a dialog can listen for it', async () => {
    const host = await fixture<HTMLDivElement>(
      html`<div><gn-toggle label="Minimize to Tray"></gn-toggle></div>`
    );
    const el = host.querySelector('gn-toggle') as GnToggle;
    let seen: boolean | undefined;
    host.addEventListener('change', (e) => {
      seen = (e as CustomEvent<{ checked: boolean }>).detail.checked;
    });

    switchEl(el).click();
    expect(seen).to.equal(true);
  });

  it('renders at the same 40x22 the hand-rolled switches used', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Word Wrap"></gn-toggle>`);
    const box = switchEl(el).getBoundingClientRect();
    expect(Math.round(box.width)).to.equal(40);
    expect(Math.round(box.height)).to.equal(22);
  });

  it('honours the size custom properties so a caller keeps its own dimensions', async () => {
    // The Keyboard Shortcuts footer switch has always been 36x20.
    const host = await fixture<HTMLDivElement>(
      html`<div style="--gn-toggle-width: 36px; --gn-toggle-height: 20px">
        <gn-toggle label="Vim-style navigation"></gn-toggle>
      </div>`
    );
    const el = host.querySelector('gn-toggle') as GnToggle;
    const box = switchEl(el).getBoundingClientRect();
    expect(Math.round(box.width)).to.equal(36);
    expect(Math.round(box.height)).to.equal(20);

    const knob = getComputedStyle(
      el.shadowRoot?.querySelector('.toggle-slider') as Element,
      '::before'
    );
    expect(knob.width).to.equal('14px');
    expect(knob.height).to.equal('14px');
  });

  it('focus() moves focus onto the switch itself', async () => {
    const el = await fixture<GnToggle>(html`<gn-toggle label="Word Wrap"></gn-toggle>`);
    el.focus();
    expect(el.shadowRoot?.activeElement).to.equal(switchEl(el));
  });
});
