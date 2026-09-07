import { expect } from '@open-wc/testing';

// Mock Tauri API before importing any modules that use it
const mockInvoke = (_command: string): Promise<unknown> => {
  return Promise.resolve(null);
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { getErrorSuggestion } from '../error-suggestion.service.ts';

describe('error-suggestion.service', () => {
  describe('getErrorSuggestion', () => {
    it('should return suggestion for non-fast-forward push error', () => {
      const result = getErrorSuggestion('Updates were rejected because the remote contains work that you do not have locally. non-fast-forward');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('Pull');
      expect(result!.action).to.not.be.undefined;
      expect(result!.action!.label).to.equal('Pull Now');
    });

    it('should return suggestion for rejected push with context', () => {
      const result = getErrorSuggestion('rejected', { operation: 'push' });
      expect(result).to.not.be.null;
      expect(result!.message).to.include('Pull');
      expect(result!.action!.label).to.equal('Pull Now');
    });

    it('should return suggestion for "not fully merged" branch error', () => {
      const result = getErrorSuggestion('The branch is not fully merged', { branchName: 'feature/test' });
      expect(result).to.not.be.null;
      expect(result!.message).to.include('not fully merged');
      expect(result!.action).to.not.be.undefined;
      expect(result!.action!.label).to.equal('Force Delete');
    });

    it('should return suggestion for authentication errors', () => {
      const result = getErrorSuggestion('authentication required');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('credentials');
      expect(result!.action!.label).to.equal('Open Settings');
    });

    it('should return suggestion for permission denied', () => {
      const result = getErrorSuggestion('Permission denied (publickey)');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('credentials');
    });

    it('should return suggestion for rebase in progress', () => {
      const result = getErrorSuggestion('rebase in progress');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('rebase');
      expect(result!.action!.label).to.equal('Abort Rebase');
    });

    it('should return suggestion for no upstream branch', () => {
      const result = getErrorSuggestion('There is no tracking information for the current branch');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('upstream');
      expect(result!.action).to.be.undefined;
    });

    it('should return suggestion for lock file errors', () => {
      const result = getErrorSuggestion('Unable to create lock file');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('locked');
      expect(result!.action).to.be.undefined;
    });

    // A repository that already has a remote operation in flight. The backend
    // refuses with GitnadoError::RemoteOperationInFlight; its message is
    // already user-facing and explains that a timed-out operation can still be
    // running, so the suggestion service must pass it through UNCHANGED rather
    // than let a later rule rewrite it.
    const inFlightMessage =
      'A push is already running for this repository. Wait for it to finish and try again — an operation that timed out can still be finishing in the background.';

    it('should keep the in-flight refusal verbatim instead of calling it a timeout', () => {
      const result = getErrorSuggestion(inFlightMessage, { operation: 'push' });
      expect(result).to.not.be.null;
      expect(result!.message).to.equal(inFlightMessage);
      // The timeout rule would otherwise claim it (the message says "timed
      // out") and offer Open Settings, which fixes nothing here.
      expect(result!.action).to.be.undefined;
    });

    it('should recognise the in-flight refusal by its error code', () => {
      const result = getErrorSuggestion('REMOTE_OPERATION_IN_FLIGHT: a pull is already running');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('already running');
      expect(result!.action).to.be.undefined;
    });

    it('should not mistake the in-flight refusal for a stuck lock file', () => {
      const result = getErrorSuggestion(
        'A fetch is already running for this repository. Wait for it to finish and try again.'
      );
      expect(result).to.not.be.null;
      expect(result!.message).to.not.include('lock file');
    });

    it('should return suggestion for operation timeout', () => {
      const result = getErrorSuggestion('The operation timed out after 300 seconds');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('timed out');
      expect(result!.action).to.not.be.undefined;
      expect(result!.action!.label).to.equal('Open Settings');
    });

    it('should return suggestion for operation_timeout code', () => {
      const result = getErrorSuggestion('OPERATION_TIMEOUT: fetch exceeded timeout');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('timed out');
      expect(result!.action!.label).to.equal('Open Settings');
    });

    it('should return suggestion for cancelled operation', () => {
      const result = getErrorSuggestion('OPERATION_CANCELLED');
      expect(result).to.not.be.null;
      expect(result!.message).to.include('cancelled');
      expect(result!.action).to.be.undefined;
    });

    it('should dispatch open-settings event for timeout errors', () => {
      const result = getErrorSuggestion('operation timed out');
      expect(result).to.not.be.null;

      let dispatched = false;
      const handler = () => { dispatched = true; };
      window.addEventListener('open-settings', handler);

      result!.action!.callback();

      expect(dispatched).to.be.true;
      window.removeEventListener('open-settings', handler);
    });

    it('should return null for unknown errors', () => {
      const result = getErrorSuggestion('some random error message');
      expect(result).to.be.null;
    });

    it('should return null for empty error message', () => {
      const result = getErrorSuggestion('');
      expect(result).to.be.null;
    });

    it('should dispatch trigger-pull event when action callback is called', () => {
      const result = getErrorSuggestion('non-fast-forward');
      expect(result).to.not.be.null;

      let dispatched = false;
      const handler = () => { dispatched = true; };
      window.addEventListener('trigger-pull', handler);

      result!.action!.callback();

      expect(dispatched).to.be.true;
      window.removeEventListener('trigger-pull', handler);
    });

    it('should dispatch force-delete-branch event with branch name', () => {
      const result = getErrorSuggestion('not fully merged', { branchName: 'my-branch' });
      expect(result).to.not.be.null;

      let detail: Record<string, unknown> | null = null;
      const handler = (e: Event) => { detail = (e as CustomEvent).detail; };
      window.addEventListener('force-delete-branch', handler);

      result!.action!.callback();

      expect(detail).to.not.be.null;
      expect(detail!.branchName).to.equal('my-branch');
      window.removeEventListener('force-delete-branch', handler);
    });

    it('should dispatch open-settings event for auth errors', () => {
      const result = getErrorSuggestion('authentication failed');
      expect(result).to.not.be.null;

      let dispatched = false;
      const handler = () => { dispatched = true; };
      window.addEventListener('open-settings', handler);

      result!.action!.callback();

      expect(dispatched).to.be.true;
      window.removeEventListener('open-settings', handler);
    });
  });

  describe('security-gate refusals are not diagnosed as git failures', () => {
    it('does not call a blocked operation a stuck lock file', () => {
      // 'blocked' contains 'lock', so a plain includes('lock') matched and told
      // the user to go remove an index.lock that does not exist.
      expect(getErrorSuggestion('Operation blocked by security settings')).to.equal(null);
    });

    it('still recognises the real lock messages', () => {
      expect(getErrorSuggestion('Unable to create index.lock: File exists')).to.not.equal(null);
      expect(getErrorSuggestion('the index is locked')).to.not.equal(null);
    });
  });

  describe('a checkout refused for local changes explains itself', () => {
    it("translates libgit2's bare conflict count", () => {
      // Reachable whenever Auto-Stash on Checkout is off. libgit2 says
      // "1 conflict prevents checkout" — no files, no way forward.
      const result = getErrorSuggestion('Checkout failed: 1 conflict prevents checkout');
      expect(result).to.not.equal(null);
      expect(result!.message).to.contain('Stash or commit');
      expect(result!.message).to.contain('Auto-Stash on Checkout');
    });

    it('handles the plural form and git\'s own wording', () => {
      expect(getErrorSuggestion('3 conflicts prevent checkout')).to.not.equal(null);
      expect(
        getErrorSuggestion('Your local changes would be overwritten by checkout'),
      ).to.not.equal(null);
    });
  });

  describe('a rejected push distinguishes the two libgit2 messages', () => {
    // push.c:345 and push.c:356 share no substring and mean opposite things.
    const REMOTE_AHEAD =
      'cannot push because a reference that you are trying to update on the remote contains commits that are not present locally.';
    const LOCAL_DIVERGED = 'cannot push non-fastforwardable reference';

    it('offers Pull Now when the remote genuinely has commits we lack', () => {
      const result = getErrorSuggestion(REMOTE_AHEAD, { operation: 'push' });
      expect(result).to.not.equal(null);
      expect(result!.message).to.match(/pull before pushing/i);
      expect(result!.action?.label).to.equal('Pull Now');
    });

    it('does NOT offer Pull Now after an amend or rebase', () => {
      // Pulling here merges the pre-amend commits back in, duplicating them and
      // undoing the amend — worse than saying nothing.
      const result = getErrorSuggestion(LOCAL_DIVERGED, { operation: 'push' });
      expect(result).to.not.equal(null);
      expect(result!.message).to.match(/diverged/i);
      // The action offered is the OPPOSITE one — force-push, which is what
      // actually recovers an amend. Asserting on the label, not on the object:
      // chai's diff of an action object hangs the browser on a function value.
      expect(
        result!.action?.label,
        'no one-click action that would undo their work',
      ).to.not.equal('Pull Now');
    });

    it('a tag already on the remote gets tag-specific advice, not "pull"', () => {
      const result = getErrorSuggestion(LOCAL_DIVERGED, { operation: 'push-tag' });
      expect(result!.message).to.match(/tag at a different commit/i);
      expect(result!.message).to.not.match(/pull before pushing/i);
    });

    it('the git CLI wording still reaches the pull advice', () => {
      const result = getErrorSuggestion('Updates were rejected', { operation: 'push' });
      expect(result!.action?.label).to.equal('Pull Now');
    });
  });

  describe('suggestion actions carry the repo that failed', () => {
    it('Pull Now pins the repo', () => {
      const result = getErrorSuggestion('...not present locally', {
        operation: 'push',
        repoPath: '/repo/a',
      });
      let detail: { repoPath?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ repoPath?: string }>).detail;
      };
      window.addEventListener('trigger-pull', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('trigger-pull', handler);
      }
      expect(detail).to.not.be.null;
      expect(detail!.repoPath).to.equal('/repo/a');
    });

    it('Abort Rebase pins the repo', () => {
      const result = getErrorSuggestion('rebase in progress', { repoPath: '/repo/a' });
      let detail: { repoPath?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ repoPath?: string }>).detail;
      };
      window.addEventListener('trigger-abort', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('trigger-abort', handler);
      }
      expect(detail!.repoPath).to.equal('/repo/a');
    });
  });

  describe('"permission denied" is not always an auth failure', () => {
    it('a locked file during a checkout is not reported as an SSH problem', () => {
      // The OS says "permission denied" for a read-only or held file too.
      const result = getErrorSuggestion('failed to write file: permission denied');
      expect(
        String(result?.message ?? ''),
        'the real filesystem error must not be replaced with credentials advice',
      ).to.not.contain('credentials or SSH keys');
    });

    it('but a push that fails on permission denied still is', () => {
      const result = getErrorSuggestion('permission denied', { operation: 'push' });
      expect(result!.message).to.match(/credentials or SSH keys/);
    });

    it('publickey wording is recognised regardless of operation', () => {
      const result = getErrorSuggestion('Permission denied (publickey)');
      expect(result!.message).to.match(/credentials or SSH keys/);
    });

    it("libssh2's verb form is still recognised", () => {
      // Scoping the permission-denied axis dropped a bare `auth` match that had
      // been catching this. libssh2 says "Failed to authenticate SSH session",
      // which contains neither "authentication" nor "permission denied", so the
      // most common SSH failure fell through every branch and suggested nothing.
      const result = getErrorSuggestion(
        'Failed to authenticate SSH session: Unable to open public key file',
        { operation: 'push' },
      );
      expect(result, 'the commonest SSH failure must not fall through').to.not.be.null;
      expect(result!.message).to.match(/credentials or SSH keys/);
    });

    it('"Author identity unknown" is not an auth failure', () => {
      // Why the match is `authenticat` and not `auth`: git says this when
      // user.name is unset, and it has nothing to do with credentials.
      const result = getErrorSuggestion(
        "Author identity unknown\n*** Please tell me who you are.",
      );
      expect(String(result?.message ?? '')).to.not.contain('credentials or SSH keys');
    });
  });

  describe('a rejected push offers an action the app can actually perform', () => {
    it('an amended history offers Force Push, not Pull', () => {
      // libgit2's "non-fastforwardable" means the remote tip IS in your object
      // database — you rewrote history. Pulling merges the pre-amend commits
      // back in and undoes the amend, so the suggestion must not say to.
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push',
        repoPath: '/repo/a',
      });
      expect(result).to.not.be.null;
      expect(result!.message, 'pulling here undoes the amend').to.not.match(/\bPull\b/);
      expect(result!.action!.label).to.equal('Force Push');
    });

    it('Force Push pins the repo the push failed in', () => {
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push',
        repoPath: '/repo/a',
      });
      let detail: { repoPath?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ repoPath?: string }>).detail;
      };
      window.addEventListener('force-push', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('force-push', handler);
      }
      expect(detail!.repoPath).to.equal('/repo/a');
    });

    it('a tag already on the remote offers Force Push Tag', () => {
      // The old copy said to delete the remote tag first — an operation
      // Gitnado implements nowhere, so the advice dead-ended.
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push-tag',
        branchName: 'v1.2.0',
        repoPath: '/repo/a',
      });
      expect(result!.message).to.not.contain('Delete the remote tag');
      expect(result!.action!.label).to.equal('Force Push Tag');
    });

    it('Force Push Tag carries the tag name and the repo', () => {
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push-tag',
        branchName: 'v1.2.0',
        repoPath: '/repo/a',
      });
      let detail: { tagName?: string; repoPath?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ tagName?: string; repoPath?: string }>).detail;
      };
      window.addEventListener('force-push-tag', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('force-push-tag', handler);
      }
      expect(detail!.tagName).to.equal('v1.2.0');
      expect(detail!.repoPath).to.equal('/repo/a');
    });

    it('Force Push Tag carries the remote the rejected push was aimed at', () => {
      // The rejected push went to the remote the user picked in the menu. A
      // force retry that left the destination to the backend resolver would
      // move the tag on a DIFFERENT remote — `origin` in a fork checkout — and
      // report success.
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push-tag',
        branchName: 'v1.2.0',
        repoPath: '/repo/a',
        remote: 'upstream',
      });
      let detail: { remote?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ remote?: string }>).detail;
      };
      window.addEventListener('force-push-tag', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('force-push-tag', handler);
      }
      expect(detail!.remote).to.equal('upstream');
    });

    it('Force Push Tag leaves the remote unset when the push named none', () => {
      // The graph ref menu pushes without choosing a remote; the retry must
      // stay on the backend resolver rather than inventing a destination.
      const result = getErrorSuggestion('cannot push non-fastforwardable reference', {
        operation: 'push-tag',
        branchName: 'v1.2.0',
        repoPath: '/repo/a',
      });
      let detail: { remote?: string } | null = null;
      const handler = (e: Event): void => {
        detail = (e as CustomEvent<{ remote?: string }>).detail;
      };
      window.addEventListener('force-push-tag', handler);
      try {
        result!.action!.callback();
      } finally {
        window.removeEventListener('force-push-tag', handler);
      }
      expect(detail!.remote).to.equal(undefined);
    });

    it('being behind the remote still offers Pull Now', () => {
      // The git CLI's hyphenated spelling means the opposite of libgit2's.
      const result = getErrorSuggestion('Updates were rejected: non-fast-forward', {
        operation: 'push',
      });
      expect(result!.action!.label).to.equal('Pull Now');
    });
  });
});