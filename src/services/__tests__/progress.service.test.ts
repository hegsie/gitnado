/**
 * Progress Service Tests
 *
 * Tests for progress tracking and cancel operation via invokeCommand.
 */

import { expect } from '@open-wc/testing';

const invokeCallArgs: Array<{ command: string; args: Record<string, unknown> }> = [];

const mockInvoke = (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  invokeCallArgs.push({ command, args: args || {} });
  return Promise.resolve(null);
};

// Mock listen to return a no-op unlisten function
const mockListen = (): Promise<() => void> => {
  return Promise.resolve(() => {});
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Mock @tauri-apps/api/event
(globalThis as Record<string, unknown>).__TAURI_EVENT_INTERNALS__ = {
  listen: mockListen,
};

import { progressService, withProgress } from '../progress.service.ts';
import { clearLogEntries, getLogEntries } from '../output-log.service.ts';

describe('progress.service', () => {
  beforeEach(() => {
    invokeCallArgs.length = 0;
  });

  describe('ready', () => {
    it('should resolve the ready promise', async () => {
      // ready() should resolve without error even when listeners fail to set up
      await progressService.ready();
    });

    it('should be callable multiple times', async () => {
      await progressService.ready();
      await progressService.ready();
    });
  });

  describe('startOperation', () => {
    it('should return a unique operation ID', () => {
      const id1 = progressService.startOperation('fetch', 'Fetching...');
      const id2 = progressService.startOperation('push', 'Pushing...');

      expect(id1).to.not.equal(id2);
      expect(id1).to.include('op-');
      expect(id2).to.include('op-');

      progressService.completeOperation(id1);
      progressService.completeOperation(id2);
    });

    it('should add operation to list', () => {
      const id = progressService.startOperation('fetch', 'Fetching...');

      const ops = progressService.getOperations();
      expect(ops.some((op) => op.id === id)).to.be.true;

      progressService.completeOperation(id);
    });
  });

  describe('updateProgress', () => {
    it('should update operation progress', () => {
      const id = progressService.startOperation('fetch', 'Fetching...');

      progressService.updateProgress(id, 50, 'Halfway');

      const ops = progressService.getOperations();
      const op = ops.find((o) => o.id === id);
      expect(op?.progress).to.equal(50);
      expect(op?.message).to.equal('Halfway');

      progressService.completeOperation(id);
    });
  });

  describe('cancelOperation', () => {
    it('a Cancel click adds no row to the output panel', () => {
      // The fetch/pull/push being cancelled already has its row; the cancel
      // itself carries no repo path, so before it was skipped every click
      // left a bare `cancel_operation` row in EVERY repository's panel.
      clearLogEntries();
      const id = progressService.startOperation('fetch', 'Fetching...', { cancellable: true });

      progressService.cancelOperation(id);

      expect(invokeCallArgs.some((c) => c.command === 'cancel_operation')).to.be.true;
      expect(getLogEntries().length).to.equal(0);
    });

    it('should invoke cancel_operation via invokeCommand', () => {
      const id = progressService.startOperation('fetch', 'Fetching...', { cancellable: true });

      progressService.cancelOperation(id);

      const call = invokeCallArgs.find((c) => c.command === 'cancel_operation');
      expect(call).to.not.be.undefined;
      expect(call!.args.operationId).to.equal(id);
    });

    it('should remove operation after cancel', () => {
      const id = progressService.startOperation('fetch', 'Fetching...', { cancellable: true });

      progressService.cancelOperation(id);

      const ops = progressService.getOperations();
      expect(ops.some((op) => op.id === id)).to.be.false;
    });

    it('should mark operation as cancelled', () => {
      const id = progressService.startOperation('fetch', 'Fetching...', { cancellable: true });

      progressService.cancelOperation(id);

      expect(progressService.isCancelled(id)).to.be.true;
    });
  });

  describe('subscribe', () => {
    it('should notify on operation changes', () => {
      const notifications: number[] = [];
      const unsubscribe = progressService.subscribe((ops) => {
        notifications.push(ops.length);
      });

      const id = progressService.startOperation('fetch', 'Fetching...');
      progressService.completeOperation(id);

      // Should have received notifications: initial (subscribe), start, complete
      expect(notifications.length).to.be.greaterThan(0);

      unsubscribe();
    });
  });

  describe('withProgress', () => {
    it('should track operation lifecycle', async () => {
      const result = await withProgress('fetch', 'Test operation', async (updateProgress) => {
        updateProgress(50, 'Halfway');
        return 'done';
      });

      expect(result).to.equal('done');
    });

    it('should clean up on error', async () => {
      try {
        await withProgress('fetch', 'Failing operation', async () => {
          throw new Error('Test error');
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).to.equal('Test error');
      }
    });
  });
});
