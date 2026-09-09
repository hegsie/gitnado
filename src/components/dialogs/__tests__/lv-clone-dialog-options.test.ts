/**
 * The clone dialog's branch and submodule options.
 *
 * The backend's clone command accepts and validates a `branch`, but the dialog
 * never sent one, so cloning anything other than the remote's default branch
 * was impossible from the UI. There is also no recursive clone on the backend,
 * so a superproject cloned here left every submodule directory empty and the
 * user had to find the palette-only Submodules dialog afterwards.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invoked: { command: string; args?: Record<string, unknown> }[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push({ command, args: args as Record<string, unknown> });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => {
    void once;
    void callback;
    return 0;
  },
  unregisterListener: (_event: string, _eventId: number) => {},
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-clone-dialog.ts';
import type { LvCloneDialog } from '../lv-clone-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';
import { repositoryStore } from '../../../stores/index.ts';

interface CloneInternals {
  url: string;
  destination: string;
  repoName: string;
  branch: string;
  cloneSubmodules: boolean;
  submodulePhase: boolean;
  isCloning: boolean;
  isComplete: boolean;
  error: string;
  progressText: string;
  handleClone: () => Promise<void>;
  handleModalClose: () => void;
}

function internals(el: LvCloneDialog): CloneInternals {
  return el as unknown as CloneInternals;
}

/** The args Tauri nests under the command's parameter name. */
function argsOf(command: string): Record<string, unknown> | undefined {
  const call = invoked.find((c) => c.command === command);
  if (!call) return undefined;
  const nested = call.args?.args as Record<string, unknown> | undefined;
  return nested ?? call.args;
}

const clonedRepo = {
  path: '/dest/repo',
  name: 'repo',
  isValid: true,
  isBare: false,
  headRef: 'main',
};

const submodule = {
  name: 'libs/vendor',
  path: 'libs/vendor',
  url: 'https://example.com/vendor.git',
  headOid: null,
  branch: null,
  initialized: false,
  status: 'uninitialized',
};

function toastMessages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

