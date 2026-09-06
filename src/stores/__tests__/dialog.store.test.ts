import { expect } from '@open-wc/testing';
import {
  dialogStore,
  dialogs,
  DIALOG_REGISTRY,
  type DialogId,
} from '../dialog.store.ts';

describe('dialog.store', () => {
  beforeEach(() => {
    dialogs.reset();
  });

  describe('open / close / isOpen', () => {
    it('starts with nothing open', () => {
      for (const id of Object.keys(DIALOG_REGISTRY) as DialogId[]) {
        expect(dialogs.isOpen(id), `${id} starts closed`).to.equal(false);
      }
    });

    it('opens and closes a dialog', () => {
      dialogs.open('clean');
      expect(dialogs.isOpen('clean')).to.equal(true);
      dialogs.close('clean');
      expect(dialogs.isOpen('clean')).to.equal(false);
    });

    it('keeps dialogs independent of one another', () => {
      dialogs.open('clean');
      dialogs.open('settings');
      dialogs.close('clean');
      expect(dialogs.isOpen('clean')).to.equal(false);
      expect(dialogs.isOpen('settings'), 'closing one must not close another').to.equal(true);
    });

    it('setOpen routes to open/close', () => {
      dialogs.setOpen('gitHub', true);
      expect(dialogs.isOpen('gitHub')).to.equal(true);
      dialogs.setOpen('gitHub', false);
      expect(dialogs.isOpen('gitHub')).to.equal(false);
    });

    it('opening twice does not double-register', () => {
      dialogs.open('bisect');
      dialogs.open('bisect');
      dialogs.close('bisect');
      expect(dialogs.isOpen('bisect'), 'one close is enough').to.equal(false);
    });

    it('closing a dialog that is already shut is a no-op that notifies nobody', () => {
      let notifications = 0;
      const unsubscribe = dialogStore.subscribe(() => {
        notifications++;
      });
      dialogs.close('lfs');
      unsubscribe();
      expect(dialogs.isOpen('lfs')).to.equal(false);
      expect(notifications, 'no spurious re-render for a no-op close').to.equal(0);
    });
  });

  describe('subscription', () => {
    it('notifies subscribers on open and on close', () => {
      const seen: boolean[] = [];
      const unsubscribe = dialogStore.subscribe((state) => {
        seen.push(state.isOpen('remotes'));
      });
      dialogs.open('remotes');
      dialogs.close('remotes');
      unsubscribe();
      expect(seen).to.deep.equal([true, false]);
    });
  });

  describe('context payloads', () => {
    it('stores and returns a dialog context', () => {
      dialogs.open('fileHistory', { filePath: 'src/main.ts' });
      expect(dialogs.context('fileHistory')?.filePath).to.equal('src/main.ts');
    });

    it('drops the context when the dialog closes', () => {
      dialogs.open('search', { mode: 'commits' });
      dialogs.close('search');
      expect(dialogs.context('search'), 'a stale payload must not outlive its dialog').to.equal(
        null,
      );
    });

    it('keeps an existing context when reopened without one', () => {
      // handleManageAccounts sets the view, then opens the manager bare.
      dialogs.setContext('profileManager', { initialView: 'accounts' });
      dialogs.open('profileManager');
      expect(dialogs.context('profileManager')?.initialView).to.equal('accounts');
    });

    it('replaces the context when reopened with one', () => {
      dialogs.open('search', { mode: 'files' });
      dialogs.open('search', { mode: 'diff' });
      expect(dialogs.context('search')?.mode).to.equal('diff');
    });

    it('returns null for a dialog that carries no context', () => {
      dialogs.open('clean');
      expect(dialogs.context('clean')).to.equal(null);
    });

    it('setContext updates the payload of an open dialog', () => {
      dialogs.open('search', { mode: 'files' });
      dialogs.setContext('search', { mode: 'commits' });
      expect(dialogs.isOpen('search'), 'the dialog stays open').to.equal(true);
      expect(dialogs.context('search')?.mode).to.equal('commits');
    });
  });

  describe('closeRepoScoped', () => {
    it('closes every dialog declared repo-scoped and no others', () => {
      for (const id of Object.keys(DIALOG_REGISTRY) as DialogId[]) dialogs.open(id);

      dialogs.closeRepoScoped();

      for (const id of Object.keys(DIALOG_REGISTRY) as DialogId[]) {
        expect(dialogs.isOpen(id), `${id} after the sweep`).to.equal(
          !DIALOG_REGISTRY[id].repoScoped,
        );
      }
    });

    it('drops the contexts of the dialogs it closes', () => {
      dialogs.open('fileHistory', { filePath: 'src/main.ts' });
      dialogs.open('search', { mode: 'diff' });
      dialogs.closeRepoScoped();
      expect(dialogs.context('fileHistory')).to.equal(null);
      expect(dialogs.context('search')).to.equal(null);
    });

    it('leaves a repo-independent dialog and its context alone', () => {
      dialogs.open('profileManager', { initialView: 'accounts' });
      dialogs.closeRepoScoped();
      expect(dialogs.isOpen('profileManager')).to.equal(true);
      expect(dialogs.context('profileManager')?.initialView).to.equal('accounts');
    });

    it('notifies nobody when nothing repo-scoped is open', () => {
      dialogs.open('settings');
      let notifications = 0;
      const unsubscribe = dialogStore.subscribe(() => {
        notifications++;
      });
      dialogs.closeRepoScoped();
      unsubscribe();
      expect(notifications).to.equal(0);
    });
  });

  describe('the registry', () => {
    // The sweep's whole point: repo-scoping is DECLARED, not inferred from a
    // field name. A dialog rendered inside app-shell's activeRepository block
    // must be repo-scoped or it springs back open over the next repository.
    //
    // This list is the PRODUCT statement — which dialogs a user can reach with
    // nothing open — and can only ever be typed by hand. Whether a declaration
    // agrees with where app-shell actually renders the dialog is not something
    // this file can know; that is DERIVED from app-shell's own render in
    // app-shell-multi-repo.test.ts ("declares every dialog rendered inside the
    // repository block as repo-scoped"), which is where a wrong `false` here
    // fails. The output panel was listed here as repo-independent while
    // rendering inside the repository block, and this test pinned the bug.
    it('declares the dialogs reachable with no repository open as repo-independent', () => {
      const repoIndependent: DialogId[] = [
        'settings',
        'shortcuts',
        'commandPalette',
        'workspaceManager',
        'ssh',
        'profileManager',
        'migration',
        'repositoryScan',
        'gitHub',
        'gitLab',
        'bitbucket',
        'azureDevOps',
        'oidc',
      ];
      for (const id of repoIndependent) {
        expect(DIALOG_REGISTRY[id].repoScoped, `${id} is usable with no repository`).to.equal(
          false,
        );
      }
      // Everything else must default to the safe side.
      for (const id of Object.keys(DIALOG_REGISTRY) as DialogId[]) {
        if (repoIndependent.includes(id)) continue;
        expect(DIALOG_REGISTRY[id].repoScoped, `${id} must be swept with its repository`).to.equal(
          true,
        );
      }
    });
  });

  describe('reset', () => {
    it('clears every open dialog and context', () => {
      dialogs.open('settings');
      dialogs.open('conflict', {
        repoPath: '/repo/a',
        operationType: 'merge',
        initialFilePath: null,
        stashSourceCertain: true,
        stashIndex: 0,
        stashOid: null,
        dropStashOnComplete: true,
        squashMerge: false,
        gitflowFinish: null,
      });

      dialogs.reset();

      expect(dialogs.isOpen('settings')).to.equal(false);
      expect(dialogs.isOpen('conflict')).to.equal(false);
      expect(dialogs.context('conflict')).to.equal(null);
    });
  });
});
