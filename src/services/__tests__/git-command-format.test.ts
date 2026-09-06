import { expect } from '@open-wc/testing';

import {
  claimableSubcommands,
  gitSubcommand,
  redactSecrets,
  synthesizeGitCommand,
  SYNTHESIZED_COMMANDS,
} from '../git-command-format.ts';

describe('git-command-format', () => {
  describe('synthesizeGitCommand — the main operations', () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      // commit
      [
        'commit',
        'create_commit',
        { path: '/r', message: 'fix the login bug' },
        'git commit -m "fix the login bug"',
      ],
      [
        'commit with amend and signing',
        'create_commit',
        { path: '/r', message: 'redo', amend: true, signCommit: true },
        'git commit --amend -S -m redo',
      ],
      [
        'empty commit',
        'create_commit',
        { path: '/r', message: 'wip', allowEmpty: true },
        'git commit --allow-empty -m wip',
      ],
      [
        'amend without a new message',
        'amend_commit',
        { path: '/r' },
        'git commit --amend --no-edit',
      ],
      [
        'amend resetting the author',
        'amend_commit',
        { path: '/r', message: 'better', resetAuthor: true },
        'git commit --amend --reset-author -m better',
      ],
      ['merge commit', 'commit_merge', { path: '/r' }, 'git commit --no-edit'],

      // staging
      [
        'stage',
        'stage_files',
        { path: '/r', paths: ['src/a.ts', 'src/b.ts'] },
        'git add -- src/a.ts src/b.ts',
      ],
      ['stage everything', 'stage_files', { path: '/r', paths: [] }, 'git add -A'],
      [
        'unstage',
        'unstage_files',
        { path: '/r', paths: ['src/a.ts'] },
        'git restore --staged -- src/a.ts',
      ],
      [
        'discard',
        'discard_changes',
        { path: '/r', paths: ['src/a.ts'] },
        'git restore -- src/a.ts',
      ],

      // checkout / branches
      ['checkout', 'checkout', { path: '/r', refName: 'feature/x' }, 'git checkout feature/x'],
      [
        'forced checkout',
        'checkout',
        { path: '/r', refName: 'main', force: true },
        'git checkout --force main',
      ],
      [
        'checkout with autostash',
        'checkout_with_autostash',
        { path: '/r', refName: 'main', autoStash: true },
        'git stash push && git checkout main && git stash pop',
      ],
      [
        'checkout without autostash',
        'checkout_with_autostash',
        { path: '/r', refName: 'main', autoStash: false },
        'git checkout main',
      ],
      [
        'branch create',
        'create_branch',
        { path: '/r', name: 'feature/y' },
        'git branch feature/y',
      ],
      [
        'branch create and switch from a start point',
        'create_branch',
        { path: '/r', name: 'feature/y', startPoint: 'origin/main', checkout: true },
        'git checkout -b feature/y origin/main',
      ],
      ['branch delete', 'delete_branch', { path: '/r', name: 'old' }, 'git branch -d old'],
      [
        'forced branch delete',
        'delete_branch',
        { path: '/r', name: 'old', force: true },
        'git branch -D old',
      ],
      [
        'branch rename',
        'rename_branch',
        { path: '/r', oldName: 'a', newName: 'b' },
        'git branch -m a b',
      ],

      // merge
      ['merge', 'merge', { path: '/r', sourceRef: 'feature' }, 'git merge feature'],
      [
        'merge --no-ff',
        'merge',
        { path: '/r', sourceRef: 'feature', noFf: true },
        'git merge --no-ff feature',
      ],
      [
        'squash merge with a message',
        'merge',
        { path: '/r', sourceRef: 'feature', squash: true, message: 'merge it' },
        'git merge --squash -m "merge it" feature',
      ],
      ['merge abort', 'abort_merge', { path: '/r' }, 'git merge --abort'],

      // rebase
      ['rebase', 'rebase', { path: '/r', onto: 'main' }, 'git rebase main'],
      ['rebase continue', 'continue_rebase', { path: '/r' }, 'git rebase --continue'],
      ['rebase abort', 'abort_rebase', { path: '/r' }, 'git rebase --abort'],
      ['rebase skip', 'skip_rebase_commit', { path: '/r' }, 'git rebase --skip'],

      // remote transfer
      ['fetch', 'fetch', { path: '/r', remote: 'origin' }, 'git fetch origin'],
      [
        'fetch with prune',
        'fetch',
        { path: '/r', remote: 'origin', prune: true },
        'git fetch --prune origin',
      ],
      ['fetch all', 'fetch_all_remotes', { path: '/r' }, 'git fetch --all'],
      [
        'pull with rebase',
        'pull',
        { path: '/r', remote: 'origin', branch: 'main', rebase: true },
        'git pull --rebase origin main',
      ],
      ['push', 'push', { path: '/r', remote: 'origin', branch: 'main' }, 'git push origin main'],
      [
        'push --force-with-lease wins over --force',
        'push',
        { path: '/r', remote: 'origin', branch: 'main', force: true, forceWithLease: true },
        'git push --force-with-lease origin main',
      ],
      [
        'push with upstream and tags',
        'push',
        { path: '/r', remote: 'origin', branch: 'main', pushTags: true, setUpstream: true },
        'git push --tags --set-upstream origin main',
      ],

      // stash
      [
        'stash with a message',
        'create_stash',
        { path: '/r', message: 'wip work', includeUntracked: true },
        'git stash push --include-untracked -m "wip work"',
      ],
      ['stash apply', 'apply_stash', { path: '/r', index: 2 }, 'git stash apply stash@{2}'],
      [
        'stash apply with drop is a pop',
        'apply_stash',
        { path: '/r', index: 0, dropAfter: true },
        'git stash pop stash@{0}',
      ],
      ['stash pop', 'pop_stash', { path: '/r', index: 1 }, 'git stash pop stash@{1}'],
      ['stash drop', 'drop_stash', { path: '/r', index: 3 }, 'git stash drop stash@{3}'],

      // reset
      [
        'hard reset',
        'reset',
        { path: '/r', targetRef: 'HEAD~1', mode: 'hard' },
        'git reset --hard HEAD~1',
      ],
      [
        'soft reset',
        'reset',
        { path: '/r', targetRef: 'abc1234', mode: 'soft' },
        'git reset --soft abc1234',
      ],

      // cherry-pick / revert
      [
        'cherry-pick',
        'cherry_pick',
        { path: '/r', commitOid: 'abc1234' },
        'git cherry-pick abc1234',
      ],
      [
        'cherry-pick a merge without committing',
        'cherry_pick',
        { path: '/r', commitOid: 'abc1234', noCommit: true, mainline: 1 },
        'git cherry-pick --no-commit -m 1 abc1234',
      ],
      ['revert', 'revert', { path: '/r', commitOid: 'abc1234' }, 'git revert abc1234'],
      [
        'revert a merge',
        'revert',
        { path: '/r', commitOid: 'abc1234', mainline: 2 },
        'git revert -m 2 abc1234',
      ],
      ['revert abort', 'abort_revert', { path: '/r' }, 'git revert --abort'],

      // tags
      ['lightweight tag', 'create_tag', { path: '/r', name: 'v1.0.0' }, 'git tag v1.0.0'],
      [
        'annotated tag on a target',
        'create_tag',
        { path: '/r', name: 'v1.0.0', message: 'release one', target: 'abc1234' },
        'git tag -a -m "release one" v1.0.0 abc1234',
      ],
      ['tag delete', 'delete_tag', { path: '/r', name: 'v1.0.0' }, 'git tag -d v1.0.0'],
      [
        'tag push',
        'push_tag',
        { path: '/r', name: 'v1.0.0', remote: 'upstream' },
        'git push upstream refs/tags/v1.0.0',
      ],
      [
        'remote tag delete',
        'delete_remote_tag',
        { path: '/r', name: 'v1.0.0', remote: 'upstream' },
        'git push upstream --delete refs/tags/v1.0.0',
      ],
      [
        // No remote given: the backend resolves one, so the line must not
        // invent `origin` — it names the default remote by omitting it.
        'a tag push with no explicit remote',
        'push_tag',
        { path: '/r', name: 'v1.0.0' },
        'git push refs/tags/v1.0.0',
      ],
      [
        'a remote tag delete with no explicit remote',
        'delete_remote_tag',
        { path: '/r', name: 'v1.0.0' },
        'git push --delete refs/tags/v1.0.0',
      ],
    ];

    for (const [label, command, args, expected] of cases) {
      it(`renders ${label}`, () => {
        expect(synthesizeGitCommand(command, args)).to.equal(expected);
      });
    }

    it('covers every operation the review called out', () => {
      for (const command of [
        'create_commit',
        'stage_files',
        'unstage_files',
        'checkout',
        'create_branch',
        'delete_branch',
        'merge',
        'rebase',
        'fetch',
        'pull',
        'push',
        'create_stash',
        'reset',
        'cherry_pick',
        'revert',
        'create_tag',
      ]) {
        expect(SYNTHESIZED_COMMANDS, command).to.include(command);
      }
    });
  });

  describe('synthesizeGitCommand — refusals', () => {
    it('returns undefined for an operation with no synthesis', () => {
      // Better the honest IPC name than a half-guessed command line.
      expect(synthesizeGitCommand('start_auto_fetch', { path: '/r' })).to.equal(undefined);
      expect(synthesizeGitCommand('store_github_token', { token: 'x' })).to.equal(undefined);
    });

    it('returns undefined when a required argument is missing', () => {
      expect(synthesizeGitCommand('checkout', { path: '/r' })).to.equal(undefined);
      expect(synthesizeGitCommand('merge', { path: '/r' })).to.equal(undefined);
      expect(synthesizeGitCommand('reset', { path: '/r', targetRef: 'HEAD' })).to.equal(
        undefined,
      );
      expect(synthesizeGitCommand('cherry_pick', {})).to.equal(undefined);
    });

    it('tolerates missing or malformed args without throwing', () => {
      expect(synthesizeGitCommand('create_commit', undefined)).to.equal('git commit');
      expect(synthesizeGitCommand('create_commit', 'not an object')).to.equal('git commit');
      expect(synthesizeGitCommand('stage_files', { paths: 'nope' })).to.equal('git add -A');
      expect(synthesizeGitCommand('stage_files', { paths: ['a.ts', 7, null] })).to.equal(
        'git add -- a.ts',
      );
    });
  });

  describe('synthesizeGitCommand — secrets', () => {
    // The IPC layer deliberately logs no arguments, because arguments can carry
    // credentials. Synthesis only reads fields it explicitly names, so a token
    // is never even read — these tests pin that.
    it('never renders a token argument', () => {
      const line = synthesizeGitCommand('push', {
        path: '/r',
        remote: 'origin',
        branch: 'main',
        token: 'ghp_0123456789abcdefghij',
      });
      expect(line).to.equal('git push origin main');
      expect(line).to.not.contain('ghp_');
    });

    it('never renders a token on fetch or pull', () => {
      expect(
        synthesizeGitCommand('fetch', { path: '/r', remote: 'origin', token: 'secret-token' }),
      ).to.equal('git fetch origin');
      expect(
        synthesizeGitCommand('pull', { path: '/r', remote: 'origin', token: 'secret-token' }),
      ).to.equal('git pull origin');
    });

    it('redacts a credentialed remote URL that reaches a rendered field', () => {
      // A remote can be named by URL rather than by name.
      const line = synthesizeGitCommand('push', {
        path: '/r',
        remote: 'https://someone:ghp_0123456789abcdefghij@github.com/o/r.git',
        branch: 'main',
      });
      expect(line).to.not.contain('ghp_');
      expect(line).to.not.contain('someone:');
      expect(line).to.contain('github.com/o/r.git');
    });

    it('redacts a token pasted into a commit message', () => {
      const line = synthesizeGitCommand('create_commit', {
        path: '/r',
        message: 'rotate key glpat-abcdefghij0123456789',
      });
      expect(line).to.not.contain('glpat-');
      expect(line).to.contain('***');
    });
  });


  // The Output panel matches a REAL backend invocation against the IPC
  // operation that caused it partly by subcommand, so a background fetch never
  // swallows a commit's row. Misreading a line here would only ever make that
  // match fail, but it must not misread the shapes the backend actually emits.
  describe('gitSubcommand', () => {
    it('reads the subcommand of a plain line', () => {
      expect(gitSubcommand('git commit -m "fix parser" -S')).to.equal('commit');
      expect(gitSubcommand('git stash push --include-untracked')).to.equal('stash');
    });

    it('skips global options and their values', () => {
      // The backend's push shells out with `-C <path>`, not a working directory.
      expect(gitSubcommand('git -C /repo push --force-with-lease origin main')).to.equal(
        'push',
      );
      expect(gitSubcommand('git -c core.hooksPath=/dev/null commit --amend')).to.equal(
        'commit',
      );
      expect(gitSubcommand('git --git-dir /r/.git --no-pager log')).to.equal('log');
    });

    it('tolerates a fully qualified program path', () => {
      expect(gitSubcommand('/usr/bin/git rebase --continue')).to.equal('rebase');
    });

    it('keeps a quoted repository path with spaces as ONE argument', () => {
      // `quote_arg` in src-tauri/src/utils/command.rs quotes any argument
      // containing whitespace, so the CLI push renders `-C "…"`. Splitting the
      // line on whitespace would make the two-slot `-C` skip land inside the
      // path and the panel would show two rows for one push.
      expect(
        gitSubcommand(
          'git -C "/Users/me/My Repos/lev" push --force-with-lease origin main',
        ),
      ).to.equal('push');
      expect(
        gitSubcommand('git -C "/Users/me/My Repos/lev" push --tags origin'),
      ).to.equal('push');
      expect(
        gitSubcommand('git --git-dir "/My Repos/lev/.git" --no-pager log'),
      ).to.equal('log');
    });

    it('unescapes the quoting the renderers emit', () => {
      // Inside the quotes it adds, `quote_arg` escapes a backslash as `\\` and
      // a quote as `\"`, so these are the lines the backend really emits for a
      // Windows path and for a path containing a quote. String.raw keeps those
      // escapes literal here — neither may end the argument early.
      expect(
        gitSubcommand(String.raw`git -C "C:\\My Repos\\lev" push origin main`),
      ).to.equal('push');
      expect(
        gitSubcommand(
          String.raw`git -C "/tmp/od\"d \\ repo" push --force-with-lease origin`,
        ),
      ).to.equal('push');
      // A fully qualified program path that had to be quoted is still `git`:
      // the escapes must resolve back to real separators, or the path stops
      // looking like git and gets read as the subcommand instead.
      expect(
        gitSubcommand(
          String.raw`"C:\\Program Files\\Git\\bin\\git.exe" rebase --continue`,
        ),
      ).to.equal('rebase');
    });

    it('does not mistake a quoted commit message for a subcommand', () => {
      // The message is an option VALUE, so the scan never reaches it — but if
      // quoting were ignored, `push` inside it could be read as the subcommand.
      expect(gitSubcommand('git commit -m "push the button" -S')).to.equal('commit');
    });

    it('is undefined when there is no line or no subcommand', () => {
      expect(gitSubcommand(undefined)).to.equal(undefined);
      expect(gitSubcommand('')).to.equal(undefined);
      expect(gitSubcommand('git --version')).to.equal(undefined);
    });
  });

  describe('claimableSubcommands', () => {
    it("is the line's own subcommand for a builder whose backend runs the same one", () => {
      expect(claimableSubcommands('create_commit', 'git commit -m x')).to.deep.equal([
        'commit',
      ]);
      expect(claimableSubcommands('push', 'git push origin main')).to.deep.equal(['push']);
      expect(claimableSubcommands('create_tag', 'git tag -a -m m v1')).to.deep.equal(['tag']);
    });

    it('adds commit for merge, which signs its merge commit through git commit -S', () => {
      expect(claimableSubcommands('merge', 'git merge feature')).to.deep.equal([
        'merge',
        'commit',
      ]);
    });

    it('stays unknown when the line names no subcommand', () => {
      // Unknown keeps the caller permissive; a declared extra must not turn an
      // operation with no line into one that accepts only that extra.
      expect(claimableSubcommands('merge', undefined)).to.equal(undefined);
      expect(claimableSubcommands('clone_repository', undefined)).to.equal(undefined);
    });

    it('always keeps the builder\'s own subcommand claimable', () => {
      for (const command of SYNTHESIZED_COMMANDS) {
        const line = synthesizeGitCommand(command, {
          message: 'm',
          paths: ['a'],
          refName: 'x',
          name: 'n',
          oldName: 'o',
          newName: 'p',
          sourceRef: 's',
          onto: 'o',
          targetRef: 't',
          mode: 'hard',
          commitOid: 'abc',
        });
        const own = gitSubcommand(line);
        if (own === undefined) continue;
        expect(claimableSubcommands(command, line), command).to.include(own);
      }
    });
  });

  describe('redactSecrets', () => {
    it('strips credentials from remote URLs but keeps the host', () => {
      expect(redactSecrets('https://user:ghp_0123456789abcdefghij@github.com/o/r.git')).to.equal(
        'https://***@github.com/o/r.git',
      );
      expect(redactSecrets('ssh://git@github.com/o/r.git')).to.equal(
        'ssh://***@github.com/o/r.git',
      );
      expect(
        redactSecrets('remote: rejected https://x-access-token:v1.abc@gitlab.example.com/g/r'),
      ).to.contain('gitlab.example.com');
    });

    it('leaves a URL with no credentials readable', () => {
      expect(redactSecrets('git fetch https://github.com/owner/repo.git')).to.equal(
        'git fetch https://github.com/owner/repo.git',
      );
    });

    it('leaves an email address in a commit message alone', () => {
      expect(redactSecrets('git commit -m "fix login for user@example.com"')).to.equal(
        'git commit -m "fix login for user@example.com"',
      );
    });

    it('strips bare provider tokens wherever they appear', () => {
      for (const secret of [
        'ghp_0123456789abcdefghij',
        'gho_0123456789abcdefghij',
        'github_pat_11ABCDEFG0abcdefghijklmnop',
        'glpat-abcdefghij0123456789',
        'xoxb-1234567890-abcdefghij',
        'sk-abcdefghijklmnopqrstuvwx',
        'AKIAIOSFODNN7EXAMPLE',
      ]) {
        const redacted = redactSecrets(`failed with ${secret} here`);
        expect(redacted, secret).to.not.contain(secret);
        expect(redacted, secret).to.contain('***');
      }
    });

    it('strips JWTs', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
      expect(redactSecrets(`bearer ${jwt}`)).to.not.contain(jwt);
    });

    it('strips anything explicitly named as a secret', () => {
      expect(redactSecrets('--password=hunter2')).to.not.contain('hunter2');
      expect(redactSecrets('Authorization: Bearer abc123def')).to.not.contain('abc123def');
      expect(redactSecrets('api_key=abcd1234')).to.not.contain('abcd1234');
      expect(redactSecrets('token: s3cr3tvalue')).to.not.contain('s3cr3tvalue');
      expect(redactSecrets('access-token abcd1234efgh')).to.not.contain('abcd1234efgh');
    });

    it('is a no-op on ordinary git output', () => {
      const output = 'To github.com:o/r.git\n   abc1234..def5678  main -> main';
      expect(redactSecrets(output)).to.equal(output);
    });
  });
});
