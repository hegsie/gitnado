/**
 * Ignore rules dialog tests.
 *
 * The .gitignore/.gitattributes backend had a complete command surface and no
 * UI at all. These tests cover the dialog that reaches it: listing and editing
 * rules, applying a template, explaining why a path is ignored, and — the one
 * that would have caught the broken wire type — rendering attribute chips from
 * the shape the Rust side actually serialises.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type {
  GitAttribute,
  GitignoreEntry,
  GitignoreTemplate,
} from '../../../services/git.service.ts';

const REPO = '/test/repo';

const NODE_TEMPLATE: GitignoreTemplate = {
  name: 'Node.js',
  patterns: ['node_modules/', 'dist/', '.env'],
};

let gitignoreEntries: GitignoreEntry[] = [];
let gitattributes: GitAttribute[] = [];
let checkVerboseResult: unknown[] = [];
/** command name -> rejection */
let failWith: Record<string, { code?: string; message: string }> = {};

const invokeCalls: Array<{ command: string; args?: unknown }> = [];

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  // plugin-dialog 2.7 routes confirm() through `message`; 'Ok' means confirmed.
  if (command === 'plugin:dialog|message') return 'Ok';

  if (failWith[command]) throw failWith[command];

  switch (command) {
    case 'get_gitignore':
      return gitignoreEntries;
    case 'get_gitignore_templates':
      return [NODE_TEMPLATE];
    case 'get_gitattributes':
      return gitattributes;
    case 'get_common_attributes':
      return [
        { name: 'text', description: 'Text file line ending handling', example: '*.txt text' },
        { name: 'binary', description: 'Binary file (no diff, no merge)', example: '*.png binary' },
      ];
    case 'add_to_gitignore':
    case 'remove_from_gitignore':
      return null;
    case 'check_ignore_verbose':
      return checkVerboseResult;
    case 'add_gitattribute':
    case 'update_gitattribute':
    case 'remove_gitattribute':
      return gitattributes;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return mockInvoke(command, args);
  },
};

// Import AFTER the mock is installed
import '../gn-gitignore-dialog.ts';
import type { GnGitignoreDialog } from '../gn-gitignore-dialog.ts';
import { uiStore } from '../../../stores/ui.store.ts';

function entry(overrides: Partial<GitignoreEntry>): GitignoreEntry {
  return {
    pattern: '*.log',
    lineNumber: 1,
    isComment: false,
    isNegation: false,
    isEmpty: false,
    ...overrides,
  };
}

async function openDialog(): Promise<GnGitignoreDialog> {
  const el = await fixture<GnGitignoreDialog>(
    html`<gn-gitignore-dialog ?open=${true} .repositoryPath=${REPO}></gn-gitignore-dialog>`,
  );
  await new Promise((r) => setTimeout(r, 50));
  await el.updateComplete;
  return el;
}

function calls(command: string): Array<{ command: string; args?: unknown }> {
  return invokeCalls.filter((c) => c.command === command);
}

