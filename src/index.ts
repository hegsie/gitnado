/**
 * Gitnado - Git GUI Client
 * Application entry point
 */

// Must come first: adopts pre-rename localStorage keys before any store
// module reads storage.
import './utils/legacy-storage-bootstrap.ts';

// Import styles
import './styles/tokens.css';

// Import app shell
import './app-shell.ts';

// Import component registrations
import './components/index.ts';

import { loggers } from './utils/logger.ts';
loggers.app.info('Gitnado initialized');
