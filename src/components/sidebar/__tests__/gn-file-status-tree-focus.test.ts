/**
 * gn-file-status tree view: the row numbering the DOM carries must match the
 * numbering the keyboard uses.
 *
 * Rendered rows got their `data-index` from a counter that walked EVERY file in
 * a subtree, collapsed folders included, while the keyboard model
 * (getAllVisibleFiles) only counts files under expanded folders. Collapse one
 * folder and the two numberings drift apart: the `.focused` highlight lands on
 * the wrong row or on no row at all, while Enter / s / u act on a file the user
 * never saw highlighted.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-file-status.ts';
import type { GnFileStatus } from '../gn-file-status.ts';
import type { StatusEntry } from '../../../types/git.types.ts';

const REPO_PATH = '/test/repo';

function entry(path: string, isStaged = false): StatusEntry {
  return { path, status: 'modified', isStaged, isConflicted: false };
}

/** Render the panel with `entries` as the repository status. */
async function renderWith(entries: StatusEntry[]): Promise<GnFileStatus> {
  mockInvoke = async (command: string) => {
    if (command === 'get_status') return entries;
    return null;
  };

  const el = await fixture<GnFileStatus>(html`
    <gn-file-status .repositoryPath=${REPO_PATH}></gn-file-status>
  `);
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

/** Click the flat/tree toggle (switching TO tree also expands every folder). */
async function clickViewToggle(el: GnFileStatus): Promise<void> {
  const toggle = el.shadowRoot!.querySelector('.view-toggle')!;
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await el.updateComplete;
}

/** Collapse the folder row whose name label is `name`. */
async function collapseFolder(el: GnFileStatus, name: string): Promise<void> {
  const folder = Array.from(el.shadowRoot!.querySelectorAll('.folder-item')).find(
    (item) => item.querySelector('.folder-name')!.textContent!.trim() === name,
  );
  expect(folder, `folder row "${name}" is rendered`).to.not.be.undefined;
  folder!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await el.updateComplete;
}

async function pressArrowDown(el: GnFileStatus): Promise<void> {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  );
  await el.updateComplete;
}

function rows(el: GnFileStatus): HTMLElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.file-item'));
}

function indices(el: GnFileStatus): (string | null)[] {
  return rows(el).map((r) => r.getAttribute('data-index'));
}

/**
 * Wrap the panel's tree builder with a counter. Returns a getter for the number
 * of buildFileTree calls made since wrapping.
 */
function countTreeBuilds(el: GnFileStatus): () => number {
  const host = el as unknown as {
    buildFileTree: (files: StatusEntry[]) => unknown;
  };
  const original = host.buildFileTree.bind(el);
  let calls = 0;
  host.buildFileTree = (files: StatusEntry[]) => {
    calls += 1;
    return original(files);
  };
  return () => calls;
}

/** Force one render pass without changing any state. */
async function rerender(el: GnFileStatus): Promise<void> {
  el.requestUpdate();
  await el.updateComplete;
}

