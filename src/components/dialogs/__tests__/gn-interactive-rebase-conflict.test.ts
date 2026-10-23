/**
 * Interactive Rebase Dialog - Conflict Handling Tests
 *
 * Tests that the rebase dialog correctly hands off to the conflict
 * resolution dialog when conflicts are encountered during rebase.
 */

// Control what the mock invoke returns/throws per-command
let executeRebaseBehavior: 'success' | 'conflict' | 'error' = 'success';

const mockInvoke = (command: string): Promise<unknown> => {
  switch (command) {
    case 'get_rebase_commits':
      return Promise.resolve({
        commits: [
          { oid: 'abc1234567890', shortId: 'abc1234', summary: 'Commit A', action: 'pick' },
          { oid: 'def1234567890', shortId: 'def1234', summary: 'Commit B', action: 'pick' },
        ],
        mergeCount: 0,
      });
    case 'execute_interactive_rebase':
      if (executeRebaseBehavior === 'conflict') {
        return Promise.reject({ code: 'REBASE_CONFLICT', message: 'Conflicts detected' });
      }
      if (executeRebaseBehavior === 'error') {
        return Promise.reject({ code: 'OTHER_ERROR', message: 'Something went wrong' });
      }
      return Promise.resolve(undefined);
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-interactive-rebase-dialog.ts';
import type { GnInteractiveRebaseDialog } from '../gn-interactive-rebase-dialog.ts';

describe('Interactive Rebase Dialog - Conflict Handling', () => {
  let el: GnInteractiveRebaseDialog;

  beforeEach(async () => {
    executeRebaseBehavior = 'success';
    el = await fixture<GnInteractiveRebaseDialog>(html`
      <gn-interactive-rebase-dialog
        repositoryPath="/test/repo"
      ></gn-interactive-rebase-dialog>
    `);
    // Open and load commits
    await el.open('abc1234567890');
    await el.updateComplete;
  });

  it('should dispatch open-conflict-dialog when rebase returns REBASE_CONFLICT', async () => {
    executeRebaseBehavior = 'conflict';

    let conflictEvent: CustomEvent | null = null;
    el.addEventListener('open-conflict-dialog', ((e: CustomEvent) => {
      conflictEvent = e;
    }) as EventListener);

    // Trigger execute via the primary button
    const executeButton = el.shadowRoot?.querySelector('.btn-primary') as HTMLButtonElement;
    executeButton?.click();
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 100));

    expect(conflictEvent).to.not.be.null;
    expect(conflictEvent!.detail.operationType).to.equal('rebase');
  });

  it('should close dialog when rebase returns REBASE_CONFLICT', async () => {
    executeRebaseBehavior = 'conflict';

    const executeButton = el.shadowRoot?.querySelector('.btn-primary') as HTMLButtonElement;
    executeButton?.click();
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 100));

    const modal = el.shadowRoot?.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal?.open).to.be.false;
  });

  it('should dispatch rebase-complete and close on success', async () => {
    executeRebaseBehavior = 'success';

    let rebaseCompleteEvent = false;
    el.addEventListener('rebase-complete', () => {
      rebaseCompleteEvent = true;
    });

    const executeButton = el.shadowRoot?.querySelector('.btn-primary') as HTMLButtonElement;
    executeButton?.click();
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 100));

    expect(rebaseCompleteEvent).to.be.true;
    const modal = el.shadowRoot?.querySelector('gn-modal') as HTMLElement & { open: boolean };
    expect(modal?.open).to.be.false;
  });

  it('should stay open with error message on non-conflict errors', async () => {
    executeRebaseBehavior = 'error';

    let conflictEvent = false;
    el.addEventListener('open-conflict-dialog', () => {
      conflictEvent = true;
    });

    const executeButton = el.shadowRoot?.querySelector('.btn-primary') as HTMLButtonElement;
    executeButton?.click();
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 100));
    await el.updateComplete;

    expect(conflictEvent).to.be.false;
    const errorEl = el.shadowRoot?.querySelector('.error-message');
    expect(errorEl).to.not.be.null;
    expect(errorEl!.textContent).to.include('Something went wrong');
  });
});