function texts(el: GnGitignoreDialog, selector: string): string[] {
  return Array.from(el.shadowRoot!.querySelectorAll(selector)).map((n) =>
    (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

function buttonWithText(el: GnGitignoreDialog, text: string): HTMLElement | undefined {
  return Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('button')).find((b) =>
    (b.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text),
  );
}

/** Captures every ignore-rules-changed the dialog dispatches. */
function trackChanges(el: GnGitignoreDialog): Array<string | undefined> {
  const seen: Array<string | undefined> = [];
  el.addEventListener('ignore-rules-changed', ((e: CustomEvent) => {
    seen.push(e.detail?.repositoryPath);
  }) as EventListener);
  return seen;
}

describe('gn-gitignore-dialog', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    failWith = {};
    checkVerboseResult = [];
    gitignoreEntries = [
      entry({ pattern: '# build output', lineNumber: 1, isComment: true }),
      entry({ pattern: 'dist/', lineNumber: 2 }),
      entry({ pattern: '', lineNumber: 3, isEmpty: true }),
    ];
    gitattributes = [];
    const state = uiStore.getState();
    state.toasts.forEach((t) => state.removeToast(t.id));
  });

  it('lists .gitignore rules, dimming comment lines', async () => {
    const el = await openDialog();

    const ruleTexts = texts(el, '.rule-text');
    expect(ruleTexts).to.deep.equal(['# build output', 'dist/']);
    expect(el.shadowRoot!.querySelectorAll('.rule-item.comment').length).to.equal(1);
    // The blank line is preserved visually rather than dropped.
    expect(el.shadowRoot!.querySelectorAll('.rule-item.blank').length).to.equal(1);
  });

  it('offers no Remove control on a blank line', async () => {
    const el = await openDialog();

    // A blank line is a spacer, not a rule — there is nothing to remove, so the
    // row carries no control that would suggest otherwise.
    const blank = el.shadowRoot!.querySelector('.rule-item.blank')!;
    expect(blank.querySelector('button')).to.be.null;

    const rows = Array.from(el.shadowRoot!.querySelectorAll('.rule-item:not(.blank)'));
    expect(rows.length).to.equal(2);
    expect(rows.every((r) => r.querySelector('button') !== null)).to.be.true;
  });

  it('removes only the occurrence the user clicked', async () => {
    gitignoreEntries = [
      entry({ pattern: '# generated', lineNumber: 1, isComment: true }),
      entry({ pattern: 'dist/', lineNumber: 2 }),
      entry({ pattern: '# generated', lineNumber: 3, isComment: true }),
      entry({ pattern: 'coverage/', lineNumber: 4 }),
    ];
    const el = await openDialog();
    const changes = trackChanges(el);

    const removeButtons = el.shadowRoot!.querySelectorAll<HTMLElement>(
      '.rule-item:not(.blank) button',
    );
    expect(removeButtons.length).to.equal(4);

    invokeCalls.length = 0;
    // The SECOND "# generated" — text alone cannot tell the two rows apart, so
    // the write has to carry the line the row came from.
    removeButtons[2].click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(calls('remove_from_gitignore')[0].args).to.deep.equal({
      path: REPO,
      pattern: '# generated',
      lineNumber: 3,
    });
    expect(calls('get_gitignore').length, 'rules are re-read after the write').to.equal(1);
    expect(uiStore.getState().toasts.some((t) => t.type === 'success')).to.be.true;
    expect(changes).to.deep.equal([REPO]);
  });

  it('adds a rule, reloads and announces the change', async () => {
    const el = await openDialog();
    const changes = trackChanges(el);

    const input = el.shadowRoot!.querySelector<HTMLInputElement>(
      'input[aria-label="Ignore pattern"]',
    )!;
    input.value = '*.log';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    invokeCalls.length = 0;
    buttonWithText(el, 'Add')!.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(calls('add_to_gitignore')[0].args).to.deep.equal({
      path: REPO,
      patterns: ['*.log'],
    });
    expect(calls('get_gitignore').length, 'rules are re-read after the write').to.equal(1);
    expect(uiStore.getState().toasts.some((t) => t.type === 'success')).to.be.true;
    expect(changes).to.deep.equal([REPO]);
  });

  it('applies a template with its full pattern list', async () => {
    const el = await openDialog();
    const changes = trackChanges(el);

    const select = el.shadowRoot!.querySelector<HTMLSelectElement>(
      'select[aria-label="Gitignore template"]',
    )!;
    select.value = 'Node.js';
    select.dispatchEvent(new Event('change'));
    await el.updateComplete;

    invokeCalls.length = 0;
    buttonWithText(el, 'Apply')!.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(calls('add_to_gitignore')[0].args).to.deep.equal({
      path: REPO,
      patterns: NODE_TEMPLATE.patterns,
    });
    expect(changes).to.deep.equal([REPO]);
  });

  it('shows the error banner when a remove fails and announces nothing', async () => {
    const el = await openDialog();
    const changes = trackChanges(el);
    failWith['remove_from_gitignore'] = {
      code: 'OPERATION_FAILED',
      message: '.gitignore file does not exist',
    };

    await (
      el as unknown as { handleRemovePattern: (e: GitignoreEntry) => Promise<void> }
    ).handleRemovePattern(gitignoreEntries[1]);
    await el.updateComplete;

    const banner = el.shadowRoot!.querySelector('.error-banner');
    expect(banner).to.not.be.null;
    expect(banner!.textContent).to.include('.gitignore file does not exist');
    expect(texts(el, '.rule-text')).to.deep.equal(['# build output', 'dist/']);
    expect(changes).to.deep.equal([]);
  });

  it('explains why a path is ignored, and says so when it is not', async () => {
    const el = await openDialog();

    checkVerboseResult = [
      {
        path: 'build/x.o',
        isIgnored: true,
        sourceFile: '.gitignore',
        sourceLine: 3,
        pattern: 'build/',
        isNegated: false,
      },
    ];

    const input = el.shadowRoot!.querySelector<HTMLInputElement>(
      'input[aria-label="Path to check"]',
    )!;
    input.value = 'build/x.o';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    invokeCalls.length = 0;
    buttonWithText(el, 'Check')!.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(calls('check_ignore_verbose')[0].args).to.deep.equal({
      path: REPO,
      filePaths: ['build/x.o'],
    });
    const answer = el.shadowRoot!.querySelector('.check-result')!.textContent!;
    expect(answer).to.include('build/');
    expect(answer).to.include('.gitignore');
    expect(answer).to.include('3');

    checkVerboseResult = [
      {
        path: 'build/x.o',
        isIgnored: false,
        sourceFile: null,
        sourceLine: null,
        pattern: null,
        isNegated: false,
      },
    ];
    buttonWithText(el, 'Check')!.click();
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;

    expect(
      el.shadowRoot!.querySelector('.check-result')!.textContent,
    ).to.include('Not ignored');
  });

  it('renders attribute chips in the shape the backend actually sends', async () => {
    // The externally-tagged Rust enum puts bare strings on the wire for the
    // unit variants and `{ value }` for the valued one — NOT `{ type: 'set' }`.
    gitattributes = [
      {
        pattern: '*',
        attributes: [{ name: 'text', value: { value: 'auto' } }],
        lineNumber: 1,
        rawLine: '* text=auto',
      },
      {
        pattern: '*.png',
        attributes: [
          { name: 'binary', value: 'set' },
          { name: 'diff', value: 'unset' },
          { name: 'merge', value: 'unspecified' },
        ],
        lineNumber: 2,
        rawLine: '*.png binary',
      },
    ];

    const el = await openDialog();
    (el as unknown as { activeTab: string }).activeTab = 'attributes';
    await el.updateComplete;

    expect(texts(el, '.attr-chip')).to.deep.equal([
      'text=auto',
      'binary',
      '-diff',
      '!merge',
    ]);
    expect(texts(el, '.attr-pattern')).to.deep.equal(['*', '*.png']);
  });

  it('adds, edits and removes an attribute rule without refetching', async () => {
    gitattributes = [
      {
        pattern: '*.psd',
        attributes: [{ name: 'binary', value: 'set' }],
        lineNumber: 1,
        rawLine: '*.psd binary',
      },
    ];
    const el = await openDialog();
    const changes = trackChanges(el);
    (el as unknown as { activeTab: string }).activeTab = 'attributes';
    await el.updateComplete;

    const internal = el as unknown as {
      newAttrPattern: string;
      newAttrValue: string;
      handleAddAttribute: () => Promise<void>;
      startEditingAttribute: (a: GitAttribute) => void;
      handleUpdateAttribute: (n: number) => Promise<void>;
      handleRemoveAttribute: (a: GitAttribute) => Promise<void>;
      attributeRules: GitAttribute[];
    };

    invokeCalls.length = 0;
    internal.newAttrPattern = '*.psd';
    internal.newAttrValue = 'binary';
    await internal.handleAddAttribute();
    expect(calls('add_gitattribute')[0].args).to.deep.equal({
      path: REPO,
      pattern: '*.psd',
      attributes: 'binary',
    });
    // The write returns the reparsed file, so no second read is issued.
    expect(calls('get_gitattributes').length).to.equal(0);
    expect(internal.attributeRules.length).to.equal(1);

    invokeCalls.length = 0;
    internal.startEditingAttribute(gitattributes[0]);
    await el.updateComplete;
    (el as unknown as { editValue: string }).editValue = 'binary -diff';
    await internal.handleUpdateAttribute(1);
    expect(calls('update_gitattribute')[0].args).to.deep.equal({
      path: REPO,
      lineNumber: 1,
      pattern: '*.psd',
      attributes: 'binary -diff',
    });

    invokeCalls.length = 0;
    await internal.handleRemoveAttribute(gitattributes[0]);
    expect(calls('remove_gitattribute')[0].args).to.deep.equal({
      path: REPO,
      lineNumber: 1,
    });

    expect(changes).to.deep.equal([REPO, REPO, REPO]);
  });

  it('keeps the typed values and announces nothing when adding an attribute fails', async () => {
    const el = await openDialog();
    const changes = trackChanges(el);
    failWith['add_gitattribute'] = {
      code: 'OPERATION_FAILED',
      message: 'A .gitattributes pattern cannot be empty.',
    };

    const internal = el as unknown as {
      newAttrPattern: string;
      newAttrValue: string;
      handleAddAttribute: () => Promise<void>;
    };
    internal.newAttrPattern = '*.psd';
    internal.newAttrValue = 'binary';
    await internal.handleAddAttribute();
    (el as unknown as { activeTab: string }).activeTab = 'attributes';
    await el.updateComplete;

    const banner = el.shadowRoot!.querySelector('.error-banner');
    expect(banner!.textContent).to.include('A .gitattributes pattern cannot be empty.');
    expect(internal.newAttrPattern).to.equal('*.psd');
    expect(internal.newAttrValue).to.equal('binary');
    expect(changes).to.deep.equal([]);
  });

  it('is not a dead end in a repo with neither file', async () => {
    gitignoreEntries = [];
    gitattributes = [];
    const el = await openDialog();

    expect(el.shadowRoot!.querySelector('.empty-state')!.textContent).to.include(
      'No ignore rules yet',
    );
    // The way out is on screen, not just the empty message.
    expect(
      el.shadowRoot!.querySelector('select[aria-label="Gitignore template"]'),
    ).to.not.be.null;
    expect(
      el.shadowRoot!.querySelector('input[aria-label="Ignore pattern"]'),
    ).to.not.be.null;

    (el as unknown as { activeTab: string }).activeTab = 'attributes';
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.empty-state')!.textContent).to.include(
      'No .gitattributes rules yet',
    );
    expect(
      el.shadowRoot!.querySelector('input[aria-label="Attribute pattern"]'),
    ).to.not.be.null;
  });
});
