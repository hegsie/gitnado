/**
 * The embedded terminal owns the keyboard.
 *
 * In a shell, Ctrl+R is history search, Ctrl+B / Ctrl+F move the cursor, and
 * Ctrl+J is a newline. Those are also app shortcuts, and the service lets
 * ctrl combos through from text fields on purpose — so without a terminal rule,
 * pressing Ctrl+R at a prompt would open Undo History instead.
 */

import { expect } from '@open-wc/testing';
import { keyboardService } from '../keyboard.service.ts';

const STORAGE_KEY = 'gitnado-keyboard-settings';

function typeIn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('keyboard.service inside the embedded terminal', () => {
  let terminal: HTMLElement;
  let helper: HTMLTextAreaElement;
  let outside: HTMLTextAreaElement;
  const fired: string[] = [];
  const registered: string[] = [];

  function register(id: string, key: string): void {
    keyboardService.register(id, {
      key,
      ctrl: true,
      description: 'Test',
      category: 'Test',
      action: () => fired.push(id),
    });
    registered.push(id);
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    fired.length = 0;
    // Stand-in for the panel; xterm types into a hidden textarea inside it.
    terminal = document.createElement('gn-terminal-panel');
    helper = document.createElement('textarea');
    terminal.append(helper);
    outside = document.createElement('textarea');
    document.body.append(terminal, outside);
  });

  afterEach(() => {
    terminal.remove();
    outside.remove();
    for (const id of registered.splice(0)) keyboardService.unregister(id);
  });

  it('leaves Ctrl combos to the shell', () => {
    register('test-reflog', 'r');
    register('test-left', 'b');

    const r = typeIn(helper, { key: 'r', ctrlKey: true });
    const b = typeIn(helper, { key: 'b', ctrlKey: true });

    expect(fired).to.be.empty;
    expect(r.defaultPrevented, 'the shell must receive Ctrl+R').to.be.false;
    expect(b.defaultPrevented).to.be.false;
  });

  it('still runs the shortcut that toggles the terminal', () => {
    register('toggle-terminal', '`');
    const e = typeIn(helper, { key: '`', ctrlKey: true });
    expect(fired).to.deep.equal(['toggle-terminal']);
    expect(e.defaultPrevented).to.be.true;
  });

  it('lets Cmd combos through (terminals never receive them on macOS)', () => {
    register('test-palette', 'p');
    typeIn(helper, { key: 'p', metaKey: true });
    expect(fired).to.deep.equal(['test-palette']);
  });

  it('does not change behaviour outside the terminal', () => {
    register('test-reflog', 'r');
    typeIn(outside, { key: 'r', ctrlKey: true });
    expect(fired).to.deep.equal(['test-reflog']);
  });
});
