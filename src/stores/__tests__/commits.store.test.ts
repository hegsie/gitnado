import { expect } from '@open-wc/testing';
import { commitsStore } from '../commits.store.ts';
import type { Commit } from '../../types/git.types.ts';

describe('commits.store', () => {
  // Create mock commit
  function createMockCommit(oid: string, message = 'Test commit'): Commit {
    const timestamp = Date.now() / 1000;
    return {
      oid,
      shortId: oid.substring(0, 7),
      message,
      summary: message.split('\n')[0],
      body: null,
      author: {
        name: 'Test User',
        email: 'test@example.com',
        timestamp,
      },
      committer: {
        name: 'Test User',
        email: 'test@example.com',
        timestamp,
      },
      parentIds: [],
      timestamp,
    };
  }

  beforeEach(() => {
    // Reset store before each test
    commitsStore.getState().reset();
  });

  describe('initial state', () => {
    it('starts with empty commits', () => {
      const state = commitsStore.getState();
      expect(state.commits.length).to.equal(0);
      expect(state.commitMap.size).to.equal(0);
    });

    it('starts with no loading state', () => {
      expect(commitsStore.getState().isLoading).to.be.false;
    });

    it('starts with hasMore true', () => {
      expect(commitsStore.getState().hasMore).to.be.true;
    });

    it('starts with no selection', () => {
      const selection = commitsStore.getState().selection;
      expect(selection.selectedOid).to.be.null;
      expect(selection.hoveredOid).to.be.null;
      expect(selection.rangeStart).to.be.null;
      expect(selection.rangeEnd).to.be.null;
    });
  });

  describe('setCommits', () => {
    it('sets commits and builds map', () => {
      const commits = [
        createMockCommit('abc123'),
        createMockCommit('def456'),
      ];
      commitsStore.getState().setCommits(commits);

      const state = commitsStore.getState();
      expect(state.commits.length).to.equal(2);
      expect(state.commitMap.size).to.equal(2);
    });

    it('resets hasMore to true', () => {
      commitsStore.getState().setHasMore(false);
      commitsStore.getState().setCommits([createMockCommit('abc123')]);

      expect(commitsStore.getState().hasMore).to.be.true;
    });
  });

  describe('appendCommits', () => {
    it('appends commits to existing', () => {
      commitsStore.getState().setCommits([createMockCommit('abc123')]);
      commitsStore.getState().appendCommits([createMockCommit('def456')]);

      const state = commitsStore.getState();
      expect(state.commits.length).to.equal(2);
      expect(state.commitMap.size).to.equal(2);
    });

    it('updates commit map correctly', () => {
      commitsStore.getState().setCommits([createMockCommit('abc123')]);
      commitsStore.getState().appendCommits([createMockCommit('def456')]);

      expect(commitsStore.getState().getCommit('abc123')).to.exist;
      expect(commitsStore.getState().getCommit('def456')).to.exist;
    });
  });

  describe('setLoading', () => {
    it('sets loading state', () => {
      commitsStore.getState().setLoading(true);
      expect(commitsStore.getState().isLoading).to.be.true;

      commitsStore.getState().setLoading(false);
      expect(commitsStore.getState().isLoading).to.be.false;
    });
  });

  describe('setHasMore', () => {
    it('sets hasMore state', () => {
      commitsStore.getState().setHasMore(false);
      expect(commitsStore.getState().hasMore).to.be.false;

      commitsStore.getState().setHasMore(true);
      expect(commitsStore.getState().hasMore).to.be.true;
    });
  });

  describe('setGraphLayout', () => {
    it('sets graph layout', () => {
      const layout = {
        nodes: new Map(),
        edges: [],
        maxLane: 3,
        totalRows: 10,
      };
      commitsStore.getState().setGraphLayout(layout);

      expect(commitsStore.getState().graphLayout).to.not.be.null;
      expect(commitsStore.getState().graphLayout?.maxLane).to.equal(3);
    });

    it('can set layout to null', () => {
      commitsStore.getState().setGraphLayout({
        nodes: new Map(),
        edges: [],
        maxLane: 0,
        totalRows: 0,
      });
      commitsStore.getState().setGraphLayout(null);

      expect(commitsStore.getState().graphLayout).to.be.null;
    });
  });

  describe('selectCommit', () => {
    it('selects a commit', () => {
      commitsStore.getState().selectCommit('abc123');
      expect(commitsStore.getState().selection.selectedOid).to.equal('abc123');
    });

    it('can clear selection', () => {
      commitsStore.getState().selectCommit('abc123');
      commitsStore.getState().selectCommit(null);
      expect(commitsStore.getState().selection.selectedOid).to.be.null;
    });

    it('preserves other selection state', () => {
      commitsStore.getState().hoverCommit('def456');
      commitsStore.getState().selectCommit('abc123');

      const selection = commitsStore.getState().selection;
      expect(selection.selectedOid).to.equal('abc123');
      expect(selection.hoveredOid).to.equal('def456');
    });
  });

  describe('hoverCommit', () => {
    it('sets hovered commit', () => {
      commitsStore.getState().hoverCommit('abc123');
      expect(commitsStore.getState().selection.hoveredOid).to.equal('abc123');
    });

    it('can clear hover', () => {
      commitsStore.getState().hoverCommit('abc123');
      commitsStore.getState().hoverCommit(null);
      expect(commitsStore.getState().selection.hoveredOid).to.be.null;
    });
  });

  describe('setRangeSelection', () => {
    it('sets range selection', () => {
      commitsStore.getState().setRangeSelection('abc123', 'def456');

      const selection = commitsStore.getState().selection;
      expect(selection.rangeStart).to.equal('abc123');
      expect(selection.rangeEnd).to.equal('def456');
    });

    it('can clear range', () => {
      commitsStore.getState().setRangeSelection('abc123', 'def456');
      commitsStore.getState().setRangeSelection(null, null);

      const selection = commitsStore.getState().selection;
      expect(selection.rangeStart).to.be.null;
      expect(selection.rangeEnd).to.be.null;
    });
  });

  describe('getCommit', () => {
    it('returns commit by oid', () => {
      const commit = createMockCommit('abc123', 'Test message');
      commitsStore.getState().setCommits([commit]);

      const found = commitsStore.getState().getCommit('abc123');
      expect(found).to.exist;
      expect(found?.message).to.equal('Test message');
    });

    it('returns undefined for unknown oid', () => {
      commitsStore.getState().setCommits([createMockCommit('abc123')]);

      const found = commitsStore.getState().getCommit('unknown');
      expect(found).to.be.undefined;
    });
  });

  describe('reset', () => {
    it('resets store to initial state', () => {
      commitsStore.getState().setCommits([createMockCommit('abc123')]);
      commitsStore.getState().setLoading(true);
      commitsStore.getState().setHasMore(false);
      commitsStore.getState().selectCommit('abc123');

      commitsStore.getState().reset();

      const state = commitsStore.getState();
      expect(state.commits.length).to.equal(0);
      expect(state.isLoading).to.be.false;
      expect(state.hasMore).to.be.true;
      expect(state.selection.selectedOid).to.be.null;
    });
  });

  describe('multi-tab repository caching and generation tracking', () => {
    it('caches and restores commits and selection per repository tab', () => {
      const store = commitsStore.getState();
      store.setActiveRepo('/repo/alpha');
      store.setCommits([createMockCommit('a111111', 'Alpha commit')]);
      store.selectCommit('a111111');

      store.setActiveRepo('/repo/beta');
      expect(commitsStore.getState().commits.length).to.equal(0);
      expect(commitsStore.getState().selection.selectedOid).to.be.null;

      store.setCommits([createMockCommit('b222222', 'Beta commit')]);
      store.selectCommit('b222222');

      // Switch back to alpha and verify immediate restoration from per-repo cache
      store.setActiveRepo('/repo/alpha');
      const alphaState = commitsStore.getState();
      expect(alphaState.commits.length).to.equal(1);
      expect(alphaState.commits[0].oid).to.equal('a111111');
      expect(alphaState.selection.selectedOid).to.equal('a111111');
      expect(alphaState.getCommit('b222222', '/repo/beta')?.oid).to.equal('b222222');
    });

    it('tracks request generations and invalidates stale generations', () => {
      const store = commitsStore.getState();
      store.setActiveRepo('/repo/alpha');
      const gen1 = store.nextGeneration('/repo/alpha');
      expect(store.isGenerationValid(gen1, '/repo/alpha')).to.be.true;

      const gen2 = store.nextGeneration('/repo/alpha');
      expect(store.isGenerationValid(gen1, '/repo/alpha')).to.be.false;
      expect(store.isGenerationValid(gen2, '/repo/alpha')).to.be.true;
    });

    it('evicts closed repository state cleanly', () => {
      const store = commitsStore.getState();
      store.setActiveRepo('/repo/alpha');
      store.setCommits([createMockCommit('a111111')]);
      store.evictRepo('/repo/alpha');

      const state = commitsStore.getState();
      expect(state.activeRepoPath).to.be.null;
      expect(state.commits.length).to.equal(0);
      expect(state.commitsByRepo['/repo/alpha']).to.be.undefined;
    });
  });
});
