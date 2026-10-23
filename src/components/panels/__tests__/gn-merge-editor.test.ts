/**
 * Tests for gn-merge-editor component
 *
 * Tests the structured no-markers merge editor: segment parsing, per-block
 * resolution (ours/theirs/both/edit/reset), whole-file strategies, pane
 * alignment, AI resolution, mark-resolved gating, and the invariant that raw
 * conflict markers never appear in the rendered UI.
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
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-merge-editor.ts';
import type { GnMergeEditor } from '../gn-merge-editor.ts';
import type { ConflictFile } from '../../../types/git.types.ts';
import { uiStore } from '../../../stores/ui.store.ts';

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

const MARKER_CHARS = ['<<<<<<<', '=======', '>>>>>>>', '|||||||'];

const DEFAULT_WORKDIR_CONTENT =
  'line1\n<<<<<<< HEAD\nline2-ours\n=======\nline2-theirs\n>>>>>>> feature\nline3';

function makeConflictFile(path: string, markerSize?: number): ConflictFile {
  return {
    path,
    ancestor: { oid: 'base-oid', path, mode: 0o100644 },
    ours: { oid: 'ours-oid', path, mode: 0o100644 },
    theirs: { oid: 'theirs-oid', path, mode: 0o100644 },
    isBinary: false,
    ...(markerSize !== undefined ? { markerSize } : {}),
  };
}

interface OutputSegmentShape {
  id: number;
  type: 'resolved' | 'conflict';
  lines: string[];
  oursLines: string[];
  theirsLines: string[];
  oursLabel: string;
  theirsLabel: string;
  origin: string | null;
  fromConflict: boolean;
}

interface EditorInternal {
  conflictFile: ConflictFile | null;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  segments: OutputSegmentShape[];
  loading: boolean;
  loadFailed: boolean;
  aiAvailable: boolean;
  parseSegments: (text: string) => OutputSegmentShape[];
  loadContents: () => Promise<void>;
  handleMarkResolved: () => Promise<void>;
  handleAiResolveAll: () => Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────
let workdirContent: string | (() => Promise<unknown>) = DEFAULT_WORKDIR_CONTENT;
let aiAvailable = false;
let aiUnavailable: { reason: string; providerSelected: boolean } | null = null;
let aiSuggestion: (() => Promise<unknown>) | null = null;

function isConfirmCommand(command: string): boolean {
  return command === 'plugin:dialog|message' || command === 'plugin:dialog|confirm';
}

function setupDefaultMocks(): void {
  workdirContent = DEFAULT_WORKDIR_CONTENT;
  aiAvailable = false;
  aiUnavailable = null;
  aiSuggestion = null;
  mockInvoke = async (command: string, args?: unknown) => {
    switch (command) {
      case 'get_blob_content': {
        const blobArgs = args as { oid: string };
        if (blobArgs?.oid === 'base-oid') return 'line1\nline2\nline3';
        if (blobArgs?.oid === 'ours-oid') return 'line1\nline2-ours\nline3';
        if (blobArgs?.oid === 'theirs-oid') return 'line1\nline2-theirs\nline3';
        return '';
      }
      case 'read_file_content':
        if (typeof workdirContent === 'function') return workdirContent();
        return workdirContent;
      case 'get_merge_tool_config':
        return null;
      case 'is_ai_available':
        return aiAvailable;
      case 'ai_unavailable_reason':
        return aiUnavailable;
      case 'suggest_conflict_resolution':
        if (aiSuggestion) return aiSuggestion();
        return { resolvedContent: 'ai-resolved', explanation: 'merged by ai' };
      case 'resolve_conflict':
        return { success: true };
      case 'get_conflicts':
        // Binary/submodule loads re-check the index to detect an
        // already-resolved re-selection. By default the loaded file IS
        // still conflicted (first load), so echo back the standard paths;
        // re-selection tests override this to [] to exercise the terminal
        // state.
        return [
          { path: 'src/test.ts' },
          { path: 'image.png' },
          { path: 'link' },
          { path: 'thing' },
          { path: 'sub' },
        ];
      default:
        return null;
    }
  };
}

async function renderEditor(): Promise<GnMergeEditor> {
  const el = await fixture<GnMergeEditor>(html`
    <gn-merge-editor
      .repositoryPath=${REPO_PATH}
    ></gn-merge-editor>
  `);
  return el;
}

/** Render the editor and load a conflict file through the real load path. */
async function renderLoadedEditor(path = 'src/test.ts'): Promise<GnMergeEditor> {
  const el = await renderEditor();
  const internal = el as unknown as EditorInternal;
  internal.conflictFile = makeConflictFile(path);
  await el.updateComplete;
  // loadContents runs from updated(); poll until it settles (the first load
  // also initializes the syntax highlighter, which can take a while).
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
  }
  await el.updateComplete;
  return el;
}

function internalOf(el: GnMergeEditor): EditorInternal {
  return el as unknown as EditorInternal;
}

function shadowText(el: GnMergeEditor): string {
  return el.shadowRoot!.textContent ?? '';
}

function expectNoMarkers(el: GnMergeEditor): void {
  const text = shadowText(el);
  for (const marker of MARKER_CHARS) {
    expect(text, `UI must never contain "${marker}"`).to.not.include(marker);
  }
}

