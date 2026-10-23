/**
 * Tests for gn-search-dialog — the UI half of the repository content search.
 *
 * `search_in_files`, `search_in_diff` and `search_commits_by_content` shipped
 * with typed wrappers and a Rust test suite but no caller anywhere in the app.
 * These tests pin the three modes to the three commands, pin the option
 * checkboxes to the camelCase args they must produce, and pin every result row
 * to the navigation event that makes it more than a printed line.
 *
 * The dialog's `repositoryPath` is live-bound to the ACTIVE repository, and
 * repo switching is a document-level shortcut that fires straight through the
 * overlay — so a mid-search switch must drop both the rows and any response
 * still in flight, or a click navigates repo B using a hit found in repo A.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeCalls: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import { render } from 'lit';
import { resetOverlayStack, pushOverlay, removeOverlay } from '../../../utils/overlay-stack.ts';
import { deepActiveElement } from '../../../utils/focus.ts';
import '../gn-search-dialog.ts';

const REPO_A = '/repo/a';
const REPO_B = '/repo/b';

type Dialog = HTMLElement & {
  updateComplete: Promise<unknown>;
  repositoryPath: string;
  mode: 'files' | 'diff' | 'commits';
  open: boolean;
  pinnedRepositoryPathIfOpen: string | null;
  close: () => void;
};

function fileHit(filePath = 'src/a.ts') {
  return {
    filePath,
    matchCount: 1,
    matches: [
      {
        filePath,
        lineNumber: 12,
        lineContent: 'const token = 1;',
        matchStart: 6,
        matchEnd: 11,
      },
    ],
  };
}

function diffHit(filePath = 'src/a.ts') {
  return {
    filePath,
    lineNumber: 7,
    lineContent: '+const token = 2;',
    matchStart: 7,
    matchEnd: 12,
  };
}

function commitHit(oid: string) {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    message: 'Introduce the token',
    authorName: 'Ada',
    authorDate: 1700000000,
    matches: [{ filePath: 'src/a.ts', lineNumber: null, lineContent: null }],
  };
}

async function settle(el: Dialog): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function openOn(path = REPO_A, mode: Dialog['mode'] = 'files'): Promise<Dialog> {
  const el = await fixture<Dialog>(
    html`<gn-search-dialog
      .repositoryPath=${path}
      .mode=${mode}
      .open=${true}
    ></gn-search-dialog>`
  );
  await settle(el);
  return el;
}

function q<T extends Element>(el: Dialog, sel: string): T | null {
  return el.shadowRoot!.querySelector<T>(sel);
}

function rows(el: Dialog): HTMLButtonElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.result-item')];
}

async function type(el: Dialog, value: string): Promise<void> {
  const input = q<HTMLInputElement>(el, '.query-input')!;
  input.value = value;
  input.dispatchEvent(new InputEvent('input'));
  await el.updateComplete;
}

async function search(el: Dialog): Promise<void> {
  q<HTMLButtonElement>(el, '.search-btn')!.click();
  await settle(el);
}

function setMode(el: Dialog, label: string): void {
  const btn = [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.mode-btn')].find(
    (b) => b.textContent?.trim() === label
  );
  expect(btn, `"${label}" mode button present`).to.not.be.undefined;
  btn!.click();
}

function argsFor(command: string): Record<string, unknown> | undefined {
  return invokeCalls.find((c) => c.command === command)?.args as
    | Record<string, unknown>
    | undefined;
}

describe('gn-search-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    resetOverlayStack();
    mockInvoke = () => Promise.resolve(null);
  });

  it('files mode searches the pinned repo and renders grouped matches', async () => {
    mockInvoke = (command) =>
      command === 'search_in_files' ? Promise.resolve([fileHit()]) : Promise.resolve(null);

    const el = await openOn();
    await type(el, 'token');
    await search(el);

    expect(argsFor('search_in_files')?.path, 'searched the pinned repo').to.equal(REPO_A);
    expect(q(el, '.result-file')!.textContent).to.contain('src/a.ts');
    const row = rows(el)[0];
    expect(row, 'a result row rendered').to.not.be.undefined;
    expect(row.textContent).to.contain(':12');
    expect(row.textContent).to.contain('const token = 1;');
    expect(row.querySelector('.result-match')!.textContent, 'match highlighted').to.equal('token');
  });

  it('files options reach the backend as camelCase', async () => {
    mockInvoke = () => Promise.resolve([]);
    const el = await openOn();
    await type(el, 'token');

    q<HTMLInputElement>(el, '.opt-case')!.click();
    q<HTMLInputElement>(el, '.opt-regex')!.click();
    const pattern = q<HTMLInputElement>(el, '.pattern-input')!;
    pattern.value = '*.ts';
    pattern.dispatchEvent(new InputEvent('input'));
    await el.updateComplete;

    await search(el);

    expect(argsFor('search_in_files')).to.deep.equal({
      path: REPO_A,
      query: 'token',
      caseSensitive: true,
      regex: true,
      filePattern: '*.ts',
      maxResults: 500,
    });
  });

  it('a failed search shows an inline error and no rows', async () => {
    mockInvoke = () => Promise.reject({ message: 'fatal: bad regex' });
    const el = await openOn();
    await type(el, 'token');
    await search(el);

    expect(q(el, '.error')!.textContent).to.contain('fatal: bad regex');
    expect(rows(el).length, 'no rows behind the error').to.equal(0);
    expect(el.open, 'the dialog stays open so the inline error is readable').to.be.true;
  });

  it('no matches renders the empty state', async () => {
    mockInvoke = () => Promise.resolve([]);
    const el = await openOn();
    await type(el, 'nothing-here');
    await search(el);

    expect(q(el, '.empty')!.textContent).to.contain('No matches found');
    expect(rows(el).length).to.equal(0);
  });

  it('a blank query never invokes a search', async () => {
    const el = await openOn();
    await type(el, '   ');

    expect(q<HTMLButtonElement>(el, '.search-btn')!.disabled, 'Search disabled').to.be.true;
    q<HTMLInputElement>(el, '.query-input')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' })
    );
    await settle(el);

    expect(invokeCalls.length, 'no command invoked').to.equal(0);
  });

  it('clicking a file match asks for blame and closes', async () => {
    mockInvoke = () => Promise.resolve([fileHit()]);
    const el = await openOn();
    await type(el, 'token');
    await search(el);

    const seen: Array<{ filePath: string }> = [];
    el.addEventListener('show-blame', (e) => {
      seen.push((e as CustomEvent<{ filePath: string }>).detail);
    });
    rows(el)[0].click();
    await el.updateComplete;

    expect(seen).to.deep.equal([{ filePath: 'src/a.ts' }]);
    expect(el.open, 'dialog closed behind the navigation').to.be.false;
  });

  it('diff mode searches the staged diff and opens that file diff', async () => {
    mockInvoke = (command) =>
      command === 'search_in_diff' ? Promise.resolve([diffHit()]) : Promise.resolve(null);

    const el = await openOn();
    setMode(el, 'Diff');
    await el.updateComplete;
    q<HTMLInputElement>(el, '.opt-staged')!.click();
    await type(el, 'token');
    await search(el);

    expect(argsFor('search_in_diff')).to.deep.equal({
      path: REPO_A,
      query: 'token',
      staged: true,
    });

    const seen: Array<{ filePath: string; staged: boolean }> = [];
    el.addEventListener('show-working-diff', (e) => {
      seen.push((e as CustomEvent<{ filePath: string; staged: boolean }>).detail);
    });
    rows(el)[0].click();
    await el.updateComplete;

    expect(seen).to.deep.equal([{ filePath: 'src/a.ts', staged: true }]);
    expect(el.open).to.be.false;
  });

  it('commits mode uses the pickaxe command and reveals the commit', async () => {
    mockInvoke = (command) =>
      command === 'search_commits_by_content'
        ? Promise.resolve([commitHit('abc123def456')])
        : Promise.resolve(null);

    const el = await openOn();
    setMode(el, 'Commits');
    await el.updateComplete;
    q<HTMLInputElement>(el, '.opt-regex')!.click();
    q<HTMLInputElement>(el, '.opt-ignore-case')!.click();
    await type(el, 'token');
    await search(el);

    // Asserting the command NAME pins this to searchCommitsByContent, not the
    // legacy searchInCommits wrapper.
    expect(argsFor('search_commits_by_content')).to.deep.equal({
      path: REPO_A,
      searchText: 'token',
      regex: true,
      ignoreCase: true,
      maxCount: 100,
    });

    const seen: Array<{ oid: string }> = [];
    el.addEventListener('show-commit', (e) => {
      seen.push((e as CustomEvent<{ oid: string }>).detail);
    });
    rows(el)[0].click();
    await el.updateComplete;

    expect(seen).to.deep.equal([{ oid: 'abc123def456' }]);
    expect(el.open).to.be.false;
  });

  it('a capped result set says so, an uncapped one does not', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => commitHit(`${i}`.padStart(12, '0')));

    mockInvoke = () => Promise.resolve(many(100));
    const el = await openOn();
    setMode(el, 'Commits');
    await el.updateComplete;
    await type(el, 'token');
    await search(el);
    expect(q(el, '.result-summary')!.textContent).to.contain('showing the first 100');

    mockInvoke = () => Promise.resolve(many(99));
    await search(el);
    expect(q(el, '.result-summary')!.textContent).to.not.contain('showing the first');
  });

  it('switching repositories drops the previous repo results', async () => {
    mockInvoke = () => Promise.resolve([fileHit()]);
    const el = await openOn();
    await type(el, 'token');
    await search(el);
    expect(rows(el).length, 'repo A rows shown').to.equal(1);

    el.repositoryPath = REPO_B;
    await settle(el);

    expect(rows(el).length, 'repo A rows dropped').to.equal(0);
    expect(q(el, '.notice')!.textContent).to.contain('Repository changed');
    expect(el.pinnedRepositoryPathIfOpen, 're-pinned').to.equal(REPO_B);

    invokeCalls.length = 0;
    await search(el);
    expect(argsFor('search_in_files')?.path, 'next search targets repo B').to.equal(REPO_B);
  });

  it('a response that lands after the repo switch is discarded', async () => {
    let release: (value: unknown) => void = () => {};
    mockInvoke = () => new Promise((resolve) => { release = resolve; });

    const el = await openOn();
    await type(el, 'token');
    q<HTMLButtonElement>(el, '.search-btn')!.click();
    await el.updateComplete;

    el.repositoryPath = REPO_B;
    await settle(el);

    release([fileHit()]);
    await settle(el);

    expect(rows(el).length, 'stale repo A response discarded').to.equal(0);
  });

  it('exposes the sweep contract and owns Escape only on top', async () => {
    mockInvoke = () => Promise.resolve([]);
    const el = await openOn();

    expect(el.pinnedRepositoryPathIfOpen).to.equal(REPO_A);

    const other = {};
    pushOverlay(other);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await el.updateComplete;
    expect(el.open, 'a dialog below the top overlay ignores Escape').to.be.true;

    removeOverlay(other);
    pushOverlay(el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await el.updateComplete;
    expect(el.open, 'the top overlay closes on Escape').to.be.false;
    expect(el.pinnedRepositoryPathIfOpen, 'closed dialogs are not swept').to.be.null;
  });

  it('switching mode discards a search still in flight', async () => {
    let release: (value: unknown) => void = () => {};
    mockInvoke = () => new Promise((resolve) => { release = resolve; });

    const el = await openOn();
    await type(el, 'token');
    q<HTMLButtonElement>(el, '.search-btn')!.click();
    await el.updateComplete;

    setMode(el, 'Diff');
    await settle(el);

    release([fileHit()]);
    await settle(el);

    expect(
      !!q(el, '.empty'),
      'no "No matches found" for a search diff mode never ran'
    ).to.be.false;
    expect(rows(el).length, 'the files response does not paint under diff mode').to.equal(0);
    expect(q(el, '.status')?.textContent ?? '', 'back to the prompt').to.contain('Enter a search');
  });

  it('reports a mode the user changed so reopening lands on the parent mode', async () => {
    mockInvoke = () => Promise.resolve([]);

    // Mirrors app-shell: the parent owns the mode and pushes it through a
    // dirty-checked `.mode` binding, so an unreported internal change would
    // make the next open a no-op and leave the dialog on the wrong mode.
    const host = document.createElement('div');
    document.body.appendChild(host);
    let parentMode: Dialog['mode'] = 'files';
    let open = true;
    const paint = () =>
      render(
        html`<gn-search-dialog
          .repositoryPath=${REPO_A}
          .mode=${parentMode}
          .open=${open}
          @mode-changed=${(e: Event) => {
            parentMode = (e as CustomEvent<{ mode: Dialog['mode'] }>).detail.mode;
          }}
        ></gn-search-dialog>`,
        host
      );

    paint();
    const el = host.querySelector('gn-search-dialog') as Dialog;
    await settle(el);

    setMode(el, 'Commits');
    await settle(el);
    expect(parentMode, 'the parent is told which mode the dialog moved to').to.equal('commits');

    open = false;
    paint();
    await settle(el);

    // Reopened by the "search in files" palette entry.
    parentMode = 'files';
    open = true;
    paint();
    await settle(el);

    expect(el.mode, 'reopened in the mode the parent asked for').to.equal('files');
    host.remove();
  });

  it('highlights a match reported at a UTF-8 byte offset', async () => {
    // 'héllo ' is 7 UTF-8 bytes but 6 UTF-16 code units, so slicing the string
    // with the backend's byte offsets would highlight 'ken' instead of 'token'.
    mockInvoke = () =>
      Promise.resolve([
        {
          filePath: 'src/a.ts',
          matchCount: 1,
          matches: [
            {
              filePath: 'src/a.ts',
              lineNumber: 3,
              lineContent: 'héllo token',
              matchStart: 7,
              matchEnd: 12,
            },
          ],
        },
      ]);

    const el = await openOn();
    await type(el, 'token');
    await search(el);

    const row = rows(el)[0];
    expect(row.querySelector('.result-match')!.textContent, 'highlight lands on the match').to.equal(
      'token'
    );
    expect(row.textContent, 'the line still reads whole').to.contain('héllo token');
  });

  it('a diff row opens the side its match was found on', async () => {
    mockInvoke = (command) =>
      command === 'search_in_diff' ? Promise.resolve([diffHit()]) : Promise.resolve(null);

    const el = await openOn();
    setMode(el, 'Diff');
    await el.updateComplete;
    q<HTMLInputElement>(el, '.opt-staged')!.click();
    await type(el, 'token');
    await search(el);

    // Flipping the radio afterwards must not re-aim rows already on screen:
    // they came out of the staged diff.
    q<HTMLInputElement>(el, '.opt-unstaged')!.click();
    await el.updateComplete;

    const seen: Array<{ filePath: string; staged: boolean }> = [];
    el.addEventListener('show-working-diff', (e) => {
      seen.push((e as CustomEvent<{ filePath: string; staged: boolean }>).detail);
    });
    rows(el)[0].click();
    await el.updateComplete;

    expect(seen).to.deep.equal([{ filePath: 'src/a.ts', staged: true }]);
  });

  it('moves focus into the query input when it opens', async () => {
    mockInvoke = () => Promise.resolve([]);
    const el = await openOn();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(deepActiveElement()).to.equal(q(el, '.query-input'));
  });
});
