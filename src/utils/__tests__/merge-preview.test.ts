/**
 * Tests for the shared merge-confirm prediction.
 *
 * A merge used to be confirmed with no warning that it would conflict — the
 * user found out only when the working tree was already conflicted. The
 * prediction has to be exact in every outcome the backend can report, and it
 * must never be the reason a merge cannot be started: when the preview fails,
 * the confirm is shown WITHOUT a prediction rather than blocked.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invokeHistory: Array<{ command: string; args?: unknown }> = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';
import type { MergePreview } from '../../services/git.service.ts';
import { formatMergePreview, mergePreviewSummary } from '../merge-preview.ts';

const REPO_PATH = '/test/repo';

function preview(overrides: Partial<MergePreview> = {}): MergePreview {
  return {
    outcome: 'normal',
    conflictCount: 0,
    conflictingFiles: [],
    unrelatedHistories: false,
    operationInProgress: null,
    ...overrides,
  };
}

describe('formatMergePreview', () => {
  it('says a fast-forward will fast-forward', () => {
    const text = formatMergePreview(preview({ outcome: 'fastForward' }), 'feature');
    expect(text).to.contain('fast-forward');
    expect(text).to.not.contain('will create a merge commit');
  });

  it('says a divergent, clean merge will create a merge commit', () => {
    const text = formatMergePreview(preview({ outcome: 'normal' }), 'feature');
    expect(text).to.contain('merge commit');
    expect(text).to.contain('No conflicts predicted');
  });

  it('says an already-merged branch would do nothing', () => {
    const text = formatMergePreview(preview({ outcome: 'upToDate' }), 'feature');
    expect(text).to.contain('Already up to date');
  });

  it('names the conflicting files and keeps the merge available', () => {
    const text = formatMergePreview(
      preview({
        outcome: 'normal',
        conflictCount: 2,
        conflictingFiles: ['src/a.ts', 'src/b.ts'],
      }),
      'feature',
    );

    expect(text).to.contain('2 files would conflict:');
    expect(text).to.contain('src/a.ts');
    expect(text).to.contain('src/b.ts');
    // Not a block — the user may be merging into the conflict deliberately.
    expect(text).to.contain('You can still merge');
  });

  it('uses the singular for exactly one conflicting file', () => {
    const text = formatMergePreview(
      preview({ outcome: 'normal', conflictCount: 1, conflictingFiles: ['src/a.ts'] }),
      'feature',
    );
    expect(text).to.contain('1 file would conflict:');
    expect(text).to.not.contain('1 files');
  });

  it('caps the listed paths and counts the rest', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
    const text = formatMergePreview(
      preview({ outcome: 'normal', conflictCount: 12, conflictingFiles: files }),
      'feature',
    );

    expect(text).to.contain('12 files would conflict:');
    expect(text).to.contain('src/file7.ts');
    expect(text).to.not.contain('src/file8.ts');
    expect(text).to.contain('…and 4 more');
  });

  it('counts the remainder from the exact count, not the truncated list', () => {
    // The backend caps `conflictingFiles` itself, so the list can be shorter
    // than the count; the remainder must still add up.
    const files = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
    const text = formatMergePreview(
      preview({ outcome: 'normal', conflictCount: 4000, conflictingFiles: files }),
      'feature',
    );
    expect(text).to.contain('…and 3992 more');
  });

  it('says an unborn branch will simply be set to the source', () => {
    const text = formatMergePreview(preview({ outcome: 'unborn' }), 'feature');
    expect(text).to.contain('no commits yet');
    expect(text).to.contain('"feature"');
    expect(text).to.not.contain('fast-forward');
  });

  it('warns about unrelated histories', () => {
    const text = formatMergePreview(preview({ unrelatedHistories: true }), 'feature');
    expect(text).to.contain('no common history');
  });

  it('warns that an operation already in progress will refuse the merge', () => {
    const text = formatMergePreview(preview({ operationInProgress: 'Merge' }), 'feature');
    expect(text).to.contain('merge is already in progress');
    expect(text).to.contain('refused');
  });

  it('starts with a blank line so it appends cleanly to a confirm', () => {
    expect(formatMergePreview(preview({ outcome: 'fastForward' }), 'feature')).to.match(/^\n\n/);
  });

  it('says nothing about an outcome it does not recognise', () => {
    const unknown = { ...preview(), outcome: 'somethingNew' } as unknown as MergePreview;
    expect(formatMergePreview(unknown, 'feature')).to.equal('');
  });
});

describe('mergePreviewSummary', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    mockInvoke = async () => null;
  });

  it('passes the source ref and no target when merging into HEAD', async () => {
    mockInvoke = async () => preview({ outcome: 'fastForward' });

    const text = await mergePreviewSummary(REPO_PATH, 'origin/feature');

    const calls = invokeHistory.filter((c) => c.command === 'preview_merge');
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].args).to.deep.equal({
      path: REPO_PATH,
      sourceRef: 'origin/feature',
      intoRef: undefined,
    });
    expect(text).to.contain('fast-forward');
  });

  it('passes the target branch when the merge lands somewhere other than HEAD', async () => {
    mockInvoke = async () => preview();

    await mergePreviewSummary(REPO_PATH, 'feature', 'develop');

    const calls = invokeHistory.filter((c) => c.command === 'preview_merge');
    expect((calls[0].args as { intoRef?: string }).intoRef).to.equal('develop');
  });

  it('falls back to no prediction when the preview command fails', async () => {
    mockInvoke = async () => {
      throw new Error('preview_merge exploded');
    };

    expect(await mergePreviewSummary(REPO_PATH, 'feature')).to.equal('');
  });

  it('falls back to no prediction when the backend returns nothing', async () => {
    mockInvoke = async () => undefined;

    expect(await mergePreviewSummary(REPO_PATH, 'feature')).to.equal('');
  });
});
