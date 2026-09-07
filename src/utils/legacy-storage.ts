/**
 * One-time adoption of localStorage written under the app's previous name.
 *
 * Gitnado was called Leviathan until 0.9.0, and every persisted key — the
 * zustand stores (`leviathan-settings`, `leviathan-repositories`, …) and the
 * per-component preferences (`leviathan-graph-zoom`, `leviathan-recent-commands`,
 * …) — carried a `leviathan-` prefix. Each such key is copied to its `gitnado-`
 * counterpart, unless that already exists, and the old key is removed. So an
 * existing user keeps their settings, open repositories, graph layout and
 * keyboard shortcuts across the rename.
 *
 * zustand's `persist` reads storage while its store module evaluates, so this
 * must run before any store module is imported — see
 * `legacy-storage-bootstrap.ts`, the entry point's first import.
 */

export const LEGACY_STORAGE_PREFIX = 'leviathan-';
export const STORAGE_PREFIX = 'gitnado-';

/**
 * Migrate every `leviathan-*` key in `storage` to `gitnado-*`.
 *
 * Returns the number of keys whose value was carried over. A key whose new
 * counterpart already exists is dropped without overwriting it (a newer version
 * already ran). Storage that throws (privacy modes, quota) is left alone.
 */
export function migrateLegacyStorage(storage: Storage = localStorage): number {
  let legacyKeys: string[];
  try {
    legacyKeys = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(LEGACY_STORAGE_PREFIX)) {
        legacyKeys.push(key);
      }
    }
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const legacyKey of legacyKeys) {
    const newKey = STORAGE_PREFIX + legacyKey.slice(LEGACY_STORAGE_PREFIX.length);
    try {
      const value = storage.getItem(legacyKey);
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value);
        migrated++;
      }
      storage.removeItem(legacyKey);
    } catch {
      // Leave this key for the next launch rather than half-migrating it.
    }
  }
  return migrated;
}
