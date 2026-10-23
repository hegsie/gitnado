/**
 * Command Palette - File & Commit Search Tests
 *
 * Tests the enhanced command palette with file and commit categories,
 * fuzzy filtering threshold, and result capping.
 */

// Mock Tauri API before importing any modules that use it
const mockInvoke = (_command: string): Promise<unknown> => {
  return Promise.resolve(null);
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-command-palette.ts';
import type { GnCommandPalette } from '../gn-command-palette.ts';
import type { Commit } from '../../../types/git.types.ts';

function makeCommit(oid: string, summary: string): Commit {
  return {
    oid,
    shortId: oid.substring(0, 7),
    message: summary,
    summary,
    body: null,
    author: { name: 'Test', email: 'test@test.com', timestamp: 0 },
    committer: { name: 'Test', email: 'test@test.com', timestamp: 0 },
    parentIds: [],
    timestamp: 0,
  };
}

describe('gn-command-palette - file & commit search', () => {
  let el: GnCommandPalette;

  const mockFiles = [
    'src/main.ts',
    'src/utils/helper.ts',
    'README.md',
  ];

  const mockCommits = [
    makeCommit('abc1234567890', 'Fix login bug'),
    makeCommit('def4567890123', 'Add user settings'),
  ];

  beforeEach(async () => {
    el = await fixture<GnCommandPalette>(html`
      <gn-command-palette
        .files=${mockFiles}
        .commits=${mockCommits}
        .commands=${[]}
        .branches=${[]}
      ></gn-command-palette>
    `);
  });

  it('should generate file commands from files property', () => {
    // Access getAllCommands via the filteredCommands after setting search
    // We need to open the palette and type 2+ chars to see file commands
    el.open = true;
    // Simulate search with 2+ chars by directly manipulating internal state
    const allCommands = (el as unknown as { getAllCommands: () => Array<{ id: string; category: string; icon?: string }> }).getAllCommands();
    const fileCommands = allCommands.filter(c => c.category === 'file');

    expect(fileCommands).to.have.length(3);
    expect(fileCommands[0].id).to.equal('file:src/main.ts');
    expect(fileCommands[0].icon).to.equal('file');
  });

  it('should generate commit commands from commits property', () => {
    const allCommands = (el as unknown as { getAllCommands: () => Array<{ id: string; category: string; label: string; icon?: string }> }).getAllCommands();
    const commitCommands = allCommands.filter(c => c.category === 'commit');

    expect(commitCommands).to.have.length(2);
    expect(commitCommands[0].id).to.equal('commit:abc1234567890');
    expect(commitCommands[0].label).to.equal('abc1234 Fix login bug');
    expect(commitCommands[0].icon).to.equal('commit');
  });

  it('should exclude file/commit commands when query is empty', () => {
    el.open = true;
    // When query is empty, updateFilteredCommands filters out file/commit
    const filtered = (el as unknown as { filteredCommands: Array<{ category: string }> }).filteredCommands;
    const fileOrCommit = filtered.filter(c => c.category === 'file' || c.category === 'commit');
    expect(fileOrCommit).to.have.length(0);
  });

  it('should include file/commit commands when query has 2+ chars', async () => {
    el.open = true;
    await el.updateComplete;

    // Simulate typing in the search input
    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'main';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    const filtered = (el as unknown as { filteredCommands: Array<{ category: string }> }).filteredCommands;
    const fileResults = filtered.filter(c => c.category === 'file');
    expect(fileResults.length).to.be.greaterThan(0);
  });

  it('should cap results at 50', async () => {
    // Create many files to exceed the cap
    const manyFiles = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
    el.files = manyFiles;
    el.open = true;
    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'file';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    const filtered = (el as unknown as { filteredCommands: Array<{ category: string }> }).filteredCommands;
    expect(filtered.length).to.be.at.most(50);
  });

  it('should dispatch open-file event when file command is executed', async () => {
    el.open = true;
    await el.updateComplete;

    let dispatchedEvent: CustomEvent | null = null;
    el.addEventListener('open-file', ((e: CustomEvent) => {
      dispatchedEvent = e;
    }) as EventListener);

    // Type to find a file
    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'main';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    // Execute the first file result
    const filtered = (el as unknown as { filteredCommands: Array<{ category: string; action: () => void }> }).filteredCommands;
    const fileCmd = filtered.find(c => c.category === 'file');
    expect(fileCmd).to.exist;
    fileCmd!.action();

    expect(dispatchedEvent).to.not.be.null;
    expect((dispatchedEvent as unknown as CustomEvent).detail.path).to.equal('src/main.ts');
  });

  it('should dispatch navigate-to-commit event when commit command is executed', async () => {
    el.open = true;
    await el.updateComplete;

    let dispatchedEvent: CustomEvent | null = null;
    el.addEventListener('navigate-to-commit', ((e: CustomEvent) => {
      dispatchedEvent = e;
    }) as EventListener);

    const input = el.shadowRoot!.querySelector('.search-input') as HTMLInputElement;
    input.value = 'login';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    const filtered = (el as unknown as { filteredCommands: Array<{ category: string; action: () => void }> }).filteredCommands;
    const commitCmd = filtered.find(c => c.category === 'commit');
    expect(commitCmd).to.exist;
    commitCmd!.action();

    expect(dispatchedEvent).to.not.be.null;
    expect((dispatchedEvent as unknown as CustomEvent).detail.oid).to.equal('abc1234567890');
  });

  it('should show Files and Commits category labels', () => {
    const getCategoryLabel = (el as unknown as { getCategoryLabel: (cat: string) => string }).getCategoryLabel.bind(el);
    expect(getCategoryLabel('file')).to.equal('Files');
    expect(getCategoryLabel('commit')).to.equal('Commits');
  });
});
