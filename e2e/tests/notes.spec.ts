import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setupOpenRepository } from '../fixtures/tauri-mock';
import { RightPanelPage } from '../pages/panels.page';
import {
  startCommandCapture,
  findCommand,
  injectCommandError,
  autoConfirmDialogs,
} from '../fixtures/test-helpers';

/**
 * Git notes on the commit details panel: read, add, edit and remove a note on
 * the selected commit, plus the ref selector and the all-notes overview.
 */

function makeCommit(index: number, parentIds: string[] = []) {
  const now = Date.now() / 1000;
  return {
    oid: `commit${index}`,
    shortId: `commit${index}`.slice(0, 7),
    message: `Commit ${index}`,
    summary: `Commit ${index}`,
    body: null,
    author: { name: 'Test User', email: 'test@example.com', timestamp: now - index * 3600 },
    committer: { name: 'Test User', email: 'test@example.com', timestamp: now - index * 3600 },
    parentIds,
    timestamp: now - index * 3600,
  };
}

const commits = [makeCommit(0), makeCommit(1, ['commit0'])];

/** Select a commit in the graph and open the details tab it feeds. */
async function selectCommit(page: Page, oid: string): Promise<void> {
  const graphCanvas = page.locator('gn-graph-canvas');
  await expect(graphCanvas).toBeAttached();
  const handle = await graphCanvas.elementHandle();
  await page.evaluate(
    ({ el, target }) => {
      (el as HTMLElement & { selectCommit: (o: string) => boolean }).selectCommit(target);
    },
    { el: handle, target: oid }
  );
  await new RightPanelPage(page).switchToDetails();
  await expect(page.locator('gn-commit-details')).toBeVisible();
}

const details = (page: Page) => page.locator('gn-commit-details');

