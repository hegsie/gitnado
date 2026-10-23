import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCaptureWithMocks,
  findCommand,
  injectCommandError,
  injectCommandMock,
  waitForCommand,
  openViaCommandPalette,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

/**
 * .gitignore / .gitattributes editing.
 *
 * The whole backend surface (add_to_gitignore, templates, check_ignore_verbose,
 * the gitattributes commands) shipped with no UI reaching it, so none of these
 * flows existed: a user could not ignore an untracked file, apply a template,
 * ask why a path was ignored, or touch .gitattributes anywhere in the app.
 */

const IGNORE_ENTRIES = [
  { pattern: '# build output', lineNumber: 1, isComment: true, isNegation: false, isEmpty: false },
  { pattern: 'dist/', lineNumber: 2, isComment: false, isNegation: false, isEmpty: false },
];

const ATTRIBUTES = [
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
    ],
    lineNumber: 2,
    rawLine: '*.png binary -diff',
  },
];

const TEMPLATES = [
  { name: 'Node.js', patterns: ['node_modules/', 'dist/', '.env'] },
  { name: 'Rust', patterns: ['/target/', 'Cargo.lock'] },
];

const COMMON_ATTRIBUTES = [
  { name: 'text', description: 'Text file line ending handling', example: '*.txt text' },
  { name: 'binary', description: 'Binary file (no diff, no merge)', example: '*.png binary' },
];

async function openIgnoreDialog(page: Page): Promise<void> {
  await openViaCommandPalette(page, 'Edit .gitignore');
  await page.locator('gn-gitignore-dialog gn-modal[open]').waitFor({ state: 'visible', timeout: 3000 });
}

test.describe('Add to .gitignore from the file context menu', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page, {
      status: {
        staged: [],
        unstaged: [
          { path: 'src/new-file.ts', status: 'untracked', isStaged: false, isConflicted: false },
          { path: 'src/modified-file.ts', status: 'modified', isStaged: false, isConflicted: false },
        ],
      },
    });
    await startCommandCaptureWithMocks(page, { add_to_gitignore: null });
  });

  test('ignores an untracked file and the file leaves the change list', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await rightPanel.getUnstagedFile('src/new-file.ts').click({ button: 'right' });

    const ignoreItem = page.locator('.context-menu-item', { hasText: 'Add to .gitignore' });
    await expect(ignoreItem).toBeVisible();

    // After the write the working tree contains .gitignore instead of the
    // now-ignored file (get_status never reports ignored paths).
    await injectCommandMock(page, {
      add_to_gitignore: null,
      get_status: [
        { path: '.gitignore', status: 'untracked', isStaged: false, isConflicted: false },
      ],
    });

    await ignoreItem.click();

    await waitForCommand(page, 'add_to_gitignore');
    const [command] = await findCommand(page, 'add_to_gitignore');
    expect(command).toBeTruthy();
    expect((command.args as { patterns: string[] }).patterns).toEqual(['/src/new-file.ts']);

    await expect(page.locator('gn-file-status li.file-item[title="src/new-file.ts"]')).toHaveCount(0);
    await expect(page.locator('gn-file-status li.file-item[title=".gitignore"]')).toBeVisible();
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible();
  });

  test('offers the extension rule and writes the glob', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await rightPanel.getUnstagedFile('src/new-file.ts').click({ button: 'right' });

    const extItem = page.locator('.context-menu-item', { hasText: 'Ignore all *.ts files' });
    await expect(extItem).toBeVisible();
    await extItem.click();

    await waitForCommand(page, 'add_to_gitignore');
    const [command] = await findCommand(page, 'add_to_gitignore');
    expect((command.args as { patterns: string[] }).patterns).toEqual(['*.ts']);
  });

  test('is not offered for a tracked file', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await rightPanel.getUnstagedFile('src/modified-file.ts').click({ button: 'right' });

    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: 'Add to .gitignore' })).toHaveCount(0);
  });

  test('a failed write surfaces a toast and leaves the file alone', async ({ page }) => {
    const rightPanel = new RightPanelPage(page);
    await rightPanel.getUnstagedFile('src/new-file.ts').click({ button: 'right' });

    await injectCommandError(page, 'add_to_gitignore', 'Permission denied');
    await page.locator('.context-menu-item', { hasText: 'Add to .gitignore' }).click();

    await expect(page.locator('gn-toast-container .toast.error').first()).toBeVisible();
    await expect(page.locator('gn-file-status li.file-item[title="src/new-file.ts"]')).toBeVisible();
  });
});

