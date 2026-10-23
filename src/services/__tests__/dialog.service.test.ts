import { expect } from '@open-wc/testing';

// Track invocations of the Tauri dialog commands
const invokeLog: { command: string; args: unknown }[] = [];
let invokeResult: unknown = null;
let invokeShouldThrow = false;

// Mock Tauri internals before importing dialog.service
if (!(globalThis as Record<string, unknown>).__TAURI_INTERNALS__) {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string, args?: unknown): Promise<unknown> => {
      invokeLog.push({ command, args });
      if (invokeShouldThrow) return Promise.reject(new Error('mock error'));
      return Promise.resolve(invokeResult);
    },
    transformCallback: () => 0,
  };
}

// Must mark the window as Tauri to pass isTauri() check
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = (
  globalThis as unknown as Record<string, unknown>
).__TAURI_INTERNALS__;

import {
  openDialog,
  openRepositoryDialog,
  openCloneDestinationDialog,
  saveDialog,
  showMessage,
  showConfirm,
  showAsk,
  showPrompt,
} from '../dialog.service.ts';

describe('dialog.service', () => {
  beforeEach(() => {
    invokeLog.length = 0;
    invokeResult = null;
    invokeShouldThrow = false;
  });

  describe('showConfirm', () => {
    it('returns false when the dialog IPC rejects, rather than throwing', async () => {
      // Every destructive handler claims the shared working-tree lock BEFORE
      // this confirm — showConfirm is an IPC round trip, so a claim taken after
      // it does not serialize a double-click — and most claim outside the
      // try/finally that releases. A throw from here would unwind past the
      // release and leave the repo's lock held for the rest of the session,
      // disabling every ref control in every surface. Not being able to ask
      // also means the only safe answer is "no".
      invokeShouldThrow = true;

      const result = await showConfirm('Delete Branch', 'Are you sure?', 'warning');

      expect(result, 'an unaskable confirm must read as declined').to.equal(false);
    });

    it('still returns the answer on the happy path', async () => {
      invokeResult = 'Ok';
      expect(await showConfirm('Title', 'Message')).to.equal(true);
      invokeResult = 'Cancel';
      expect(await showConfirm('Title', 'Message')).to.equal(false);
    });
  });

  describe('showPrompt', () => {
    it('returns null instead of rejecting when the prompt cannot be shown', async () => {
      // Several callers claim the shared working-tree lock BEFORE this prompt
      // and do so outside the try/finally that releases it, so a throw would
      // unwind past the release and hold that repo's lock for the session —
      // disabling every ref control in every surface. Being unable to ask is
      // the same as a cancel.
      const el = document.querySelector('gn-prompt-dialog');
      el?.remove();
      const original = document.createElement.bind(document);
      (document as unknown as { createElement: unknown }).createElement = ((
        tag: string,
      ) => {
        if (tag === 'gn-prompt-dialog') throw new Error('chunk load failed');
        return original(tag);
      }) as typeof document.createElement;

      try {
        const result = await showPrompt('Rename Branch', 'New name:');
        expect(result, 'an unaskable prompt must read as cancelled').to.equal(null);
      } finally {
        (document as unknown as { createElement: unknown }).createElement = original;
      }
    });
  });

  describe('openDialog', () => {
    it('should return null when dialog is cancelled', async () => {
      invokeResult = null;
      const result = await openDialog();
      expect(result).to.be.null;
    });

    it('should return a file path when selected', async () => {
      invokeResult = '/test/repo';
      const result = await openDialog({ directory: true });
      expect(result).to.equal('/test/repo');
    });

    it('should return array for multiple selection', async () => {
      invokeResult = ['/path/one', '/path/two'];
      const result = await openDialog({ multiple: true });
      expect(result).to.deep.equal(['/path/one', '/path/two']);
    });

    it('should propagate errors', async () => {
      invokeShouldThrow = true;
      try {
        await openDialog();
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.equal('mock error');
      }
    });
  });

  describe('openRepositoryDialog', () => {
    it('should return a string path', async () => {
      invokeResult = '/home/user/repo';
      const result = await openRepositoryDialog();
      expect(result).to.equal('/home/user/repo');
    });

    it('should return null on cancel', async () => {
      invokeResult = null;
      const result = await openRepositoryDialog();
      expect(result).to.be.null;
    });

    it('should return first element when result is array', async () => {
      invokeResult = ['/first/repo', '/second/repo'];
      const result = await openRepositoryDialog();
      expect(result).to.equal('/first/repo');
    });

    it('should return null for empty array result', async () => {
      invokeResult = [];
      const result = await openRepositoryDialog();
      expect(result).to.be.null;
    });
  });

  describe('openCloneDestinationDialog', () => {
    it('should return selected directory', async () => {
      invokeResult = '/clone/destination';
      const result = await openCloneDestinationDialog();
      expect(result).to.equal('/clone/destination');
    });

    it('should return null on cancel', async () => {
      invokeResult = null;
      const result = await openCloneDestinationDialog();
      expect(result).to.be.null;
    });

    it('should return first element when result is array', async () => {
      invokeResult = ['/first/path'];
      const result = await openCloneDestinationDialog();
      expect(result).to.equal('/first/path');
    });

    it('should accept a default path', async () => {
      invokeResult = '/some/path';
      const result = await openCloneDestinationDialog('/default/path');
      expect(result).to.equal('/some/path');
    });
  });

  describe('saveDialog', () => {
    it('should return a file path when saved', async () => {
      invokeResult = '/save/file.txt';
      const result = await saveDialog({ title: 'Save' });
      expect(result).to.equal('/save/file.txt');
    });

    it('should return null on cancel or error', async () => {
      invokeShouldThrow = true;
      const result = await saveDialog();
      expect(result).to.be.null;
    });
  });

  describe('showMessage', () => {
    it('should not throw', async () => {
      invokeResult = undefined;
      await showMessage('Title', 'Body');
    });

    it('should accept kind parameter', async () => {
      invokeResult = undefined;
      await showMessage('Warning', 'Careful!', 'warning');
    });
  });

  describe('showConfirm', () => {
    it('should return true when confirmed', async () => {
      // plugin-dialog 2.7: confirm() resolves true only when the underlying
      // `plugin:dialog|message` command returns the OK button label ('Ok'),
      // no longer a boolean.
      invokeResult = 'Ok';
      const result = await showConfirm('Confirm', 'Are you sure?');
      expect(result).to.be.true;
    });

    it('should return false when denied', async () => {
      invokeResult = 'Cancel';
      const result = await showConfirm('Confirm', 'Are you sure?');
      expect(result).to.be.false;
    });

    it('should accept kind parameter', async () => {
      invokeResult = 'Ok';
      const result = await showConfirm('Delete', 'Remove file?', 'warning');
      expect(result).to.be.true;
    });
  });

  describe('showAsk', () => {
    it('should return true when OK is pressed', async () => {
      // plugin-dialog 2.7: ask() resolves true only when the message command
      // returns the affirmative button label ('Yes').
      invokeResult = 'Yes';
      const result = await showAsk('Question', 'Proceed?');
      expect(result).to.be.true;
    });

    it('should return false when Cancel is pressed', async () => {
      invokeResult = 'No';
      const result = await showAsk('Question', 'Proceed?');
      expect(result).to.be.false;
    });

    it('should accept kind parameter', async () => {
      invokeResult = 'No';
      const result = await showAsk('Error', 'Retry?', 'error');
      expect(result).to.be.false;
    });
  });
});