test.describe('Commit notes', () => {
  test('a commit with no note offers to add one', async ({ page }) => {
    await setupOpenRepository(page, { commits });
    await selectCommit(page, 'commit0');

    await expect(details(page).locator('.note-empty')).toContainText('refs/notes/commits');
    await expect(details(page).getByRole('button', { name: 'Add note' })).toBeVisible();
  });

  test('an existing note is shown for the selected commit', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [{ commitOid: 'commit0', message: 'Cherry-picked to 1.x', notesRef: 'refs/notes/commits' }],
    });
    await selectCommit(page, 'commit0');

    await expect(details(page).locator('.note-body')).toContainText('Cherry-picked to 1.x');
  });

  test('adding a note writes it, shows it, and confirms it', async ({ page }) => {
    await setupOpenRepository(page, { commits });
    await selectCommit(page, 'commit0');
    await startCommandCapture(page);

    await details(page).getByRole('button', { name: 'Add note' }).click();
    await details(page).getByRole('textbox', { name: 'Commit note' }).fill('Needs a backport');
    await details(page).getByRole('button', { name: 'Save note' }).click();

    await expect(details(page).locator('.note-body')).toContainText('Needs a backport');
    await expect(page.locator('.toast')).toContainText('Note added to commit');

    const calls = await findCommand(page, 'set_note');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      commitOid: 'commit0',
      message: 'Needs a backport',
      notesRef: 'refs/notes/commits',
    });
  });

  test('a failed write keeps the text and tells the user why', async ({ page }) => {
    await setupOpenRepository(page, { commits });
    await selectCommit(page, 'commit0');

    await details(page).getByRole('button', { name: 'Add note' }).click();
    await details(page).getByRole('textbox', { name: 'Commit note' }).fill('Unsaveable');
    await injectCommandError(page, 'set_note', 'config value user.email was not found');
    await details(page).getByRole('button', { name: 'Save note' }).click();

    await expect(details(page).locator('.note-error')).toContainText('user.email');
    // The editor stays open with the typed note intact
    await expect(details(page).getByRole('textbox', { name: 'Commit note' })).toHaveValue('Unsaveable');
    await expect(details(page).locator('.note-body')).toHaveCount(0);
  });

  test('editing a note replaces it', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [{ commitOid: 'commit0', message: 'First pass', notesRef: 'refs/notes/commits' }],
    });
    await selectCommit(page, 'commit0');

    await details(page).getByRole('button', { name: 'Edit' }).click();
    await details(page).getByRole('textbox', { name: 'Commit note' }).fill('Second pass');
    await details(page).getByRole('button', { name: 'Save note' }).click();

    await expect(details(page).locator('.note-body')).toContainText('Second pass');
    await expect(page.locator('.toast')).toContainText('Note updated on commit');
  });

  test('removing a note clears the section once confirmed', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [{ commitOid: 'commit0', message: 'Obsolete', notesRef: 'refs/notes/commits' }],
    });
    await autoConfirmDialogs(page);
    await selectCommit(page, 'commit0');
    await startCommandCapture(page);

    await details(page).getByRole('button', { name: 'Remove' }).click();

    await expect(details(page).locator('.note-body')).toHaveCount(0);
    await expect(details(page).locator('.note-empty')).toBeVisible();
    await expect(page.locator('.toast')).toContainText('Note removed from commit');
    expect(await findCommand(page, 'remove_note')).toHaveLength(1);
  });

  test('a failed removal keeps the note and reports the error', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [{ commitOid: 'commit0', message: 'Stubborn', notesRef: 'refs/notes/commits' }],
    });
    await autoConfirmDialogs(page);
    await selectCommit(page, 'commit0');
    await injectCommandError(page, 'remove_note', 'note not found');

    await details(page).getByRole('button', { name: 'Remove' }).click();

    await expect(details(page).locator('.note-error')).toContainText('note not found');
    await expect(details(page).locator('.note-body')).toContainText('Stubborn');
  });

  test('the ref selector switches which notes ref is read', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [
        { commitOid: 'commit0', message: 'Commit-ref note', notesRef: 'refs/notes/commits' },
        { commitOid: 'commit0', message: 'Review-ref note', notesRef: 'refs/notes/review' },
      ],
    });
    await selectCommit(page, 'commit0');

    await expect(details(page).locator('.note-body')).toContainText('Commit-ref note');

    await details(page).getByLabel('Notes ref').selectOption('refs/notes/review');

    await expect(details(page).locator('.note-body')).toContainText('Review-ref note');
  });

  test('the default ref stays selectable when the repo only uses a custom ref', async ({
    page,
  }) => {
    // A repo that keeps its notes in refs/notes/review must still be able to
    // reach — and write to — the ref git itself uses by default.
    await setupOpenRepository(page, {
      commits,
      notes: [{ commitOid: 'commit0', message: 'Review-ref note', notesRef: 'refs/notes/review' }],
    });
    await selectCommit(page, 'commit0');

    const selector = details(page).getByLabel('Notes ref');
    await expect(selector.locator('option', { hasText: 'refs/notes/commits' })).toHaveCount(1);

    await selector.selectOption('refs/notes/commits');

    await expect(details(page).locator('.note-empty')).toContainText('refs/notes/commits');
    await details(page).getByRole('button', { name: 'Add note' }).click();
    await details(page).locator('.note-editor').fill('Now in the default ref');
    await details(page).getByRole('button', { name: 'Save note' }).click();

    await expect(details(page).locator('.note-body')).toContainText('Now in the default ref');
  });

  test('the overview lists every note in the ref and navigates to one', async ({ page }) => {
    await setupOpenRepository(page, {
      commits,
      notes: [
        { commitOid: 'commit0', message: 'On commit 0', notesRef: 'refs/notes/commits' },
        { commitOid: 'commit1', message: 'On commit 1', notesRef: 'refs/notes/commits' },
      ],
    });
    await selectCommit(page, 'commit0');

    const toggle = details(page).locator('.notes-overview-toggle');
    await expect(toggle).toContainText('2 notes');
    await toggle.click();

    const items = details(page).locator('.notes-overview-item');
    await expect(items).toHaveCount(2);

    await items.nth(1).click();

    // Clicking an entry reveals that commit, and the panel follows it
    await expect(details(page).locator('.commit-message')).toContainText('Commit 1');
    await expect(details(page).locator('.note-body')).toContainText('On commit 1');
  });
});
