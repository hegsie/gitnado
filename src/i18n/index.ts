/**
 * Localization runtime.
 *
 * `@lit/localize` is configured in RUNTIME mode: every locale's templates are
 * loaded on demand and the active locale can change while the app is running,
 * so the language setting takes effect immediately instead of asking the user
 * to restart. (Transform mode would produce one bundle per locale and require a
 * reload — the wrong trade for a desktop app with a language picker.)
 *
 * Only components that have been migrated to `msg()` follow the active locale;
 * see docs/localisation.md for the migration workflow.
 */

import { configureLocalization } from '@lit/localize';
import type { LocaleModule } from '@lit/localize';
import { allLocales, sourceLocale, targetLocales } from './generated/locale-codes.ts';

/** Every locale the app ships, source locale included. */
export type Locale = (typeof allLocales)[number];

/** A locale as offered in Settings. */
export interface LocaleOption {
  code: Locale;
  /** Endonym — never translated, so the picker is readable in any locale. */
  name: string;
}

/**
 * Display names, keyed by locale so adding a locale to lit-localize.json
 * without naming it here is a type error rather than a blank menu entry.
 */
const localeNames: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
};

export const supportedLocales: readonly LocaleOption[] = allLocales.map((code) => ({
  code,
  name: localeNames[code],
}));

/**
 * Lazily loaded template modules, one per target locale. Written as a literal
 * map rather than a computed `import()` path so both Vite and the test runner
 * can statically see every locale module.
 */
const localeLoaders: Record<string, () => Promise<LocaleModule>> = {
  fr: () => import('./generated/locales/fr.ts'),
};

export const { getLocale, setLocale } = configureLocalization({
  sourceLocale,
  targetLocales,
  loadLocale: (locale: string) => {
    const loader = localeLoaders[locale];
    if (!loader) {
      return Promise.reject(new Error(`No templates bundled for locale "${locale}"`));
    }
    return loader();
  },
});

export function isSupportedLocale(code: string): code is Locale {
  return (allLocales as readonly string[]).includes(code);
}

/**
 * Map any language tag onto a locale we ship, falling back to the source
 * locale. Regional tags fall back to their base language, so `fr-CA` gets the
 * French templates rather than English.
 */
export function resolveLocale(code: string | null | undefined): Locale {
  if (!code) return sourceLocale;
  if (isSupportedLocale(code)) return code;
  const base = code.split('-')[0].toLowerCase();
  return isSupportedLocale(base) ? base : sourceLocale;
}

/**
 * The locale to start from on a fresh install: the first of the OS/browser
 * preferred languages that we actually ship, English otherwise.
 */
export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return sourceLocale;
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    if (!tag) continue;
    if (isSupportedLocale(tag)) return tag;
    const base = tag.split('-')[0].toLowerCase();
    if (isSupportedLocale(base)) return base;
  }
  return sourceLocale;
}

/**
 * Switch the active locale. Unsupported codes fall back to English rather than
 * throwing, and a failed template load leaves the previous locale in place —
 * a language setting must never be able to blank the UI.
 *
 * Resolves with the locale that ended up active.
 */
export async function setAppLocale(code: string): Promise<Locale> {
  const target = resolveLocale(code);
  try {
    await setLocale(target);
    return target;
  } catch {
    // The templates could not be loaded. Stay on whatever is rendering now.
    return resolveLocale(getLocale());
  }
}

/** The locale currently rendering. */
export function getAppLocale(): Locale {
  return resolveLocale(getLocale());
}
