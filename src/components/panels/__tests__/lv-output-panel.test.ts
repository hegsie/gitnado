import { expect, fixture, html } from '@open-wc/testing';

import '../lv-output-panel.ts';
import type { LvOutputPanel } from '../lv-output-panel.ts';
import {
  logGitCommand,
  clearLogEntries,
} from '../../../services/output-log.service.ts';

describe('lv-output-panel', () => {
  beforeEach(() => {
    clearLogEntries();
  });

  it('shows the empty state with no entries', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    const empty = el.shadowRoot!.querySelector('.empty');
    expect(empty).to.exist;
    expect(empty!.textContent).to.contain('No output yet');
  });

  it('renders logged commands live, newest first, with status', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);

    logGitCommand('checkout', '', true);
    logGitCommand('push', 'authentication failed', false);
    await el.updateComplete;

    const commands = Array.from(
      el.shadowRoot!.querySelectorAll('.entry-command'),
    ).map((n) => n.textContent?.trim());
    expect(commands).to.deep.equal(['push', 'checkout']);
    expect(el.shadowRoot!.querySelector('.status-dot.failure')).to.exist;
    expect(el.shadowRoot!.querySelector('.status-dot.success')).to.exist;
  });

  it('expands a failed entry to show its output', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    logGitCommand('push', 'authentication failed', false);
    await el.updateComplete;

    (el.shadowRoot!.querySelector('.entry-header') as HTMLElement).click();
    await el.updateComplete;

    const output = el.shadowRoot!.querySelector('.entry-output');
    expect(output).to.exist;
    expect(output!.textContent).to.contain('authentication failed');
  });

  it('expansion stays on the same entry when new entries prepend', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    logGitCommand('push', 'authentication failed', false);
    await el.updateComplete;

    // Expand the failed entry
    (el.shadowRoot!.querySelector('.entry-header') as HTMLElement).click();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.entry-output')!.textContent).to.contain(
      'authentication failed',
    );

    // A new entry prepends, shifting positions — the expansion must stay
    // attached to the SAME entry, not slide to whatever is now first.
    logGitCommand('checkout', '', true);
    await el.updateComplete;

    const entries = Array.from(el.shadowRoot!.querySelectorAll('.entry'));
    expect(entries[0].querySelector('.entry-output'), 'new entry not expanded').to.not.exist;
    expect(entries[1].querySelector('.entry-output')!.textContent).to.contain(
      'authentication failed',
    );
  });

  it('Clear empties the list', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    logGitCommand('merge', '', true);
    await el.updateComplete;

    (el.shadowRoot!.querySelector('.clear-btn') as HTMLElement).click();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(0);
    expect(el.shadowRoot!.querySelector('.empty')).to.exist;
  });

  it('Clear on a scoped panel only clears its repo, keeping other repos', async () => {
    const el = await fixture<LvOutputPanel>(
      html`<lv-output-panel .repositoryPath=${'/repo/a'}></lv-output-panel>`,
    );

    logGitCommand('checkout', '', true, '/repo/a');
    logGitCommand('merge', '', true, '/repo/b');
    await el.updateComplete;

    (el.shadowRoot!.querySelector('.clear-btn') as HTMLElement).click();
    await el.updateComplete;

    // Repo A's own view is now empty...
    expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(0);

    // ...but repo B's history survives (visible when we switch to it).
    el.repositoryPath = '/repo/b';
    await el.updateComplete;
    const commandsB = Array.from(
      el.shadowRoot!.querySelectorAll('.entry-command'),
    ).map((n) => n.textContent?.trim());
    expect(commandsB).to.deep.equal(['merge']);
  });

  it('scopes entries to repositoryPath in multi-repo sessions', async () => {
    const el = await fixture<LvOutputPanel>(
      html`<lv-output-panel .repositoryPath=${'/repo/a'}></lv-output-panel>`,
    );

    logGitCommand('checkout', '', true, '/repo/a');
    logGitCommand('merge', '', true, '/repo/b');
    logGitCommand('store_github_token', '', true); // repo-independent
    await el.updateComplete;

    const commands = Array.from(
      el.shadowRoot!.querySelectorAll('.entry-command'),
    ).map((n) => n.textContent?.trim());
    // Other repos' entries are hidden; repo-independent entries stay visible
    expect(commands).to.deep.equal(['store_github_token', 'checkout']);

    // Switching the active repository re-scopes the list
    el.repositoryPath = '/repo/b';
    await el.updateComplete;
    const commandsB = Array.from(
      el.shadowRoot!.querySelectorAll('.entry-command'),
    ).map((n) => n.textContent?.trim());
    expect(commandsB).to.deep.equal(['store_github_token', 'merge']);
  });

  it('shows all entries when repositoryPath is unset', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    logGitCommand('checkout', '', true, '/repo/a');
    logGitCommand('merge', '', true, '/repo/b');
    await el.updateComplete;

    expect(el.shadowRoot!.querySelectorAll('.entry').length).to.equal(2);
  });

  it('renders no close button by default (injected/standalone usage)', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
    expect(el.shadowRoot!.querySelector('.close-btn')).to.not.exist;
  });

  it('closable renders a close button that dispatches a composed close event', async () => {
    const el = await fixture<LvOutputPanel>(html`<lv-output-panel closable></lv-output-panel>`);

    let closed = false;
    el.addEventListener('close', () => {
      closed = true;
    });

    const btn = el.shadowRoot!.querySelector('.close-btn') as HTMLElement;
    expect(btn).to.exist;
    btn.click();
    expect(closed).to.be.true;
  });

  describe('git command lines', () => {
    it('shows the git command line rather than the IPC name', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('create_commit', '', true, {
        gitCommand: 'git commit -m "fix the bug"',
        synthesized: true,
        durationMs: 42,
      });
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.entry-command')!.textContent!.trim()).to.equal(
        'git commit -m "fix the bug"',
      );
      // The IPC name stays visible so the entry is still traceable.
      expect(el.shadowRoot!.querySelector('.entry-ipc')!.textContent!.trim()).to.equal(
        'create_commit',
      );
    });

    it('marks a synthesised line and explains it in a legend', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('checkout', '', true, {
        gitCommand: 'git checkout main',
        synthesized: true,
      });
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.synth-mark')).to.exist;
      expect(el.shadowRoot!.querySelector('.entry-command.synthesized')).to.exist;
      const legend = el.shadowRoot!.querySelector('.legend');
      expect(legend, 'legend explains the marker').to.exist;
      expect(legend!.textContent).to.contain('libgit2');
    });

    it('does not mark — or explain away — a command that really ran', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('git rebase --continue', 'Successfully rebased.', true, {
        gitCommand: 'git rebase --continue',
        synthesized: false,
        durationMs: 180,
      });
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.synth-mark')).to.not.exist;
      expect(el.shadowRoot!.querySelector('.entry-ipc')).to.not.exist;
      expect(el.shadowRoot!.querySelector('.legend'), 'no libgit2 legend').to.not.exist;
    });

    it('falls back to the IPC name when there is no git line', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('start_auto_fetch', '', true);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.entry-command')!.textContent!.trim()).to.equal(
        'start_auto_fetch',
      );
      expect(el.shadowRoot!.querySelector('.synth-mark')).to.not.exist;
    });

    it('shows timing when it was measured, and nothing when it was not', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('a', '', true, { durationMs: 84 });
      logGitCommand('b', '', true, { durationMs: 1500 });
      logGitCommand('c', '', true, { durationMs: 65_000 });
      logGitCommand('d', '', true);
      await el.updateComplete;

      const durations = Array.from(
        el.shadowRoot!.querySelectorAll('.entry-duration'),
      ).map((n) => n.textContent!.trim());
      // Newest first: c, b, a — `d` has no duration and renders none.
      expect(durations).to.deep.equal(['1m 05s', '1.5s', '84ms']);
    });

    it('styles a failed command output distinctly from a successful one', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('push', 'error: failed to push some refs', false, {
        gitCommand: 'git push origin main',
        synthesized: false,
      });
      await el.updateComplete;

      (el.shadowRoot!.querySelector('.entry-header') as HTMLElement).click();
      await el.updateComplete;

      const output = el.shadowRoot!.querySelector('.entry-output');
      expect(output!.classList.contains('failure')).to.be.true;
      expect(output!.textContent).to.contain('error: failed to push some refs');
    });

    it('explains an expanded entry that captured no output', async () => {
      const el = await fixture<LvOutputPanel>(html`<lv-output-panel></lv-output-panel>`);
      logGitCommand('checkout', '', true, { gitCommand: 'git checkout main' });
      await el.updateComplete;

      (el.shadowRoot!.querySelector('.entry-header') as HTMLElement).click();
      await el.updateComplete;

      const output = el.shadowRoot!.querySelector('.entry-output.empty-output');
      expect(output, 'an expanded row is never an unexplained empty box').to.exist;
      expect(output!.textContent).to.contain('no output');
    });
  });
});
