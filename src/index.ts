/**
 * Gitnado - Git GUI Client
 * Application entry point
 */

// Must come first: adopts pre-rename localStorage keys before any store
// module reads storage.
import './utils/legacy-storage-bootstrap.ts';

// Import styles
import './styles/tokens.css';

// Localization runtime. Importing this configures @lit/localize in runtime
// mode. The persisted language is applied at the bottom of this file, but a
// locale's templates arrive through a dynamic import(), so the first paint is
// in the source locale and the @localized() surfaces re-render a frame or two
// later, once the module resolves. Blocking the app shell on that import to
// avoid the swap would trade a brief re-render for an empty window on every
// launch. Language changes made later take exactly the same path, so they
// apply without a restart.
import './i18n/index.ts';
import { applyPersistedLocale } from './stores/settings.store.ts';

// Import app shell
import './app-shell.ts';

// Import component registrations
import './components/index.ts';

import { loggers } from './utils/logger.ts';

// Through the store action, not setAppLocale(): a persisted language whose
// templates cannot be loaded must be written back as the locale that really
// rendered, or Settings would keep naming a language the UI is not in.
void applyPersistedLocale();

loggers.app.info('Gitnado initialized');
