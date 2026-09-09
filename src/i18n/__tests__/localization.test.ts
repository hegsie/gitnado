/**
 * Localization runtime.
 *
 * The language setting hands arbitrary strings to this module — a locale that
 * was persisted before it was dropped, a system language we do not ship — so
 * everything here has to resolve to something renderable rather than throw.
 */

import { expect, waitUntil } from '@open-wc/testing';
import { msg, str } from '@lit/localize';
import {
  detectSystemLocale,
  getAppLocale,
  isSupportedLocale,
  resolveLocale,
  setAppLocale,
  supportedLocales,
} from '../index.ts';

describe('i18n runtime', () => {
  afterEach(async () => {
    await setAppLocale('en');
  });

  it('ships English as the source locale and French alongside it', () => {
    expect(supportedLocales.map((l) => l.code)).to.deep.equal(['en', 'fr']);
    // Endonyms: the picker stays readable whatever the active locale is.
    expect(supportedLocales.map((l) => l.name)).to.deep.equal(['English', 'Français']);
  });

  it('recognises only the locales it ships', () => {
    expect(isSupportedLocale('fr')).to.be.true;
    expect(isSupportedLocale('de')).to.be.false;
  });

  it('resolves a regional tag to the base locale it ships', () => {
    expect(resolveLocale('fr-CA')).to.equal('fr');
    expect(resolveLocale('en-GB')).to.equal('en');
  });

  it('resolves an unknown or empty locale to English', () => {
    expect(resolveLocale('xx-YY')).to.equal('en');
    expect(resolveLocale('')).to.equal('en');
    expect(resolveLocale(null)).to.equal('en');
  });

  it('detects a system locale we actually ship', () => {
    expect(supportedLocales.some((l) => l.code === detectSystemLocale())).to.be.true;
  });

  it('renders source strings under the source locale', () => {
    expect(getAppLocale()).to.equal('en');
    expect(msg('Open')).to.equal('Open');
  });

  it('translates msg() after switching to a shipped locale', async () => {
    const applied = await setAppLocale('fr');
    expect(applied).to.equal('fr');
    expect(getAppLocale()).to.equal('fr');
    await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
    expect(msg('A powerful, open-source Git client')).to.equal(
      'Un client Git puissant et open source'
    );
  });

  it('loads a locale asynchronously, so the first paint is in the source locale', async () => {
    // What src/index.ts documents: applyPersistedLocale() is deliberately not
    // awaited before the app shell is imported, because a locale's templates
    // arrive through a dynamic import(). Nothing is translated until that
    // promise settles, and the @localized() surfaces re-render when it does.
    const pending = setAppLocale('fr');
    expect(msg('Open'), 'nothing is translated synchronously').to.equal('Open');
    expect(getAppLocale(), 'and the active locale has not moved yet').to.equal('en');

    await pending;
    await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
  });

  it('falls back to English for an unsupported locale instead of throwing', async () => {
    const applied = await setAppLocale('xx');
    expect(applied).to.equal('en');
    expect(getAppLocale()).to.equal('en');
    expect(msg('Open')).to.equal('Open');
  });

  it('takes a regional tag straight to the locale it ships', async () => {
    const applied = await setAppLocale('fr-CA');
    expect(applied).to.equal('fr');
    expect(msg('Clone')).to.equal('Cloner');
  });

  /**
   * Every string on the two localised surfaces has to have a translation, or
   * the French UI silently mixes English into it. A message whose source text
   * is not in the bundle falls back to the source, so "still English under fr"
   * is exactly the failure this catches.
   *
   * This used to iterate a hand-written list of ~20 source strings, which meant
   * any string it did not happen to name could lose its translation and still
   * pass. It now enumerates the XLIFF itself and drives every unit through the
   * real `msg()` runtime, so the check grows with the catalogue.
   *
   * The other half of the contract — that the XLIFF's ids are exactly the ids
   * the `msg()` call sites in `src/**` hash to — cannot be checked from a
   * browser, which has no view of the source tree. `scripts/i18n-coverage.test.mjs`
   * derives and asserts that, and `npm test` runs it alongside these tests.
   */
  describe('the French catalogue resolves through the runtime', () => {
    /** One translation unit, with template expressions split out. */
    interface Unit {
      id: string;
      /** Literal chunks of the source, one more than there are expressions. */
      strings: string[];
      /** Literal chunks of the target. */
      targetStrings: string[];
      /** For each gap in the target, which source expression fills it. */
      targetOrder: number[];
    }

    /**
     * `<source>Opened workspace: <x id="0"/></source>` becomes the template
     * strings `["Opened workspace: ", ""]` — the same shape `str` produces, and
     * the shape the message id is hashed from.
     */
    function split(element: Element): { strings: string[]; order: number[] } {
      const strings: string[] = [''];
      const order: number[] = [];
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          strings[strings.length - 1] += node.textContent ?? '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          order.push(Number((node as Element).getAttribute('id')));
          strings.push('');
        }
      }
      return { strings, order };
    }

    let units: Unit[];

    before(async () => {
      const response = await fetch('/src/i18n/xliff/fr.xlf');
      expect(response.ok, 'the French XLIFF is readable').to.be.true;
      const xliff = new DOMParser().parseFromString(await response.text(), 'application/xml');
      expect(xliff.querySelector('parsererror'), 'the XLIFF is well-formed XML').to.not.exist;

      units = Array.from(xliff.querySelectorAll('trans-unit')).map((unit) => {
        const source = split(unit.querySelector('source') as Element);
        const target = split(unit.querySelector('target') as Element);
        return {
          id: unit.getAttribute('id') ?? '',
          strings: source.strings,
          targetStrings: target.strings,
          targetOrder: target.order,
        };
      });
    });

    beforeEach(async () => {
      await setAppLocale('fr');
      await waitUntil(() => msg('Open') === 'Ouvrir', 'French templates became active');
    });

    it('has a catalogue to check', () => {
      expect(units.length, 'trans-units in fr.xlf').to.be.greaterThan(100);
      expect(units.every((unit) => unit.id !== '')).to.be.true;
    });

    it('renders every translated unit in French', () => {
      const untranslated: string[] = [];

      for (const unit of units) {
        // One distinct marker per expression, so a value that lands in the
        // wrong gap after translation reorders them is visible in the diff.
        const values = unit.strings.slice(1).map((_, i) => `\u27e6${i}\u27e7`);
        const rendered =
          unit.strings.length === 1
            ? msg(unit.strings[0])
            : msg(str(unit.strings as unknown as TemplateStringsArray, ...values));
        const expected = unit.targetStrings.reduce(
          (acc, chunk, i) => (i === 0 ? chunk : acc + values[unit.targetOrder[i - 1]] + chunk),
          ''
        );
        if (rendered !== expected) {
          untranslated.push(
            `${unit.id}: got ${JSON.stringify(rendered)}, want ${JSON.stringify(expected)}`
          );
        }
      }

      expect(
        untranslated,
        `${untranslated.length} unit(s) in src/i18n/xliff/fr.xlf do not render their French target — ` +
          `the generated bundle src/i18n/generated/locales/fr.ts is out of step with the XLIFF:\n` +
          untranslated.join('\n')
      ).to.deep.equal([]);
    });

    it('still substitutes values into a translated message', () => {
      const label = 'X';
      expect(msg(str`${label} copied to clipboard`)).to.equal('X copié dans le presse-papiers');
      const host = 'www.gravatar.com';
      const avatars = msg(
        str`Display author avatars in commit nodes. Avatars are fetched from Gravatar (${host}), a third-party service: each request sends an MD5 hash of the commit author's email address and your IP address. Off by default; Offline Mode disables it.`
      );
      expect(avatars).to.not.contain('Display author avatars');
      expect(avatars, 'the host is still substituted').to.contain(host);
    });
  });
});