function findConflictButton(el: GnMergeEditor, label: string): HTMLButtonElement {
  const block = el.shadowRoot!.querySelector('.code-conflict-block');
  expect(block, 'conflict block rendered').to.not.be.null;
  const btn = Array.from(block!.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  expect(btn, `conflict button "${label}"`).to.not.be.undefined;
  return btn as HTMLButtonElement;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-merge-editor', () => {
  beforeEach(() => {
    invokeHistory.length = 0;
    setupDefaultMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders without errors', async () => {
      const el = await renderEditor();
      expect(el).to.exist;
      expect(el.tagName.toLowerCase()).to.equal('gn-merge-editor');
    });

    it('renders empty state without conflict file', async () => {
      const el = await renderEditor();
      const empty = el.shadowRoot!.querySelector('.empty');
      expect(empty).to.exist;
      expect(empty!.textContent).to.include('Select a file');
    });

    it('renders toolbar and panes when a conflict file loads', async () => {
      const el = await renderLoadedEditor();
      expect(el.shadowRoot!.querySelector('.toolbar')).to.exist;
      expect(el.shadowRoot!.querySelector('#panel-ours')).to.exist;
      expect(el.shadowRoot!.querySelector('#panel-base')).to.exist;
      expect(el.shadowRoot!.querySelector('#panel-theirs')).to.exist;
      expect(el.shadowRoot!.querySelector('#panel-output')).to.exist;
    });

    it('never renders raw conflict markers even though the file has them', async () => {
      const el = await renderLoadedEditor();
      expect(internalOf(el).segments.some((s) => s.type === 'conflict')).to.be.true;
      expectNoMarkers(el);
    });

    it('shows the remaining conflict count', async () => {
      const el = await renderLoadedEditor();
      expect(shadowText(el)).to.include('1 conflict remaining');
    });
  });

  // ── parseSegments ────────────────────────────────────────────────────
  describe('parseSegments', () => {
    it('parses content without conflicts as a single resolved segment', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments('line1\nline2\nline3');
      expect(segments.length).to.equal(1);
      expect(segments[0].type).to.equal('resolved');
      expect(segments[0].lines).to.deep.equal(['line1', 'line2', 'line3']);
    });

    it('parses content with one conflict', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments(DEFAULT_WORKDIR_CONTENT);
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict', 'resolved']);
      expect(segments[1].oursLines).to.deep.equal(['line2-ours']);
      expect(segments[1].theirsLines).to.deep.equal(['line2-theirs']);
    });

    it('parses multiple conflicts', async () => {
      const el = await renderEditor();
      const text = [
        'a',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
        'c',
        '<<<<<<< HEAD', 'd-ours', '=======', 'd-theirs', '>>>>>>> other',
        'e',
      ].join('\n');
      const segments = internalOf(el).parseSegments(text);
      expect(segments.filter((s) => s.type === 'conflict').length).to.equal(2);
    });

    it('extracts labels from conflict markers', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature/x'
      );
      expect(segments[0].oursLabel).to.equal('HEAD');
      expect(segments[0].theirsLabel).to.equal('feature/x');
    });

    it('defaults to OURS/THEIRS when labels are missing', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments('<<<<<<<\nours\n=======\ntheirs\n>>>>>>>');
      expect(segments[0].oursLabel).to.equal('OURS');
      expect(segments[0].theirsLabel).to.equal('THEIRS');
    });

    it('treats a nested "<<<<<<<" line as content', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nours\n<<<<<<< nested\n=======\ntheirs\n>>>>>>> other'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].oursLines).to.deep.equal(['ours', '<<<<<<< nested']);
    });

    it('supports diff3 output without leaking the base section into ours', async () => {
      const el = await renderEditor();
      internalOf(el).conflictFile = { ...makeConflictFile('src/test.ts'), conflictStyle: 'diff3' };
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nours\n||||||| base\nbase-line\n=======\ntheirs\n>>>>>>> other'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].oursLines).to.deep.equal(['ours']);
      expect(segments[0].theirsLines).to.deep.equal(['theirs']);
    });

    it('diff3: a bare ||||||| line in OURS content cannot truncate the ours hunk', async () => {
      // merge.conflictStyle=diff3: the ours hunk itself contains a bare
      // 7-pipe line. Cutting ours at the FIRST base-marker-shaped line
      // would silently drop everything after it (the truncated prefix
      // still validates!) — base candidates must be tried longest-first.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'base-line';
          if (blobArgs?.oid === 'ours-oid') return 'ours-A\n|||||||\nours-B';
          if (blobArgs?.oid === 'theirs-oid') return 'theirs-line';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            '<<<<<<< HEAD',
            'ours-A',
            '|||||||',
            'ours-B',
            '||||||| c5ca07f',
            'base-line',
            '=======',
            'theirs-line',
            '>>>>>>> feature',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = { ...makeConflictFile('src/test.ts'), conflictStyle: 'diff3' };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines, 'the full ours hunk survives').to.deep.equal([
        'ours-A',
        '|||||||',
        'ours-B',
      ]);
      expect(conflicts[0].theirsLines).to.deep.equal(['theirs-line']);
    });

    it('keeps a ||||||| line as ours CONTENT in default merge-style conflicts', async () => {
      const el = await renderEditor();
      // The default style has no base sections (and libgit2 never writes
      // them): a pipe run in ours is real content — discarding the lines
      // after it as a "base section" would silently lose them from every
      // Use Ours / Use Both pick.
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nline A\n|||||||\nline B (part of ours)\n=======\ntheir line\n>>>>>>> branch'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].oursLines).to.deep.equal([
        'line A',
        '|||||||',
        'line B (part of ours)',
      ]);
      expect(segments[0].theirsLines).to.deep.equal(['their line']);
    });

    it('does not mistake a divider banner inside ours for the separator', async () => {
      const el = await renderEditor();
      // The ours side contains a legitimate ====-banner line; only the exact
      // 7-equals line is git's separator.
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nfoo\n========================\nbar\n=======\ntheirs-content\n>>>>>>> feature'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].oursLines).to.deep.equal(['foo', '========================', 'bar']);
      expect(segments[0].theirsLines).to.deep.equal(['theirs-content']);
    });

    it('treats pipe-banner content and diff3 markers in theirs as content', async () => {
      const el = await renderEditor();
      // A ||||||| after the separator is content (git never emits it there);
      // it must not silently discard following lines.
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nours\n=======\n||||||||||\ntheirs-content\n>>>>>>> feature'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].oursLines).to.deep.equal(['ours']);
      expect(segments[0].theirsLines).to.deep.equal(['||||||||||', 'theirs-content']);
    });

    it('parses CRLF files, keeping content line endings intact', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments(
        'ctx\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\ntail\r'
      );
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict', 'resolved']);
      expect(segments[0].lines).to.deep.equal(['ctx\r']);
      expect(segments[1].oursLines).to.deep.equal(['ours\r']);
      expect(segments[1].theirsLines).to.deep.equal(['theirs\r']);
      expect(segments[1].oursLabel).to.equal('HEAD');
      expect(segments[1].theirsLabel).to.equal('feature');
    });

    it('treats a >>>>>>>-shaped line before the separator as content', async () => {
      const el = await renderEditor();
      // A quoted diff or docs line resembling an end marker inside the ours
      // section must not terminate the conflict — that would drop the real
      // theirs side and leak the true markers as "resolved" text.
      const segments = internalOf(el).parseSegments(
        '<<<<<<< HEAD\nline1\n>>>>>>> quoted diff header\nline3\n=======\ntheirs line\n>>>>>>> feature'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].type).to.equal('conflict');
      expect(segments[0].oursLines).to.deep.equal([
        'line1',
        '>>>>>>> quoted diff header',
        'line3',
      ]);
      expect(segments[0].theirsLines).to.deep.equal(['theirs line']);
      expect(segments[0].theirsLabel).to.equal('feature');
    });

    it('does not mistake 8+ angle brackets for conflict markers', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments('<<<<<<<< not a marker\ncontent');
      expect(segments.length).to.equal(1);
      expect(segments[0].type).to.equal('resolved');
      expect(segments[0].lines).to.deep.equal(['<<<<<<<< not a marker', 'content']);
    });

    it('a long bracket run with only a coincidental divider stays content', async () => {
      const el = await renderEditor();
      // An 8-char banner plus a stray 8-equals divider is NOT a conflict in
      // a default-size (7) file — only runs of EXACTLY the file's marker
      // size are markers, so nothing here can open a phantom conflict.
      const segments = internalOf(el).parseSegments(
        '<<<<<<<< banner heading\ntext\n========\nmore text'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].type).to.equal('resolved');
    });

    it('a long marker example in docs cannot swallow a real conflict below it', async () => {
      const el = await renderEditor();
      // Docs text shows an 8-char marker sample; a REAL 7-char conflict
      // follows, then a setext-style 8-equals underline. The sample line
      // must stay content and the real conflict must parse — otherwise the
      // real markers would render as pickable content and be written back.
      const segments = internalOf(el).parseSegments(
        [
          'Conflict docs',
          '<<<<<<<< (a raised-size marker looks like this)',
          'some prose',
          '<<<<<<< HEAD',
          'real ours line',
          '=======',
          'real theirs line',
          '>>>>>>> feature',
          'Overview',
          '========',
          'tail content',
        ].join('\n')
      );
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['real ours line']);
      expect(conflicts[0].theirsLines).to.deep.equal(['real theirs line']);
      // The docs sample line stayed ordinary content.
      expect(segments[0].lines).to.include('<<<<<<<< (a raised-size marker looks like this)');
    });

    it('parses raised conflict-marker-size markers using the backend-reported size', async () => {
      const el = await renderEditor();
      internalOf(el).conflictFile = makeConflictFile('src/test.ts', 32);
      const m = (ch: string) => ch.repeat(32);
      const segments = internalOf(el).parseSegments(
        [
          'ctx',
          `${m('<')} HEAD`,
          'ours-line',
          '=======',
          m('='),
          'theirs-line',
          `${m('>')} feature`,
          'tail',
        ].join('\n')
      );
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict', 'resolved']);
      // The bare 7-equals line inside the ours side is CONTENT for a
      // 32-char-marker conflict; only the exact 32-equals line separates.
      expect(segments[1].oursLines).to.deep.equal(['ours-line', '=======']);
      expect(segments[1].theirsLines).to.deep.equal(['theirs-line']);
      expect(segments[1].oursLabel).to.equal('HEAD');
      expect(segments[1].theirsLabel).to.equal('feature');
    });

    it('a complete default-size conflict sample inside a raised-size conflict stays content', async () => {
      const el = await renderEditor();
      internalOf(el).conflictFile = makeConflictFile('src/test.ts', 12);
      const m = (ch: string) => ch.repeat(12);
      // THE reason conflict-marker-size gets raised: the file's own content
      // shows what a (7-char) conflict looks like. Every line of the sample
      // — start, separator, end — must stay ours CONTENT of the real
      // 12-char conflict; the real markers must parse and never render.
      const segments = internalOf(el).parseSegments(
        [
          'Intro text',
          `${m('<')} HEAD`,
          'A conflict looks like:',
          '<<<<<<< A',
          'one',
          '=======',
          'two',
          '>>>>>>> B',
          m('='),
          'their docs version',
          `${m('>')} feature`,
          'tail',
        ].join('\n')
      );
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict', 'resolved']);
      expect(segments[1].oursLines).to.deep.equal([
        'A conflict looks like:',
        '<<<<<<< A',
        'one',
        '=======',
        'two',
        '>>>>>>> B',
      ]);
      expect(segments[1].theirsLines).to.deep.equal(['their docs version']);
      expect(segments[0].lines).to.deep.equal(['Intro text']);
      expect(segments[2].lines).to.deep.equal(['tail']);
    });

    it('raised-size markers are content when the file was written at the default size', async () => {
      const el = await renderEditor();
      // No markerSize (or 7) means git wrote 7-char markers; a 12-char docs
      // sample above the real conflict is content, never a phantom start.
      const m = (ch: string) => ch.repeat(12);
      const segments = internalOf(el).parseSegments(
        [
          `${m('<')} (a raised-size marker looks like this)`,
          'some prose',
          '<<<<<<< HEAD',
          'real ours line',
          '=======',
          'real theirs line',
          '>>>>>>> feature',
        ].join('\n')
      );
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['real ours line']);
      expect(conflicts[0].theirsLines).to.deep.equal(['real theirs line']);
      expect(segments[0].lines).to.include(`${m('<')} (a raised-size marker looks like this)`);
    });

    it('parses a lowered conflict-marker-size', async () => {
      const el = await renderEditor();
      internalOf(el).conflictFile = makeConflictFile('src/test.ts', 3);
      const segments = internalOf(el).parseSegments(
        '<<< HEAD\nours\n===\ntheirs\n>>> feature'
      );
      expect(segments.length).to.equal(1);
      expect(segments[0].type).to.equal('conflict');
      expect(segments[0].oursLines).to.deep.equal(['ours']);
      expect(segments[0].theirsLines).to.deep.equal(['theirs']);
    });

    it('falls back to size 7 for missing or nonsense marker sizes', async () => {
      const el = await renderEditor();
      // 1e9 would drive a gigabyte separator-string allocation if trusted.
      for (const bad of [0, -3, 2.5, 1_000_000_000, undefined]) {
        internalOf(el).conflictFile = makeConflictFile('src/test.ts', bad as number | undefined);
        const segments = internalOf(el).parseSegments(DEFAULT_WORKDIR_CONTENT);
        expect(segments.filter((s) => s.type === 'conflict').length, `size=${bad}`).to.equal(1);
      }
    });

    it('a setext underline in ours cannot swallow the real separator (blob-validated resplit)', async () => {
      // Ours legitimately contains a line of exactly seven equals (a
      // Markdown setext H1 underline). Shape alone cannot tell it from
      // git's separator — the split must validate against the blobs, or
      // the real separator leaks into the theirs pane and gets written
      // back to disk on Use Theirs + Mark Resolved.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'Intro\ntail';
          if (blobArgs?.oid === 'ours-oid') return 'Intro\nHeading\n=======\nOURS CHANGE\ntail';
          if (blobArgs?.oid === 'theirs-oid') return 'Intro\nTHEIRS CHANGE\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'Intro',
            '<<<<<<< HEAD',
            'Heading',
            '=======',
            'OURS CHANGE',
            '=======',
            'THEIRS CHANGE',
            '>>>>>>> theirs',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/doc.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['Heading', '=======', 'OURS CHANGE']);
      expect(conflicts[0].theirsLines).to.deep.equal(['THEIRS CHANGE']);
    });

    it('a setext underline in THEIRS does not shift the split either', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'tail';
          if (blobArgs?.oid === 'ours-oid') return 'OURS\ntail';
          if (blobArgs?.oid === 'theirs-oid') return 'Heading\n=======\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            '<<<<<<< HEAD',
            'OURS',
            '=======',
            'Heading',
            '=======',
            '>>>>>>> theirs',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/doc.md');
      const conflicts = internalOf(el).segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['OURS']);
      expect(conflicts[0].theirsLines).to.deep.equal(['Heading', '=======']);
    });

    it('a quoted end marker inside THEIRS cannot close the block early', async () => {
      // The theirs side's CONTENT quotes an end marker (docs example). A
      // shape-only close at it would strand the real end marker below as
      // "resolved" text — rendered on screen and written back to disk.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'ctx\ntail';
          if (blobArgs?.oid === 'ours-oid') return 'ctx\nours line\ntail';
          if (blobArgs?.oid === 'theirs-oid')
            return 'ctx\nTheir docs say markers end with:\n>>>>>>> B\nmore theirs text\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'ctx',
            '<<<<<<< HEAD',
            'ours line',
            '=======',
            'Their docs say markers end with:',
            '>>>>>>> B',
            'more theirs text',
            '>>>>>>> feature',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/doc.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['ours line']);
      expect(conflicts[0].theirsLines).to.deep.equal([
        'Their docs say markers end with:',
        '>>>>>>> B',
        'more theirs text',
      ]);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText, 'no real marker may land in resolved text').to.deep.equal([
        'ctx',
        'tail',
      ]);
    });

    it('a complete quoted example that survived the merge is CONTENT, not a conflict', async () => {
      // A docs file contains a worked conflict example; the REAL conflict is
      // elsewhere. The example region exists verbatim in both blobs — it
      // must render as plain content, not as a pickable phantom block whose
      // resolution would mangle the documentation.
      setupDefaultMocks();
      const example = ['Example of a conflict:', '<<<<<<< HEAD', 'your code', '=======', 'their code', '>>>>>>> branch'];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return [...example, 'intro', 'BASE'].join('\n');
          if (blobArgs?.oid === 'ours-oid') return [...example, 'intro', 'OURS'].join('\n');
          if (blobArgs?.oid === 'theirs-oid') return [...example, 'intro', 'THEIRS'].join('\n');
          return '';
        }
        if (command === 'read_file_content') {
          return [
            ...example,
            'intro',
            '<<<<<<< HEAD',
            'OURS',
            '=======',
            'THEIRS',
            '>>>>>>> branch',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('docs/conflicts.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length, 'only the REAL conflict is a block').to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['OURS']);
      expect(conflicts[0].theirsLines).to.deep.equal(['THEIRS']);
      // The example survived as ordinary content, markers and all.
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText).to.deep.equal([...example, 'intro']);
    });

    it('a committed marker triplet INSIDE a real conflict does not close it early', async () => {
      // The file was committed with a bare marker triplet as content (a
      // well-known footgun); a real merge then conflicts around it. The
      // committed ======= / >>>>>>> must not terminate the real block —
      // that would orphan git's real separator and end marker as resolved
      // text.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'ctx\n<<<<<<<\n=======\n>>>>>>>\ntail';
          if (blobArgs?.oid === 'ours-oid')
            return 'ctx\nours-real\n<<<<<<<\n=======\n>>>>>>>\nmore-ours\ntail';
          if (blobArgs?.oid === 'theirs-oid')
            return 'ctx\n<<<<<<<\n=======\n>>>>>>>\ntheirs-real\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'ctx',
            '<<<<<<< HEAD',
            'ours-real',
            '<<<<<<<',
            '=======',
            '>>>>>>>',
            'more-ours',
            '=======',
            'theirs-real',
            '>>>>>>> branch',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/fixture.txt');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal([
        'ours-real',
        '<<<<<<<',
        '=======',
        '>>>>>>>',
        'more-ours',
      ]);
      expect(conflicts[0].theirsLines).to.deep.equal(['theirs-real']);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText, 'the real separator/end must not be orphaned').to.deep.equal([
        'ctx',
        'tail',
      ]);
    });

    it('a quoted end marker IDENTICAL to the real one cannot close the block early', async () => {
      // The theirs hunk quotes an end marker whose text exactly matches
      // git's real end marker (a tutorial quoting `>>>>>>> feature` while
      // that very branch merges in). Line-membership orphan checks are
      // blind here — only the strong trailing-is-blob-run justification
      // can pick the real close.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'ctx\ntail';
          if (blobArgs?.oid === 'ours-oid') return 'ctx\nours-real\ntail';
          if (blobArgs?.oid === 'theirs-oid')
            return 'ctx\ntheirs section unique 1\n>>>>>>> feature\ntheirs section unique 2\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'ctx',
            '<<<<<<< HEAD',
            'ours-real',
            '=======',
            'theirs section unique 1',
            '>>>>>>> feature',
            'theirs section unique 2',
            '>>>>>>> feature',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('docs/tutorial.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['ours-real']);
      expect(conflicts[0].theirsLines).to.deep.equal([
        'theirs section unique 1',
        '>>>>>>> feature',
        'theirs section unique 2',
      ]);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText, 'the real end marker must be consumed, never resolved text').to.deep.equal(
        ['ctx', 'tail']
      );
    });

    it('a quoted marker just AFTER the real end stays trailing content (symmetric case)', async () => {
      // The mirror image: common content directly after the hunk quotes a
      // line identical to the real end marker. The close must happen at
      // the REAL end, keeping the quoted copy as resolved content.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'ctx\n>>>>>>> feature\ntail';
          if (blobArgs?.oid === 'ours-oid') return 'ctx\nours1\n>>>>>>> feature\ntail';
          if (blobArgs?.oid === 'theirs-oid') return 'ctx\ntheirs1\n>>>>>>> feature\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'ctx',
            '<<<<<<< HEAD',
            'ours1',
            '=======',
            'theirs1',
            '>>>>>>> feature',
            '>>>>>>> feature',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('docs/notes.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['ours1']);
      expect(conflicts[0].theirsLines).to.deep.equal(['theirs1']);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText).to.deep.equal(['ctx', '>>>>>>> feature', 'tail']);
    });

    it('a quoted start marker directly ABOVE the real conflict stays content', async () => {
      // git emits the quoted `<<<<<<< A` (common context) directly above
      // the real hunk. Opening the region there swallows the real start
      // marker into the body — nothing validates and the shape-only
      // fallback would leak `<<<<<<< HEAD` as ours content. The parser
      // must reconsider the quoted line as content and rescan.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid')
            return '<<<<<<< A\nx0\n=======\ny\n>>>>>>> B';
          if (blobArgs?.oid === 'ours-oid')
            return '<<<<<<< A\nx1\n=======\ny\n>>>>>>> B';
          if (blobArgs?.oid === 'theirs-oid')
            return '<<<<<<< A\nx2\n=======\ny\n>>>>>>> B';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            '<<<<<<< A',
            '<<<<<<< HEAD',
            'x1',
            '=======',
            'x2',
            '>>>>>>> theirs',
            '=======',
            'y',
            '>>>>>>> B',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('docs/example.md');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['x1']);
      expect(conflicts[0].theirsLines).to.deep.equal(['x2']);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText, 'quoted markers stay content; real markers are consumed').to.deep.equal(
        ['<<<<<<< A', '=======', 'y', '>>>>>>> B']
      );
    });

    it('a quoted start marker INSIDE theirs does not blind the close checks', async () => {
      // The theirs hunk contains marker-fragment content (like this very
      // test file). The trailing window after an early close candidate must
      // look PAST quoted start-shaped lines, or the orphaned real end below
      // them goes unseen and the file splinters into phantom blocks.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'X\ntail';
          if (blobArgs?.oid === 'ours-oid') return 'O1\ntail';
          if (blobArgs?.oid === 'theirs-oid')
            return 'T1\n>>>>>>> QE\nT2\n<<<<<<< QS\nT3\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            '<<<<<<< HEAD',
            'O1',
            '=======',
            'T1',
            '>>>>>>> QE',
            'T2',
            '<<<<<<< QS',
            'T3',
            '>>>>>>> theirs',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/parser.test.ts');
      const segments = internalOf(el).segments;
      const conflicts = segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['O1']);
      expect(conflicts[0].theirsLines).to.deep.equal([
        'T1',
        '>>>>>>> QE',
        'T2',
        '<<<<<<< QS',
        'T3',
      ]);
      const resolvedText = segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText).to.deep.equal(['tail']);
    });

    it('an unterminated conflict stays a block even when its start text is quoted elsewhere', async () => {
      // The ours blob quotes '<<<<<<< HEAD' in a docs section, and the
      // file ALSO has a genuinely truncated conflict at EOF (crashed save).
      // The quoted-start recovery must not fire without end-candidate
      // evidence — reclassifying the real start as content would zero the
      // conflict count and let Mark Resolved write the marker back.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'docs quote:\n<<<<<<< HEAD\ncontext';
          if (blobArgs?.oid === 'ours-oid')
            return 'docs quote:\n<<<<<<< HEAD\ncontext\nours-body';
          if (blobArgs?.oid === 'theirs-oid') return 'docs quote:\n<<<<<<< HEAD\ncontext';
          return '';
        }
        if (command === 'read_file_content') {
          return ['context', '<<<<<<< HEAD', 'ours-body'].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/broken.txt');
      const internal = internalOf(el);
      expect(
        internal.segments.filter((s) => s.type === 'conflict').length,
        'the truncated conflict must stay a block, keeping Mark Resolved locked'
      ).to.equal(1);
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;
    });

    it('authoritative hunk positions beat every quoted-marker ambiguity', async () => {
      // Fable round-16's killer case: theirs quotes a line byte-identical
      // to the REAL end marker AND the auto-merged trailing interleaves
      // insertions from both sides, defeating both close-justification
      // tiers. With backend positions the parse is exact regardless.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'intro\nalpha\nctx1\nctx2\nctx3\ntail';
          if (blobArgs?.oid === 'ours-oid')
            return 'intro\nfrom-ours\nctx1\nours-insert\nctx2\nctx3\ntail';
          if (blobArgs?.oid === 'theirs-oid')
            return 'intro\nfrom-theirs\nquoted:\n>>>>>>> feature\nctx1\nctx2\ntheirs-insert\nctx3\ntail';
          return '';
        }
        if (command === 'read_file_content') {
          return [
            'intro',
            '<<<<<<< HEAD',
            'from-ours',
            '=======',
            'from-theirs',
            'quoted:',
            '>>>>>>> feature',
            '>>>>>>> feature',
            'ctx1',
            'ours-insert',
            'ctx2',
            'theirs-insert',
            'ctx3',
            'tail',
          ].join('\n');
        }
        return baseMock(command, args);
      };

      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = {
        ...makeConflictFile('docs/notes.md'),
        conflictHunks: [{ start: 1, separator: 3, end: 7 }],
      };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['from-ours']);
      expect(conflicts[0].theirsLines).to.deep.equal([
        'from-theirs',
        'quoted:',
        '>>>>>>> feature',
      ]);
      const resolvedText = internal.segments
        .filter((s) => s.type === 'resolved')
        .flatMap((s) => s.lines);
      expect(resolvedText, 'the real end marker is consumed, never resolved text').to.deep.equal([
        'intro',
        'ctx1',
        'ours-insert',
        'ctx2',
        'theirs-insert',
        'ctx3',
        'tail',
      ]);
    });

    it('authoritative hunk positions work for CRLF files (indices align with backend lines())', async () => {
      // The backend derives indices via Rust lines() (strips \r\n); the
      // frontend splits on '\n' (keeps '\r' per line, plus a trailing '').
      // For every index < length the two agree — and the sanity checks
      // strip CR — so CRLF files parse by positions too.
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = {
        ...makeConflictFile('src/win.ts'),
        conflictHunks: [{ start: 1, separator: 3, end: 5 }],
      };
      const segments = internal.parseSegments(
        'ctx\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\ntail\r\n'
      );
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict', 'resolved']);
      expect(segments[1].oursLines).to.deep.equal(['ours\r']);
      expect(segments[1].theirsLines).to.deep.equal(['theirs\r']);
      expect(segments[1].oursLabel).to.equal('HEAD');
      expect(segments[1].theirsLabel).to.equal('feature');
      // Content line endings round-trip verbatim.
      expect(segments[0].lines).to.deep.equal(['ctx\r']);
      expect(segments[2].lines).to.deep.equal(['tail\r', '']);
    });

    it('malformed hunk positions fall back to the shape heuristics', async () => {
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      // End index far out of range — positions do not describe this text.
      internal.conflictFile = {
        ...makeConflictFile('src/test.ts'),
        conflictHunks: [{ start: 1, separator: 3, end: 999 }],
      };
      const segments = internal.parseSegments(DEFAULT_WORKDIR_CONTENT);
      expect(segments.filter((s) => s.type === 'conflict').length).to.equal(1);
      const conflict = segments.find((s) => s.type === 'conflict')!;
      expect(conflict.oursLines).to.deep.equal(['line2-ours']);
    });

    it('keeps an unterminated conflict as a conflict block', async () => {
      const el = await renderEditor();
      const segments = internalOf(el).parseSegments(
        'ok\n<<<<<<< HEAD\nours\n=======\ntheirs'
      );
      expect(segments.map((s) => s.type)).to.deep.equal(['resolved', 'conflict']);
      expect(segments[1].theirsLines).to.deep.equal(['theirs']);
    });
  });

  // ── Stale-load races ─────────────────────────────────────────────────
  describe('stale-load races', () => {
    it('ignores a stale load when the user switches files quickly', async () => {
      setupDefaultMocks();
      let releaseA: ((v: string) => void) | null = null;
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') return 'x';
        if (command === 'read_file_content') {
          const filePath = (args as { filePath: string }).filePath;
          if (filePath === 'src/a.ts') {
            // File A's read hangs until we release it — simulating a slow
            // load that resolves AFTER the user has switched to file B.
            return new Promise((res) => {
              releaseA = res as (v: string) => void;
            });
          }
          return 'b-content';
        }
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        return null;
      }) as MockInvoke;

      const el = await renderEditor();
      const internal = internalOf(el);
      internal.conflictFile = makeConflictFile('src/a.ts');
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 30));

      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }

      // The stale A load finally resolves — it must NOT overwrite B's state
      // (Mark Resolved would otherwise stage A's content under B's path).
      releaseA!('a-content');
      await new Promise((r) => setTimeout(r, 30));
      await el.updateComplete;

      expect(internal.segments.flatMap((s) => s.lines).join('\n')).to.equal('b-content');
      expect(internal.loading).to.be.false;
    });

    it('a stale submodule load whose conflict re-check resolves late must not wipe a newer file', async () => {
      // A submodule's load awaits get_conflicts (isNoLongerConflicted). If the
      // user switches to a text file while that await is in flight, the stale
      // submodule load resumes and — without the post-await epoch guard — falls
      // into the gitlink branch that blanks segments/panes, leaving the NEW
      // file showing "no conflicts" with Mark Resolved enabled → a 0-byte write.
      setupDefaultMocks();
      let releaseConflicts: ((v: unknown) => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_conflicts') {
          // Park the submodule's re-check until we release it, then report the
          // submodule STILL conflicted (isNoLongerConflicted → false) so the
          // stale load reaches the gitlink-wipe branch the guard must skip.
          return new Promise((res) => {
            releaseConflicts = res as (v: unknown) => void;
          });
        }
        return baseMock(command, args);
      }) as MockInvoke;

      const el = await renderEditor();
      const internal = internalOf(el);
      internal.conflictFile = {
        path: 'sub',
        ancestor: { oid: 'a'.repeat(40), path: 'sub', mode: 0o160000 },
        ours: { oid: 'b'.repeat(40), path: 'sub', mode: 0o160000 },
        theirs: { oid: 'c'.repeat(40), path: 'sub', mode: 0o160000 },
        isBinary: false,
        isSubmodule: true,
      };
      await el.updateComplete;
      // Let the submodule load park on the hanging get_conflicts.
      await new Promise((r) => setTimeout(r, 40));

      // User switches to a normal text file, which loads fully.
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      const bSegments = internal.segments;
      expect(bSegments.length, 'text file loaded its segments').to.be.greaterThan(0);

      // The submodule's re-check finally resolves (still conflicted). The stale
      // load must return without touching the newer file's state.
      releaseConflicts!([{ path: 'sub' }, { path: 'src/b.ts' }]);
      await new Promise((r) => setTimeout(r, 40));
      await el.updateComplete;

      expect(internal.segments, 'newer file segments preserved').to.equal(bSegments);
      expect(internal.segments.length).to.be.greaterThan(0);
      expect(
        (el as unknown as { resolvedInPlace: boolean }).resolvedInPlace,
        'newer file not falsely resolved'
      ).to.not.equal(true);
    });
  });

  // ── Load failure handling ────────────────────────────────────────────
  describe('load failure', () => {
    it('shows an error state with Retry instead of fabricating a merge', async () => {
      setupDefaultMocks();
      workdirContent = () => Promise.reject(new Error('read failed'));
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      expect(internal.loadFailed).to.be.true;
      expect(internal.segments).to.deep.equal([]);
      expect(shadowText(el)).to.include('Could not read the merged file');
      const retry = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Retry'
      );
      expect(retry).to.not.be.undefined;
      // Mark Resolved must be disabled — there is nothing trustworthy to write.
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;
    });

    it('Retry reloads the file and clears the error state', async () => {
      setupDefaultMocks();
      let fail = true;
      workdirContent = () =>
        fail ? Promise.reject(new Error('read failed')) : Promise.resolve(DEFAULT_WORKDIR_CONTENT);
      const el = await renderLoadedEditor();
      expect(internalOf(el).loadFailed).to.be.true;

      fail = false;
      const retry = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Retry'
      ) as HTMLButtonElement;
      retry.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(internalOf(el).loadFailed).to.be.false;
      expect(internalOf(el).segments.length).to.be.greaterThan(0);
    });

    it('treats an empty working-directory file as valid content, not a failure', async () => {
      setupDefaultMocks();
      workdirContent = '';
      const el = await renderLoadedEditor();
      const internal = internalOf(el);
      expect(internal.loadFailed).to.be.false;
      expect(internal.segments.length).to.equal(1);
      expect(internal.segments[0].type).to.equal('resolved');
    });

    it('a workdir-only read failure still offers verbatim take-side resolution', async () => {
      // Non-UTF-8 (legacy encoding) text files fail read_file_content but
      // are not binary — without a verbatim escape hatch the file could
      // never be resolved in-app and Complete would stay disabled forever.
      setupDefaultMocks();
      workdirContent = () => Promise.reject(new Error('invalid utf-8'));
      const el = await renderLoadedEditor();
      expect(internalOf(el).loadFailed).to.be.true;

      const takeOurs = Array.from(el.shadowRoot!.querySelectorAll('.output-error button')).find(
        (b) => b.textContent?.includes('verbatim') && b.classList.contains('btn-ours')
      ) as HTMLButtonElement;
      expect(takeOurs, 'verbatim Use Ours offered in the error state').to.not.be.undefined;

      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => {
        resolvedFired = true;
      });
      invokeHistory.length = 0;
      takeOurs.click();
      await new Promise((r) => setTimeout(r, 30));
      const call = invokeHistory.find((h) => h.command === 'resolve_conflict_take_side');
      expect(call, 'take-side resolves blob-verbatim').to.not.be.undefined;
      expect((call!.args as { side: string }).side).to.equal('ours');
      expect(resolvedFired).to.be.true;
    });

    it('a verbatim take from the read-failure state lands terminal, not forever-Retry', async () => {
      // The verbatim buttons appear only in the load-failure state. On the
      // last file, taking a side succeeds but a reload would re-fail the
      // same undecodable blob — the editor must show a terminal notice, not
      // re-render the error with a Retry that loops and buttons that error.
      setupDefaultMocks();
      workdirContent = () => Promise.reject(new Error('invalid utf-8'));
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict_take_side') return { success: true };
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      expect(internalOf(el).loadFailed).to.be.true;

      const takeOurs = Array.from(el.shadowRoot!.querySelectorAll('.output-error button')).find(
        (b) => b.textContent?.includes('verbatim') && b.classList.contains('btn-ours'),
      ) as HTMLButtonElement;
      takeOurs.click();
      await new Promise((r) => setTimeout(r, 40));
      await el.updateComplete;

      expect(shadowText(el)).to.include('Resolved — the chosen version was staged');
      expect(
        el.shadowRoot!.querySelector('.output-error'),
        'no forever-Retry error state',
      ).to.be.null;
    });

    it('verbatim take-side is offered PER SIDE — a failed ours blob hides only ours', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'ours-oid') throw new Error('blob read failed');
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      expect(internalOf(el).loadFailed).to.be.true;
      const verbatimBtns = Array.from(
        el.shadowRoot!.querySelectorAll('.output-error button')
      ).filter((b) => b.textContent?.includes('verbatim'));
      expect(verbatimBtns.length).to.equal(1);
      expect(verbatimBtns[0].classList.contains('btn-theirs')).to.be.true;
    });

    it('a failed BASE blob keeps the structured editor fully working', async () => {
      // Missing base object (shallow/partial clone) — parsing and block
      // resolution never need base content, so the editor must stay alive
      // with only Use Base disabled, not degrade to whole-file-only.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') throw new Error('missing object');
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = internalOf(el);
      expect(internal.loadFailed).to.be.false;
      expect(internal.segments.filter((s) => s.type === 'conflict').length).to.equal(1);

      // Per-block resolution still works.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(internal.segments.filter((s) => s.type === 'conflict').length).to.equal(0);

      // Only Use Base is disabled — its content is not trustworthy.
      const useBase = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn')).find(
        (b) => b.textContent?.trim() === 'Use Base'
      ) as HTMLButtonElement;
      expect(useBase.disabled).to.be.true;
      const useOurs = Array.from(
        el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-ours')
      ).find((b) => b.textContent?.trim() === 'Use Ours') as HTMLButtonElement;
      expect(useOurs.disabled).to.be.false;
    });
  });

  // ── Per-block resolution ─────────────────────────────────────────────
  describe('per-block resolution', () => {
    it('Use Ours resolves the block with ours lines and records the origin', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const internal = internalOf(el);
      const resolved = internal.segments[1];
      expect(resolved.type).to.equal('resolved');
      expect(resolved.lines).to.deep.equal(['line2-ours']);
      expect(resolved.origin).to.equal('ours');
      expect(resolved.fromConflict).to.be.true;
      expect(shadowText(el)).to.include('No conflicts');
      expectNoMarkers(el);
    });

    it('Use Theirs resolves the block with theirs lines', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Theirs').click();
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.lines).to.deep.equal(['line2-theirs']);
      expect(resolved.origin).to.equal('theirs');
    });

    it('Use Both keeps ours then theirs', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Both').click();
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.lines).to.deep.equal(['line2-ours', 'line2-theirs']);
      expect(resolved.origin).to.equal('both');
    });

    it('resolves only the targeted conflict, preserving others', async () => {
      setupDefaultMocks();
      workdirContent = [
        'a',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
        'c',
        '<<<<<<< HEAD', 'd-ours', '=======', 'd-theirs', '>>>>>>> other',
      ].join('\n');
      const el = await renderLoadedEditor();

      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const internal = internalOf(el);
      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['d-ours']);
      expect(shadowText(el)).to.include('1 conflict remaining');
      expectNoMarkers(el);
    });

    it('Reset reopens a resolved-from-conflict block', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const resetBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-btn')).find(
        (b) => b.textContent?.trim() === 'Reset'
      ) as HTMLButtonElement;
      expect(resetBtn, 'Reset button on resolved-from-conflict segment').to.not.be.undefined;
      resetBtn.click();
      await el.updateComplete;

      const internal = internalOf(el);
      expect(internal.segments[1].type).to.equal('conflict');
      expect(internal.segments[1].oursLines).to.deep.equal(['line2-ours']);
      expect(shadowText(el)).to.include('1 conflict remaining');
    });
  });

  // ── Inline editing ───────────────────────────────────────────────────
  describe('inline editing', () => {
    it('editing a conflict block starts from both sides, never marker text', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Edit').click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.segment-editor textarea') as HTMLTextAreaElement;
      expect(textarea).to.not.be.null;
      expect(textarea.value).to.equal('line2-ours\nline2-theirs');
      for (const marker of MARKER_CHARS) {
        expect(textarea.value).to.not.include(marker);
      }
    });

    it('applying a conflict edit resolves the block as manual', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Edit').click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.segment-editor textarea') as HTMLTextAreaElement;
      textarea.value = 'hand-merged';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      const applyBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-editor button')).find(
        (b) => b.textContent?.trim() === 'Apply'
      ) as HTMLButtonElement;
      applyBtn.click();
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.type).to.equal('resolved');
      expect(resolved.lines).to.deep.equal(['hand-merged']);
      expect(resolved.origin).to.equal('manual');
      expect(shadowText(el)).to.include('No conflicts');
    });

    it('cancelling a conflict edit leaves the block unresolved', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Edit').click();
      await el.updateComplete;

      const cancelBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-editor button')).find(
        (b) => b.textContent?.trim() === 'Cancel'
      ) as HTMLButtonElement;
      cancelBtn.click();
      await el.updateComplete;

      expect(internalOf(el).segments[1].type).to.equal('conflict');
      expect(shadowText(el)).to.include('1 conflict remaining');
    });

    it('resolved text is editable in place', async () => {
      const el = await renderLoadedEditor();
      // First resolved segment ("line1") has an Edit hover action.
      const editBtn = el.shadowRoot!.querySelector('.output-segment .segment-btn') as HTMLButtonElement;
      expect(editBtn.textContent?.trim()).to.equal('Edit');
      editBtn.click();
      await el.updateComplete;

      const textarea = el.shadowRoot!.querySelector('.segment-editor textarea') as HTMLTextAreaElement;
      expect(textarea.value).to.equal('line1');
      textarea.value = 'line1-edited';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await el.updateComplete;

      const applyBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-editor button')).find(
        (b) => b.textContent?.trim() === 'Apply'
      ) as HTMLButtonElement;
      applyBtn.click();
      await el.updateComplete;

      expect(internalOf(el).segments[0].lines).to.deep.equal(['line1-edited']);
      expect(shadowText(el)).to.include('line1-edited');
    });
  });

  // ── Whole-file strategies ────────────────────────────────────────────
  describe('whole-file strategies', () => {
    it('Use Ours replaces the output with ours content', async () => {
      const el = await renderLoadedEditor();
      const btn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-ours')).find(
        (b) => b.textContent?.trim() === 'Use Ours'
      ) as HTMLButtonElement;
      btn.click();
      await el.updateComplete;

      const internal = internalOf(el);
      expect(internal.segments.length).to.equal(1);
      expect(internal.segments[0].lines).to.deep.equal(['line1', 'line2-ours', 'line3']);
      expect(internal.segments[0].origin).to.equal('ours');
      expect(shadowText(el)).to.include('No conflicts');
    });

    it('Use Theirs replaces the output with theirs content', async () => {
      const el = await renderLoadedEditor();
      const btn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-theirs')).find(
        (b) => b.textContent?.trim() === 'Use Theirs'
      ) as HTMLButtonElement;
      btn.click();
      await el.updateComplete;

      expect(internalOf(el).segments[0].lines).to.deep.equal(['line1', 'line2-theirs', 'line3']);
    });

    it('Use Base resets the output to the ancestor content', async () => {
      const el = await renderLoadedEditor();
      const btn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn')).find(
        (b) => b.textContent?.trim() === 'Use Base'
      ) as HTMLButtonElement;
      btn.click();
      await el.updateComplete;

      expect(internalOf(el).segments[0].lines).to.deep.equal(['line1', 'line2', 'line3']);
      expect(internalOf(el).segments[0].origin).to.equal('base');
    });

    it('Reload re-reads the on-disk merge, restoring conflicts', async () => {
      // The whole-file accept is unsaved work, so Reload confirms first.
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) return 'Ok';
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const useOurs = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-ours')).find(
        (b) => b.textContent?.trim() === 'Use Ours'
      ) as HTMLButtonElement;
      useOurs.click();
      await el.updateComplete;
      expect(internalOf(el).segments.filter((s) => s.type === 'conflict').length).to.equal(0);

      const reload = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn')).find(
        (b) => b.textContent?.trim() === 'Reload'
      ) as HTMLButtonElement;
      reload.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(internalOf(el).segments.filter((s) => s.type === 'conflict').length).to.equal(1);
    });
  });

  // ── Mark resolved ──────────────────────────────────────────────────────
  describe('mark resolved', () => {
    it('is disabled while conflicts remain', async () => {
      const el = await renderLoadedEditor();
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;
    });

    it('refuses to write while conflicts remain even if invoked directly', async () => {
      const el = await renderLoadedEditor();
      invokeHistory.length = 0;
      await internalOf(el).handleMarkResolved();
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
    });

    it('refuses to write while an inline edit is open (unapplied draft)', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      // Open Edit on the resolved segment — the draft is unapplied.
      const editBtn = el.shadowRoot!.querySelector('.output-segment .segment-btn') as HTMLButtonElement;
      editBtn.click();
      await el.updateComplete;

      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;

      // Direct invocation must also refuse — it would stage the PRE-edit text.
      invokeHistory.length = 0;
      await internalOf(el).handleMarkResolved();
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
    });

    it('refuses to write after a failed load even if invoked directly', async () => {
      setupDefaultMocks();
      workdirContent = () => Promise.reject(new Error('read failed'));
      const el = await renderLoadedEditor();
      expect(internalOf(el).loadFailed).to.be.true;

      // conflictCount is 0 here (no segments), so without the loadFailed
      // guard this would write an EMPTY file as the resolution.
      invokeHistory.length = 0;
      await internalOf(el).handleMarkResolved();
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
    });

    it('dispatches the file it actually resolved, not the one selected after a mid-flight switch', async () => {
      setupDefaultMocks();
      let releaseResolve: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict') {
          return new Promise((res) => {
            releaseResolve = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/a.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const resolvedPaths: string[] = [];
      el.addEventListener('conflict-resolved', ((e: CustomEvent) => {
        resolvedPaths.push(e.detail.file.path);
      }) as EventListener);

      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      markBtn.click();
      await el.updateComplete;

      // The user selects another file while the backend call is in flight.
      internalOf(el).conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;

      releaseResolve!();
      await new Promise((r) => setTimeout(r, 30));

      // The event must carry the file the call resolved — marking B resolved
      // without resolving it would let a stash Complete drop the stash early.
      expect(resolvedPaths).to.deep.equal(['src/a.ts']);

      // And A's saved content must NOT be recorded as file B's saved state —
      // that would corrupt B's unsaved-work detection.
      expect(
        (el as unknown as { lastSavedContent: string | null }).lastSavedContent,
        "a stale write's content must not become the current file's saved state"
      ).to.equal(null);
    });

    it('ignores a double-click while the resolve call is in flight', async () => {
      setupDefaultMocks();
      let resolveCalls = 0;
      let releaseResolve: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict') {
          resolveCalls++;
          return new Promise((res) => {
            releaseResolve = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      let resolvedEvents = 0;
      el.addEventListener('conflict-resolved', () => {
        resolvedEvents++;
      });

      const internal = el as unknown as { handleMarkResolved: () => Promise<void> };
      const first = internal.handleMarkResolved.call(el);
      const second = internal.handleMarkResolved.call(el);
      releaseResolve!();
      await Promise.all([first, second]);

      expect(resolveCalls).to.equal(1);
      expect(resolvedEvents).to.equal(1);
    });

    it('a file switch releases the resolving lock for the new file', async () => {
      setupDefaultMocks();
      let releaseResolve: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict') {
          return new Promise((res) => {
            releaseResolve = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/a.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const internal = el as unknown as EditorInternal & {
        resolving: boolean;
        handleMarkResolved: () => Promise<void>;
      };
      const pending = internal.handleMarkResolved.call(el);
      await el.updateComplete;
      expect(internal.resolving).to.be.true;

      // Switching files must not leave the NEW file's buttons locked by the
      // old file's in-flight call.
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;
      expect(internal.resolving).to.be.false;

      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.false;

      // The stale call settling must not re-lock the new file either.
      releaseResolve!();
      await pending;
      await el.updateComplete;
      expect(internal.resolving).to.be.false;
    });

    it('writes marker-free content and dispatches conflict-resolved once resolved', async () => {
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Both').click();
      await el.updateComplete;

      let eventFile: string | null = null;
      el.addEventListener('conflict-resolved', ((e: CustomEvent) => {
        eventFile = e.detail.file.path;
      }) as EventListener);

      invokeHistory.length = 0;
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.false;
      markBtn.click();
      await new Promise((r) => setTimeout(r, 50));

      const resolveCall = invokeHistory.find((h) => h.command === 'resolve_conflict');
      expect(resolveCall).to.exist;
      const content = (resolveCall!.args as { content: string }).content;
      expect(content).to.equal('line1\nline2-ours\nline2-theirs\nline3');
      for (const marker of MARKER_CHARS) {
        expect(content).to.not.include(marker);
      }
      expect(eventFile).to.equal('src/test.ts');
    });
  });

  // ── Empty-side conflicts (delete/modify hunks) ───────────────────────
  describe('empty-side conflicts', () => {
    it('renders an empty side as such and keeps a removed-section resolution reachable', async () => {
      setupDefaultMocks();
      workdirContent = 'ctx\n<<<<<<< HEAD\n=======\ntheirs-line\n>>>>>>> other\ntail';
      const el = await renderLoadedEditor();

      const block = el.shadowRoot!.querySelector('.code-conflict-block')!;
      expect(block.querySelector('.code-conflict-side-ours')!.textContent).to.include(
        'no lines on this side'
      );

      // Resolving to the empty side yields a zero-line segment; it must still
      // render a placeholder row so its hover actions (Edit/Reset) work.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.type).to.equal('resolved');
      expect(resolved.lines).to.deep.equal([]);
      const segmentEls = el.shadowRoot!.querySelectorAll('.output-segment');
      const emptySegment = Array.from(segmentEls).find((s) =>
        s.textContent?.includes('removed the section')
      );
      expect(emptySegment, 'placeholder row rendered').to.not.be.undefined;
      expect(emptySegment!.querySelector('.segment-actions .segment-btn')).to.not.be.null;
    });

    it('Edit → Apply on an empty resolution keeps zero lines, not one blank line', async () => {
      setupDefaultMocks();
      workdirContent = 'ctx\n<<<<<<< HEAD\n=======\ntheirs-line\n>>>>>>> other\ntail';
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(internalOf(el).segments[1].lines).to.deep.equal([]);

      // Open Edit on the empty placeholder and Apply without typing anything.
      const segmentEls = el.shadowRoot!.querySelectorAll('.output-segment');
      const emptySegment = Array.from(segmentEls).find((s) =>
        s.textContent?.includes('removed the section')
      )!;
      (emptySegment.querySelector('.segment-actions .segment-btn') as HTMLButtonElement).click();
      await el.updateComplete;

      const applyBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-editor button')).find(
        (b) => b.textContent?.trim() === 'Apply'
      ) as HTMLButtonElement;
      applyBtn.click();
      await el.updateComplete;

      // Still zero lines — no spurious blank line was inserted.
      expect(internalOf(el).segments[1].lines).to.deep.equal([]);
    });
  });

  // ── Add/add conflicts (no common ancestor) ───────────────────────────
  describe('add/add conflicts', () => {
    it('treats an absent ancestor as zero base lines, coloring both sides as additions', async () => {
      setupDefaultMocks();
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'ours-oid') return 'a\nb';
          if (blobArgs?.oid === 'theirs-oid') return 'x\ny';
          return '';
        }
        if (command === 'read_file_content')
          return '<<<<<<< HEAD\na\nb\n=======\nx\ny\n>>>>>>> other';
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        return null;
      }) as MockInvoke;

      const el = await renderEditor();
      const internal = internalOf(el);
      internal.conflictFile = { ...makeConflictFile('src/new.ts'), ancestor: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;

      // No phantom blank base line: every base-pane row is a filler.
      const baseNumbers = Array.from(
        el.shadowRoot!.querySelectorAll('#panel-base .line-number')
      ).map((n) => n.textContent?.trim());
      expect(baseNumbers.every((n) => n === '')).to.be.true;
      // All ours lines are additions, none miscolored as changed.
      expect(el.shadowRoot!.querySelectorAll('#panel-ours .code-addition').length).to.equal(2);
      expect(el.shadowRoot!.querySelectorAll('#panel-ours .line-changed').length).to.equal(0);

      // There is no ancestor version — offering "Use Base" would stage an
      // empty file as a "common ancestor" that never existed.
      const useBase = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn')).find(
        (b) => b.textContent?.trim() === 'Use Base'
      );
      expect(useBase).to.be.undefined;
    });
  });

  // ── Side blob read failures ──────────────────────────────────────────
  describe('side blob read failures', () => {
    it('shows read failed in the base header when the ancestor blob fails', async () => {
      setupDefaultMocks();
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return Promise.reject(new Error('read failed'));
          if (blobArgs?.oid === 'ours-oid') return 'line1\nline2-ours\nline3';
          if (blobArgs?.oid === 'theirs-oid') return 'line1\nline2-theirs\nline3';
          return '';
        }
        if (command === 'read_file_content') return DEFAULT_WORKDIR_CONTENT;
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        return null;
      }) as MockInvoke;

      const el = await renderLoadedEditor();
      const baseHeader = el.shadowRoot!.querySelector('.panel-header.base')!;
      expect(baseHeader.textContent).to.include('read failed');
      expect(baseHeader.textContent).to.not.include('0 lines');
      const basePane = el.shadowRoot!.getElementById('panel-base')!;
      expect(basePane.textContent).to.include('Could not read this version');

      // The surviving panes must not pretend to know the diff from a base
      // that never loaded: no fake change counts, no addition highlighting.
      const oursHeader = el.shadowRoot!.querySelector('.panel-header.ours')!;
      expect(oursHeader.textContent).to.include('base unavailable');
      expect(oursHeader.textContent).to.not.include('changes from base');
      expect(el.shadowRoot!.querySelectorAll('#panel-ours .code-addition').length).to.equal(0);
      expect(el.shadowRoot!.querySelectorAll('#panel-ours .line-changed').length).to.equal(0);
    });

    it('routes a failed read of an existing side to the Retry state', async () => {
      setupDefaultMocks();
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          // The ours blob EXISTS but its read fails — this must not
          // masquerade as an empty file (Use Ours would truncate it).
          if (blobArgs?.oid === 'ours-oid') return Promise.reject(new Error('read failed'));
          if (blobArgs?.oid === 'base-oid') return 'line1\nline2\nline3';
          if (blobArgs?.oid === 'theirs-oid') return 'line1\nline2-theirs\nline3';
          return '';
        }
        if (command === 'read_file_content') return DEFAULT_WORKDIR_CONTENT;
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        // The file is genuinely STILL conflicted — the read failure is a
        // side-blob error, not a resolution — so it must land in the error
        // state, not the resolved terminal.
        if (command === 'get_conflicts') return [{ path: 'src/test.ts' }];
        return null;
      }) as MockInvoke;

      const el = await renderLoadedEditor();
      const internal = internalOf(el);
      expect(internal.loadFailed).to.be.true;
      // The message must blame the side version, not the (readable) workdir file.
      expect(shadowText(el)).to.include('Could not read all of this file’s versions');
      expect(shadowText(el)).to.not.include('merged file from the working directory');
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;

      // The failed pane shows an error, not fabricated empty content.
      const oursPane = el.shadowRoot!.getElementById('panel-ours')!;
      expect(oursPane.textContent).to.include('Could not read this version');
      expect(oursPane.querySelectorAll('.code-line').length).to.equal(0);
      expect(shadowText(el)).to.include('read failed');

      // Whole-file accepts are disabled — their content is not trustworthy.
      const useOurs = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-ours')).find(
        (b) => b.textContent?.trim() === 'Use Ours'
      ) as HTMLButtonElement;
      expect(useOurs.disabled).to.be.true;
      const headerUse = el.shadowRoot!.querySelector(
        '.panel-header.ours .panel-header-btn'
      ) as HTMLButtonElement;
      expect(headerUse.disabled).to.be.true;

      // The output header must not contradict the retry box with "No conflicts".
      expect(el.shadowRoot!.querySelector('.conflict-count')!.textContent).to.not.include(
        'No conflicts'
      );
    });
  });

  // ── Parsed side labels ───────────────────────────────────────────────
  describe('parsed side labels', () => {
    it('shows the branch labels git recorded alongside the generic roles', async () => {
      const el = await renderLoadedEditor();
      const block = el.shadowRoot!.querySelector('.code-conflict-block')!;
      // Default mock content is <<<<<<< HEAD ... >>>>>>> feature
      expect(block.querySelector('.code-conflict-side-ours .code-conflict-side-label')!.textContent)
        .to.include('HEAD');
      expect(block.querySelector('.code-conflict-side-theirs .code-conflict-side-label')!.textContent)
        .to.include('feature');
    });
  });

  // ── Pane alignment ───────────────────────────────────────────────────
  describe('pane alignment', () => {
    it('renders the same number of rows in all three source panes', async () => {
      setupDefaultMocks();
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'a\nb\nc';
          // ours inserts two lines at the top; theirs deletes one line.
          if (blobArgs?.oid === 'ours-oid') return 'x\ny\na\nb\nc';
          if (blobArgs?.oid === 'theirs-oid') return 'a\nc';
          return '';
        }
        if (command === 'read_file_content') return 'a\nb\nc';
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        return null;
      }) as MockInvoke;

      const el = await renderLoadedEditor();
      const rows = (side: string) =>
        el.shadowRoot!.querySelectorAll(`#panel-${side} .code-line`).length;
      expect(rows('ours')).to.equal(rows('base'));
      expect(rows('base')).to.equal(rows('theirs'));
    });

    it('an insertion does not mark every following line as changed', async () => {
      setupDefaultMocks();
      mockInvoke = (async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'a\nb\nc\nd';
          if (blobArgs?.oid === 'ours-oid') return 'new\na\nb\nc\nd';
          if (blobArgs?.oid === 'theirs-oid') return 'a\nb\nc\nd';
          return '';
        }
        if (command === 'read_file_content') return 'a\nb\nc\nd';
        if (command === 'get_merge_tool_config') return null;
        if (command === 'is_ai_available') return false;
        return null;
      }) as MockInvoke;

      const el = await renderLoadedEditor();
      // Exactly one added line in ours; nothing else may be highlighted.
      const additions = el.shadowRoot!.querySelectorAll('#panel-ours .code-addition');
      const changed = el.shadowRoot!.querySelectorAll('#panel-ours .line-changed');
      expect(additions.length).to.equal(1);
      expect(changed.length).to.equal(0);
      expect(shadowText(el)).to.include('1 change from base');
    });
  });

  // ── Operation-aware labels ───────────────────────────────────────────
  describe('operation-aware labels', () => {
    it('labels sides for merge by default', async () => {
      const el = await renderLoadedEditor();
      const text = shadowText(el);
      expect(text).to.include('Ours (Current Branch)');
      expect(text).to.include('Theirs (Incoming)');
    });

    it('labels the swapped sides during a rebase', async () => {
      const el = await renderEditor();
      el.operationType = 'rebase';
      const internal = internalOf(el);
      internal.conflictFile = makeConflictFile('src/test.ts');
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const text = shadowText(el);
      expect(text).to.include('Ours (Rebasing Onto)');
      expect(text).to.include('Theirs (Your Commit)');
    });

    it('labels stash conflicts as working tree vs stashed changes', async () => {
      const el = await renderEditor();
      el.operationType = 'stash';
      const internal = internalOf(el);
      internal.conflictFile = makeConflictFile('src/test.ts');
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const text = shadowText(el);
      expect(text).to.include('Ours (Working Tree)');
      expect(text).to.include('Theirs (Stashed Changes)');
    });
  });

  // ── AI resolution ────────────────────────────────────────────────────
  describe('AI resolution', () => {
    const PROVIDER_DOWN =
      'Anthropic Claude is not available. Please check its API key in Settings, or select a different provider.';

    function findButton(el: GnMergeEditor, label: string): HTMLButtonElement | undefined {
      return Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === label
      );
    }

    it('keeps the AI actions on screen, disabled and explained, when the chosen provider is down', async () => {
      setupDefaultMocks();
      // A provider IS selected in Settings, it just cannot be reached. The
      // request is never redirected elsewhere, so the actions cannot run — but
      // removing them would leave the user no way to learn why they stopped.
      aiAvailable = false;
      aiUnavailable = { reason: PROVIDER_DOWN, providerSelected: true };

      const el = await renderLoadedEditor();

      const suggest = findConflictButton(el, 'AI Suggest');
      expect(suggest.disabled, 'AI Suggest is disabled').to.be.true;
      expect(suggest.title).to.include('Anthropic Claude');

      const resolveAll = findButton(el, 'AI Resolve All');
      expect(resolveAll, 'AI Resolve All rendered').to.not.be.undefined;
      expect(resolveAll!.disabled, 'AI Resolve All is disabled').to.be.true;
      expect(resolveAll!.title).to.include('Anthropic Claude');
    });

    it('hides the AI actions when no provider has ever been configured', async () => {
      setupDefaultMocks();
      aiAvailable = false;
      aiUnavailable = {
        reason: 'No AI provider available. Please configure a provider in Settings.',
        providerSelected: false,
      };

      const el = await renderLoadedEditor();

      expect(findButton(el, 'AI Suggest'), 'no AI Suggest button').to.be.undefined;
      expect(findButton(el, 'AI Resolve All'), 'no AI Resolve All button').to.be.undefined;
    });

    it('re-enables the AI actions when settings change makes the provider reachable', async () => {
      setupDefaultMocks();
      aiAvailable = false;
      aiUnavailable = { reason: PROVIDER_DOWN, providerSelected: true };

      const el = await renderLoadedEditor();
      expect(findConflictButton(el, 'AI Suggest').disabled).to.be.true;

      // The user fixes the API key in Settings.
      aiAvailable = true;
      aiUnavailable = null;
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const suggest = findConflictButton(el, 'AI Suggest');
      expect(suggest.disabled, 'AI Suggest is enabled again').to.be.false;
      expect(suggest.title).to.not.include('Anthropic Claude');
    });

    it('applies a per-block AI suggestion with origin "ai"', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      const el = await renderLoadedEditor();

      findConflictButton(el, 'AI Suggest').click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.type).to.equal('resolved');
      expect(resolved.lines).to.deep.equal(['ai-resolved']);
      expect(resolved.origin).to.equal('ai');
      expect(shadowText(el)).to.include('merged by ai');
    });

    it('AI Resolve All stops after the first failure instead of retrying forever', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      workdirContent = [
        '<<<<<<< HEAD', 'a-ours', '=======', 'a-theirs', '>>>>>>> other',
        'mid',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
      ].join('\n');
      let aiCalls = 0;
      aiSuggestion = () => {
        aiCalls++;
        return Promise.reject(new Error('ai down'));
      };

      const el = await renderLoadedEditor();
      await internalOf(el).handleAiResolveAll();

      expect(aiCalls).to.equal(1);
      expect(internalOf(el).segments.filter((s) => s.type === 'conflict').length).to.equal(2);
    });

    it('skips blocks the user resolved mid-batch instead of aborting', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      workdirContent = [
        '<<<<<<< HEAD', 'a-ours', '=======', 'a-theirs', '>>>>>>> other',
        'mid',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
      ].join('\n');

      const el = await renderLoadedEditor();
      let aiCalls = 0;
      aiSuggestion = () => {
        aiCalls++;
        if (aiCalls === 1) {
          // While the FIRST block's suggestion is in flight, the user
          // manually resolves the SECOND block. The batch must skip it —
          // not treat it as a failure and abandon the rest.
          const second = el.shadowRoot!.querySelectorAll('.code-conflict-block')[1];
          const useOurs = Array.from(second.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Use Ours'
          ) as HTMLButtonElement;
          useOurs.click();
        }
        return Promise.resolve({ resolvedContent: 'ai-resolved', explanation: '' });
      };

      await internalOf(el).handleAiResolveAll();
      await el.updateComplete;

      // Only the first block needed an AI call; the second was skipped as
      // already-resolved rather than aborting the batch.
      expect(aiCalls).to.equal(1);
      expect(internalOf(el).segments.filter((s) => s.type === 'conflict').length).to.equal(0);
    });

    it('disables AI Suggest on every block while one suggestion is in flight', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      workdirContent = [
        '<<<<<<< HEAD', 'a-ours', '=======', 'a-theirs', '>>>>>>> other',
        'mid',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
      ].join('\n');
      let release: (() => void) | null = null;
      aiSuggestion = () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ resolvedContent: 'ai-resolved', explanation: '' });
        });

      const el = await renderLoadedEditor();
      const blocks = el.shadowRoot!.querySelectorAll('.code-conflict-block');
      expect(blocks.length).to.equal(2);

      const aiBtn = (block: Element) =>
        Array.from(block.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('AI')
        ) as HTMLButtonElement;

      aiBtn(blocks[0]).click();
      await el.updateComplete;

      // The OTHER block's AI button must also be disabled — clicking it would
      // silently no-op otherwise.
      const secondBtn = aiBtn(el.shadowRoot!.querySelectorAll('.code-conflict-block')[1]);
      expect(secondBtn.disabled).to.be.true;

      release!();
      await new Promise((r) => setTimeout(r, 20));
      await el.updateComplete;
    });

    it('AI Resolve All stops when the file changes under it and releases the lock', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      workdirContent = [
        '<<<<<<< HEAD', 'a-ours', '=======', 'a-theirs', '>>>>>>> other',
        'mid',
        '<<<<<<< HEAD', 'b-ours', '=======', 'b-theirs', '>>>>>>> other',
      ].join('\n');
      let aiCalls = 0;
      let releaseFirst: (() => void) | null = null;
      aiSuggestion = () => {
        aiCalls++;
        if (aiCalls === 1) {
          return new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ resolvedContent: 'ai-resolved', explanation: '' });
          });
        }
        return Promise.resolve({ resolvedContent: 'ai-resolved', explanation: '' });
      };

      const el = await renderLoadedEditor('src/a.ts');
      const internal = el as unknown as EditorInternal & {
        suggestingAll: boolean;
        handleAiResolveAll: () => Promise<void>;
      };
      const batch = internal.handleAiResolveAll.call(el);
      await el.updateComplete;
      expect(internal.suggestingAll).to.be.true;

      // Switch files while the first suggestion is in flight — the batch must
      // stop instead of grinding stale ids, and the lock must release for the
      // new file.
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;
      expect(internal.suggestingAll).to.be.false;

      releaseFirst!();
      await batch;
      await el.updateComplete;

      // Only the first (pre-switch) call was made — the loop broke on the
      // epoch change instead of iterating file A's remaining stale ids.
      expect(aiCalls).to.equal(1);
      expect(internal.suggestingAll).to.be.false;
    });

    it('a stale AI call from a previous file does not clear the new file\'s in-flight flag', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      const releases: Array<() => void> = [];
      aiSuggestion = () =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve({ resolvedContent: 'ai-resolved', explanation: '' })
          );
        });

      // Start a suggestion on file A, then switch to file B mid-flight.
      const el = await renderLoadedEditor('src/a.ts');
      findConflictButton(el, 'AI Suggest').click();
      await el.updateComplete;

      const internal = internalOf(el);
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;

      // Start a suggestion on file B (the switch reset the in-flight flag).
      findConflictButton(el, 'AI Suggest').click();
      await el.updateComplete;

      // File A's stale call resolves — it must not clear B's in-flight flag,
      // or the AI buttons would re-enable while B's call is still running.
      releases[0]!();
      await new Promise((r) => setTimeout(r, 30));
      await el.updateComplete;

      const aiBtn = Array.from(
        el.shadowRoot!.querySelector('.code-conflict-block')!.querySelectorAll('button')
      ).find((b) => b.textContent?.includes('AI')) as HTMLButtonElement;
      expect(aiBtn.disabled).to.be.true;

      // Release B's call and let it settle.
      releases[1]!();
      await new Promise((r) => setTimeout(r, 30));
      await el.updateComplete;
      expect(internalOf(el).segments.some((s) => s.origin === 'ai')).to.be.true;
    });

    it('a slow AI suggestion never overwrites a manual resolution made mid-flight', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      let releaseAi: (() => void) | null = null;
      aiSuggestion = () =>
        new Promise((resolve) => {
          releaseAi = () =>
            resolve({ resolvedContent: 'ai-resolved', explanation: 'from ai' });
        });

      const el = await renderLoadedEditor();
      findConflictButton(el, 'AI Suggest').click();
      await el.updateComplete;

      // While the suggestion is in flight, the user picks a side manually.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(internalOf(el).segments[1].origin).to.equal('ours');

      // The late AI response must not replace the user's explicit pick.
      releaseAi!();
      await new Promise((r) => setTimeout(r, 30));
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.origin).to.equal('ours');
      expect(resolved.lines).to.deep.equal(['line2-ours']);
      expect(shadowText(el)).to.not.include('from ai');
    });

    it('treats an empty AI suggestion as removing the section, not a blank line', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      aiSuggestion = () => Promise.resolve({ resolvedContent: '', explanation: '' });

      const el = await renderLoadedEditor();
      findConflictButton(el, 'AI Suggest').click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const resolved = internalOf(el).segments[1];
      expect(resolved.type).to.equal('resolved');
      expect(resolved.lines).to.deep.equal([]);
    });

    it('rejects an AI suggestion that contains conflict markers', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      aiSuggestion = () =>
        Promise.resolve({
          resolvedContent: 'ok line\n<<<<<<< HEAD\nleak\n=======',
          explanation: 'bad',
        });

      const el = await renderLoadedEditor();
      findConflictButton(el, 'AI Suggest').click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // The block stays unresolved and no marker text reaches the DOM.
      expect(internalOf(el).segments[1].type).to.equal('conflict');
      expectNoMarkers(el);
    });

    it('drops a stale AI explanation when the block is reset or re-picked', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      const el = await renderLoadedEditor();

      findConflictButton(el, 'AI Suggest').click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;
      expect(shadowText(el)).to.include('merged by ai');

      // Reset the block: the explanation no longer describes anything.
      const resetBtn = Array.from(el.shadowRoot!.querySelectorAll('.segment-btn')).find(
        (b) => b.textContent?.trim() === 'Reset'
      ) as HTMLButtonElement;
      resetBtn.click();
      await el.updateComplete;
      expect(shadowText(el)).to.not.include('merged by ai');

      // Re-picking a side must not resurrect it.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(shadowText(el)).to.not.include('merged by ai');
    });

    it('clears AI explanations when a different file loads', async () => {
      setupDefaultMocks();
      aiAvailable = true;
      const el = await renderLoadedEditor();
      findConflictButton(el, 'AI Suggest').click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;
      expect(shadowText(el)).to.include('merged by ai');

      const internal = internalOf(el);
      internal.conflictFile = makeConflictFile('src/other.ts');
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(shadowText(el)).to.not.include('merged by ai');
    });
  });

  // ── Unsaved-work tracking ─────────────────────────────────────────────
  describe('hasUnsavedResolutions', () => {
    it('tracks picks as unsaved until Mark Resolved writes them', async () => {
      const el = await renderLoadedEditor();
      expect(el.hasUnsavedResolutions()).to.be.false;

      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;

      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      markBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // The picks are on disk now — navigating away is safe.
      expect(el.hasUnsavedResolutions()).to.be.false;

      // A new edit after saving is unsaved again.
      const editBtn = el.shadowRoot!.querySelector('.output-segment .segment-btn') as HTMLButtonElement;
      editBtn.click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;
    });

    it('counts a whole-file accept as unsaved work too', async () => {
      const el = await renderLoadedEditor();
      // Whole-file accepts create segments without fromConflict — they must
      // still be protected from a silent discard on file switch.
      const useOurs = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions .btn-ours')).find(
        (b) => b.textContent?.trim() === 'Use Ours'
      ) as HTMLButtonElement;
      useOurs.click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;
    });
  });

  // ── External tool session signaling ──────────────────────────────────
  describe('external tool session signaling', () => {
    it('announces tool start/finish so the host can lock destructive actions', async () => {
      setupDefaultMocks();
      let releaseTool: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') {
          return new Promise((res) => {
            releaseTool = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor();
      const events: string[] = [];
      el.addEventListener('external-tool-started', () => events.push('started'));
      el.addEventListener('external-tool-finished', () => events.push('finished'));

      const toolBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.includes('External Tool')
      ) as HTMLButtonElement;
      expect(toolBtn, 'external tool button rendered').to.not.be.undefined;
      toolBtn.click();
      await el.updateComplete;

      expect(events).to.deep.equal(['started']);

      releaseTool!();
      await new Promise((r) => setTimeout(r, 30));
      await el.updateComplete;

      expect(events).to.deep.equal(['started', 'finished']);
    });

    it("an unrelated file's tool completion must not wipe the current file's picks", async () => {
      setupDefaultMocks();
      let releaseTool: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') {
          return new Promise((res) => {
            releaseTool = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/a.ts');
      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
      };

      // Launch the external tool for file A.
      const toolPromise = internal.handleOpenExternalMergeTool.call(el);
      await el.updateComplete;

      // Switch to file B while A's tool is still open.
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;

      // While ANY tool session is open, in-memory picks are inert (they
      // could be wiped by a post-tool reload, so they are blocked outright)
      // and the buttons say so.
      const useOurs = findConflictButton(el, 'Use Ours');
      expect(useOurs.disabled, 'picks are disabled during a tool session').to.be.true;
      useOurs.click();
      await el.updateComplete;
      expect(
        internal.segments.filter((s) => s.type === 'resolved' && s.origin === 'ours').length,
        'a click during the session must not resolve anything'
      ).to.equal(0);

      // A's external tool now finishes — its completion must only touch A,
      // never reload the file the user has since switched to, and B's
      // blocks re-enable for normal work.
      releaseTool!();
      await toolPromise;
      await el.updateComplete;

      expect(findConflictButton(el, 'Use Ours').disabled).to.be.false;
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const resolvedCountAfter = internal.segments.filter(
        (s) => s.type === 'resolved' && s.origin === 'ours'
      ).length;
      expect(resolvedCountAfter, "B's picks work normally after the session ends").to.equal(1);
    });

    it('all in-memory mutations are inert while a tool session is open', async () => {
      setupDefaultMocks();
      let releaseTool: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') {
          return new Promise((res) => {
            releaseTool = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
        acceptWholeFile: (origin: string) => void;
        startEditSegment: (segment: unknown) => void;
        handleReload: () => Promise<void>;
        editingSegmentId: number | null;
      };
      const toolPromise = internal.handleOpenExternalMergeTool.call(el);
      await el.updateComplete;

      // Whole-file accept: would be silently destroyed by the post-tool
      // reload — must be a no-op.
      internal.acceptWholeFile.call(el, 'ours');
      await el.updateComplete;
      expect(internal.segments.some((s) => s.type === 'conflict'), 'accept was inert').to.be.true;

      // Opening an inline edit: same fate.
      internal.startEditSegment.call(el, internal.segments[0]);
      expect(internal.editingSegmentId).to.equal(null);

      // Reload: would clear the session's lock semantics mid-flight.
      invokeHistory.length = 0;
      await internal.handleReload.call(el);
      expect(
        invokeHistory.some((h) => h.command === 'read_file_content'),
        'reload was inert'
      ).to.be.false;

      releaseTool!();
      await toolPromise;
    });

    it('a still-conflicted tool exit warns instead of toasting success', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') return { success: true };
        // Post-tool index check: the file is STILL conflicted.
        if (command === 'get_conflicts') {
          return [
            { path: 'src/test.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => {
        resolvedFired = true;
      });

      // Clear toasts accumulated by earlier tests — the store is global.
      const uiState = uiStore.getState();
      uiState.toasts.forEach((t) => uiState.removeToast(t.id));

      const toolBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.includes('External Tool')
      ) as HTMLButtonElement;
      toolBtn.click();
      await new Promise((r) => setTimeout(r, 50));

      // Not resolved: no conflict-resolved dispatch, and the toast is the
      // warning, not the success (mirroring the dialog's launcher).
      expect(resolvedFired).to.be.false;
      const toasts = uiStore.getState().toasts.map((t) => t.message);
      expect(toasts.some((m) => m.includes('still has conflicts'))).to.be.true;
      expect(toasts.some((m) => m.includes('Merge tool completed'))).to.be.false;
    });

    it('a still-conflicted tool exit reloads only when the file is still selected', async () => {
      setupDefaultMocks();
      let releaseTool: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') {
          return new Promise((res) => {
            releaseTool = () => res({ success: true });
          });
        }
        // Post-tool index check: the file is STILL conflicted.
        if (command === 'get_conflicts') {
          return [
            { path: 'src/a.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/a.ts');
      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
      };
      const toolPromise = internal.handleOpenExternalMergeTool.call(el);
      await el.updateComplete;

      // Switch to B while A's tool is open.
      internal.conflictFile = makeConflictFile('src/b.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;

      invokeHistory.length = 0;
      releaseTool!();
      await toolPromise;
      await el.updateComplete;

      // The still-conflicted branch must not reload anything: A is no
      // longer on screen, and reloading B would wipe the state the user is
      // working in.
      expect(
        invokeHistory.some((h) => h.command === 'read_file_content'),
        'no file may be reloaded when the tool file is no longer selected'
      ).to.be.false;
      // B is fully usable after the session ends.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const resolved = internal.segments.filter((s) => s.origin === 'ours').length;
      expect(resolved).to.equal(1);
    });

    it('launching the tool with unsaved picks asks for confirmation first', async () => {
      setupDefaultMocks();
      let launchCalls = 0;
      const baseMock = mockInvoke;
      let confirmAnswer: unknown = false;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (isConfirmCommand(command)) return confirmAnswer;
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return { success: true };
        }
        if (command === 'get_conflicts') {
          return [
            { path: 'src/test.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;

      const toolBtn = () =>
        Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
          (b) => b.textContent?.includes('External Tool')
        ) as HTMLButtonElement;

      // Declined: the tool never launches and the picks stay.
      toolBtn().click();
      await new Promise((r) => setTimeout(r, 50));
      expect(launchCalls).to.equal(0);
      expect(el.hasUnsavedResolutions()).to.be.true;

      // Accepted ('Ok' is the plugin's confirmed value): the tool launches.
      confirmAnswer = 'Ok';
      toolBtn().click();
      await new Promise((r) => setTimeout(r, 80));
      expect(launchCalls).to.equal(1);
    });

    it('a double-click during the confirm window launches only one tool session', async () => {
      setupDefaultMocks();
      let launchCalls = 0;
      let confirmCalls = 0;
      let releaseConfirm: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (isConfirmCommand(command)) {
          confirmCalls++;
          // The native confirm is an async IPC round-trip — a second click
          // can land before it resolves.
          return new Promise((res) => {
            releaseConfirm = () => res('Ok');
          });
        }
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return { success: true };
        }
        if (command === 'get_conflicts') {
          return [
            { path: 'src/test.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;

      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
      };
      // Two rapid invocations: the second must be swallowed by the claimed
      // launch flag, not stack a second confirm/tool session.
      const first = internal.handleOpenExternalMergeTool();
      const second = internal.handleOpenExternalMergeTool();
      await new Promise((r) => setTimeout(r, 30));
      expect(confirmCalls, 'only one confirm may be shown').to.equal(1);
      releaseConfirm!();
      await Promise.all([first, second]);
      await new Promise((r) => setTimeout(r, 30));
      expect(launchCalls, 'only one tool session may launch').to.equal(1);
    });

    it('a lock engaging during the launch confirm makes the launch inert', async () => {
      // The host's Abort/Complete are NOT disabled during this confirm
      // (the tool-session lock is only announced after it) — a launch
      // proceeding after an abort would edit a file the operation no
      // longer owns.
      setupDefaultMocks();
      let launchCalls = 0;
      let startedFired = false;
      let releaseConfirm: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (isConfirmCommand(command)) {
          return new Promise((res) => {
            releaseConfirm = () => res('Ok');
          });
        }
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      el.addEventListener('external-tool-started', () => {
        startedFired = true;
      });
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
        externalToolLocked: boolean;
        launchingExternalTool: boolean;
      };
      const pending = internal.handleOpenExternalMergeTool();
      await new Promise((r) => setTimeout(r, 30));
      // The host locks the editor while the confirm is up (abort/complete
      // started).
      internal.externalToolLocked = true;
      releaseConfirm!();
      await pending;
      await new Promise((r) => setTimeout(r, 30));

      expect(launchCalls, 'the tool must not launch under a host lock').to.equal(0);
      expect(startedFired, 'no tool session may be announced').to.be.false;
      expect(internal.launchingExternalTool, 'the claim is released').to.be.false;
    });

    it('cancelling the confirm releases the launch claim for a later attempt', async () => {
      setupDefaultMocks();
      let launchCalls = 0;
      const baseMock = mockInvoke;
      let confirmAnswer: unknown = false;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (isConfirmCommand(command)) return confirmAnswer;
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return { success: true };
        }
        if (command === 'get_conflicts') {
          return [
            { path: 'src/test.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
      };
      // Declined: the claim must be released, or the button is dead forever.
      await internal.handleOpenExternalMergeTool();
      expect(launchCalls).to.equal(0);
      confirmAnswer = 'Ok';
      await internal.handleOpenExternalMergeTool();
      await new Promise((r) => setTimeout(r, 30));
      expect(launchCalls, 'a fresh attempt after cancel must work').to.equal(1);
    });

    it('resolve actions and the external tool are mutually exclusive', async () => {
      setupDefaultMocks();
      let releaseTool: (() => void) | null = null;
      let launchCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') {
          launchCalls++;
          return new Promise((res) => {
            releaseTool = () => res({ success: true });
          });
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor();
      const internal = el as unknown as EditorInternal & {
        handleOpenExternalMergeTool: () => Promise<void>;
        handleMarkResolved: () => Promise<void>;
      };

      // A synchronous double-invocation must launch the tool exactly once.
      const first = internal.handleOpenExternalMergeTool.call(el);
      const second = internal.handleOpenExternalMergeTool.call(el);
      await el.updateComplete;
      expect(launchCalls).to.equal(1);

      // While the tool session is open, resolve writes must be inert — they
      // would race the tool's eventual save on the same file.
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;
      invokeHistory.length = 0;
      await internal.handleMarkResolved.call(el);
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;

      releaseTool!();
      await Promise.all([first, second]);
    });

    it('the host lock disables the tool button AND resolve writes', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      el.externalToolLocked = true;
      await el.updateComplete;

      const toolBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.includes('External Tool')
      ) as HTMLButtonElement;
      expect(toolBtn.disabled).to.be.true;

      // The dialog's own tool session runs against this same file — resolve
      // writes must also be inert, not just the tool button.
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled).to.be.true;
      invokeHistory.length = 0;
      await (el as unknown as { handleMarkResolved: () => Promise<void> }).handleMarkResolved.call(el);
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
    });

    it('a tool run that fully resolves the file dispatches conflict-resolved', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_merge_tool_config') return { toolName: 'meld' };
        if (command === 'launch_merge_tool') return { success: true };
        // Post-tool index check: the file is no longer conflicted.
        if (command === 'get_conflicts') return [];
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      let resolvedPath: string | null = null;
      el.addEventListener('conflict-resolved', ((e: CustomEvent) => {
        resolvedPath = e.detail.file.path;
      }) as EventListener);

      const toolBtn = Array.from(el.shadowRoot!.querySelectorAll('.toolbar-actions button')).find(
        (b) => b.textContent?.includes('External Tool')
      ) as HTMLButtonElement;
      toolBtn.click();
      await new Promise((r) => setTimeout(r, 50));

      // Matching the dialog's own tool path: the host marks the file
      // resolved instead of leaving it listed as unresolved.
      expect(resolvedPath).to.equal('src/test.ts');
    });
  });

  // ── Binary conflicts ────────────────────────────────────────────────────
  describe('binary conflicts', () => {
    it('renders take-side UI (no text editor) for a binary conflict', async () => {
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = { ...makeConflictFile('image.png'), isBinary: true };
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));
      internal.loading = false;
      await el.updateComplete;

      // No text output panel / editor for binary files.
      expect(el.shadowRoot!.querySelector('.output-panel')).to.be.null;
      expect(el.shadowRoot!.querySelector('.source-panels')).to.be.null;
      // Binary conflict message + side buttons present.
      expect(el.shadowRoot!.textContent).to.include('Binary file conflict');
      expect(el.shadowRoot!.querySelector('.btn-ours')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.btn-theirs')).to.not.be.null;
    });

    it('resolves a binary conflict via resolve_conflict_take_side, not text resolve', async () => {
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = { ...makeConflictFile('image.png'), isBinary: true };
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));
      internal.loading = false;
      await el.updateComplete;

      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => { resolvedFired = true; });

      invokeHistory.length = 0;
      const oursBtn = el.shadowRoot!.querySelector('.btn-ours') as HTMLButtonElement;
      oursBtn.click();
      await new Promise(r => setTimeout(r, 50));

      const takeSide = invokeHistory.find(h => h.command === 'resolve_conflict_take_side');
      expect(takeSide, 'take-side called').to.exist;
      expect((takeSide!.args as Record<string, unknown>).side).to.equal('ours');
      // Text resolve pipeline must NOT be used (would truncate binary to 0 bytes).
      expect(invokeHistory.some(h => h.command === 'resolve_conflict')).to.be.false;
      expect(resolvedFired).to.be.true;
    });

    it('re-selecting an already-resolved binary file shows a terminal state, not a live chooser', async () => {
      // After resolution the file is no longer in the index conflict list;
      // re-rendering the chooser with live buttons would let a second click
      // error "No conflict found".
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        // The file is NOT in the conflict list anymore (already resolved).
        if (command === 'get_conflicts') return [];
        if (command === 'get_blob_content') throw { code: 'IO_ERROR', message: 'binary' };
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = { ...makeConflictFile('image.png'), isBinary: true };
      await el.updateComplete;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading) break;
      }
      await el.updateComplete;

      expect(shadowText(el)).to.include('Resolved — the chosen version was staged');
      expect(el.shadowRoot!.querySelector('.btn-ours'), 'no live chooser buttons').to.be.null;
      expect(el.shadowRoot!.querySelector('.btn-theirs')).to.be.null;
    });
  });

  // ── Deleted-side (modify/delete) conflicts ────────────────────────────────
  describe('deleted-side conflicts', () => {
    it('labels the deleted side and resolves it via take-side (deletion)', async () => {
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      // theirs deleted the file; ours modified it.
      internal.conflictFile = { ...makeConflictFile('src/gone.ts'), theirs: null };
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));
      internal.loading = false;
      await el.updateComplete;

      const theirsBtn = el.shadowRoot!.querySelector('.toolbar-actions .btn-theirs') as HTMLButtonElement;
      expect(theirsBtn.textContent).to.include('delete file');

      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => { resolvedFired = true; });

      invokeHistory.length = 0;
      theirsBtn.click();
      await new Promise(r => setTimeout(r, 50));

      const takeSide = invokeHistory.find(h => h.command === 'resolve_conflict_take_side');
      expect(takeSide, 'take-side called for deleted side').to.exist;
      expect((takeSide!.args as Record<string, unknown>).side).to.equal('theirs');
      expect(invokeHistory.some(h => h.command === 'resolve_conflict')).to.be.false;
      expect(resolvedFired).to.be.true;
    });

    it('the pane-header Use (delete) stays enabled during a failed load, like the toolbar', async () => {
      setupDefaultMocks();
      // theirs deleted the file AND the workdir read fails: deletion staging
      // is backend-side and content-independent, so it must stay available.
      workdirContent = () => Promise.reject(new Error('read failed'));
      // The file is STILL conflicted in the index (this is a genuine read
      // failure, not an already-staged deletion).
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_conflicts') {
          return [
            { path: 'src/gone.ts', ancestor: null, ours: null, theirs: null, isBinary: false },
          ];
        }
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean; loadFailed: boolean };
      internal.conflictFile = { ...makeConflictFile('src/gone.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.loadFailed) break;
      }
      await el.updateComplete;
      expect(internal.loadFailed).to.be.true;

      const theirsHeaderUse = el.shadowRoot!.querySelector(
        '.panel-header.theirs .panel-header-btn'
      ) as HTMLButtonElement;
      expect(theirsHeaderUse.textContent).to.include('delete');
      expect(theirsHeaderUse.disabled).to.be.false;
      // The content-dependent ours side stays disabled.
      const oursHeaderUse = el.shadowRoot!.querySelector(
        '.panel-header.ours .panel-header-btn'
      ) as HTMLButtonElement;
      expect(oursHeaderUse.disabled).to.be.true;
    });

    it('the pane-header Use button also resolves a deleted side as a deletion', async () => {
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      // theirs deleted the file; ours modified it.
      internal.conflictFile = { ...makeConflictFile('src/gone.ts'), theirs: null };
      await el.updateComplete;
      await new Promise(r => setTimeout(r, 50));
      internal.loading = false;
      await el.updateComplete;

      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => { resolvedFired = true; });

      // The THEIRS pane-header "Use" button must stage the deletion like the
      // toolbar button — not write a 0-byte file from the empty side content.
      invokeHistory.length = 0;
      const theirsHeaderUse = el.shadowRoot!.querySelector(
        '.panel-header.theirs .panel-header-btn'
      ) as HTMLButtonElement;
      theirsHeaderUse.click();
      await new Promise(r => setTimeout(r, 50));

      const takeSide = invokeHistory.find(h => h.command === 'resolve_conflict_take_side');
      expect(takeSide, 'take-side called from pane header').to.exist;
      expect((takeSide!.args as Record<string, unknown>).side).to.equal('theirs');
      expect(invokeHistory.some(h => h.command === 'resolve_conflict')).to.be.false;
      expect(resolvedFired).to.be.true;
    });
  });

  // ── Hand-edit marker confirmation ─────────────────────────────────────
  describe('hand-edit marker confirmation', () => {
    async function renderWithEdit(): Promise<{
      el: GnMergeEditor;
      internal: EditorInternal & {
        startEditSegment: (segment: unknown) => void;
        applyEditSegment: () => Promise<void>;
        editingSegmentId: number | null;
        editDraft: string;
      };
    }> {
      const el = await renderLoadedEditor('src/test.ts');
      const internal = el as unknown as EditorInternal & {
        startEditSegment: (segment: unknown) => void;
        applyEditSegment: () => Promise<void>;
        editingSegmentId: number | null;
        editDraft: string;
      };
      const conflict = internal.segments.find((s) => s.type === 'conflict')!;
      internal.startEditSegment.call(el, conflict);
      await el.updateComplete;
      return { el, internal };
    }

    it('a pasted marker line asks for confirmation and declining keeps the edit open', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return false; // decline
        }
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId;
      internal.editDraft = '<<<<<<< HEAD\npasted raw conflict text';
      await internal.applyEditSegment.call(el);
      await el.updateComplete;

      expect(confirmCalls, 'marker-shaped edit must confirm').to.equal(1);
      expect(internal.editingSegmentId, 'declining keeps the edit open').to.equal(editedId);
      expect(
        internal.segments.find((s) => s.id === editedId)?.type,
        'the segment stays an open conflict'
      ).to.equal('conflict');
    });

    it('confirming keeps intentional marker-like text (setext underlines are legal)', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) return 'Ok';
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId!;
      internal.editDraft = 'Heading\n=======';
      await internal.applyEditSegment.call(el);
      await el.updateComplete;

      const segment = internal.segments.find((s) => s.id === editedId)!;
      expect(segment.type).to.equal('resolved');
      expect(segment.lines).to.deep.equal(['Heading', '=======']);
      expect(internal.editingSegmentId).to.equal(null);
    });

    it('a lock engaging during the confirm window makes the apply inert', async () => {
      setupDefaultMocks();
      let releaseConfirm: (() => void) | null = null;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          return new Promise((res) => {
            releaseConfirm = () => res('Ok');
          });
        }
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId!;
      internal.editDraft = '<<<<<<< HEAD\npasted';
      const applying = internal.applyEditSegment.call(el);
      await new Promise((r) => setTimeout(r, 10));

      // A host tool session starts while the confirm is up — the apply
      // must re-check the lock after the await, like Reload does.
      el.externalToolLocked = true;
      releaseConfirm!();
      await applying;
      await el.updateComplete;

      expect(
        internal.segments.find((s) => s.id === editedId)?.type,
        'the apply must be inert once the lock engaged'
      ).to.equal('conflict');
      el.externalToolLocked = false;
    });

    it('whole-file accept with an open edit draft confirms before discarding it', async () => {
      setupDefaultMocks();
      let confirmAnswer: unknown = false;
      let confirmCalls = 0;
      const confirms: { title?: string; message?: string }[] = [];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return confirmAnswer;
        }
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId!;
      internal.editDraft = 'careful hand-typed merge';
      const accept = (el as unknown as { acceptWholeFile: (o: string) => Promise<void> })
        .acceptWholeFile;

      // Declined: the draft and the open edit survive.
      await accept.call(el, 'ours');
      await el.updateComplete;
      expect(confirmCalls).to.equal(1);
      // The draft is the ONLY unsaved work here — a freshly loaded file with
      // an edit opened on it. The dialog must name the typed text it is about
      // to throw away, and must not enumerate picks the user never made.
      expect(confirms[0].title).to.equal('Replace in-progress resolution?');
      expect(
        confirms[0].message,
        'the open draft is not in the output, so it must be named explicitly'
      ).to.contain('discards the edit that was typed but not applied');
      expect(
        confirms[0].message,
        'no pick, edit or whole-file choice exists to replace'
      ).to.not.contain('currently in the output');
      expect(internal.editingSegmentId, 'declining keeps the edit open').to.equal(editedId);
      expect(internal.editDraft).to.equal('careful hand-typed merge');

      // Accepted: the whole file replaces the segments.
      confirmAnswer = 'Ok';
      await accept.call(el, 'ours');
      await el.updateComplete;
      expect(internal.editingSegmentId).to.equal(null);
      expect(internal.segments.length).to.equal(1);
      expect(internal.segments[0].origin).to.equal('ours');
    });

    it('whole-file accept with BOTH output work and an open draft names both losses', async () => {
      setupDefaultMocks();
      const confirms: { title?: string; message?: string }[] = [];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return false; // decline
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      // A real pick lands in the output...
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const internal = internalOf(el) as EditorInternal & {
        editingSegmentId: number | null;
        editDraft: string;
      };
      // ...and an inline edit is opened on top of it, which is NOT in the output.
      await (
        el as unknown as { startEditSegment: (s: unknown) => Promise<void> }
      ).startEditSegment.call(el, internal.segments[0]);
      await el.updateComplete;
      internal.editDraft = 'typed but never applied';

      await (
        el as unknown as { acceptWholeFile: (origin: string) => Promise<void> }
      ).acceptWholeFile.call(el, 'theirs');
      await el.updateComplete;

      expect(confirms).to.have.length(1);
      expect(confirms[0].message).to.contain(
        'replaces the picks, edits and whole-file choice currently in the output'
      );
      expect(confirms[0].message, 'the open draft is lost too and must be named').to.contain(
        'discards the edit that was typed but not applied'
      );
      // Declining keeps both.
      expect(internal.editingSegmentId).to.not.equal(null);
      expect(internal.editDraft).to.equal('typed but never applied');
    });

    it('a whole-file accept plus an open draft is not described as conflict picks', async () => {
      setupDefaultMocks();
      const confirms: { title?: string; message?: string }[] = [];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return false; // decline
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = internalOf(el) as EditorInternal & {
        editingSegmentId: number | null;
        editDraft: string;
      };
      const accept = (el as unknown as { acceptWholeFile: (o: string) => Promise<void> })
        .acceptWholeFile;

      // Toolbar "Use Ours" puts a whole-file accept — and nothing else — in
      // the output. It has nothing to replace, so it must not confirm.
      await accept.call(el, 'ours');
      await el.updateComplete;
      expect(confirms, 'the first whole-file accept replaces nothing').to.have.length(0);
      expect(internal.segments.length).to.equal(1);

      // Opening an edit on that accepted segment takes outputIsWholeFileAccept
      // false, so the NEXT whole-file button does confirm.
      await (
        el as unknown as { startEditSegment: (s: unknown) => Promise<void> }
      ).startEditSegment.call(el, internal.segments[0]);
      await el.updateComplete;
      internal.editDraft = 'typed but never applied';

      await accept.call(el, 'theirs');
      await el.updateComplete;

      expect(confirms).to.have.length(1);
      expect(confirms[0].title).to.equal('Replace in-progress resolution?');
      expect(
        confirms[0].message,
        'the only thing in the output is the whole-file choice — name it, not picks'
      ).to.not.contain('conflict pick');
      expect(confirms[0].message).to.contain(
        'replaces the picks, edits and whole-file choice currently in the output'
      );
      expect(confirms[0].message, 'the open draft is lost too and must be named').to.contain(
        'discards the edit that was typed but not applied'
      );
      // Declining keeps the accepted side and the draft.
      expect(internal.segments[0].origin).to.equal('ours');
      expect(internal.editingSegmentId).to.not.equal(null);
      expect(internal.editDraft).to.equal('typed but never applied');
    });

    it('take-side with only an open draft names the draft, not absent picks', async () => {
      setupDefaultMocks();
      const confirms: { title?: string; message?: string }[] = [];
      let takeSideCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return false; // decline
        }
        if (command === 'resolve_conflict_take_side') {
          takeSideCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = internalOf(el) as EditorInternal & {
        editingSegmentId: number | null;
        editDraft: string;
      };
      // A modify/delete conflict: theirs dropped the file, so the toolbar
      // offers "Use Theirs (delete file)" -> handleTakeSide directly.
      internal.conflictFile = { ...makeConflictFile('src/test.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;
      expect(internal.segments.length, 'the marker-free workdir file renders as output').to.be
        .greaterThan(0);

      await (
        el as unknown as { startEditSegment: (s: unknown) => Promise<void> }
      ).startEditSegment.call(el, internal.segments[0]);
      await el.updateComplete;
      internal.editDraft = 'typed but never applied';

      await (
        el as unknown as { handleTakeSide: (side: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;

      expect(confirms).to.have.length(1);
      expect(confirms[0].title).to.equal('Take this whole side?');
      expect(confirms[0].message).to.contain('deletes the file and stages the deletion');
      expect(
        confirms[0].message,
        'the typed text is the only thing being discarded — say so'
      ).to.contain('discarding the edit that was typed but not applied');
      expect(
        confirms[0].message,
        'no pick or whole-file choice is in the output to lose'
      ).to.not.contain('picks, edits and whole-file choice');
      // Declining writes nothing and keeps the draft.
      expect(takeSideCalls).to.equal(0);
      expect(internal.editingSegmentId).to.not.equal(null);
      expect(internal.editDraft).to.equal('typed but never applied');
    });

    it('whole-file accepts do not confirm before any in-editor work exists', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return 'Ok';
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();

      await (
        el as unknown as { acceptWholeFile: (origin: string) => Promise<void> }
      ).acceptWholeFile.call(el, 'ours');
      await (
        el as unknown as { acceptWholeFile: (origin: string) => Promise<void> }
      ).acceptWholeFile.call(el, 'ours');
      await el.updateComplete;

      expect(confirmCalls).to.equal(0);
      expect(internalOf(el).segments).to.have.length(1);
      expect(internalOf(el).segments[0].origin).to.equal('ours');
    });

    it('swapping between whole-file sides does not confirm — nothing is lost', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return 'Ok';
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = internalOf(el);
      const accept = (el as unknown as { acceptWholeFile: (o: string) => Promise<void> })
        .acceptWholeFile;

      await accept.call(el, 'ours');
      await el.updateComplete;
      expect(internal.segments[0].origin).to.equal('ours');

      // Comparing the sides is a browse action, not a destructive one.
      await accept.call(el, 'theirs');
      await el.updateComplete;
      expect(confirmCalls, 'swapping whole-file sides must not confirm').to.equal(0);
      expect(internal.segments).to.have.length(1);
      expect(internal.segments[0].origin).to.equal('theirs');
      expect(internal.segments[0].lines.join('\n')).to.equal(internal.theirsContent);

      await accept.call(el, 'base');
      await el.updateComplete;
      expect(confirmCalls).to.equal(0);
      expect(internal.segments[0].origin).to.equal('base');
      expect(internal.segments[0].lines.join('\n')).to.equal(internal.baseContent);

      // And back — the first side is one click away, so it stays silent too.
      await accept.call(el, 'ours');
      await el.updateComplete;
      expect(confirmCalls).to.equal(0);
      expect(internal.segments[0].origin).to.equal('ours');
      expect(internal.segments[0].lines.join('\n')).to.equal(internal.oursContent);
    });

    it('hand-editing a whole-file accept makes the next whole-file pick confirm', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return false; // decline
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = el as unknown as EditorInternal & {
        startEditSegment: (segment: unknown) => Promise<void>;
        applyEditSegment: () => Promise<void>;
        editDraft: string;
        acceptWholeFile: (origin: string) => Promise<void>;
      };
      await internal.acceptWholeFile.call(el, 'ours');
      await el.updateComplete;
      await internal.startEditSegment.call(el, internal.segments[0]);
      internal.editDraft = 'hand written';
      await internal.applyEditSegment.call(el);
      await el.updateComplete;

      await internal.acceptWholeFile.call(el, 'theirs');
      await el.updateComplete;

      expect(confirmCalls, 'a typed edit is real work and must confirm').to.equal(1);
      expect(internal.segments[0].lines).to.deep.equal(['hand written']);
      expect(internal.segments[0].origin).to.equal('manual');
    });

    it('a per-block pick that fills the whole file still confirms and is replaced', async () => {
      // One conflict block IS the whole file, so a per-block "Use Ours"
      // leaves a single ours-origin segment — but its lines are the block's
      // ours side, not the ours blob, so the toolbar button must still act.
      setupDefaultMocks();
      let confirmAnswer: unknown = false;
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return confirmAnswer;
        }
        if (command === 'get_blob_content') {
          const oid = (args as { oid: string })?.oid;
          if (oid === 'ours-oid') return 'ours-line\ntail';
          if (oid === 'theirs-oid') return 'theirs-line\ntail';
          return 'base-line\ntail';
        }
        return baseMock(command, args);
      };
      workdirContent = '<<<<<<< HEAD\nours-line\n=======\ntheirs-line\n>>>>>>> feature';
      const el = await renderEditor();
      const internal = internalOf(el);
      internal.conflictFile = {
        ...makeConflictFile('src/test.ts'),
        conflictHunks: [{ start: 0, separator: 2, end: 4 }],
      };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;
      expect(internal.segments).to.have.length(1);

      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(internal.segments[0].origin).to.equal('ours');
      expect(internal.segments[0].fromConflict).to.be.true;
      const before = structuredClone(internal.segments);

      const accept = (el as unknown as { acceptWholeFile: (o: string) => Promise<void> })
        .acceptWholeFile;
      await accept.call(el, 'ours');
      await el.updateComplete;

      expect(confirmCalls, 'a per-block pick is real work and must confirm').to.equal(1);
      expect(internal.segments, 'declining keeps the pick').to.deep.equal(before);

      confirmAnswer = 'Ok';
      await accept.call(el, 'ours');
      await el.updateComplete;

      expect(confirmCalls).to.equal(2);
      expect(internal.segments).to.have.length(1);
      expect(internal.segments[0].fromConflict).to.be.false;
      expect(
        internal.segments[0].lines,
        'the whole ours blob replaces the block-only pick'
      ).to.deep.equal(['ours-line', 'tail']);
    });

    for (const origin of ['ours', 'theirs'] as const) {
      it(`whole-file ${origin} confirms before replacing per-block resolutions`, async () => {
        setupDefaultMocks();
        let confirmAnswer: unknown = false;
        let confirmCalls = 0;
        const baseMock = mockInvoke;
        mockInvoke = async (command: string, args?: unknown) => {
          if (isConfirmCommand(command)) {
            confirmCalls++;
            return confirmAnswer;
          }
          return baseMock(command, args);
        };
        const el = await renderLoadedEditor();
        findConflictButton(el, 'Use Both').click();
        await el.updateComplete;
        const before = structuredClone(internalOf(el).segments);

        const accept = (
          el as unknown as { acceptWholeFile: (selected: string) => Promise<void> }
        ).acceptWholeFile;
        await accept.call(el, origin);
        await el.updateComplete;

        expect(confirmCalls).to.equal(1);
        expect(internalOf(el).segments).to.deep.equal(before);

        confirmAnswer = 'Ok';
        await accept.call(el, origin);
        await el.updateComplete;

        expect(confirmCalls).to.equal(2);
        expect(internalOf(el).segments).to.have.length(1);
        expect(internalOf(el).segments[0].origin).to.equal(origin);
      });
    }

    it('declining a verbatim take-side preserves per-block resolutions', async () => {
      setupDefaultMocks();
      let takeSideCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) return false;
        if (command === 'resolve_conflict_take_side') {
          takeSideCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const before = structuredClone(internalOf(el).segments);

      await (
        el as unknown as { handleTakeSide: (side: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;

      expect(takeSideCalls).to.equal(0);
      expect(internalOf(el).segments).to.deep.equal(before);
      expect(el.hasUnsavedResolutions()).to.be.true;
    });

    it('accepting a deleted whole-file side confirms only once before taking it', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      let takeSideCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return 'Ok';
        }
        if (command === 'resolve_conflict_take_side') {
          takeSideCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = internalOf(el);
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      internal.conflictFile = { ...internal.conflictFile!, theirs: null };

      await (
        el as unknown as { acceptWholeFile: (origin: string) => Promise<void> }
      ).acceptWholeFile.call(el, 'theirs');
      await el.updateComplete;

      expect(confirmCalls).to.equal(1);
      expect(takeSideCalls).to.equal(1);
    });

    it('the deleted-side take confirm names the staged deletion, not an output swap', async () => {
      // Modify/delete: git leaves the workdir file marker-free, so the output
      // parses to ONE plain segment with no per-block buttons at all. The only
      // route to this confirm is Use Ours followed by a change of mind — so
      // there is no conflict pick and no edit to "replace", and the thing the
      // user must be told is that the file gets deleted and staged.
      setupDefaultMocks();
      workdirContent = 'const value = "ours";';
      const confirms: { title?: string; message?: string }[] = [];
      let takeSideCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return false; // decline
        }
        if (command === 'resolve_conflict_take_side') {
          takeSideCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = internalOf(el);
      internal.conflictFile = { ...makeConflictFile('src/test.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;
      expect(el.shadowRoot!.querySelector('.code-conflict-block'), 'no per-block buttons exist')
        .to.be.null;

      await (
        el as unknown as { acceptWholeFile: (origin: string) => Promise<void> }
      ).acceptWholeFile.call(el, 'ours');
      await el.updateComplete;
      expect(confirms, 'the first whole-file accept has nothing to replace').to.have.length(0);
      const before = structuredClone(internal.segments);

      await (
        el as unknown as { handleTakeSide: (side: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;

      expect(confirms).to.have.length(1);
      expect(confirms[0].title).to.equal('Take this whole side?');
      expect(confirms[0].message).to.contain('deletes the file and stages the deletion');
      expect(
        confirms[0].message,
        'the in-editor whole-file lead describes a swap that is not what happens here'
      ).to.not.contain('Using one whole-file version');
      // Declining leaves the accepted side in place and writes nothing.
      expect(takeSideCalls).to.equal(0);
      expect(internal.segments).to.deep.equal(before);
    });

    it('a verbatim take-side confirm names the on-disk write, not an output swap', async () => {
      setupDefaultMocks();
      const confirms: { title?: string; message?: string }[] = [];
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          const shown = (args ?? {}) as { title?: string; message?: string };
          confirms.push({ title: shown.title, message: shown.message });
          return false;
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;

      await (
        el as unknown as { handleTakeSide: (side: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;

      expect(confirms).to.have.length(1);
      expect(confirms[0].title).to.equal('Take this whole side?');
      expect(confirms[0].message).to.contain('writes it to disk and stages the file');
    });

    it('serializes take-side clicks while the overwrite confirmation is open', async () => {
      setupDefaultMocks();
      let releaseConfirm: (() => void) | null = null;
      let confirmCalls = 0;
      let takeSideCalls = 0;
      let externalToolCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return new Promise((resolve) => {
            releaseConfirm = () => resolve('Ok');
          });
        }
        if (command === 'resolve_conflict_take_side') {
          takeSideCalls++;
          return { success: true };
        }
        if (command === 'launch_merge_tool') {
          externalToolCalls++;
          return { success: true };
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      const takeSide = (
        el as unknown as { handleTakeSide: (side: string) => Promise<void> }
      ).handleTakeSide;

      const first = takeSide.call(el, 'theirs');
      const second = takeSide.call(el, 'theirs');
      await (
        el as unknown as { handleOpenExternalMergeTool: () => Promise<void> }
      ).handleOpenExternalMergeTool.call(el);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(confirmCalls).to.equal(1);
      expect(externalToolCalls).to.equal(0);

      releaseConfirm!();
      await Promise.all([first, second]);
      expect(takeSideCalls).to.equal(1);
    });

    it('opening Edit on another segment confirms before discarding the open draft', async () => {
      setupDefaultMocks();
      let confirmAnswer: unknown = false;
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return confirmAnswer;
        }
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId!;
      internal.editDraft = 'careful hand-typed merge';

      const other = internal.segments.find((s) => s.id !== editedId)!;
      const start = (
        el as unknown as { startEditSegment: (s: unknown) => Promise<void> }
      ).startEditSegment;

      // Declined: the original draft and target stay.
      await start.call(el, other);
      await el.updateComplete;
      expect(confirmCalls).to.equal(1);
      expect(internal.editingSegmentId).to.equal(editedId);
      expect(internal.editDraft).to.equal('careful hand-typed merge');

      // Accepted: the edit retargets.
      confirmAnswer = 'Ok';
      await start.call(el, other);
      await el.updateComplete;
      expect(internal.editingSegmentId).to.equal(other.id);
    });

    it('marker-free edits apply without any confirmation', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return 'Ok';
        }
        return baseMock(command, args);
      };
      const { el, internal } = await renderWithEdit();
      const editedId = internal.editingSegmentId!;
      internal.editDraft = 'hand merged';
      await internal.applyEditSegment.call(el);
      await el.updateComplete;

      expect(confirmCalls).to.equal(0);
      expect(internal.segments.find((s) => s.id === editedId)?.lines).to.deep.equal([
        'hand merged',
      ]);
    });
  });

  // ── Reload confirmation ───────────────────────────────────────────────
  describe('reload confirmation', () => {
    it('reload with unsaved picks confirms; declining keeps them', async () => {
      setupDefaultMocks();
      let confirmAnswer: unknown = false;
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return confirmAnswer;
        }
        return baseMock(command, args);
      };

      const el = await renderLoadedEditor('src/test.ts');
      const internal = el as unknown as EditorInternal & {
        handleReload: () => Promise<void>;
      };
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;

      // Declined: picks stay, nothing reloads.
      await internal.handleReload.call(el);
      await el.updateComplete;
      expect(confirmCalls).to.equal(1);
      expect(el.hasUnsavedResolutions(), 'declining keeps the picks').to.be.true;

      // Accepted: the file re-parses from disk and the picks are gone.
      confirmAnswer = 'Ok';
      await internal.handleReload.call(el);
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      await el.updateComplete;
      expect(el.hasUnsavedResolutions(), 'accepting reloads from disk').to.be.false;
      expect(internal.segments.some((s) => s.type === 'conflict')).to.be.true;
    });

    it('a successful take-side supersedes stale in-memory picks', async () => {
      // Picks made before a whole-side take are moot once the side is on
      // disk and staged — leaving userTouched set would make Complete raise
      // a false "unsaved rework" confirm on the LAST file (no auto-advance).
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) return 'Ok';
        if (command === 'resolve_conflict_take_side') return { success: true };
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor('src/test.ts');
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      expect(el.hasUnsavedResolutions()).to.be.true;

      await (
        el as unknown as { handleTakeSide: (s: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;
      expect(
        el.hasUnsavedResolutions(),
        'the write supersedes the in-memory picks'
      ).to.be.false;
    });

    it('a take-side DELETION lands in the terminal deleted state, not an error', async () => {
      // Modify/delete conflict, LAST file (no auto-advance): after "Use
      // Theirs (delete file)" the stale parse must not stay on screen with
      // Mark Resolved enabled (one click would fs::write the old content
      // back), and it must NOT reload into the read-failure error whose
      // Retry/verbatim buttons would resurrect the staged deletion.
      setupDefaultMocks();
      let deleted = false;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict_take_side') {
          deleted = true;
          return { success: true };
        }
        if (command === 'read_file_content' && deleted) {
          throw new Error('file deleted');
        }
        return baseMock(command, args);
      };
      // Theirs DELETED the file in this conflict.
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = { ...makeConflictFile('src/test.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;

      await (
        el as unknown as { handleTakeSide: (s: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      await el.updateComplete;

      expect(internalOf(el).loadFailed, 'no false error state').to.be.false;
      expect(shadowText(el)).to.include('deleted by the resolution');
      const markBtn = Array.from(el.shadowRoot!.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Mark Resolved'
      ) as HTMLButtonElement;
      expect(markBtn.disabled, 'Mark Resolved cannot resurrect the file').to.be.true;
      // No resurrect buttons anywhere.
      const verbatimBtns = Array.from(el.shadowRoot!.querySelectorAll('button')).filter(
        (b) => b.textContent?.includes('verbatim') || b.textContent?.trim() === 'Retry'
      );
      expect(verbatimBtns.length).to.equal(0);
    });

    it('RE-SELECTING a file resolved as a deletion shows the terminal state, not an error', async () => {
      // The user resolved file A as a deletion, advanced to B, then clicks
      // A again to double-check. The workdir read fails because the file
      // is correctly GONE — presenting that as a read error (with a Retry
      // that loops forever and a verbatim button that resurrects the
      // deletion) would make a correct resolution look broken.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        // Structured Tauri error: the file is GONE (not merely undecodable).
        if (command === 'read_file_content')
          throw { code: 'FILE_NOT_FOUND', message: 'File not found: src/gone.ts' };
        // The index no longer lists the file — its deletion is staged.
        if (command === 'get_conflicts') return [];
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = { ...makeConflictFile('src/gone.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (
          !internal.loading &&
          ((el as unknown as { resolvedAsDeleted: boolean }).resolvedAsDeleted ||
            internal.loadFailed)
        )
          break;
      }
      await el.updateComplete;

      expect(internal.loadFailed, 'a staged deletion is not an error').to.be.false;
      expect(shadowText(el)).to.include('deleted by the resolution');
      const badButtons = Array.from(el.shadowRoot!.querySelectorAll('button')).filter(
        (b) => b.textContent?.includes('verbatim') || b.textContent?.trim() === 'Retry'
      );
      expect(badButtons.length, 'no resurrect/retry affordances').to.equal(0);
    });

    it('a STILL-conflicted but undecodable file is a read error, never a false "was deleted"', async () => {
      // The file is genuinely still conflicted but its content is
      // legacy-encoded, so the strict read fails the same way a missing
      // file would. Because the index STILL lists it as conflicted, it must
      // land in the honest error state (Retry/verbatim), not a false
      // "was deleted" or a false "resolved" terminal.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'read_file_content')
          throw { code: 'IO_ERROR', message: 'stream did not contain valid UTF-8' };
        if (command === 'get_conflicts') return [{ path: 'src/latin1.ts' }];
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = { ...makeConflictFile('src/latin1.ts'), theirs: null };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;

      expect(internal.loadFailed).to.be.true;
      expect(shadowText(el)).to.include('Could not read the merged file');
      expect(shadowText(el)).to.not.include('deleted by the resolution');
      expect(shadowText(el)).to.not.include('the chosen version was staged');
    });

    it('re-selecting a text file resolved via verbatim take lands terminal, not forever-Retry', async () => {
      // A legacy-encoded file resolved via "Use Theirs (verbatim)" is no
      // longer conflicted, but re-selecting it re-fails the same undecodable
      // read. The index confirms it is resolved, so it must show the
      // terminal notice, not the error state with a looping Retry and
      // verbatim buttons that error "No conflict found".
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'read_file_content')
          throw { code: 'IO_ERROR', message: 'stream did not contain valid UTF-8' };
        // The index no longer lists it — the verbatim take resolved it.
        if (command === 'get_conflicts') return [];
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as EditorInternal;
      internal.conflictFile = makeConflictFile('src/latin1.ts');
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading) break;
      }
      await el.updateComplete;

      expect(internal.loadFailed, 'no forever-Retry error state').to.be.false;
      expect(shadowText(el)).to.include('Resolved — the chosen version was staged');
      expect(el.shadowRoot!.querySelector('.output-error')).to.be.null;
    });

    it('a take-side that KEEPS the file reloads the fresh content', async () => {
      setupDefaultMocks();
      let taken = false;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'resolve_conflict_take_side') {
          taken = true;
          return { success: true };
        }
        if (command === 'read_file_content' && taken) {
          return 'line1\nline2-theirs\nline3';
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor('src/test.ts');
      await (
        el as unknown as { handleTakeSide: (s: string) => Promise<void> }
      ).handleTakeSide.call(el, 'theirs');
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internalOf(el).loading && internalOf(el).segments.length > 0) break;
      }
      await el.updateComplete;

      const internal = internalOf(el);
      expect(internal.loadFailed).to.be.false;
      // The stale conflicted parse is gone; the taken content shows.
      expect(internal.segments.filter((s) => s.type === 'conflict').length).to.equal(0);
      expect(internal.segments.flatMap((s) => s.lines)).to.deep.equal([
        'line1',
        'line2-theirs',
        'line3',
      ]);
    });

    it('reload without unsaved picks does not ask', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return false;
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor('src/test.ts');
      const internal = el as unknown as EditorInternal & {
        handleReload: () => Promise<void>;
      };
      invokeHistory.length = 0;
      await internal.handleReload.call(el);
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && internal.segments.length > 0) break;
      }
      expect(confirmCalls).to.equal(0);
      expect(invokeHistory.some((h) => h.command === 'read_file_content')).to.be.true;
    });
  });

  // ── Hand-deleted separator recovery ──────────────────────────────────────
  describe('hand-deleted separator recovery', () => {
    it('a conflict whose ======= was hand-deleted never shows its orphan end marker', async () => {
      // The user hand-merged and deleted the separator line but left the
      // end marker. Shape-only parsing would sweep the marker into the
      // ours pane — visible AND writable to disk via Accept Ours.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-ours',
        'line2-theirs',
        '>>>>>>> feature',
        'line3',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      expect(internal.segments.map((s) => s.type)).to.deep.equal([
        'resolved',
        'conflict',
        'resolved',
      ]);
      // The blob-validated split recovers both sides; the orphan marker is
      // the region's terminator, not content.
      expect(internal.segments[1].oursLines).to.deep.equal(['line2-ours']);
      expect(internal.segments[1].theirsLines).to.deep.equal(['line2-theirs']);
      expectNoMarkers(el);
    });

    it('a hand-deleted START marker never leaks the orphan =======/>>>>>>> into the UI', async () => {
      // The region scan only OPENS on a <<<<<<< line; deleting it leaves an
      // orphaned separator/end that would otherwise render as resolved text.
      // The safety net presents the whole file as one clean conflict block.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        // <<<<<<< HEAD deleted by hand
        'line2-ours',
        '=======',
        'line2-theirs',
        '>>>>>>> feature',
        'line3',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      // Falls back to a single conflict block (ours-blob vs theirs-blob).
      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expectNoMarkers(el);
    });

    it('a separator-less conflict at EOF (no trailing content) still recovers', async () => {
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-ours',
        'line2-theirs',
        '>>>>>>> feature',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      expect(conflicts[0].oursLines).to.deep.equal(['line2-ours']);
      expect(conflicts[0].theirsLines).to.deep.equal(['line2-theirs']);
      expectNoMarkers(el);
    });

    it('a nested START marker swept into a conflict pane never renders raw', async () => {
      // ours blob = ['line2-ours'], theirs blob = ['line2-theirs']. A nested
      // <<<<<<< inside the body makes the split fall back and pull the start
      // marker into a pane. The safety net must present the whole file as
      // one clean conflict, never a pane containing '<<<<<<<'.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-ours',
        '=======',
        'line2-theirs',
        '<<<<<<< HEAD',
        'extraline',
        '>>>>>>> feature',
        'line3',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      // No pane contains a raw start marker.
      for (const c of conflicts) {
        expect(c.oursLines.some((l) => l.startsWith('<<<<<<<'))).to.be.false;
        expect(c.theirsLines.some((l) => l.startsWith('<<<<<<<'))).to.be.false;
      }
      expectNoMarkers(el);
    });

    it('markers added OUTSIDE a hunk-parsed range (after Reload) never render raw', async () => {
      // The backend hunk positions are fetched once at open and not
      // refreshed by Reload. An externally-added marker block outside the
      // original hunk range would be swept into a resolved segment — the
      // safety net now covers the position-based path too.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-ours',
        '=======',
        'line2-theirs',
        '>>>>>>> feature',
        'line3',
        // Externally pasted leftover markers, OUTSIDE the reported hunk.
        '<<<<<<< OTHER',
        'stray',
        '>>>>>>> OTHER',
      ].join('\n');
      const el = await renderEditor();
      const internal = internalOf(el);
      // Authoritative hunk positions for the ORIGINAL conflict only (lines
      // 1/3/5, 0-based), as fetched at open — they still validate.
      internal.conflictFile = {
        ...makeConflictFile('src/test.ts'),
        conflictHunks: [{ start: 1, separator: 3, end: 5 }],
      };
      await el.updateComplete;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading && (internal.segments.length > 0 || internal.loadFailed)) break;
      }
      await el.updateComplete;

      expectNoMarkers(el);
    });

    it('a deleted separator PLUS an edited body line still keeps the orphan marker out of the panes', async () => {
      // The hand edit removed the separator AND changed a line, so no
      // blob-validated split exists. The orphan end marker must still act
      // as the region terminator — sweeping it into the ours pane would
      // render a raw marker.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-edited',
        'line2-theirs',
        '>>>>>>> feature',
        'line3',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      // No split validates — the body falls back to everything-ours, but
      // the marker itself is consumed as the terminator.
      expect(conflicts[0].oursLines).to.deep.equal(['line2-edited', 'line2-theirs']);
      expect(conflicts[0].theirsLines).to.deep.equal([]);
      // The trailing content after the terminator is normal resolved text.
      expect(internal.segments[internal.segments.length - 1].lines).to.deep.equal(['line3']);
      expectNoMarkers(el);
    });

    it('a hand-typed end-shaped line inside a region never renders raw (whole-file fallback)', async () => {
      // Mid-region junk: an end-shaped line typed BEFORE the real separator.
      // Any split that keeps it as pane content would show a raw >>>>>>>
      // marker, so the safety net presents the whole file as one clean
      // conflict block instead — no marker is ever displayed.
      setupDefaultMocks();
      workdirContent = [
        'line1',
        '<<<<<<< HEAD',
        'line2-ours',
        '>>>>>>> junk',
        '=======',
        'line2-theirs',
        '>>>>>>> feature',
        'line3',
      ].join('\n');
      const el = await renderLoadedEditor();
      const internal = internalOf(el);

      const conflicts = internal.segments.filter((s) => s.type === 'conflict');
      expect(conflicts.length).to.equal(1);
      // No pane contains any raw marker.
      for (const c of conflicts) {
        for (const line of [...c.oursLines, ...c.theirsLines]) {
          expect(/^(<{7,}|={7,}|>{7,}|\|{7,})/.test(line), `pane leaked "${line}"`).to.be.false;
        }
      }
      expectNoMarkers(el);
    });
  });

  // ── Orphan-marker write confirmation ─────────────────────────────────────
  describe('orphan-marker write confirmation', () => {
    /** Load a clean editor, then directly install a RESOLVED segment that
     * carries a real orphaned marker (a marker-shaped line in NEITHER blob,
     * origin != 'manual'). The parser's whole-file fallback prevents this
     * shape from arising via parsing, but the write-time confirm gate is
     * defense-in-depth for any other path (AI, stale segments), so it is
     * tested by constructing the segment directly. */
    async function editorWithOrphanMarkerAccepted(
      confirmAnswers: { calls: number; answer: unknown },
    ): Promise<GnMergeEditor> {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmAnswers.calls++;
          return confirmAnswers.answer;
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      const internal = el as unknown as EditorInternal & {
        segments: OutputSegmentShape[];
        nextSegmentId: number;
      };
      internal.segments = [
        {
          id: internal.nextSegmentId++,
          type: 'resolved',
          lines: ['line2-ours', '>>>>>>> junk'],
          oursLines: [],
          theirsLines: [],
          oursLabel: '',
          theirsLabel: '',
          origin: 'ours',
          fromConflict: true,
        },
      ];
      await el.updateComplete;
      return el;
    }

    it('marking resolved with an orphaned real marker in an accepted side confirms first', async () => {
      const confirms = { calls: 0, answer: false as unknown };
      const el = await editorWithOrphanMarkerAccepted(confirms);
      invokeHistory.length = 0;

      await internalOf(el).handleMarkResolved.call(el);
      expect(confirms.calls, 'must confirm before writing an orphan marker').to.equal(1);
      // Declined: nothing is written.
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
    });

    it('confirming writes the content as-is', async () => {
      const confirms = { calls: 0, answer: 'Ok' as unknown };
      const el = await editorWithOrphanMarkerAccepted(confirms);
      invokeHistory.length = 0;

      await internalOf(el).handleMarkResolved.call(el);
      expect(confirms.calls).to.equal(1);
      const resolve = invokeHistory.find((h) => h.command === 'resolve_conflict');
      expect(resolve, 'confirmed write proceeds').to.exist;
      expect((resolve!.args as { content: string }).content).to.include('>>>>>>> junk');
    });

    it('a clean resolution never raises the orphan-marker confirm', async () => {
      setupDefaultMocks();
      let confirmCalls = 0;
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return false;
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();
      findConflictButton(el, 'Use Ours').click();
      await el.updateComplete;
      invokeHistory.length = 0;

      await internalOf(el).handleMarkResolved.call(el);
      expect(confirmCalls).to.equal(0);
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.true;
    });

    it('Use Base does not false-confirm on a marker-shaped line that is clean ancestor content', async () => {
      // The ancestor blob has a bare `=======` (a Markdown setext
      // underline) that both sides changed away. Use Base stages the clean
      // ancestor verbatim — the orphan-marker check must recognize the
      // line as base blob content, not a real orphaned marker.
      setupDefaultMocks();
      const baseMock = mockInvoke;
      let confirmCalls = 0;
      mockInvoke = async (command: string, args?: unknown) => {
        if (isConfirmCommand(command)) {
          confirmCalls++;
          return false;
        }
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'base-oid') return 'Heading\n=======\nbody';
          if (blobArgs?.oid === 'ours-oid') return 'line1\nline2-ours\nline3';
          if (blobArgs?.oid === 'theirs-oid') return 'line1\nline2-theirs\nline3';
          return '';
        }
        return baseMock(command, args);
      };
      const el = await renderLoadedEditor();

      // Use Base replaces all segments with the ancestor content.
      (el as unknown as { acceptWholeFile: (o: string) => Promise<void> }).acceptWholeFile.call(
        el,
        'base',
      );
      await el.updateComplete;
      invokeHistory.length = 0;

      await internalOf(el).handleMarkResolved.call(el);
      expect(confirmCalls, 'clean ancestor content must not confirm').to.equal(0);
      const resolve = invokeHistory.find((h) => h.command === 'resolve_conflict');
      expect(resolve, 'the base content is written').to.exist;
      expect((resolve!.args as { content: string }).content).to.include('=======');
    });
  });

  // ── Symlink conflicts ─────────────────────────────────────────────────────
  describe('symlink conflicts', () => {
    it('names the conflict a symbolic link conflict and shows both targets', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'ours-oid') return 'target-a';
          if (blobArgs?.oid === 'theirs-oid') return 'target-b';
          return '';
        }
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = {
        ...makeConflictFile('link'),
        isBinary: true,
        ours: { oid: 'ours-oid', path: 'link', mode: 0o120000 },
        theirs: { oid: 'theirs-oid', path: 'link', mode: 0o120000 },
      };
      await el.updateComplete;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading) break;
      }
      await el.updateComplete;

      const text = shadowText(el);
      expect(text).to.include('Symbolic link conflict');
      expect(text).to.not.include('Binary file conflict');
      // The choice is between TARGETS — show them.
      expect(text).to.include('target-a');
      expect(text).to.include('target-b');
      expect(el.shadowRoot!.querySelector('.btn-ours')).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.btn-theirs')).to.not.be.null;
    });

    it('a file<->symlink type conflict labels the regular-file side honestly', async () => {
      setupDefaultMocks();
      const baseMock = mockInvoke;
      mockInvoke = async (command: string, args?: unknown) => {
        if (command === 'get_blob_content') {
          const blobArgs = args as { oid: string };
          if (blobArgs?.oid === 'theirs-oid') return 'target-a';
          return 'file contents';
        }
        return baseMock(command, args);
      };
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = {
        ...makeConflictFile('thing'),
        isBinary: true,
        ours: { oid: 'ours-oid', path: 'thing', mode: 0o100644 },
        theirs: { oid: 'theirs-oid', path: 'thing', mode: 0o120000 },
      };
      await el.updateComplete;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading) break;
      }
      await el.updateComplete;

      const text = shadowText(el);
      expect(text).to.include('Symbolic link conflict');
      expect(text).to.include('a regular file');
      expect(text).to.include('target-a');
    });
  });

  // ── Submodule conflicts ───────────────────────────────────────────────────
  describe('submodule conflicts', () => {
    function makeSubmoduleConflict(): ConflictFile {
      return {
        path: 'sub',
        ancestor: { oid: 'a'.repeat(40), path: 'sub', mode: 0o160000 },
        ours: { oid: 'b'.repeat(40), path: 'sub', mode: 0o160000 },
        theirs: { oid: 'c'.repeat(40), path: 'sub', mode: 0o160000 },
        isBinary: false,
        isSubmodule: true,
      };
    }

    async function renderSubmoduleEditor(
      file: ConflictFile = makeSubmoduleConflict(),
    ): Promise<GnMergeEditor> {
      setupDefaultMocks();
      const el = await renderEditor();
      const internal = el as unknown as { conflictFile: ConflictFile; loading: boolean };
      internal.conflictFile = file;
      await el.updateComplete;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        if (!internal.loading) break;
      }
      await el.updateComplete;
      return el;
    }

    it('renders the commit-pointer chooser, never the text editor or blob reads', async () => {
      invokeHistory.length = 0;
      const el = await renderSubmoduleEditor();

      const text = shadowText(el);
      expect(text).to.include('Submodule conflict');
      // The choice is between COMMITS — show the short OIDs.
      expect(text).to.include('b'.repeat(7));
      expect(text).to.include('c'.repeat(7));
      expect(el.shadowRoot!.querySelector('.output-panel')).to.be.null;
      // Nothing is readable for a gitlink: no blob/workdir fetches at all.
      expect(invokeHistory.some((h) => h.command === 'get_blob_content')).to.be.false;
      expect(invokeHistory.some((h) => h.command === 'read_file_content')).to.be.false;
      expectNoMarkers(el);
    });

    it('resolves via take-side and reports success', async () => {
      const el = await renderSubmoduleEditor();
      let resolvedFired = false;
      el.addEventListener('conflict-resolved', () => {
        resolvedFired = true;
      });

      invokeHistory.length = 0;
      (el.shadowRoot!.querySelector('.btn-theirs') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));

      const takeSide = invokeHistory.find((h) => h.command === 'resolve_conflict_take_side');
      expect(takeSide, 'take-side called').to.exist;
      expect((takeSide!.args as Record<string, unknown>).side).to.equal('theirs');
      expect(invokeHistory.some((h) => h.command === 'resolve_conflict')).to.be.false;
      expect(resolvedFired).to.be.true;
    });

    it('a successful take lands in a terminal state — no live buttons to re-click into an error', async () => {
      // Without the terminal state the chooser re-renders with enabled
      // buttons and a second click errors "No conflict found" on a file
      // that is actually resolved.
      const el = await renderSubmoduleEditor();
      (el.shadowRoot!.querySelector('.btn-ours') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      // Submodule-specific terminal message (staged commit + submodule update).
      expect(shadowText(el)).to.include('Resolved — the chosen commit is staged');
      expect(el.shadowRoot!.querySelector('.btn-ours'), 'no re-clickable chooser').to.be.null;
      expect(el.shadowRoot!.querySelector('.btn-theirs')).to.be.null;
    });

    it('a submodule<->file type conflict labels the file side honestly, not as a commit', async () => {
      // is_submodule is set when ANY side is a gitlink, so a type conflict
      // routes here — the file side's OID is a BLOB and must not be
      // formatted like a commit pointer.
      const file = {
        ...makeSubmoduleConflict(),
        theirs: { oid: 'd'.repeat(40), path: 'sub', mode: 0o100644 },
      };
      const el = await renderSubmoduleEditor(file);

      const text = shadowText(el);
      expect(text).to.include('a regular file');
      expect(text, 'blob OID must not be shown as a commit').to.not.include('d'.repeat(7));
      const theirsBtn = el.shadowRoot!.querySelector('.btn-theirs') as HTMLButtonElement;
      expect(theirsBtn.textContent).to.include('Use Theirs (file)');
    });

    it('a deleted side offers removing the submodule and lands in the terminal state', async () => {
      const file = { ...makeSubmoduleConflict(), theirs: null };
      const el = await renderSubmoduleEditor(file);

      const theirsBtn = el.shadowRoot!.querySelector('.btn-theirs') as HTMLButtonElement;
      expect(theirsBtn.textContent).to.include('remove submodule');
      theirsBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(shadowText(el)).to.include('this submodule was removed');
    });
  });
});
