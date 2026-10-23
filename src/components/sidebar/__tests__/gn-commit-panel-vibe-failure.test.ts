/**
 * A Vibe Check whose AI pass failed must say so.
 *
 * analyze_staged_changes discarded both AI failure arms — a provider that had
 * stopped since the availability check, a missing model, a dead network, an
 * unparseable response — and still returned success carrying only the regex
 * secret findings. The panel rendered that as a completed check reading "No
 * issues found", telling the user their staged changes had been reviewed when
 * nothing had reviewed them.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../gn-commit-panel.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO_PATH = '/test/repo';

interface Panel extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function panelWithVibeResult(result: Record<string, unknown>): Promise<Panel> {
  const el = await fixture<Panel>(html`
    <gn-commit-panel .repositoryPath=${REPO_PATH} .stagedCount=${2}></gn-commit-panel>
  `);
  await el.updateComplete;
  // The whole AI section is gated on a configured provider.
  (el as any).aiAvailable = true;
  (el as any).vibeCheckResult = result;
  await el.updateComplete;
  return el;
}

function warningText(el: Panel): string | null {
  const node = el.shadowRoot!.querySelector('.vibe-ai-warning');
  return node ? node.textContent!.replace(/\s+/g, ' ').trim() : null;
}

describe('gn-commit-panel vibe check AI failure', () => {
  beforeEach(() => {
    mockInvoke = async (command: string) => {
      if (command === 'plugin:notification|is_permission_granted') return false;
      if (command === 'get_status') return { staged: [], unstaged: [], untracked: [] };
      return null;
    };
  });

  it('warns that only the secret scan ran when the AI pass failed', async () => {
    const el = await panelWithVibeResult({
      findings: [],
      summary: 'No issues found (secret scan only — AI analysis failed)',
      riskLevel: 'low',
      aiAnalysisRan: false,
      aiError: 'connection refused',
    });

    const warning = warningText(el);
    expect(warning, 'a failed AI pass must be visible, not silent').to.not.be.null;
    expect(warning!).to.contain('secret scan');
    expect(warning!, 'the reason helps the user fix it').to.contain('connection refused');
  });

  it('still warns when no reason was reported', async () => {
    const el = await panelWithVibeResult({
      findings: [],
      summary: 'No issues found (secret scan only — AI analysis failed)',
      riskLevel: 'low',
      aiAnalysisRan: false,
      aiError: null,
    });

    expect(warningText(el), 'the warning does not depend on having a reason').to.not.be.null;
  });

  it('shows no warning when the AI pass ran', async () => {
    const el = await panelWithVibeResult({
      findings: [],
      summary: 'No issues found',
      riskLevel: 'low',
      aiAnalysisRan: true,
      aiError: null,
    });

    expect(warningText(el), 'a complete check must not cry wolf').to.be.null;
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
