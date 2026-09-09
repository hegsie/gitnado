import { expect } from '@open-wc/testing';
import { repositoryStore } from '../repository.store.ts';
import type { Repository } from '../../types/git.types.ts';

describe('repository.store', () => {
  // Create mock repository
  function createMockRepo(path: string, name = 'test-repo'): Repository {
    return {
      path,
      name,
      isValid: true,
      isBare: false,
      headRef: 'main',
      detachedHeadOid: null,
      state: 'clean',
      isShallow: false,
      isPartialClone: false,
      cloneFilter: null,
    };
  }

  beforeEach(() => {
    // Reset store before each test
    repositoryStore.getState().reset();
  });

  describe('initial state', () => {
    it('starts with no open repositories', () => {
      const state = repositoryStore.getState();
      expect(state.openRepositories.length).to.equal(0);
      expect(state.activeIndex).to.equal(-1);
    });

    it('starts with no loading state', () => {
      const state = repositoryStore.getState();
      expect(state.isLoading).to.be.false;
      expect(state.error).to.be.null;
    });
  });

  describe('addRepository', () => {
    it('adds a repository to open repositories', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      const state = repositoryStore.getState();
      expect(state.openRepositories.length).to.equal(1);
      expect(state.openRepositories[0].repository.path).to.equal('/test/path');
    });

    it('sets active index to new repository', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('does not duplicate existing repository', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
      repositoryStore.getState().addRepository(repo);

      expect(repositoryStore.getState().openRepositories.length).to.equal(1);
    });

    it('adds repository to recent list', () => {
      const repo = createMockRepo('/test/path', 'my-repo');
      repositoryStore.getState().addRepository(repo);

      const state = repositoryStore.getState();
      expect(state.recentRepositories.length).to.be.greaterThan(0);
      expect(state.recentRepositories[0].path).to.equal('/test/path');
    });
  });

  describe('addRepository with activate: false', () => {
    it('adds the repo without changing the active tab', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/active'));
      repositoryStore.getState().addRepository(createMockRepo('/repo/bg'), { activate: false });

      const state = repositoryStore.getState();
      expect(state.openRepositories.length).to.equal(2);
      expect(state.activeIndex).to.equal(0);
    });

    it('does not steal focus for an already-open repo either', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      repositoryStore.getState().addRepository(createMockRepo('/repo/two'));

      repositoryStore.getState().addRepository(createMockRepo('/repo/one'), { activate: false });

      expect(repositoryStore.getState().activeIndex).to.equal(1);
    });

    it('keeps activeIndex -1 when batch-adding into an empty store', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'), { activate: false });
      expect(repositoryStore.getState().activeIndex).to.equal(-1);

      repositoryStore.getState().setActiveByPath('/repo/one');
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });
  });

  describe('updateRepoData', () => {
    const branch = {
      name: 'feature/x',
      shorthand: 'feature/x',
      isHead: false,
      isRemote: false,
      upstream: null,
      targetOid: 'abc123',
      isStale: false,
    };

    it('updates a BACKGROUND repo without touching activeIndex', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      repositoryStore.getState().addRepository(createMockRepo('/repo/two'));
      // repo two is active; update repo one by path
      expect(repositoryStore.getState().activeIndex).to.equal(1);

      repositoryStore.getState().updateRepoData('/repo/one', { branches: [branch] });

      const state = repositoryStore.getState();
      expect(state.activeIndex).to.equal(1);
      expect(state.openRepositories[0].branches).to.deep.equal([branch]);
      expect(state.openRepositories[1].branches).to.deep.equal([]);
    });

    /**
     * "Not read yet" and "read, and there are none" are the same empty list,
     * and the rule that greys out Fetch/Pull/Push and refuses the shortcuts
     * reads it — so the store records which of the two it is holding.
     */
    describe('remotesLoaded', () => {
      it('is false for a freshly opened tab, whose empty list is only a seed', () => {
        repositoryStore.getState().addRepository(createMockRepo('/repo/one'));

        const repo = repositoryStore.getState().openRepositories[0];
        expect(repo.remotes).to.deep.equal([]);
        expect(repo.remotesLoaded, 'nothing has asked git yet').to.equal(false);
      });

      it('is set by any write that carries remotes, including an empty answer', () => {
        repositoryStore.getState().addRepository(createMockRepo('/repo/one'));

        repositoryStore.getState().updateRepoData('/repo/one', { remotes: [] });

        expect(
          repositoryStore.getState().openRepositories[0].remotesLoaded,
          'git answered: there are none',
        ).to.equal(true);
      });

      it('is set through the active-repo setter too', () => {
        repositoryStore.getState().addRepository(createMockRepo('/repo/one'));

        repositoryStore
          .getState()
          .setRemotes([{ name: 'origin', url: 'https://example.test/o/r.git', pushUrl: null }]);

        expect(repositoryStore.getState().openRepositories[0].remotesLoaded).to.equal(true);
      });

      it('is left alone by a write that says nothing about remotes', () => {
        repositoryStore.getState().addRepository(createMockRepo('/repo/one'));

        repositoryStore.getState().updateRepoData('/repo/one', { branches: [branch] });

        expect(repositoryStore.getState().openRepositories[0].remotesLoaded).to.equal(false);
      });
    });

    it('is a no-op for a path that is not open', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      const before = repositoryStore.getState().openRepositories;

      repositoryStore.getState().updateRepoData('/not/open', { branches: [branch] });

      expect(repositoryStore.getState().openRepositories).to.deep.equal(before);
    });

    it('active-repo setters delegate to the active repo only', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      repositoryStore.getState().addRepository(createMockRepo('/repo/two'));

      repositoryStore.getState().setBranches([branch]);

      const state = repositoryStore.getState();
      expect(state.openRepositories[1].branches).to.deep.equal([branch]);
      expect(state.openRepositories[0].branches).to.deep.equal([]);
    });

    it('setStatus computes staged/unstaged for the active repo', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      const staged = { path: 'a.txt', status: 'modified', isStaged: true } as never;
      const unstaged = { path: 'b.txt', status: 'modified', isStaged: false } as never;

      repositoryStore.getState().setStatus([staged, unstaged]);

      const repo = repositoryStore.getState().openRepositories[0];
      expect(repo.stagedFiles).to.deep.equal([staged]);
      expect(repo.unstagedFiles).to.deep.equal([unstaged]);
    });
  });

  describe('prunePersistedRepo', () => {
    it('removes a repo from the persisted list without touching open repos', () => {
      repositoryStore.getState().addRepository(createMockRepo('/repo/one'));
      repositoryStore.getState().addRepository(createMockRepo('/repo/two'));

      repositoryStore.getState().prunePersistedRepo('/repo/one');

      const state = repositoryStore.getState();
      expect(state.persistedOpenRepos.map((r) => r.path)).to.deep.equal(['/repo/two']);
      expect(state.openRepositories.length).to.equal(2);
    });
  });

  describe('removeRepository', () => {
    it('removes a repository from open repositories', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
      repositoryStore.getState().removeRepository('/test/path');

      expect(repositoryStore.getState().openRepositories.length).to.equal(0);
    });

    it('updates active index when removing active repository', () => {
      const repo1 = createMockRepo('/test/path1');
      const repo2 = createMockRepo('/test/path2');
      repositoryStore.getState().addRepository(repo1);
      repositoryStore.getState().addRepository(repo2);

      expect(repositoryStore.getState().activeIndex).to.equal(1);

      repositoryStore.getState().removeRepository('/test/path2');
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('sets active index to -1 when removing last repository', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
      repositoryStore.getState().removeRepository('/test/path');

      expect(repositoryStore.getState().activeIndex).to.equal(-1);
    });
  });

  describe('setActiveIndex', () => {
    it('changes active repository', () => {
      const repo1 = createMockRepo('/test/path1');
      const repo2 = createMockRepo('/test/path2');
      repositoryStore.getState().addRepository(repo1);
      repositoryStore.getState().addRepository(repo2);

      repositoryStore.getState().setActiveIndex(0);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('ignores invalid index', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      repositoryStore.getState().setActiveIndex(99);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('ignores negative index', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      repositoryStore.getState().setActiveIndex(-1);
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });
  });

  describe('setActiveByPath', () => {
    it('sets active repository by path', () => {
      const repo1 = createMockRepo('/test/path1');
      const repo2 = createMockRepo('/test/path2');
      repositoryStore.getState().addRepository(repo1);
      repositoryStore.getState().addRepository(repo2);

      repositoryStore.getState().setActiveByPath('/test/path1');
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });

    it('does nothing for non-existent path', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      repositoryStore.getState().setActiveByPath('/non/existent');
      expect(repositoryStore.getState().activeIndex).to.equal(0);
    });
  });

  describe('setLoading and setError', () => {
    it('sets loading state', () => {
      repositoryStore.getState().setLoading(true);
      expect(repositoryStore.getState().isLoading).to.be.true;

      repositoryStore.getState().setLoading(false);
      expect(repositoryStore.getState().isLoading).to.be.false;
    });

    it('sets error and clears loading', () => {
      repositoryStore.getState().setLoading(true);
      repositoryStore.getState().setError('Test error');

      const state = repositoryStore.getState();
      expect(state.error).to.equal('Test error');
      expect(state.isLoading).to.be.false;
    });
  });

  describe('setBranches, setTags, setStashes, setRemotes', () => {
    beforeEach(() => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
    });

    it('sets branches on active repository', () => {
      repositoryStore.getState().setBranches([{ name: 'main', shorthand: 'main', isHead: true, isRemote: false, targetOid: 'abc123', upstream: null, isStale: false }]);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active?.branches.length).to.equal(1);
      expect(active?.branches[0].name).to.equal('main');
    });

    it('sets tags on active repository', () => {
      repositoryStore.getState().setTags([{ name: 'v1.0.0', targetOid: 'abc123', isAnnotated: false, message: null, tagger: null }]);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active?.tags.length).to.equal(1);
      expect(active?.tags[0].name).to.equal('v1.0.0');
    });

    it('sets stashes on active repository', () => {
      repositoryStore.getState().setStashes([{ index: 0, message: 'WIP', oid: 'abc123' }]);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active?.stashes.length).to.equal(1);
    });

    it('sets remotes on active repository', () => {
      repositoryStore.getState().setRemotes([{ name: 'origin', url: 'https://github.com/test/repo.git', pushUrl: null }]);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active?.remotes.length).to.equal(1);
      expect(active?.remotes[0].name).to.equal('origin');
    });
  });

  describe('setStatus', () => {
    beforeEach(() => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
    });

    it('sets status and separates staged/unstaged', () => {
      repositoryStore.getState().setStatus([
        { path: 'staged.txt', status: 'modified', isStaged: true, isConflicted: false },
        { path: 'unstaged.txt', status: 'modified', isStaged: false, isConflicted: false },
      ]);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active?.status.length).to.equal(2);
      expect(active?.stagedFiles.length).to.equal(1);
      expect(active?.unstagedFiles.length).to.equal(1);
    });
  });

  describe('recent repositories', () => {
    it('adds to recent repositories', () => {
      repositoryStore.getState().addRecentRepository('/test/path', 'test-repo');

      const recent = repositoryStore.getState().recentRepositories;
      expect(recent.length).to.equal(1);
      expect(recent[0].path).to.equal('/test/path');
      expect(recent[0].name).to.equal('test-repo');
    });

    it('moves existing to front when re-added', () => {
      repositoryStore.getState().addRecentRepository('/test/path1', 'repo1');
      repositoryStore.getState().addRecentRepository('/test/path2', 'repo2');
      repositoryStore.getState().addRecentRepository('/test/path1', 'repo1');

      const recent = repositoryStore.getState().recentRepositories;
      expect(recent[0].path).to.equal('/test/path1');
    });

    it('removes from recent repositories', () => {
      repositoryStore.getState().addRecentRepository('/test/path', 'test-repo');
      repositoryStore.getState().removeRecentRepository('/test/path');

      expect(repositoryStore.getState().recentRepositories.length).to.equal(0);
    });

    it('clears all recent repositories', () => {
      repositoryStore.getState().addRecentRepository('/test/path1', 'repo1');
      repositoryStore.getState().addRecentRepository('/test/path2', 'repo2');
      repositoryStore.getState().clearRecentRepositories();

      expect(repositoryStore.getState().recentRepositories.length).to.equal(0);
    });

    it('limits recent to max 10', () => {
      for (let i = 0; i < 15; i++) {
        repositoryStore.getState().addRecentRepository(`/test/path${i}`, `repo${i}`);
      }

      expect(repositoryStore.getState().recentRepositories.length).to.equal(10);
    });
  });

  describe('getActiveRepository', () => {
    it('returns null when no repositories', () => {
      expect(repositoryStore.getState().getActiveRepository()).to.be.null;
    });

    it('returns active repository', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);

      const active = repositoryStore.getState().getActiveRepository();
      expect(active).to.not.be.null;
      expect(active?.repository.path).to.equal('/test/path');
    });
  });

  describe('reset', () => {
    it('resets store to initial state', () => {
      const repo = createMockRepo('/test/path');
      repositoryStore.getState().addRepository(repo);
      repositoryStore.getState().setLoading(true);
      repositoryStore.getState().setError('test error');

      repositoryStore.getState().reset();

      const state = repositoryStore.getState();
      expect(state.openRepositories.length).to.equal(0);
      expect(state.activeIndex).to.equal(-1);
      expect(state.isLoading).to.be.false;
      expect(state.error).to.be.null;
    });
  });
});