describe('lv-clone-dialog branch and submodule options', () => {
  let el: LvCloneDialog;

  beforeEach(async () => {
    invoked.length = 0;
    mockInvoke = () => Promise.resolve(null);
    settingsStore.getState().setDefaultClonePath('');
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false });
    uiStore.setState({ toasts: [] });
    repositoryStore.setState({ openRepositories: [], activeIndex: -1 });

    el = await fixture<LvCloneDialog>(html`<lv-clone-dialog></lv-clone-dialog>`);
  });

  // ── Fields ───────────────────────────────────────────────────────────────
  describe('fields', () => {
    it('renders an optional Branch field', () => {
      const input = el.shadowRoot!.querySelector('#branch') as HTMLInputElement;
      expect(input, 'the branch field must exist').to.exist;
      expect(input.type).to.equal('text');
      expect(input.placeholder.toLowerCase()).to.contain('default');
    });

    it('renders a Clone submodules checkbox', () => {
      const box = el.shadowRoot!.querySelector('#clone-submodules') as HTMLInputElement;
      expect(box, 'the submodule checkbox must exist').to.exist;
      expect(box.type).to.equal('checkbox');
      expect(box.checked, 'submodules are opt-in').to.be.false;
    });

    it('disables both new controls while a clone is in flight', async () => {
      internals(el).isCloning = true;
      await el.updateComplete;

      const branch = el.shadowRoot!.querySelector('#branch') as HTMLInputElement;
      const box = el.shadowRoot!.querySelector('#clone-submodules') as HTMLInputElement;
      expect(branch.disabled).to.be.true;
      expect(box.disabled).to.be.true;
    });

    it('tracks typing in the branch field', async () => {
      const input = el.shadowRoot!.querySelector('#branch') as HTMLInputElement;
      input.value = 'release/2.0';
      input.dispatchEvent(new Event('input'));
      await el.updateComplete;

      expect(internals(el).branch).to.equal('release/2.0');
    });

    it('clears both new fields on reset', async () => {
      const state = internals(el);
      state.branch = 'develop';
      state.cloneSubmodules = true;

      (el as unknown as { reset: () => void }).reset();

      expect(state.branch).to.equal('');
      expect(state.cloneSubmodules).to.be.false;
    });
  });

  // ── Branch passed through ────────────────────────────────────────────────
  describe('branch', () => {
    beforeEach(() => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        return Promise.resolve(null);
      };
    });

    it('sends the requested branch to clone_repository', async () => {
      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.branch = '  develop  ';

      await state.handleClone();

      expect(argsOf('clone_repository')?.branch, 'the branch is trimmed and sent').to.equal(
        'develop',
      );
    });

    it('omits branch entirely when the field is left empty', async () => {
      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.branch = '   ';

      await state.handleClone();

      const args = argsOf('clone_repository');
      expect(args, 'the clone still runs').to.exist;
      expect(args!.branch, 'an empty branch means the remote default').to.be.undefined;
    });

    it('rejects a branch the backend would refuse, without a round trip', async () => {
      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.branch = '--upload-pack=evil';

      await state.handleClone();
      await el.updateComplete;

      const error = el.shadowRoot!.querySelector('.error-message');
      expect(error, 'the refusal is shown inline').to.exist;
      expect(error!.textContent).to.contain('Branch name');
      expect(
        invoked.some((c) => c.command === 'clone_repository'),
        'a branch the backend rejects is never sent',
      ).to.be.false;
      expect(state.isCloning, 'the dialog stays usable').to.be.false;
    });

    it('surfaces the backend error when the branch does not exist', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') {
          return Promise.reject({
            code: 'COMMAND_ERROR',
            message: "Remote branch nope not found in upstream origin",
          });
        }
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.branch = 'nope';

      await state.handleClone();
      await el.updateComplete;

      const error = el.shadowRoot!.querySelector('.error-message');
      expect(error, 'a missing branch must be reported').to.exist;
      expect(error!.textContent).to.contain('Remote branch nope not found');
    });
  });

  // ── Submodule phase ──────────────────────────────────────────────────────
  describe('submodules', () => {
    it('does not touch the submodule commands when the box is unchecked', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = false;

      await state.handleClone();

      expect(invoked.some((c) => c.command === 'get_submodules')).to.be.false;
      expect(invoked.some((c) => c.command === 'update_submodules')).to.be.false;
    });

    it('initialises and updates submodules against the new repository', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.repoName = 'repo';
      state.cloneSubmodules = true;

      await state.handleClone();

      const update = argsOf('update_submodules');
      expect(update, 'the submodule phase must run after a successful clone').to.exist;
      expect(update!.path, 'it runs against the cloned repository').to.equal('/dest/repo');
      expect(update!.init, 'uninitialised submodules must be initialised').to.be.true;
      expect(update!.recursive, 'nested submodules are cloned too').to.be.true;
    });

    it('skips the update — and its network gate — when there are no submodules', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([]);
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = true;

      await state.handleClone();

      expect(invoked.some((c) => c.command === 'get_submodules')).to.be.true;
      expect(
        invoked.some((c) => c.command === 'update_submodules'),
        'nothing to update means nothing to ask the user about',
      ).to.be.false;
    });

    it('shows the submodule step in the dialog progress', async () => {
      let releaseUpdate: ((value: unknown) => void) | null = null;
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        if (command === 'update_submodules') {
          return new Promise((resolve) => {
            releaseUpdate = resolve;
          });
        }
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = true;

      const pending = state.handleClone();
      await waitUntil(() => state.submodulePhase, 'the submodule phase to start');
      await el.updateComplete;

      expect(state.submodulePhase, 'the phase is active').to.be.true;
      const progress = el.shadowRoot!.querySelector('.progress-text');
      expect(progress, 'progress stays visible during the submodule phase').to.exist;
      expect(progress!.textContent).to.contain('submodule');

      (releaseUpdate as ((value: unknown) => void) | null)?.(null);
      await pending;
    });

    it('reports a submodule failure as a partial success, not a failed clone', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        if (command === 'update_submodules') {
          return Promise.reject({ code: 'COMMAND_ERROR', message: 'authentication required' });
        }
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = true;

      await state.handleClone();
      await el.updateComplete;

      // A toast, not an inline banner: opening the cloned repository can tear
      // this dialog down with the welcome screen that hosts it.
      const toasts = uiStore.getState().toasts;
      const warning = toasts.find((t) => t.type === 'warning');
      expect(warning, 'the partial failure must be reported').to.exist;
      expect(warning!.message).to.contain('cloned');
      expect(warning!.message).to.contain('authentication required');

      expect(
        el.shadowRoot!.querySelector('.error-message'),
        'the clone itself did NOT fail',
      ).to.not.exist;
      expect(state.error, 'and nothing claims the clone failed').to.equal('');

      const repos = repositoryStore.getState().openRepositories;
      expect(
        repos.some((r) => r.repository.path === '/dest/repo'),
        'the cloned repository stays open',
      ).to.be.true;
    });

    it('closes the dialog after a submodule failure rather than trapping it', async () => {
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        if (command === 'update_submodules') {
          return Promise.reject({ code: 'COMMAND_ERROR', message: 'boom' });
        }
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = true;

      el.open();
      await el.updateComplete;
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.cloneSubmodules = true;

      await state.handleClone();
      // The close is scheduled on the same 500ms timer a clean clone uses.
      await waitUntil(() => {
        const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & { open: boolean };
        return !modal.open;
      }, 'the dialog to close after the failed submodule phase');

      expect(state.isCloning, 'and the dialog is reusable').to.be.false;
    });

    it('a gate refusal on the submodule update is not shown as a failure', async () => {
      settingsStore.setState({ offlineMode: true });
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        return Promise.resolve(null);
      };

      try {
        const state = internals(el);
        state.url = 'https://example.com/user/repo.git';
        state.destination = '/dest';
        state.cloneSubmodules = true;

        await state.handleClone();
        await el.updateComplete;

        expect(
          uiStore.getState().toasts.some((t) => t.message.includes('submodules were not')),
          'the gate already explained itself',
        ).to.be.false;
        expect(state.error, 'and the clone did not fail').to.equal('');
      } finally {
        settingsStore.setState({ offlineMode: false });
      }
    });

    it('closing during the submodule phase keeps the repository and reports later', async () => {
      let releaseUpdate: ((value: unknown) => void) | null = null;
      mockInvoke = (command) => {
        if (command === 'clone_repository') return Promise.resolve(clonedRepo);
        if (command === 'get_submodules') return Promise.resolve([submodule]);
        if (command === 'update_submodules') {
          return new Promise((resolve) => {
            releaseUpdate = resolve;
          });
        }
        return Promise.resolve(null);
      };

      const state = internals(el);
      state.url = 'https://example.com/user/repo.git';
      state.destination = '/dest';
      state.repoName = 'repo';
      state.cloneSubmodules = true;

      const pending = state.handleClone();
      await waitUntil(() => state.submodulePhase, 'the submodule phase to start');
      await el.updateComplete;

      // Escape / the x / the footer button while submodules are still running.
      state.handleModalClose();
      await el.updateComplete;

      const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & { open: boolean };
      expect(modal.open, 'the dialog closes rather than blocking on submodules').to.be.false;
      expect(
        invoked.some((c) => c.command === 'cancel_clone'),
        'the clone already succeeded, so nothing may cancel it',
      ).to.be.false;
      expect(
        repositoryStore
          .getState()
          .openRepositories.some((r) => r.repository.path === '/dest/repo'),
        'the cloned repository is kept',
      ).to.be.true;

      (releaseUpdate as ((value: unknown) => void) | null)?.(null);
      await pending;
      await waitUntil(
        () => toastMessages().some((m) => m.includes('submodule')),
        'the background phase to report',
      );

      expect(
        toastMessages().some((m) => m.includes('submodule')),
        'the detached phase reports its outcome in a toast',
      ).to.be.true;
    });
  });
});
