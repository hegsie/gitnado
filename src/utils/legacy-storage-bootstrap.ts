/**
 * Side-effect module: adopt pre-rename (`leviathan-*`) localStorage before any
 * store module evaluates. Must stay the FIRST import of `src/index.ts` —
 * import order is evaluation order, and zustand `persist` reads storage at
 * import time.
 */
import { migrateLegacyStorage } from './legacy-storage.ts';
import { loggers } from './logger.ts';

const migrated = migrateLegacyStorage();
if (migrated > 0) {
  loggers.app.info(`Carried over ${migrated} setting(s) from the Leviathan-era storage keys`);
}
