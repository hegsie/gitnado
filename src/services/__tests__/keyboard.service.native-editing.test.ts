/**
 * Global shortcuts must not steal the browser's text-editing combos.
 *
 * handleKeyDown deliberately lets ctrl/meta shortcuts through while the caret is
 * in an input, so that Ctrl+P and friends still work from a search box. But the
 * Undo History dialog is registered on Ctrl/Cmd+Z, and matching it there
 * preventDefault()s the field's own undo: pressing Ctrl+Z to take back a word of
 * a commit message threw a modal over the user's work instead — on every text
 * field in the app.
 */

import { expect } from '@open-wc/testing';
import { keyboardService } from '../keyboard.service.ts';

const STORAGE_KEY = 'gitnado-keyboard-settings';

/** Dispatch a keydown as though it originated inside `target`. */
function typeIn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('keyboard.service native editing keys', () => {
  let input: HTMLInputElement;
  let textarea: HTMLTextAreaElement;
  const registered: string[] = [];

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    registered.length = 0;

    input = document.createElement('input');
    textarea = document.createElement('textarea');
    document.body.append(input, textarea);
  });

  afterEach(() => {
    input.remove();
    textarea.remove();
    for (const id of registered) {
      keyboardService.unregister(id);
    }
  });

  function register(id: string, fired: string[], shortcut: Partial<Parameters<typeof keyboardService.register>[1]>): void {
    keyboardService.register(id, {
      key: 'z',
      ctrl: true,
      description: 'Test',
      category: 'Test',
      action: () => fired.push(id),
      ...shortcut,
    } as Parameters<typeof keyboardService.register>[1]);
    registered.push(id);
  }

  it('leaves Ctrl+Z to the input instead of opening Undo History', () => {
    const fired: string[] = [];
    register('test-reflog', fired, { key: 'z', ctrl: true });

    const event = typeIn(input, { key: 'z', ctrlKey: true });

    expect(fired, 'the global shortcut must not run while typing').to.be.empty;
    expect(event.defaultPrevented, 'native undo must not be preventDefault()ed').to.be.false;
  });

  it('leaves Cmd+Z alone too (ctrl and meta collapse to the same binding)', () => {
    const fired: string[] = [];
    register('test-reflog-meta', fired, { key: 'z', ctrl: true });

    const event = typeIn(textarea, { key: 'z', metaKey: true });

    expect(fired).to.be.empty;
    expect(event.defaultPrevented).to.be.false;
  });

  it('leaves select-all and clipboard combos to the field', () => {
    const fired: string[] = [];
    register('test-select-all', fired, { key: 'a', ctrl: true });
    register('test-cut', fired, { key: 'x', ctrl: true });

    const selectAll = typeIn(input, { key: 'a', ctrlKey: true });
    const cut = typeIn(input, { key: 'x', ctrlKey: true });

    expect(fired).to.be.empty;
    expect(selectAll.defaultPrevented).to.be.false;
    expect(cut.defaultPrevented).to.be.false;
  });

  it('still runs non-editing ctrl shortcuts from inside an input', () => {
    const fired: string[] = [];
    register('test-palette', fired, { key: 'p', ctrl: true });

    typeIn(input, { key: 'p', ctrlKey: true });

    expect(fired, 'Ctrl+P must keep working from a text field').to.deep.equal(['test-palette']);
  });

  it('still runs Ctrl+Z when focus is not in a text field', () => {
    const fired: string[] = [];
    register('test-reflog-global', fired, { key: 'z', ctrl: true });

    const button = document.createElement('button');
    document.body.append(button);
    try {
      typeIn(button, { key: 'z', ctrlKey: true });
      expect(fired, 'Undo History must still open from outside an input').to.deep.equal([
        'test-reflog-global',
      ]);
    } finally {
      button.remove();
    }
  });
});
