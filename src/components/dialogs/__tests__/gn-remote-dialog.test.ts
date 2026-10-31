/**
 * Remote Dialog Unit Tests
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-remote-dialog.ts';
import type { GnRemoteDialog } from '../gn-remote-dialog.ts';

describe('gn-remote-dialog', () => {
  it('resets form state on reopen and clears stale remotes when get_remotes fails', async () => {
    mockInvoke = async (command: string) => {
      if (command === 'get_remotes') {
        return [{ name: 'origin', url: 'https://github.com/acme/a.git', pushUrl: null }];
      }
      return null;
    };

    const el = await fixture<GnRemoteDialog>(
      html`<gn-remote-dialog ?open=${true} .repositoryPath=${'/repo/a'}></gn-remote-dialog>`,
    );
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).remotes).to.have.lengthOf(1);

    // Enter add mode and populate form fields, then close via host property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).startAdd();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).formName = 'upstream';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).formUrl = 'https://github.com/acme/upstream.git';

    el.open = false;
    await el.updateComplete;

    mockInvoke = async (command: string) => {
      if (command === 'get_remotes') {
        throw { code: 'GIT_ERROR', message: 'Failed to read remotes' };
      }
      return null;
    };

    el.repositoryPath = '/repo/b';
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).mode).to.equal('list');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).formName).to.equal('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).formUrl).to.equal('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).remotes).to.deep.equal([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error).to.include('Failed to read remotes');
  });

  it('re-pins to the new repository when closed and reopened while an operation is in flight', async () => {
    let resolveAdd!: () => void;
    const remoteReads: string[] = [];
    const addedToRepo: string[] = [];

    mockInvoke = async (command: string, args?: unknown) => {
      const path = ((args as { path?: string }) ?? {}).path ?? '';
      if (command === 'get_remotes') {
        remoteReads.push(path);
        return [{ name: 'origin', url: `https://github.com/acme/${path}.git`, pushUrl: null }];
      }
      if (command === 'add_remote') {
        addedToRepo.push(path);
        await new Promise<void>((r) => {
          resolveAdd = r;
        });
        return null;
      }
      return null;
    };

    const el = await fixture<GnRemoteDialog>(
      html`<gn-remote-dialog ?open=${true} .repositoryPath=${'/repo/a'}></gn-remote-dialog>`,
    );
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // Start adding a remote on /repo/a
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).startAdd();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).formName = 'upstream';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).formUrl = 'https://github.com/acme/upstream.git';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addPromise = (el as any).handleAdd();
    await new Promise((r) => setTimeout(r, 10));

    // Close dialog, switch to /repo/b, and reopen while add_remote is still in flight
    el.open = false;
    await el.updateComplete;
    remoteReads.length = 0;

    el.repositoryPath = '/repo/b';
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 20));
    await el.updateComplete;

    // Reopen must pin and load /repo/b, and when /repo/a's add finishes it must not overwrite /repo/b
    expect(remoteReads).to.deep.equal(['/repo/b']);
    resolveAdd();
    await addPromise;

    expect(addedToRepo).to.deep.equal(['/repo/a']);
    expect(remoteReads).to.deep.equal(['/repo/b']);
  });
});
