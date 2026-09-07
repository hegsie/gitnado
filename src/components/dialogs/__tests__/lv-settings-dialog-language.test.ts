/**
 * Settings Dialog — Language row.
 *
 * The language picker is the user-facing half of runtime localisation: it lists
 * the locales we ship, persists the choice, and the dialog around it has to
 * re-render in the new language on the spot — no restart, no reopening.
 */

import { expect, fixture, html, waitUntil } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    // A REAL `SystemCapabilities`. The old literal used none of the interface's
    // field names, so `recommendedTier` was undefined, the Local AI status pill
    // rendered empty, and the comparison below could not see the English it
    // would otherwise have contained.
    case 'get_system_capabilities':
      return {
        totalRamBytes: 17_179_869_184,
        availableRamBytes: 8_589_934_592,
        gpuInfo: null,
        recommendedTier: 'standard',
        gpuAccelerationAvailable: false,
      };
    // At least one model, for the same reason: with an empty registry no model
    // row exists, so nothing inside it is ever compared.
    case 'get_available_models':
      return [
        {
          id: 'qwen2.5-coder-1.5b',
          displayName: 'Qwen2.5 Coder 1.5B',
          hfRepo: 'org/repo',
          hfFilename: 'model.gguf',
          sha256: 'x'.repeat(64),
          sizeBytes: 1_073_741_824,
          minRamBytes: 8_589_934_592,
          tier: 'ultra_light',
          architecture: 'qwen2',
          contextLength: 32_768,
        },
      ];
    case 'get_downloaded_models':
    case 'get_available_diff_tools':
    case 'get_available_merge_tools':
    case 'list_diff_tools':
      return [];
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_merge_tool_config':
      return { toolName: null, toolCmd: null };
    case 'get_diff_tool':
      return { tool: null, cmd: null, prompt: false };
    default:
      return null;
  }
};

let nextCallbackId = 1;

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: () => nextCallbackId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

// Import AFTER setting up the mock
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { getAppLocale, setAppLocale } from '../../../i18n/index.ts';

function select(el: LvSettingsDialog): HTMLSelectElement {
  const node = el.shadowRoot?.querySelector<HTMLSelectElement>('#language-select');
  expect(node, 'language select exists').to.exist;
  return node as HTMLSelectElement;
}

function sectionTitles(el: LvSettingsDialog): string[] {
  return Array.from(el.shadowRoot?.querySelectorAll('.section-title') ?? []).map(
    (node) => node.textContent?.trim() ?? ''
  );
}

async function choose(el: LvSettingsDialog, locale: string): Promise<void> {
  const languageSelect = select(el);
  languageSelect.value = locale;
  languageSelect.dispatchEvent(new Event('change'));
}