test.describe('Ignore rules dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_gitignore: IGNORE_ENTRIES,
      get_gitignore_templates: TEMPLATES,
      get_gitattributes: ATTRIBUTES,
      get_common_attributes: COMMON_ATTRIBUTES,
      add_to_gitignore: null,
      remove_from_gitignore: null,
      add_gitattribute: ATTRIBUTES,
      remove_gitattribute: [ATTRIBUTES[0]],
      check_ignore_verbose: [
        {
          path: 'dist/app.js',
          isIgnored: true,
          sourceFile: '.gitignore',
          sourceLine: 2,
          pattern: 'dist/',
          isNegated: false,
        },
      ],
    });
    await autoConfirmDialogs(page);
  });

  test('opens from the command palette and lists the rules', async ({ page }) => {
    await openIgnoreDialog(page);

    const dialog = page.locator('gn-gitignore-dialog');
    await expect(dialog.locator('.rule-text', { hasText: '# build output' })).toBeVisible();
    await expect(dialog.locator('.rule-text', { hasText: 'dist/' })).toBeVisible();
  });

  test('adds a rule and applies a template', async ({ page }) => {
    await openIgnoreDialog(page);
    const dialog = page.locator('gn-gitignore-dialog');

    await dialog.locator('input[aria-label="Ignore pattern"]').fill('*.log');
    await dialog.locator('button', { hasText: 'Add' }).first().click();

    await waitForCommand(page, 'add_to_gitignore');
    const added = await findCommand(page, 'add_to_gitignore');
    expect((added[0].args as { patterns: string[] }).patterns).toEqual(['*.log']);

    await dialog.locator('select[aria-label="Gitignore template"]').selectOption('Rust');
    await dialog.locator('button', { hasText: 'Apply' }).click();

    await expect
      .poll(async () => {
        const all = await findCommand(page, 'add_to_gitignore');
        return (all[all.length - 1].args as { patterns: string[] }).patterns;
      })
      .toEqual(['/target/', 'Cargo.lock']);
  });

  test('removes only the rule row the user clicked', async ({ page }) => {
    // The same line can legitimately appear twice — repeated section comments,
    // or a pattern restated around a negation. Removing by text alone took the
    // twin with it, so the write carries the line the clicked row came from.
    const DUPLICATES = [
      { pattern: '# generated', lineNumber: 1, isComment: true, isNegation: false, isEmpty: false },
      { pattern: 'dist/', lineNumber: 2, isComment: false, isNegation: false, isEmpty: false },
      { pattern: '# generated', lineNumber: 3, isComment: true, isNegation: false, isEmpty: false },
      { pattern: 'coverage/', lineNumber: 4, isComment: false, isNegation: false, isEmpty: false },
    ];
    await injectCommandMock(page, { get_gitignore: DUPLICATES });
    await openIgnoreDialog(page);
    const dialog = page.locator('gn-gitignore-dialog');

    const rows = dialog.locator('.rule-item:not(.blank)');
    await expect(rows).toHaveCount(4);

    // What the file looks like once line 3 — and only line 3 — is gone.
    await injectCommandMock(page, {
      get_gitignore: [DUPLICATES[0], DUPLICATES[1], { ...DUPLICATES[3], lineNumber: 3 }],
    });

    await rows.nth(2).locator('button').click();

    await waitForCommand(page, 'remove_from_gitignore');
    const [command] = await findCommand(page, 'remove_from_gitignore');
    expect((command.args as { pattern: string }).pattern).toBe('# generated');
    expect((command.args as { lineNumber: number }).lineNumber).toBe(3);

    await expect(rows).toHaveCount(3);
    await expect(dialog.locator('.rule-text', { hasText: '# generated' })).toHaveCount(1);
    await expect(page.locator('gn-toast-container .toast.success').first()).toBeVisible();
  });

  test('explains why a path is ignored', async ({ page }) => {
    await openIgnoreDialog(page);
    const dialog = page.locator('gn-gitignore-dialog');

    await dialog.locator('input[aria-label="Path to check"]').fill('dist/app.js');
    await dialog.locator('button', { hasText: 'Check' }).click();

    const result = dialog.locator('.check-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('dist/');
    await expect(result).toContainText('.gitignore');
  });

  test('renders attribute chips and removes a rule', async ({ page }) => {
    await openIgnoreDialog(page);
    const dialog = page.locator('gn-gitignore-dialog');

    await dialog.locator('.tab', { hasText: '.gitattributes' }).click();

    // Chips come from the externally-tagged wire shape: a bare string for the
    // unit variants, `{ value }` for the valued one.
    await expect(dialog.locator('.attr-chip', { hasText: 'text=auto' })).toBeVisible();
    await expect(dialog.locator('.attr-chip').filter({ hasText: /^binary$/ })).toBeVisible();
    await expect(dialog.locator('.attr-chip').filter({ hasText: /^-diff$/ })).toBeVisible();

    await dialog.locator('button[aria-label="Remove *.png"]').click();

    await waitForCommand(page, 'remove_gitattribute');
    const [command] = await findCommand(page, 'remove_gitattribute');
    expect((command.args as { lineNumber: number }).lineNumber).toBe(2);
    await expect(dialog.locator('.attr-pattern', { hasText: '*.png' })).toHaveCount(0);
  });
});

test.describe('Ignore rules dialog in a repo with neither file', () => {
  test.beforeEach(async ({ page }) => {
    await setupOpenRepository(page);
    await startCommandCaptureWithMocks(page, {
      get_gitignore: [],
      get_gitignore_templates: TEMPLATES,
      get_gitattributes: [],
      get_common_attributes: COMMON_ATTRIBUTES,
    });
  });

  test('shows the empty state with a way forward, not a dead end', async ({ page }) => {
    await openIgnoreDialog(page);
    const dialog = page.locator('gn-gitignore-dialog');

    await expect(dialog.locator('.empty-state')).toContainText('No ignore rules yet');
    await expect(dialog.locator('select[aria-label="Gitignore template"]')).toBeVisible();
    await expect(dialog.locator('input[aria-label="Ignore pattern"]')).toBeVisible();

    await dialog.locator('.tab', { hasText: '.gitattributes' }).click();
    await expect(dialog.locator('.empty-state')).toContainText('No .gitattributes rules yet');
    await expect(dialog.locator('input[aria-label="Attribute pattern"]')).toBeVisible();
  });
});
