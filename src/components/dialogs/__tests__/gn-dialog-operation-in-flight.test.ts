/**
 * Every repo-scoped dialog must expose `operationInFlight`, and it must track
 * the SAME flag the dialog's own dismissal guard consults.
 *
 * The host's tab-close sweep is driven entirely off this getter. A dialog that
 * does not expose it (or exposes one wired to the wrong flag) is silently
 * force-dismissed mid-operation, and the sweep announces a cancellation that
 * never happened — "clean cancelled", then "Deleted 4,913 items".
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
let cbId = 0;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(null),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect } from '@open-wc/testing';

import '../gn-clean-dialog.ts';
import '../gn-interactive-rebase-dialog.ts';
import '../gn-cherry-pick-dialog.ts';
import '../gn-branch-cleanup-dialog.ts';
import '../gn-worktree-dialog.ts';
import '../gn-submodule-dialog.ts';
import '../gn-lfs-dialog.ts';
import '../gn-reflog-dialog.ts';
import '../gn-remote-dialog.ts';
import '../gn-config-dialog.ts';
import '../gn-hooks-dialog.ts';
import '../gn-gitignore-dialog.ts';
import '../gn-create-tag-dialog.ts';
import '../gn-create-branch-dialog.ts';
import '../gn-credentials-dialog.ts';
import '../gn-repository-health-dialog.ts';
import '../gn-changelog-dialog.ts';
import '../gn-export-import-dialog.ts';

/**
 * tag → [private in-flight field, value that means "running"].
 *
 * The field named here is the one the dialog's own `dismiss()` /
 * `handleModalClose()` refuses on, so the two can never drift apart.
 */
const IN_FLIGHT_FIELDS: Array<[string, string, unknown]> = [
  ['gn-clean-dialog', 'cleaning', true],
  ['gn-interactive-rebase-dialog', 'executing', true],
  ['gn-cherry-pick-dialog', 'isExecuting', true],
  ['gn-branch-cleanup-dialog', 'deleting', true],
  ['gn-worktree-dialog', 'removingPath', '/repo/wt'],
  ['gn-submodule-dialog', 'removingPath', 'vendor/lib'],
  ['gn-lfs-dialog', 'pruning', true],
  ['gn-reflog-dialog', 'resetting', true],
  ['gn-remote-dialog', 'saving', true],
  ['gn-remote-dialog', 'pruningRemote', 'origin'],
  ['gn-remote-dialog', 'removingRemote', 'origin'],
  ['gn-remote-dialog', 'fetchingRemote', 'origin'],
  ['gn-config-dialog', 'saving', true],
  ['gn-hooks-dialog', 'saving', true],
  ['gn-gitignore-dialog', 'saving', true],
  ['gn-create-tag-dialog', 'isCreating', true],
  ['gn-create-branch-dialog', 'isCreating', true],
  ['gn-credentials-dialog', 'testing', true],
  ['gn-repository-health-dialog', 'runningAction', 'gc'],
  ['gn-changelog-dialog', 'isGenerating', true],
  ['gn-export-import-dialog', 'operationRunning', true],
];

type Probe = HTMLElement & { operationInFlight?: boolean };

describe('repo-scoped dialogs expose operationInFlight', () => {
  for (const [tag, field, runningValue] of IN_FLIGHT_FIELDS) {
    it(`${tag} reports ${field} through operationInFlight`, () => {
      // Never appended: connectedCallback would kick off IPC loads this test
      // has no business simulating. The getter is pure state.
      const el = document.createElement(tag) as Probe;

      expect(
        'operationInFlight' in el,
        `${tag} must expose operationInFlight — the sweep reads nothing else`,
      ).to.be.true;
      expect(el.operationInFlight, `${tag} is idle on construction`).to.equal(false);

      (el as unknown as Record<string, unknown>)[field] = runningValue;
      expect(
        el.operationInFlight,
        `${tag}.operationInFlight must follow ${field}`,
      ).to.equal(true);
    });
  }

  it('every dialog that pins a repository also reports whether work is running', () => {
    // The pairing IS the contract: `pinnedRepositoryPathIfOpen` is what makes
    // the sweep act on a dialog, and `operationInFlight` is the only thing
    // stopping it from lying about the result.
    const pinned = new Set(IN_FLIGHT_FIELDS.map(([tag]) => tag));
    for (const tag of pinned) {
      const el = document.createElement(tag) as Probe & {
        pinnedRepositoryPathIfOpen?: string | null;
      };
      expect('pinnedRepositoryPathIfOpen' in el, `${tag} pins its repo`).to.be.true;
      expect('operationInFlight' in el, `${tag} reports in-flight work`).to.be.true;
    }
  });
});