describe('gn-file-status tree view row indices', () => {
  it('a collapsed folder does not inflate the row indices', async () => {
    const el = await renderWith([
      entry('src/a.ts'),
      entry('src/b.ts'),
      entry('docs/readme.md'),
    ]);
    await clickViewToggle(el);
    await collapseFolder(el, 'src');

    const rendered = rows(el);
    expect(rendered, 'only the file outside the collapsed folder renders').to.have.length(1);
    expect(rendered[0].getAttribute('title')).to.equal('docs/readme.md');
    expect(
      rendered[0].getAttribute('data-index'),
      'the first rendered row is row 0, not row 2',
    ).to.equal('0');
  });

  it('the highlighted row is the row the keyboard is on', async () => {
    const el = await renderWith([
      entry('src/a.ts'),
      entry('src/b.ts'),
      entry('docs/readme.md'),
    ]);
    await clickViewToggle(el);
    await collapseFolder(el, 'src');

    await pressArrowDown(el);

    const focused = el.shadowRoot!.querySelectorAll<HTMLElement>('.file-item.focused');
    expect(focused, 'exactly one row is highlighted').to.have.length(1);
    expect(
      focused[0].getAttribute('title'),
      'the highlight is on the file s/u/Enter would act on',
    ).to.equal('docs/readme.md');
  });

  it('the unstaged section starts after the VISIBLE staged rows', async () => {
    const el = await renderWith([
      entry('lib/x.ts', true),
      entry('lib/y.ts', true),
      entry('top.txt'),
    ]);
    await clickViewToggle(el);
    await collapseFolder(el, 'lib');

    await pressArrowDown(el);

    const rendered = rows(el);
    expect(rendered, 'the staged section renders no rows while lib is collapsed').to.have.length(1);
    expect(rendered[0].getAttribute('title')).to.equal('top.txt');
    expect(
      rendered[0].getAttribute('data-index'),
      'the unstaged offset counts visible staged rows (0), not stagedFiles.length (2)',
    ).to.equal('0');
    expect(rendered[0].classList.contains('focused'), 'and it is the highlighted row').to.be.true;
  });

  it('handles a collapsed folder nested inside an expanded one', async () => {
    const el = await renderWith([
      entry('src/deep/a.ts'),
      entry('src/deep/b.ts'),
      entry('src/top.ts'),
    ]);
    await clickViewToggle(el);
    await collapseFolder(el, 'deep');

    await pressArrowDown(el);

    const rendered = rows(el);
    expect(rendered, 'only src/top.ts renders').to.have.length(1);
    expect(rendered[0].getAttribute('title')).to.equal('src/top.ts');
    expect(
      rendered[0].getAttribute('data-index'),
      'the nested collapsed folder contributes 0 to the sibling offset',
    ).to.equal('0');
    expect(rendered[0].classList.contains('focused'), 'and it is the highlighted row').to.be.true;
  });

  // No-regression guard: with nothing collapsed the two numberings already
  // agreed, so this case passes both with and WITHOUT the fix — it is here to
  // prove the fix did not disturb the fully-expanded tree or flat view.
  it('numbers rows contiguously when every folder is expanded, and in flat view', async () => {
    const el = await renderWith([
      entry('src/a.ts'),
      entry('docs/readme.md'),
      entry('lib/x.ts', true),
    ]);

    await clickViewToggle(el);
    expect(
      rows(el).map((r) => r.getAttribute('title')),
      'staged rows come first in DOM order',
    ).to.deep.equal(['lib/x.ts', 'src/a.ts', 'docs/readme.md']);
    expect(indices(el), 'tree view numbers 0..n-1').to.deep.equal(['0', '1', '2']);

    // Back to flat view
    await clickViewToggle(el);
    expect(
      rows(el).map((r) => r.getAttribute('title')),
      'flat view keeps the same row order',
    ).to.deep.equal(['lib/x.ts', 'src/a.ts', 'docs/readme.md']);
    expect(indices(el), 'flat view numbers 0..n-1').to.deep.equal(['0', '1', '2']);
  });
});

describe('gn-file-status tree view render cost', () => {
  it('builds each section tree once per render', async () => {
    const el = await renderWith([
      entry('lib/x.ts', true),
      entry('lib/y.ts', true),
      entry('src/a.ts'),
    ]);
    await clickViewToggle(el);

    const builds = countTreeBuilds(el);
    await rerender(el);

    expect(
      builds(),
      'one buildFileTree per section — counting the staged rows reuses the tree the staged rows were rendered from',
    ).to.equal(2);
  });

  it('builds each section tree once per render with a folder collapsed', async () => {
    const el = await renderWith([
      entry('lib/x.ts', true),
      entry('lib/y.ts', true),
      entry('top.txt'),
    ]);
    await clickViewToggle(el);
    await collapseFolder(el, 'lib');

    const builds = countTreeBuilds(el);
    await rerender(el);

    expect(builds(), 'still one buildFileTree per section').to.equal(2);
    expect(
      rows(el).map((r) => r.getAttribute('data-index')),
      'and the reused tree still yields the visible-row offset',
    ).to.deep.equal(['0']);
  });

  // No-regression guard: flat view never built a tree and still must not — it
  // passes with and without the render-cost fix.
  it('builds no tree at all in flat view', async () => {
    const el = await renderWith([entry('lib/x.ts', true), entry('src/a.ts')]);

    const builds = countTreeBuilds(el);
    await rerender(el);

    expect(builds(), 'flat view renders straight from the file arrays').to.equal(0);
  });
});