describe('lv-settings-dialog language setting', () => {
  let el: LvSettingsDialog;

  beforeEach(async () => {
    await setAppLocale('en');
    settingsStore.setState({ language: 'en' });
    el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
    await el.updateComplete;
  });

  afterEach(async () => {
    settingsStore.setState({ language: 'en' });
    await setAppLocale('en');
  });

  it('lists every locale the app ships, in English by default', () => {
    const options = Array.from(select(el).options).map((o) => ({
      value: o.value,
      label: o.textContent?.trim(),
    }));
    expect(options).to.deep.equal([
      { value: 'en', label: 'English' },
      { value: 'fr', label: 'Français' },
    ]);
    expect(select(el).value).to.equal('en');
    expect(sectionTitles(el)[0]).to.equal('Appearance');
  });

  it('persists the choice and re-renders the dialog without a reload', async () => {
    let changed = 0;
    const onChange = (): number => (changed += 1);
    window.addEventListener('settings-changed', onChange);

    await choose(el, 'fr');

    await waitUntil(
      () => sectionTitles(el)[0] === 'Apparence',
      'the settings dialog re-rendered in French'
    );
    window.removeEventListener('settings-changed', onChange);

    expect(settingsStore.getState().language).to.equal('fr');
    expect(getAppLocale()).to.equal('fr');
    expect(sectionTitles(el)).to.include('Sécurité');
    // The toggle rows take their label from the same strings.
    const toggleLabels = Array.from(el.shadowRoot?.querySelectorAll('.setting-name') ?? []).map(
      (node) => node.textContent?.trim()
    );
    expect(toggleLabels).to.include('Mode hors ligne');
    expect(changed, 'settings-changed was dispatched once').to.equal(1);
  });

  it('keeps the select in step with the persisted locale when reopened', async () => {
    await choose(el, 'fr');
    await waitUntil(() => settingsStore.getState().language === 'fr');

    const reopened = await fixture<LvSettingsDialog>(
      html`<lv-settings-dialog></lv-settings-dialog>`
    );
    await reopened.updateComplete;
    await waitUntil(() => select(reopened).value === 'fr', 'the reopened dialog shows French');
    expect(select(reopened).options[0].textContent?.trim()).to.equal('English');
  });

  it('switches back to English', async () => {
    await choose(el, 'fr');
    await waitUntil(() => sectionTitles(el)[0] === 'Apparence');

    await choose(el, 'en');
    await waitUntil(
      () => sectionTitles(el)[0] === 'Appearance',
      'the settings dialog went back to English'
    );
    expect(settingsStore.getState().language).to.equal('en');
  });

  /**
   * A half-translated screen is worse than an untranslated one, and the way it
   * happens is that one branch re-words a string another branch already
   * translated: the `@lit/localize` id is a hash of the source text, so the
   * merge is clean and the translation silently detaches.
   *
   * This used to name a handful of expected French labels, so a row it did not
   * happen to list could go back to English unnoticed. It now renders the whole
   * dialog twice and compares the two sets: any text that survives the switch to
   * French unchanged is English that leaked into the French UI.
   */
  it('leaves no English text behind when the dialog switches to French', async () => {
    // `.error-text` is the AI banner: its message is a string built when the
    // error happens, so it is provoked in each language below rather than
    // relying on the re-render. Without it here, a bare template rendered
    // into the banner showed English under "fr" with nothing to catch it.
    // `.status-indicator` earns its place here: the stack localised several of
    // these pills (`Configured`, `Not configured`, `Loaded`) while the Local AI
    // tier pill beside them stayed English, and this selector could not see it.
    const LOCALISED =
      '.section-title, .setting-name, .setting-description, .error-text, .status-indicator';
    // The mock answers `test_ai_provider` with nothing, which the dialog
    // reports as the provider being unavailable.
    const provokeAiError = async (): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (el as any).handleTestProvider('open_ai');
      await el.updateComplete;
    };
    const visibleText = (): Set<string> =>
      new Set(
        Array.from(el.shadowRoot?.querySelectorAll(LOCALISED) ?? []).map(
          (node) => node.textContent?.trim() ?? ''
        )
      );

    /**
     * Text that is legitimately identical in both languages. Every entry has to
     * be a word French borrows unchanged — if a row lands here because nobody
     * translated it, that is the bug this test exists to catch.
     */
    // `Port` is a word French borrows unchanged. The model name is registry
    // DATA, not a label: it is the product's own name and reads identically in
    // every locale, so it is not evidence of a missing translation.
    const SAME_IN_FRENCH = new Set(['Port', 'Qwen2.5 Coder 1.5B']);

    await provokeAiError();
    const english = visibleText();
    expect(english.size, 'the dialog rendered its rows in English').to.be.greaterThan(50);
    expect(
      [...english].some((text) => text.includes('OpenAI is not available')),
      'control: the AI banner is on screen and part of the comparison'
    ).to.be.true;

    await choose(el, 'fr');
    await waitUntil(() => sectionTitles(el)[0] === 'Apparence');
    await provokeAiError();

    const leftInEnglish = [...visibleText()].filter(
      (text) => text !== '' && english.has(text) && !SAME_IN_FRENCH.has(text)
    );
    expect(
      leftInEnglish,
      `${leftInEnglish.length} label(s) render the same text under "fr" as under "en" — ` +
        `their translation is missing or detached from the source string:\n` +
        leftInEnglish.map((text) => `  ${JSON.stringify(text)}`).join('\n')
    ).to.deep.equal([]);
  });

  it('localises the menu labels that live in the settings store', async () => {
    // The whitespace menu's labels are built in the settings store, not in this
    // component, so they have to be localised there rather than baked into a
    // module-level constant that freezes at the startup locale.
    await choose(el, 'fr');
    await waitUntil(() => sectionTitles(el)[0] === 'Apparence');

    const options = Array.from(
      el.shadowRoot?.querySelectorAll('#diff-whitespace-select option') ?? []
    ).map((option) => option.textContent?.trim());
    expect(options).to.deep.equal([
      'Afficher tous les espaces',
      'Ignorer les espaces en fin de ligne',
      "Ignorer les modifications d'espaces",
      'Ignorer tous les espaces',
    ]);
  });

  it('falls back to English when asked for a locale the app does not ship', async () => {
    const applied = await settingsStore.getState().setLanguage('xx-YY');
    expect(applied).to.equal('en');
    expect(settingsStore.getState().language).to.equal('en');
    await el.updateComplete;
    expect(sectionTitles(el)[0]).to.equal('Appearance');
  });

  it('maps a regional tag onto the locale it ships', async () => {
    const applied = await settingsStore.getState().setLanguage('fr-CA');
    expect(applied).to.equal('fr');
    expect(settingsStore.getState().language).to.equal('fr');
  });

  it('resets the language along with every other preference', async () => {
    await settingsStore.getState().setLanguage('fr');
    expect(settingsStore.getState().language).to.equal('fr');

    settingsStore.getState().resetToDefaults();

    expect(settingsStore.getState().language).to.equal('en');
    await waitUntil(() => getAppLocale() === 'en', 'the reset put the locale back to English');
  });
});
