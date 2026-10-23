/**
 * Changelog Dialog Tests
 *
 * Tests rendering, generation, and copy functionality.
 */

let failingCommands: Set<string> = new Set();
let commandOverrides: Record<string, unknown> = {};

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  if (failingCommands.has(command)) {
    throw { code: 'COMMAND_ERROR', message: 'Operation failed' };
  }

  if (command in commandOverrides) return commandOverrides[command];

  switch (command) {
    case 'get_tags':
      return [
        { name: 'v0.2.72', targetOid: 'abc123', message: null, tagger: null, isAnnotated: false },
        { name: 'v0.2.71', targetOid: 'def456', message: null, tagger: null, isAnnotated: false },
      ];
    case 'is_ai_available':
      return true;
    case 'generate_changelog':
      return { content: '## Features\n- Added semantic search (abc1234)' };
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import { expect, fixture, html } from '@open-wc/testing';
import '../gn-changelog-dialog.ts';
import type { GnChangelogDialog } from '../gn-changelog-dialog.ts';

describe('gn-changelog-dialog', () => {
  beforeEach(() => {
    failingCommands = new Set();
    commandOverrides = {};
  });

  it('names the unavailable provider instead of claiming none is configured', async () => {
    // A provider IS selected in Settings; it is just unreachable. Since a
    // selected provider is never substituted, the generic "configure one"
    // warning would send the user looking for a problem that is not there.
    commandOverrides = {
      is_ai_available: false,
      ai_unavailable_reason: {
        reason:
          'Anthropic Claude is not available. Please check its API key in Settings, or select a different provider.',
        providerSelected: true,
      },
    };

    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );
    await el.open();
    await el.updateComplete;

    const warning = el.shadowRoot!.querySelector('.ai-warning');
    expect(warning, 'warning rendered').to.not.be.null;
    expect(warning!.textContent).to.include('Anthropic Claude');
    expect(warning!.textContent).to.include('API key');
  });

  it('falls back to the generic warning when no reason is available', async () => {
    commandOverrides = { is_ai_available: false, ai_unavailable_reason: null };

    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );
    await el.open();
    await el.updateComplete;

    const warning = el.shadowRoot!.querySelector('.ai-warning');
    expect(warning, 'warning rendered').to.not.be.null;
    expect(warning!.textContent).to.include('No AI provider available');
  });

  it('shows no AI warning while AI is usable', async () => {
    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );
    await el.open();
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('.ai-warning')).to.be.null;
  });

  it('renders the modal', async () => {
    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );

    const modal = el.shadowRoot!.querySelector('gn-modal');
    expect(modal).to.not.be.null;
  });

  it('loads tags on open', async () => {
    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );

    await el.open();
    await el.updateComplete;

    // Should have tag options in the select
    const select = el.shadowRoot!.querySelector('select');
    if (select) {
      expect(select.options.length).to.be.greaterThan(0);
    }
  });

  it('generates changelog on button click', async () => {
    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );

    await el.open();
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).baseRef = 'v0.2.71';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).compareRef = 'v0.2.72';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleGenerate();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).result).to.include('Features');
  });

  it('shows error on generation failure', async () => {
    failingCommands.add('generate_changelog');

    const el = await fixture<GnChangelogDialog>(
      html`<gn-changelog-dialog .repositoryPath=${'/test/repo'}></gn-changelog-dialog>`,
    );

    await el.open();
    await el.updateComplete;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el as any).baseRef = 'v0.2.71';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (el as any).handleGenerate();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((el as any).error).to.not.be.empty;
  });
});
