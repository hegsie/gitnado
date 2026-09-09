/**
 * Welcome screen localisation.
 *
 * The welcome screen is the first thing a user sees, so it is the first surface
 * migrated to `msg()`. It must render the English source strings by default and
 * follow a locale change while it is on screen — runtime mode means no reload.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const mockInvoke: MockInvoke = (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return Promise.resolve(false);
  switch (command) {
    case 'get_recent_repositories':
    case 'list_workspaces':
      return Promise.resolve([]);
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import { setAppLocale } from '../../../i18n/index.ts';
import '../lv-welcome.ts';
import type { LvWelcome } from '../lv-welcome.ts';

function text(el: LvWelcome, selector: string): string {
  return el.shadowRoot?.querySelector(selector)?.textContent?.trim() ?? '';
}

describe('lv-welcome localisation', () => {
  let el: LvWelcome;

  beforeEach(async () => {
    el = await fixture<LvWelcome>(html`<lv-welcome></lv-welcome>`);
    await el.updateComplete;
  });

  afterEach(async () => {
    await setAppLocale('en');
  });

  it('renders the English source strings by default', () => {
    expect(text(el, '.tagline')).to.equal('A powerful, open-source Git client');
    expect(text(el, '.recent-title')).to.equal('Recent Repositories');
    expect(text(el, '.empty-recent')).to.equal('No recent repositories');
    const actions = Array.from(el.shadowRoot?.querySelectorAll('.action-btn span') ?? []).map(
      (span) => span.textContent?.trim()
    );
    expect(actions).to.deep.equal(['Open', 'Clone', 'Init', 'Scan', 'Profiles & Accounts']);
  });

  it('re-renders in the new locale without being recreated', async () => {
    await setAppLocale('fr');
    await waitUntil(
      () => text(el, '.tagline') === 'Un client Git puissant et open source',
      'the welcome screen re-rendered in French'
    );
    expect(text(el, '.recent-title')).to.equal('Dépôts récents');
    expect(text(el, '.empty-recent')).to.equal('Aucun dépôt récent');
    const actions = Array.from(el.shadowRoot?.querySelectorAll('.action-btn span') ?? []).map(
      (span) => span.textContent?.trim()
    );
    expect(actions).to.deep.equal([
      'Ouvrir',
      'Cloner',
      'Initialiser',
      'Analyser',
      'Profils et comptes',
    ]);
  });

  it('goes back to English when the locale is switched back', async () => {
    await setAppLocale('fr');
    await waitUntil(() => text(el, '.tagline') === 'Un client Git puissant et open source');
    await setAppLocale('en');
    await waitUntil(
      () => text(el, '.tagline') === 'A powerful, open-source Git client',
      'the welcome screen went back to English'
    );
  });

  it('translates the drop overlay, not just the buttons', async () => {
    // The overlay only exists while a folder is being dragged over the window,
    // which is exactly when a user is least able to puzzle out a foreign
    // string — it has to follow the locale like everything else here.
    el.dragActive = true;
    await el.updateComplete;
    expect(text(el, '.drop-overlay-title')).to.equal('Drop a folder to open it');
    expect(text(el, '.drop-overlay-hint')).to.equal(
      'Git repositories open straight away; any other folder can be scanned or initialized.'
    );

    await setAppLocale('fr');
    await waitUntil(
      () => text(el, '.drop-overlay-title') === "Déposez un dossier pour l'ouvrir",
      'the drop overlay re-rendered in French'
    );
    expect(text(el, '.drop-overlay-hint')).to.equal(
      "Les dépôts Git s'ouvrent directement ; tout autre dossier peut être analysé ou initialisé."
    );
  });

  it('keeps rendering English for a locale it does not ship', async () => {
    await setAppLocale('xx');
    await el.updateComplete;
    expect(text(el, '.tagline')).to.equal('A powerful, open-source Git client');
  });
});
