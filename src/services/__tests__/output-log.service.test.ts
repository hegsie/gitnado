import { expect } from '@open-wc/testing';

// Mock Tauri API before importing tauri-api.ts (same pattern as the other
// service tests): invokeCommand reads globalThis.__TAURI_INTERNALS__.invoke.
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
};

import {
  logGitCommand,
  getLogEntries,
  clearLogEntries,
  subscribeOutputLog,
  shouldLogToOutput,
  resetGitOperationTracking,
} from '../output-log.service.ts';
import { invokeCommand } from '../tauri-api.ts';
import { recordGitCommandEvent } from '../git-output.service.ts';

describe('output-log.service', () => {
  beforeEach(() => {
    clearLogEntries();
    resetGitOperationTracking();
    mockInvoke = () => Promise.resolve(null);
  });

  describe('log store', () => {
    it('records entries newest-first', () => {
      logGitCommand('first', '', true);
      logGitCommand('second', 'boom', false);

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      expect(entries[0].command).to.equal('second');
      expect(entries[0].success).to.be.false;
      expect(entries[0].output).to.equal('boom');
      expect(entries[1].command).to.equal('first');
    });

    it('trims to 100 entries', () => {
      for (let i = 0; i < 105; i++) {
        logGitCommand(`cmd-${i}`, '', true);
      }
      const entries = getLogEntries();
      expect(entries.length).to.equal(100);
      expect(entries[0].command).to.equal('cmd-104');
    });

    it('clear empties the log and notifies subscribers', () => {
      let notified = 0;
      const unsubscribe = subscribeOutputLog(() => {
        notified++;
      });

      logGitCommand('checkout', '', true);
      expect(notified).to.equal(1);

      clearLogEntries();
      expect(getLogEntries().length).to.equal(0);
      expect(notified).to.equal(2);

      unsubscribe();
      logGitCommand('merge', '', true);
      expect(notified).to.equal(2); // no notification after unsubscribe
    });

    it('scoped clear removes only the target repo (and repo-independent) entries', () => {
      logGitCommand('checkout', '', true, '/repoA');
      logGitCommand('merge', '', true, '/repoB');
      logGitCommand('store_github_token', '', true); // repo-independent

      let notified = 0;
      const unsubscribe = subscribeOutputLog(() => {
        notified++;
      });

      // Clearing repo A must NOT destroy repo B's history.
      clearLogEntries('/repoA');
      expect(notified).to.equal(1);

      const remaining = getLogEntries();
      const commands = remaining.map((e) => e.command);
      expect(commands).to.include('merge'); // repo B kept
      expect(commands).to.not.include('checkout'); // repo A cleared
      // Repo-independent entries are cleared when scoped (documented choice).
      expect(commands).to.not.include('store_github_token');

      unsubscribe();
    });

    it('accepts a details object as well as a bare repo path', () => {
      logGitCommand('push', 'ok', true, {
        repoPath: '/repoA',
        gitCommand: 'git push origin main',
        synthesized: false,
        durationMs: 1234,
      });
      logGitCommand('merge', '', true, '/repoB');

      // Newest first.
      const [mergeEntry, pushEntry] = getLogEntries();
      expect(pushEntry.repoPath).to.equal('/repoA');
      expect(pushEntry.gitCommand).to.equal('git push origin main');
      expect(pushEntry.synthesized).to.be.false;
      expect(pushEntry.durationMs).to.equal(1234);

      // The original 4th-parameter shape still works.
      expect(mergeEntry.repoPath).to.equal('/repoB');
      expect(mergeEntry.gitCommand).to.equal(undefined);
    });

    it('zero-arg clear still empties everything (e2e/injected usage)', () => {
      logGitCommand('checkout', '', true, '/repoA');
      logGitCommand('merge', '', true, '/repoB');

      clearLogEntries();
      expect(getLogEntries().length).to.equal(0);
    });
  });

  describe('shouldLogToOutput', () => {
    it('logs state-changing commands', () => {
      expect(shouldLogToOutput('checkout')).to.be.true;
      expect(shouldLogToOutput('merge')).to.be.true;
      expect(shouldLogToOutput('push')).to.be.true;
      expect(shouldLogToOutput('create_stash')).to.be.true;
      expect(shouldLogToOutput('commit_merge')).to.be.true;
    });

    it('skips read queries and plumbing', () => {
      expect(shouldLogToOutput('get_commit_history')).to.be.false;
      expect(shouldLogToOutput('list_worktrees')).to.be.false;
      expect(shouldLogToOutput('check_bitbucket_connection')).to.be.false;
      expect(shouldLogToOutput('detect_conflict_markers')).to.be.false;
      expect(shouldLogToOutput('start_watching')).to.be.false;
      expect(shouldLogToOutput('store_keyring_token')).to.be.false;
      expect(shouldLogToOutput('plugin:event|listen')).to.be.false;
    });

    it('skips app plumbing and index maintenance the user never ran', () => {
      // `sync_app_menu` fires at startup and on every tab open/close and
      // shortcut rebind; the scan commands are the "Add repository" browse
      // flow; the index builders are background bookkeeping. None is a git
      // operation, and none has a git line — so besides being noise in every
      // repository's panel, each was a stray claimant for the REAL invocation
      // of an operation the user actually ran.
      for (const command of [
        'sync_app_menu',
        'classify_repository_path',
        'scan_for_repositories',
        'cancel_repository_scan',
        'refresh_search_index',
        'build_search_index',
        'drop_search_index',
        'build_embedding_index',
        'cancel_embedding_build',
      ]) {
        expect(shouldLogToOutput(command), command).to.be.false;
      }
    });

    it('still logs the repository operations that look like plumbing', () => {
      // The skip list is by exact name, so neighbouring real operations that
      // the user did run must keep their rows.
      expect(shouldLogToOutput('run_gc')).to.be.true;
      expect(shouldLogToOutput('push_to_multiple_remotes')).to.be.true;
      expect(shouldLogToOutput('clone_repository')).to.be.true;
    });
  });

  describe('invokeCommand integration', () => {
    it('logs a successful state-changing command without its args', async () => {
      await invokeCommand('checkout', { path: '/repo', refName: 'main' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].command).to.equal('checkout');
      expect(entries[0].success).to.be.true;
      // Args are still never dumped wholesale into the output field
      expect(entries[0].output).to.equal('');
      // The repository path IS recorded so multi-repo sessions can scope entries
      expect(entries[0].repoPath).to.equal('/repo');
    });

    it('records the equivalent git command line, marked as synthesised', async () => {
      await invokeCommand('checkout', { path: '/repo', refName: 'feature/x' });

      const entry = getLogEntries()[0];
      expect(entry.gitCommand).to.equal('git checkout feature/x');
      // git2 did the work — the panel must not imply the CLI ran
      expect(entry.synthesized).to.be.true;
      expect(entry.durationMs).to.be.a('number');
      expect(entry.durationMs).to.be.at.least(0);
    });

    it('records no git line for a command with no honest synthesis', async () => {
      await invokeCommand('start_auto_fetch', { path: '/repo' });

      const entry = getLogEntries()[0];
      expect(entry.command).to.equal('start_auto_fetch');
      expect(entry.gitCommand).to.equal(undefined);
      expect(entry.synthesized).to.be.false;
    });

    it('never puts a token into the synthesised line', async () => {
      await invokeCommand('push', {
        path: '/repo',
        remote: 'origin',
        branch: 'main',
        token: 'ghp_0123456789abcdefghij',
      });

      const entry = getLogEntries()[0];
      expect(entry.gitCommand).to.equal('git push origin main');
      expect(JSON.stringify(entry)).to.not.contain('ghp_');
    });

    it('redacts a credentialed URL echoed back in a backend error', async () => {
      mockInvoke = () =>
        Promise.reject({
          code: 'AUTH',
          message:
            'failed to push to https://user:ghp_0123456789abcdefghij@github.com/o/r.git',
        });

      await invokeCommand('push', { path: '/repo', remote: 'origin', branch: 'main' });

      const entry = getLogEntries()[0];
      expect(entry.success).to.be.false;
      expect(entry.output).to.not.contain('ghp_');
      expect(entry.output).to.contain('***@github.com/o/r.git');
    });

    it('scopes commands that pass the repo path as repoPath (e.g. stage_hunk)', async () => {
      // stage_hunk/unstage_hunk pass the repository path as `repoPath`, not `path`.
      // The entry must still be scoped to that repo so it shows only in that repo's
      // panel and is not destroyed by an unrelated repo's scoped Clear.
      await invokeCommand('stage_hunk', { repoPath: '/repoA', patch: 'diff' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].command).to.equal('stage_hunk');
      expect(entries[0].repoPath).to.equal('/repoA');
    });

    it('leaves repoPath unset for repo-independent commands', async () => {
      await invokeCommand('store_github_token', { token: 'secret' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].repoPath).to.equal(undefined);
      expect(entries[0].output).to.equal('');
    });

    it('logs a failed command with its error message', async () => {
      mockInvoke = () =>
        Promise.reject({ code: 'MERGE_CONFLICT', message: 'Merge conflict detected' });

      const result = await invokeCommand('merge', { path: '/repo', sourceRef: 'feature' });
      expect(result.success).to.be.false;

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].command).to.equal('merge');
      expect(entries[0].success).to.be.false;
      expect(entries[0].output).to.equal('Merge conflict detected');
    });

    it('does not log read queries', async () => {
      await invokeCommand('get_commit_history', { path: '/repo' });
      await invokeCommand('check_bitbucket_connection');

      expect(getLogEntries().length).to.equal(0);
    });
  });

  // ------------------------------------------------------------------------
  // The panel has TWO feeds: the synthesised line this IPC layer records, and
  // the REAL `git` invocations the backend reports. Every operation that falls
  // back to the CLI used to produce one row from each — and the synthesised one
  // could contradict the real one, because it is built from the IPC arguments
  // and cannot see flags the backend added.
  // ------------------------------------------------------------------------
  describe('reconciling the synthesised and real feeds', () => {
    /** Make `command` report a real `git` run the way the backend would. */
    function shellsOut(
      command: string,
      event: {
        command: string;
        output?: string;
        success?: boolean;
        repoPath?: string | null;
      },
      result: () => Promise<unknown> = () => Promise.resolve(null),
    ): void {
      mockInvoke = (invoked: string) => {
        if (invoked !== command) return Promise.resolve(null);
        recordGitCommandEvent({
          command: event.command,
          output: event.output ?? '',
          success: event.success ?? true,
          durationMs: 412,
          repoPath: event.repoPath ?? null,
        });
        return result();
      };
    }

    it('a CLI-backed signed commit logs ONE row, and it carries -S', async () => {
      // `commit.gpgsign = true` with no explicit toggle: the frontend passes no
      // signCommit, so its synthesised line cannot know about `-S`.
      shellsOut('create_commit', {
        command: 'git commit -m "fix parser" -S',
        output: '[main abc1234] fix parser',
        repoPath: '/repo',
      });

      await invokeCommand('create_commit', { path: '/repo', message: 'fix parser' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git commit -m "fix parser" -S');
      // The real argv is the truth — it must not be marked as an equivalent.
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].output).to.contain('fix parser');
    });

    it('a git2-backed commit still logs its ONE synthesised row', async () => {
      await invokeCommand('create_commit', { path: '/repo', message: 'plain' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git commit -m plain');
      expect(entries[0].synthesized).to.be.true;
    });

    it('a CLI-backed signed amend logs ONE row, and it carries -S', async () => {
      // `amend_commit` picks its path with should_sign_commit(&path, sign_amend):
      // with no explicit signAmend it falls back to the repository's
      // commit.gpgsign, and amend_commit_with_git_cli then runs
      // `git commit --amend -S …`. The synthesised line reads signAmend from the
      // IPC arguments, which is undefined here, so it renders no -S.
      shellsOut('amend_commit', {
        command: 'git commit --amend -S -m "reworded"',
        output: '[main abc1234] reworded',
        repoPath: '/repo',
      });

      await invokeCommand('amend_commit', { path: '/repo', message: 'reworded' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git commit --amend -S -m "reworded"');
      expect(entries[0].synthesized).to.be.false;
    });

    it('a CLI-backed signed merge commit logs ONE row, and it carries -S', async () => {
      // commit_merge shells out through commit_merge_signed (`git commit -S -m`)
      // when signing is on. Its builder has no signing branch at all, so the
      // synthesised twin would always claim the merge commit was unsigned.
      shellsOut('commit_merge', {
        command: 'git commit -S -m "Merge branch feature"',
        output: '[main def5678] Merge branch feature',
        repoPath: '/repo',
      });

      await invokeCommand('commit_merge', {
        path: '/repo',
        message: 'Merge branch feature',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git commit -S -m "Merge branch feature"');
      expect(entries[0].synthesized).to.be.false;
    });

    it('a CLI-backed force push logs ONE row carrying --force-with-lease', async () => {
      // The backend push shells out with `-C <path>`, so the subcommand is not
      // the first token of the line.
      shellsOut('push', {
        command: 'git -C /repo push --force-with-lease origin main',
        output: 'forced update',
        repoPath: '/repo',
      });

      await invokeCommand('push', {
        path: '/repo',
        remote: 'origin',
        branch: 'main',
        forceWithLease: true,
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal(
        'git -C /repo push --force-with-lease origin main',
      );
      expect(entries[0].synthesized).to.be.false;
    });

    it('a CLI-backed signed tag logs ONE row, and it says -s, not -a', async () => {
      // `tag.gpgsign = true` sends create_tag through `git tag -s` (tags.rs,
      // create_signed_tag_cli). The synthesised line is built from the IPC
      // arguments, which carry no signing flag, so it says `-a` (annotated):
      // the panel would claim the tag was unsigned when it was in fact signed.
      shellsOut('create_tag', {
        command: 'git tag -s -m release v1.0 abc1234',
        output: '',
        repoPath: '/repo',
      });

      await invokeCommand('create_tag', {
        path: '/repo',
        name: 'v1.0',
        message: 'release',
        target: 'abc1234',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git tag -s -m release v1.0 abc1234');
      expect(entries[0].gitCommand).to.not.contain('-a');
      expect(entries[0].synthesized).to.be.false;
    });

    it('a CLI-backed signed tag REPLACEMENT (tag -s -f) logs ONE row', async () => {
      // edit_tag_message replaces a tag in place, and signs it when tag.gpgsign
      // is on. It has no synthesis of its own, so without reconciliation the
      // panel showed the real line plus a bare `edit_tag_message` row.
      shellsOut('edit_tag_message', {
        command: 'git tag -s -f -m reworded v1.0 abc1234',
        output: '',
        repoPath: '/repo',
      });

      await invokeCommand('edit_tag_message', {
        path: '/repo',
        name: 'v1.0',
        message: 'reworded',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git tag -s -f -m reworded v1.0 abc1234');
      expect(entries[0].synthesized).to.be.false;
    });

    it('an unsigned annotated tag keeps its synthesised -a row', async () => {
      // The mirror image: with tag.gpgsign off, git2 creates the tag and there
      // is no real invocation. The `-a` line is then CORRECT and must survive —
      // reconciliation must not swallow the row it is the only source for.
      await invokeCommand('create_tag', {
        path: '/repo',
        name: 'v1.0',
        message: 'release',
        target: 'abc1234',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git tag -a -m release v1.0 abc1234');
      expect(entries[0].synthesized).to.be.true;
    });

    it('an operation that never shells out keeps its synthesised row', async () => {
      await invokeCommand('create_stash', {
        path: '/repo',
        message: 'wip',
        includeUntracked: true,
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal(
        'git stash push --include-untracked -m wip',
      );
      expect(entries[0].synthesized).to.be.true;
    });

    it('a real run in one repository never suppresses another repository\'s row', async () => {
      const resolvers = new Map<string, () => void>();
      mockInvoke = (_command: string, args?: unknown) => {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        return new Promise((resolve) => {
          resolvers.set(path, () => resolve(null));
        });
      };

      const a = invokeCommand('create_commit', { path: '/repoA', message: 'A' });
      const b = invokeCommand('create_commit', { path: '/repoB', message: 'B' });

      // Repo A shells out while BOTH operations are in flight.
      recordGitCommandEvent({
        command: 'git commit -m A -S',
        output: '',
        success: true,
        durationMs: 7,
        repoPath: '/repoA',
      });

      resolvers.get('/repoA')?.();
      resolvers.get('/repoB')?.();
      await Promise.all([a, b]);

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);

      const forA = entries.find((e) => e.repoPath === '/repoA');
      expect(forA?.synthesized).to.be.false;
      expect(forA?.gitCommand).to.contain('-S');

      // Repo B never shelled out, so its own equivalent line must survive.
      const forB = entries.find((e) => e.repoPath === '/repoB');
      expect(forB?.synthesized).to.be.true;
      expect(forB?.gitCommand).to.equal('git commit -m B');
    });

    it('an unrelated real run in the same repository does not swallow a row', async () => {
      // An auto-fetch firing while a commit is in flight is a DIFFERENT git
      // subcommand, so it gets its own row and the commit keeps its own.
      shellsOut('create_commit', {
        command: 'git fetch --prune origin',
        repoPath: '/repo',
      });

      await invokeCommand('create_commit', { path: '/repo', message: 'unrelated' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      expect(entries.some((e) => e.gitCommand === 'git fetch --prune origin')).to.be
        .true;
      expect(entries.some((e) => e.gitCommand === 'git commit -m unrelated')).to.be
        .true;
    });

    it('a real push is claimed by the push, not by an older unrelated operation', async () => {
      // `run_gc` has no builder, so its subcommand is unknown and it stays
      // claimable — but it must never take the claim ahead of the operation
      // whose subcommand IS this run's, or the push would write a second,
      // contradictory row.
      const resolvers = new Map<string, () => void>();
      mockInvoke = (command: string) =>
        new Promise((resolve) => {
          resolvers.set(command, () => resolve(null));
        });

      const gc = invokeCommand('run_gc', { path: '/repo' });
      const push = invokeCommand('push', {
        path: '/repo',
        remote: 'origin',
        branch: 'main',
        forceWithLease: true,
      });

      recordGitCommandEvent({
        command: 'git -C /repo push --force-with-lease origin main',
        output: 'forced update',
        success: true,
        durationMs: 40,
        repoPath: '/repo',
      });

      resolvers.get('push')?.();
      await push;

      // ONE row for the push, and it is the real invocation.
      const afterPush = getLogEntries();
      expect(afterPush.length).to.equal(1);
      expect(afterPush[0].synthesized).to.be.false;
      expect(afterPush[0].gitCommand).to.equal(
        'git -C /repo push --force-with-lease origin main',
      );

      // The gc never shelled out, so it still gets its own row.
      resolvers.get('run_gc')?.();
      await gc;
      expect(getLogEntries().length).to.equal(2);
    });

    it('a repository path containing a space does not double the push row', async () => {
      // The backend quotes any argument with whitespace, so the real line is
      // `git -C "…/My Repos/lev" push …`. Reading that line as whitespace
      // tokens makes the two-slot `-C` skip land inside the path, the
      // subcommands then disagree, the claim is refused and the panel shows
      // the real push AND a synthesised twin.
      const repoPath = '/Users/me/My Repos/lev';
      shellsOut('push', {
        command: `git -C "${repoPath}" push --force-with-lease origin main`,
        output: 'forced update',
        repoPath,
      });

      await invokeCommand('push', {
        path: repoPath,
        remote: 'origin',
        branch: 'main',
        forceWithLease: true,
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].gitCommand).to.equal(
        `git -C "${repoPath}" push --force-with-lease origin main`,
      );
    });

    it("a permissively claimed operation's failure never marks a real run failed", async () => {
      // `run_gc` is claimable by any run in the repository because its
      // subcommand is unknown. If it then fails, its error must land on a row
      // of its own — stamping it onto the successful `git push` that really
      // ran would tell the user a push that worked had failed.
      let rejectGc: (error: unknown) => void = () => {};
      mockInvoke = () =>
        new Promise((_resolve, reject) => {
          rejectGc = reject;
        });

      const gc = invokeCommand('run_gc', { path: '/repo' });

      recordGitCommandEvent({
        command: 'git -C /repo push --force-with-lease origin main',
        output: 'forced update',
        success: true,
        durationMs: 40,
        repoPath: '/repo',
      });

      rejectGc({ code: 'GC_FAILED', message: 'failed to open the commit index' });
      await gc;

      const entries = getLogEntries();
      const real = entries.find((e) => e.gitCommand?.includes('push'));
      expect(real?.success, 'the push really succeeded').to.be.true;
      expect(real?.output).to.not.contain('commit index');

      // The failure is still shown, as its own row.
      const failure = entries.find((e) => !e.success);
      expect(failure?.command).to.equal('run_gc');
      expect(failure?.output).to.contain('failed to open the commit index');
    });

    it('a confirmed claim still carries the operation failure onto its row', async () => {
      // The guard above must not cost the documented behaviour: when the
      // subcommand CONFIRMS the claim, a later failure belongs on that row.
      shellsOut(
        'push',
        { command: 'git -C /repo push --force-with-lease origin main', repoPath: '/repo' },
        () => Promise.reject({ code: 'PUSH_FAILED', message: 'hook rejected the push' }),
      );

      await invokeCommand('push', {
        path: '/repo',
        remote: 'origin',
        branch: 'main',
        forceWithLease: true,
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].success).to.be.false;
      expect(entries[0].output).to.contain('hook rejected the push');
    });

    it('a real run reported AFTER the operation settles replaces its row', async () => {
      // Event delivery and IPC resolution are separate channels, so the real
      // line can arrive either side of the command returning.
      await invokeCommand('create_commit', { path: '/repo', message: 'late' });
      expect(getLogEntries().length).to.equal(1);

      recordGitCommandEvent({
        command: 'git commit -m late -S',
        output: '[main def5678] late',
        success: true,
        durationMs: 9,
        repoPath: '/repo',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].gitCommand).to.equal('git commit -m late -S');
    });

    it("a late real run does not inherit an unconfirmed operation's failure", async () => {
      // Same hazard as the in-flight case, on the late-claim path: `run_gc`
      // settles FAILED, then the real push event arrives inside the late-claim
      // window. Dropping the gc row and stamping its error onto the push would
      // report a push that succeeded as failed.
      mockInvoke = () =>
        Promise.reject({
          code: 'GC_FAILED',
          message: 'failed to open the commit index',
        });
      await invokeCommand('run_gc', { path: '/repo' });
      expect(getLogEntries().length).to.equal(1);

      recordGitCommandEvent({
        command: 'git -C /repo push --force-with-lease origin main',
        output: 'forced update',
        success: true,
        durationMs: 40,
        repoPath: '/repo',
      });

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      const real = entries.find((e) => e.gitCommand?.includes('push'));
      expect(real?.success, 'the push really succeeded').to.be.true;
      expect(real?.output).to.not.contain('commit index');
      const failure = entries.find((e) => e.command === 'run_gc');
      expect(failure?.success).to.be.false;
    });

    it('a late run of a different subcommand keeps both rows', async () => {
      await invokeCommand('create_commit', { path: '/repo', message: 'keep' });

      recordGitCommandEvent({
        command: 'git gc --auto',
        output: '',
        success: true,
        durationMs: 30,
        repoPath: '/repo',
      });

      expect(getLogEntries().length).to.equal(2);
    });

    it('a failure after a successful real run is carried onto that row', async () => {
      // The commit itself ran; something after it (a hook, a refresh) failed.
      // The user must still see why, without a second row appearing.
      shellsOut(
        'create_commit',
        { command: 'git commit -m x -S', repoPath: '/repo' },
        () => Promise.reject({ code: 'HOOK', message: 'post-commit hook failed' }),
      );

      const result = await invokeCommand('create_commit', {
        path: '/repo',
        message: 'x',
      });
      expect(result.success).to.be.false;

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].success).to.be.false;
      expect(entries[0].output).to.contain('post-commit hook failed');
    });

    it('does not repeat the git error the backend already reported', async () => {
      shellsOut(
        'create_commit',
        {
          command: 'git commit -m x -S',
          output: 'error: gpg failed to sign the data',
          success: false,
          repoPath: '/repo',
        },
        () =>
          Promise.reject({
            code: 'COMMIT_FAILED',
            message: 'Git commit failed: error: gpg failed to sign the data',
          }),
      );

      await invokeCommand('create_commit', { path: '/repo', message: 'x' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].success).to.be.false;
      const occurrences = entries[0].output.split('gpg failed to sign').length - 1;
      expect(occurrences).to.equal(1);
    });

    // `merge` is the one builder whose backend shells out to a DIFFERENT git
    // subcommand than the builder names: with `commit.gpgsign` set, the merge
    // itself runs through libgit2 and the merge commit is then made with
    // `git commit -S -m <msg>` (commit_merge_signed in merge.rs). The real
    // run's subcommand is `commit`, the synthesised line's is `merge`, and a
    // plain "known subcommands must be equal" rule refused the claim — so one
    // click on "Merge into current branch" showed BOTH `≈ git merge feature`
    // and the real `git commit -S …`.
    it('a merge signed because of commit.gpgsign logs ONE row — the real git commit -S', async () => {
      shellsOut('merge', {
        command: 'git commit -S -m "Merge branch \'feature\'"',
        output: "[main 1a2b3c4] Merge branch 'feature'",
        repoPath: '/repo',
      });

      await invokeCommand('merge', { path: '/repo', sourceRef: 'feature' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git commit -S -m "Merge branch \'feature\'"');
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].command).to.equal('git commit -S -m "Merge branch \'feature\'"');
      expect(entries[0].success).to.be.true;
    });

    it('a signed merge with no GPG key shows ONE red row carrying the error, not two', async () => {
      // The claim is CONFIRMED (a declared subcommand), so the IPC failure is
      // carried onto the real row rather than opening a second red one.
      shellsOut(
        'merge',
        {
          command: 'git commit -S -m "Merge branch \'feature\'"',
          output: 'error: gpg failed to sign the data',
          success: false,
          repoPath: '/repo',
        },
        () =>
          Promise.reject({
            code: 'OPERATION_FAILED',
            message: 'Git commit failed: error: gpg failed to sign the data',
          }),
      );

      const result = await invokeCommand('merge', { path: '/repo', sourceRef: 'feature' });
      expect(result.success).to.be.false;

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].success).to.be.false;
      expect(entries[0].gitCommand).to.equal('git commit -S -m "Merge branch \'feature\'"');
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].output).to.contain('gpg failed to sign the data');
      const occurrences = entries[0].output.split('gpg failed to sign').length - 1;
      expect(occurrences).to.equal(1);
    });

    it('an unsigned merge keeps its ONE synthesised git merge row', async () => {
      // Over-suppression guard: declaring `commit` as a subcommand the merge
      // may run must not cost a git2-backed merge its own equivalent line.
      await invokeCommand('merge', { path: '/repo', sourceRef: 'feature', noFf: true });

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].gitCommand).to.equal('git merge --no-ff feature');
      expect(entries[0].synthesized).to.be.true;
      expect(entries[0].command).to.equal('merge');
    });

    it('a merge in flight still does not swallow an unrelated real run', async () => {
      // The declared list widens the merge to `commit`, not to everything: an
      // auto-fetch firing mid-merge keeps its own row and so does the merge.
      shellsOut('merge', {
        command: 'git fetch --prune origin',
        repoPath: '/repo',
      });

      await invokeCommand('merge', { path: '/repo', sourceRef: 'feature' });

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      expect(entries.some((e) => e.gitCommand === 'git fetch --prune origin')).to.be.true;
      expect(
        entries.some((e) => e.gitCommand === 'git merge feature' && e.synthesized === true),
      ).to.be.true;
    });

    it("a signed merge commit's real run is not taken by an older create_commit in another repository", async () => {
      // Both accept `commit`; the repository tells them apart.
      const resolvers = new Map<string, () => void>();
      mockInvoke = (_command: string, args?: unknown) => {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        return new Promise((resolve) => {
          resolvers.set(path, () => resolve(null));
        });
      };

      const commit = invokeCommand('create_commit', { path: '/other', message: 'unrelated' });
      const merge = invokeCommand('merge', { path: '/repo', sourceRef: 'feature' });

      recordGitCommandEvent({
        command: 'git commit -S -m "Merge branch \'feature\'"',
        output: '',
        success: true,
        durationMs: 30,
        repoPath: '/repo',
      });

      resolvers.get('/other')?.();
      resolvers.get('/repo')?.();
      await Promise.all([commit, merge]);

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      const forOther = entries.find((e) => e.repoPath === '/other');
      expect(forOther?.synthesized).to.be.true;
      expect(forOther?.gitCommand).to.equal('git commit -m unrelated');
      const forRepo = entries.find((e) => e.repoPath === '/repo');
      expect(forRepo?.synthesized).to.be.false;
      expect(forRepo?.gitCommand).to.contain('-S');
    });
  });

  describe('a real run that reports no repository', () => {
    // A CLI clone has no working directory yet, so the backend reports its
    // run with `repoPath: null`. Such a run matches every candidate on the
    // repository axis and can only be attributed when ONE candidate is left.
    function inFlight(): {
      settle: (path: string) => void;
    } {
      const resolvers = new Map<string, () => void>();
      mockInvoke = (_command: string, args?: unknown) => {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        return new Promise((resolve) => {
          resolvers.set(path, () => resolve(null));
        });
      };
      return { settle: (path) => resolvers.get(path)?.() };
    }

    it('is claimed when exactly one candidate is in flight', async () => {
      const { settle } = inFlight();
      const clone = invokeCommand('clone_repository', {
        url: 'https://example.com/a.git',
        path: '/clones/a',
        depth: 1,
      });

      recordGitCommandEvent({
        command: 'git clone --depth 1 https://example.com/a.git /clones/a',
        output: "Cloning into '/clones/a'...",
        success: true,
        durationMs: 900,
        repoPath: null,
      });

      settle('/clones/a');
      await clone;

      const entries = getLogEntries();
      expect(entries.length).to.equal(1);
      expect(entries[0].synthesized).to.be.false;
      expect(entries[0].gitCommand).to.equal(
        'git clone --depth 1 https://example.com/a.git /clones/a',
      );
    });

    it('is NOT claimed while two candidates are in flight — every row stands', async () => {
      const { settle } = inFlight();
      const a = invokeCommand('clone_repository', {
        url: 'https://example.com/a.git',
        path: '/clones/a',
        depth: 1,
      });
      const b = invokeCommand('clone_repository', {
        url: 'https://example.com/b.git',
        path: '/clones/b',
        depth: 1,
      });

      recordGitCommandEvent({
        command: 'git clone --depth 1 https://example.com/a.git /clones/a',
        output: "Cloning into '/clones/a'...",
        success: true,
        durationMs: 900,
        repoPath: null,
      });

      settle('/clones/a');
      settle('/clones/b');
      await Promise.all([a, b]);

      // The real row plus BOTH operations' own rows: nothing was guessed.
      const entries = getLogEntries();
      expect(entries.length).to.equal(3);
      expect(entries.filter((e) => e.command === 'clone_repository').length).to.equal(2);
      expect(
        entries.filter((e) => e.gitCommand?.startsWith('git clone')).length,
      ).to.equal(1);
    });

    it('a candidate with a KNOWN, different subcommand is not a candidate', async () => {
      // A commit in flight elsewhere does not make the clone ambiguous: the
      // subcommand rules it out before the repository question is asked.
      const { settle } = inFlight();
      const commit = invokeCommand('create_commit', { path: '/repo', message: 'x' });
      const clone = invokeCommand('clone_repository', {
        url: 'https://example.com/a.git',
        path: '/clones/a',
        depth: 1,
      });

      recordGitCommandEvent({
        command: 'git clone --depth 1 https://example.com/a.git /clones/a',
        output: '',
        success: true,
        durationMs: 900,
        repoPath: null,
      });

      settle('/repo');
      settle('/clones/a');
      await Promise.all([commit, clone]);

      const entries = getLogEntries();
      expect(entries.length).to.equal(2);
      expect(entries.some((e) => e.gitCommand === 'git commit -m x' && e.synthesized)).to.be
        .true;
      expect(entries.some((e) => e.command === 'clone_repository')).to.be.false;
    });
  });
});
