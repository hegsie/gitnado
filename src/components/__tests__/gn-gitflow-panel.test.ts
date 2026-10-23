/**
 * Tests for gn-gitflow-panel component.
 *
 * These render the REAL gn-gitflow-panel component, mock only the Tauri invoke
 * layer, and verify the actual component code calls the right commands and
 * renders the correct DOM.
 *
 * IMPORTANT: The __TAURI_INTERNALS__.invoke mock intercepts at the lowest
 * level. The `invokeCommand` wrapper in tauri-api.ts wraps successful returns
 * with { success: true, data } and catches thrown errors as { success: false,
 * error }. So our mock must return RAW data (not pre-wrapped) and throw to
 * simulate errors.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
const invokeHistory: Array<{ command: string; args?: unknown }> = [];
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invokeHistory.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import type { GnGitflowPanel } from '../sidebar/gn-gitflow-panel.ts';
import type { Branch } from '../../types/git.types.ts';

// Import the actual component — registers <gn-gitflow-panel> custom element
import '../sidebar/gn-gitflow-panel.ts';

// Import prompt dialog so showPrompt finds it in the DOM
import '../dialogs/gn-prompt-dialog.ts';
import type { GnPromptDialog } from '../dialogs/gn-prompt-dialog.ts';

// Helper to mock the themed prompt dialog used by showPrompt
function setupMockPrompt(value: string | null): void {
  let dialog = document.querySelector<GnPromptDialog>('gn-prompt-dialog');
  if (!dialog) {
    dialog = document.createElement('gn-prompt-dialog') as GnPromptDialog;
    document.body.appendChild(dialog);
  }
  dialog.open = async () => value;
}

function cleanupMockPrompt(): void {
  const dialog = document.querySelector('gn-prompt-dialog');
  if (dialog) dialog.remove();
}

// ── Test data ──────────────────────────────────────────────────────────────
const REPO_PATH = '/test/repo';

// Raw config objects returned at the invoke level (invokeCommand wraps them)
const DEFAULT_CONFIG = {
  initialized: true,
  masterBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  supportPrefix: 'support/',
  versionTagPrefix: '',
};

const UNINIT_CONFIG = {
  initialized: false,
  masterBranch: '',
  developBranch: '',
  featurePrefix: '',
  releasePrefix: '',
  hotfixPrefix: '',
  supportPrefix: '',
  versionTagPrefix: '',
};

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: 'develop',
    shorthand: 'develop',
    isHead: true,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
    ...overrides,
  };
}

const featureBranches: Branch[] = [
  makeBranch({ name: 'develop', shorthand: 'develop', isHead: true }),
  makeBranch({ name: 'feature/login', shorthand: 'feature/login', isHead: false, targetOid: 'f1' }),
  makeBranch({ name: 'feature/signup', shorthand: 'feature/signup', isHead: false, targetOid: 'f2' }),
];

const releaseBranches: Branch[] = [
  makeBranch({ name: 'develop', shorthand: 'develop', isHead: true }),
  makeBranch({ name: 'release/1.0.0', shorthand: 'release/1.0.0', isHead: false, targetOid: 'r1' }),
];

const hotfixBranches: Branch[] = [
  makeBranch({ name: 'develop', shorthand: 'develop', isHead: true }),
  makeBranch({ name: 'hotfix/1.0.1', shorthand: 'hotfix/1.0.1', isHead: false, targetOid: 'h1' }),
];

const allTypeBranches: Branch[] = [
  makeBranch({ name: 'develop', shorthand: 'develop', isHead: true }),
  makeBranch({ name: 'feature/login', shorthand: 'feature/login', isHead: false, targetOid: 'f1' }),
  makeBranch({ name: 'release/1.0.0', shorthand: 'release/1.0.0', isHead: false, targetOid: 'r1' }),
  makeBranch({ name: 'hotfix/1.0.1', shorthand: 'hotfix/1.0.1', isHead: false, targetOid: 'h1' }),
];

const emptyBranches: Branch[] = [
  makeBranch({ name: 'develop', shorthand: 'develop', isHead: true }),
];

// ── Helpers ────────────────────────────────────────────────────────────────
function clearHistory(): void {
  invokeHistory.length = 0;
}

function findCommands(name: string): Array<{ command: string; args?: unknown }> {
  return invokeHistory.filter((h) => h.command === name);
}

/**
 * Setup mock invoke. Returns RAW data at the __TAURI_INTERNALS__ level.
 * invokeCommand wraps successful returns as { success: true, data }.
 * For errors, throw — invokeCommand wraps as { success: false, error }.
 */
function setupMocks(opts: {
  config?: typeof DEFAULT_CONFIG;
  branches?: Branch[];
} = {}): void {
  const config = opts.config ?? DEFAULT_CONFIG;
  const branches = opts.branches ?? emptyBranches;

  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_gitflow_config':
        return config;
      case 'get_branches':
        return branches;
      case 'init_gitflow':
        return DEFAULT_CONFIG;
      case 'gitflow_start_feature':
      case 'gitflow_start_release':
      case 'gitflow_start_hotfix':
        return makeBranch();
      case 'gitflow_finish_feature':
      case 'gitflow_finish_release':
      case 'gitflow_finish_hotfix':
        return null;
      default:
        return null;
    }
  };
}

async function renderPanel(): Promise<GnGitflowPanel> {
  const el = await fixture<GnGitflowPanel>(
    html`<gn-gitflow-panel .repositoryPath=${REPO_PATH}></gn-gitflow-panel>`
  );
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 100));
  await el.updateComplete;
  return el;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('gn-gitflow-panel', () => {
  beforeEach(() => {
    clearHistory();
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('shows feature, release, and hotfix sections when initialized', async () => {
      setupMocks({ branches: allTypeBranches });
      const el = await renderPanel();

      const sections = el.shadowRoot!.querySelectorAll('.section');
      expect(sections.length).to.equal(3);

      const sectionTitles = Array.from(el.shadowRoot!.querySelectorAll('.section-title'))
        .map((t) => t.textContent?.trim());
      expect(sectionTitles.some((t) => t?.includes('Feature'))).to.be.true;
      expect(sectionTitles.some((t) => t?.includes('Release'))).to.be.true;
      expect(sectionTitles.some((t) => t?.includes('Hotfix'))).to.be.true;
    });

    it('shows branch counts next to section labels', async () => {
      setupMocks({ branches: allTypeBranches });
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      expect(sectionHeaders[0].textContent).to.include('(1)');
      expect(sectionHeaders[1].textContent).to.include('(1)');
      expect(sectionHeaders[2].textContent).to.include('(1)');
    });

    it('shows multiple feature branches with correct count', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      expect(sectionHeaders[0].textContent).to.include('(2)');

      const items = el.shadowRoot!.querySelectorAll('.item-name');
      const itemNames = Array.from(items).map((i) => i.textContent?.trim());
      expect(itemNames).to.include('login');
      expect(itemNames).to.include('signup');
    });

    it('shows config summary with master, develop, and prefix values', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();

      const configSummary = el.shadowRoot!.querySelector('.config-summary');
      expect(configSummary).to.not.be.null;

      const configValues = Array.from(el.shadowRoot!.querySelectorAll('.config-value'))
        .map((v) => v.textContent?.trim());
      expect(configValues).to.include('main');
      expect(configValues).to.include('develop');
      expect(configValues).to.include('feature/*');
      expect(configValues).to.include('release/*');
      expect(configValues).to.include('hotfix/*');
    });
  });

  // ── Section toggle ─────────────────────────────────────────────────────
  describe('section toggle', () => {
    it('collapses a section when clicking its header', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();

      let featureItems = el.shadowRoot!.querySelectorAll('.item');
      expect(featureItems.length).to.be.greaterThan(0);

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      (sectionHeaders[0] as HTMLElement).click();
      await el.updateComplete;

      const icon = el.shadowRoot!.querySelector('.section-icon');
      expect(icon?.classList.contains('collapsed')).to.be.true;

      featureItems = el.shadowRoot!.querySelectorAll('.item');
      expect(featureItems.length).to.equal(0);
    });

    it('re-expands a collapsed section on second click', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();

      const sectionHeaders = el.shadowRoot!.querySelectorAll('.section-header');
      const featureHeader = sectionHeaders[0] as HTMLElement;

      featureHeader.click();
      await el.updateComplete;
      featureHeader.click();
      await el.updateComplete;

      const icon = el.shadowRoot!.querySelector('.section-icon');
      expect(icon?.classList.contains('collapsed')).to.be.false;

      const featureItems = el.shadowRoot!.querySelectorAll('.item');
      expect(featureItems.length).to.be.greaterThan(0);
    });
  });

  // ── GitFlow init detection ─────────────────────────────────────────────
  describe('gitflow init detection', () => {
    it('shows Initialize Git Flow button when not initialized', async () => {
      setupMocks({ config: UNINIT_CONFIG });
      const el = await renderPanel();

      const initBtn = el.shadowRoot!.querySelector('.btn-primary');
      expect(initBtn).to.not.be.null;
      expect(initBtn!.textContent?.trim()).to.equal('Initialize Git Flow');
    });

    it('shows init description text when not initialized', async () => {
      setupMocks({ config: UNINIT_CONFIG });
      const el = await renderPanel();

      const desc = el.shadowRoot!.querySelector('.init-description');
      expect(desc).to.not.be.null;
      expect(desc!.textContent).to.include('not initialized');
    });

    it('does NOT show init section when already initialized', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();

      const initSection = el.shadowRoot!.querySelector('.init-section');
      expect(initSection).to.be.null;
    });

    it('calls init_gitflow when Initialize button is clicked', async () => {
      let initCalled = false;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return initCalled ? DEFAULT_CONFIG : UNINIT_CONFIG;
          case 'init_gitflow':
            initCalled = true;
            return DEFAULT_CONFIG;
          case 'get_branches':
            return emptyBranches;
          default:
            return null;
        }
      };

      const el = await renderPanel();
      clearHistory();

      const initBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      initBtn.click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const initCalls = findCommands('init_gitflow');
      expect(initCalls.length).to.equal(1);
      expect((initCalls[0].args as Record<string, unknown>).path).to.equal(REPO_PATH);
    });

    it('dispatches gitflow-initialized event on successful init', async () => {
      let initCalled = false;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return initCalled ? DEFAULT_CONFIG : UNINIT_CONFIG;
          case 'init_gitflow':
            initCalled = true;
            return DEFAULT_CONFIG;
          case 'get_branches':
            return emptyBranches;
          default:
            return null;
        }
      };

      const el = await renderPanel();

      let eventDetail: unknown = null;
      el.addEventListener('gitflow-initialized', ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      const initBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      initBtn.click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      // Carries the pre-await repo capture so the host's refresh pins to
      // the repo the init ran on.
      expect(eventDetail).to.deep.equal({ repositoryPath: REPO_PATH });
    });
  });

  // ── Start operations ───────────────────────────────────────────────────
  describe('load race safety', () => {
    it('a slow load for the previous repo cannot overwrite the current repo panel', async () => {
      // The Finish buttons bind directly to the active items; a stale load
      // for repo A landing after the user switched to repo B would show A's
      // branches under B's tab and could finish/delete the wrong branch.
      let releaseA: ((v: unknown) => void) | null = null;
      mockInvoke = async (command: string, args?: unknown) => {
        const path = (args as { path?: string })?.path;
        if (command === 'get_gitflow_config') {
          if (path === '/repo/A') return new Promise((res) => { releaseA = res; });
          return DEFAULT_CONFIG;
        }
        if (command === 'get_branches') {
          return path === '/repo/A'
            ? [makeBranch({ name: 'feature/A-only', shorthand: 'feature/A-only', isHead: false })]
            : [makeBranch({ name: 'feature/B-only', shorthand: 'feature/B-only', isHead: false })];
        }
        return null;
      };

      const el = await fixture<GnGitflowPanel>(
        html`<gn-gitflow-panel .repositoryPath=${'/repo/A'}></gn-gitflow-panel>`
      );
      // A's config load is deferred (in flight). Switch to B, which resolves.
      el.repositoryPath = '/repo/B';
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 60));
      await el.updateComplete;

      const internal = el as unknown as { activeFeatures: Array<{ name: string }> };
      expect(internal.activeFeatures.map((f) => f.name)).to.deep.equal(['B-only']);

      // A's slow response finally lands — it must be discarded, not applied.
      releaseA!(DEFAULT_CONFIG);
      await new Promise((r) => setTimeout(r, 60));
      await el.updateComplete;

      expect(
        internal.activeFeatures.map((f) => f.name),
        "the stale repo's items must not overwrite the current panel",
      ).to.deep.equal(['B-only']);
    });
  });

  describe('start operations', () => {
    it('calls gitflow_start_feature when New Feature action button is clicked', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt('my-feature');

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const calls = findCommands('gitflow_start_feature');
        expect(calls.length).to.equal(1);
        expect((calls[0].args as Record<string, unknown>).path).to.equal(REPO_PATH);
        expect((calls[0].args as Record<string, unknown>).name).to.equal('my-feature');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('calls gitflow_start_release when New Release action button is clicked', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt('2.0.0');

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[1] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const calls = findCommands('gitflow_start_release');
        expect(calls.length).to.equal(1);
        expect((calls[0].args as Record<string, unknown>).path).to.equal(REPO_PATH);
        expect((calls[0].args as Record<string, unknown>).version).to.equal('2.0.0');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('calls gitflow_start_hotfix when New Hotfix action button is clicked', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt('1.0.2');

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[2] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const calls = findCommands('gitflow_start_hotfix');
        expect(calls.length).to.equal(1);
        expect((calls[0].args as Record<string, unknown>).path).to.equal(REPO_PATH);
        expect((calls[0].args as Record<string, unknown>).version).to.equal('1.0.2');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('does NOT call start when prompt is cancelled (returns null)', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt(null);

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        expect(findCommands('gitflow_start_feature').length).to.equal(0);
      } finally {
        cleanupMockPrompt();
      }
    });

    it('dispatches gitflow-operation event on successful start feature', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();

      setupMockPrompt('new-feat');

      let eventDetail: unknown = null;
      el.addEventListener('gitflow-operation', ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        // repositoryPath is the PRE-AWAIT capture — the host's refresh must
        // target the repo the start ran on, not the tab active at completion.
        expect(eventDetail).to.deep.equal({
          type: 'start-feature',
          name: 'new-feat',
          repositoryPath: REPO_PATH,
        });
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── Finish operations ──────────────────────────────────────────────────
  describe('finish operations', () => {
    it('calls gitflow_finish_feature when finish button is clicked on a feature', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();
      clearHistory();

      const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
      expect(finishBtns.length).to.be.greaterThan(0);

      (finishBtns[0] as HTMLButtonElement).click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const calls = findCommands('gitflow_finish_feature');
      expect(calls.length).to.equal(1);
      const args = calls[0].args as Record<string, unknown>;
      expect(args.path).to.equal(REPO_PATH);
      expect(args.name).to.equal('login');
      expect(args.deleteBranch).to.equal(true);
      expect(args.squash).to.equal(false);
    });

    it('calls gitflow_finish_release when finish button is clicked on a release', async () => {
      setupMocks({ branches: releaseBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt('Release 1.0.0');

      try {
        const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
        expect(finishBtns.length).to.be.greaterThan(0);

        (finishBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const calls = findCommands('gitflow_finish_release');
        expect(calls.length).to.equal(1);
        const args = calls[0].args as Record<string, unknown>;
        expect(args.path).to.equal(REPO_PATH);
        expect(args.version).to.equal('1.0.0');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('calls gitflow_finish_hotfix when finish button is clicked on a hotfix', async () => {
      setupMocks({ branches: hotfixBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt('Hotfix 1.0.1');

      try {
        const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
        expect(finishBtns.length).to.be.greaterThan(0);

        (finishBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const calls = findCommands('gitflow_finish_hotfix');
        expect(calls.length).to.equal(1);
        const args = calls[0].args as Record<string, unknown>;
        expect(args.path).to.equal(REPO_PATH);
        expect(args.version).to.equal('1.0.1');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('dispatches gitflow-operation event on successful finish feature', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();

      let eventDetail: unknown = null;
      el.addEventListener('gitflow-operation', ((e: CustomEvent) => {
        eventDetail = e.detail;
      }) as EventListener);

      const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
      (finishBtns[0] as HTMLButtonElement).click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      // repositoryPath is the PRE-AWAIT capture — same pinning as the
      // conflict-path events.
      expect(eventDetail).to.deep.equal({
        type: 'finish-feature',
        name: 'login',
        repositoryPath: REPO_PATH,
      });
    });

    it('does NOT call finish release when prompt is cancelled', async () => {
      setupMocks({ branches: releaseBranches });
      const el = await renderPanel();
      clearHistory();

      setupMockPrompt(null);

      try {
        const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
        (finishBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 100));
        await el.updateComplete;

        expect(findCommands('gitflow_finish_release').length).to.equal(0);
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    it('shows the load error, not the init section, when config load fails', async () => {
      // When get_gitflow_config throws, invokeCommand catches it and returns
      // { success: false, error: { message } } — it never throws, so this is
      // the path a real backend Err takes. That is a FAILED load, not "not
      // initialized": the Initialize button would rewrite the repo's gitflow
      // config with the defaults, so it must not be offered here.
      mockInvoke = async (command: string) => {
        if (command === 'get_gitflow_config') {
          throw new Error('failed to open repository');
        }
        return null;
      };

      const el = await renderPanel();

      expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(1);
      expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(0);
      expect(el.shadowRoot!.querySelector('.load-error-message')?.textContent ?? '').to.contain(
        'failed to open repository',
      );
    });

    it('retries the config load and renders the sections on success', async () => {
      let failNext = true;
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            if (failNext) throw new Error('failed to open repository');
            return DEFAULT_CONFIG;
          case 'get_branches':
            return emptyBranches;
          default:
            return null;
        }
      };

      const el = await renderPanel();
      expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(1);

      failNext = false;
      const retryBtn = el.shadowRoot!.querySelector('.load-error .btn') as HTMLButtonElement;
      expect(retryBtn).to.not.be.null;
      retryBtn.click();

      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(0);
      expect(el.shadowRoot!.querySelectorAll('.section-header').length).to.equal(3);
      expect(findCommands('get_gitflow_config').length).to.be.greaterThan(1);
    });

    it('reports a config load that succeeds with no payload as a failure', async () => {
      // { success: true, data: null } lands in the same else branch as an Err.
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return null;
          case 'get_branches':
            return emptyBranches;
          default:
            return null;
        }
      };

      const el = await renderPanel();

      expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(1);
      expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(0);
      expect(el.shadowRoot!.querySelector('.load-error-message')?.textContent ?? '').to.contain(
        'Failed to load Git Flow configuration',
      );
    });

    it('renders the read-failure message as section text, not a dismissible banner', async () => {
      // The failure text belongs to the load-error section itself. If it were
      // the dismissible error banner instead, dismissing it would leave the
      // panel with a bare Retry button and no explanation of what went wrong.
      mockInvoke = async (command: string) => {
        if (command === 'get_gitflow_config') {
          throw new Error('failed to open repository');
        }
        return null;
      };

      const el = await renderPanel();

      expect(el.shadowRoot!.querySelectorAll('.error-banner').length).to.equal(0);
      expect(el.shadowRoot!.querySelector('.load-error-message')?.textContent ?? '').to.contain(
        'failed to open repository',
      );
    });

    it('shows error when init_gitflow fails', async () => {
      // When init_gitflow throws, invokeCommand returns { success: false,
      // error: { message: '...' } }. Component sets this.error to the message.
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return UNINIT_CONFIG;
          case 'init_gitflow':
            throw new Error('Init failed: no main branch');
          default:
            return null;
        }
      };

      const el = await renderPanel();

      const initBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      initBtn.click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const errorEl = el.shadowRoot!.querySelector('.error-banner');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('Init failed: no main branch');
      // An init that failed on a genuinely uninitialized repo must KEEP the
      // Initialize button — it is not a config read failure.
      expect(el.shadowRoot!.querySelectorAll('.init-section').length).to.equal(1);
      expect(el.shadowRoot!.querySelectorAll('.load-error').length).to.equal(0);
    });

    it('shows error when start feature fails', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return emptyBranches;
          case 'gitflow_start_feature':
            throw new Error('Branch already exists');
          default:
            return null;
        }
      };

      const el = await renderPanel();

      setupMockPrompt('duplicate');

      try {
        const actionBtns = el.shadowRoot!.querySelectorAll('.action-btn');
        (actionBtns[0] as HTMLButtonElement).click();

        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const errorEl = el.shadowRoot!.querySelector('.error-banner');
        expect(errorEl).to.not.be.null;
        expect(errorEl!.textContent).to.include('Branch already exists');
      } finally {
        cleanupMockPrompt();
      }
    });

    it('shows error when finish feature fails', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return featureBranches;
          case 'gitflow_finish_feature':
            throw new Error('Merge conflict');
          default:
            return null;
        }
      };

      const el = await renderPanel();

      const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
      (finishBtns[0] as HTMLButtonElement).click();

      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const errorEl = el.shadowRoot!.querySelector('.error-banner');
      expect(errorEl).to.not.be.null;
      expect(errorEl!.textContent).to.include('Merge conflict');
    });

    it('renders error as a dismissable inline banner above panel content', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return featureBranches;
          case 'gitflow_finish_feature':
            throw new Error('Something broke');
          default:
            return null;
        }
      };

      const el = await renderPanel();

      const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
      (finishBtns[0] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      // Banner is shown AND the normal panel content is still rendered.
      const banner = el.shadowRoot!.querySelector('.error-banner');
      expect(banner).to.not.be.null;
      expect(el.shadowRoot!.querySelector('.panel')).to.not.be.null;

      // Dismiss clears the error.
      const dismissBtn = el.shadowRoot!.querySelector('.error-banner-dismiss') as HTMLButtonElement;
      expect(dismissBtn).to.not.be.null;
      dismissBtn.click();
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.error-banner')).to.be.null;
      expect(el.shadowRoot!.querySelector('.panel')).to.not.be.null;
    });

    it('opens the conflict dialog when finish feature returns MERGE_CONFLICT', async () => {
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return featureBranches;
          case 'gitflow_finish_feature':
            throw { code: 'MERGE_CONFLICT', message: 'conflicts while merging' };
          default:
            return null;
        }
      };

      const el = await renderPanel();

      let conflictDetail: unknown = null;
      el.addEventListener('open-conflict-dialog', ((e: CustomEvent) => {
        conflictDetail = e.detail;
      }) as EventListener);

      const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
      (finishBtns[0] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 150));
      await el.updateComplete;

      const fd = conflictDetail as { operationType: string; squash: boolean; gitflowFinish: Record<string, unknown> };
      expect(fd.operationType).to.equal('merge');
      expect(fd.squash).to.be.false;
      expect(fd.gitflowFinish).to.include({
        kind: 'feature',
        name: 'login',
        branchName: 'feature/login',
        deleteBranch: true,
      });
      // No inline error banner when routing to the conflict dialog.
      expect(el.shadowRoot!.querySelector('.error-banner')).to.be.null;
    });

    it('opens the conflict dialog when finish hotfix returns MERGE_CONFLICT', async () => {
      setupMockPrompt('Hotfix 1.0.1');
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return hotfixBranches;
          case 'gitflow_finish_hotfix':
            throw { code: 'MERGE_CONFLICT', message: 'conflicts while merging hotfix' };
          default:
            return null;
        }
      };

      const el = await renderPanel();

      let conflictDetail: unknown = null;
      el.addEventListener('open-conflict-dialog', ((e: CustomEvent) => {
        conflictDetail = e.detail;
      }) as EventListener);

      try {
        const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
        (finishBtns[0] as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const fd = conflictDetail as { operationType: string; squash: boolean; gitflowFinish: Record<string, unknown> };
        expect(fd.operationType).to.equal('merge');
        expect(fd.squash).to.be.false;
        expect(fd.gitflowFinish).to.include({
          kind: 'hotfix',
          name: '1.0.1',
          branchName: 'hotfix/1.0.1',
          deleteBranch: true,
          tagMessage: 'Hotfix 1.0.1',
        });
      } finally {
        cleanupMockPrompt();
      }
    });

    it('shows the tag-collision error in the banner and does not open the conflict dialog when finish release fails', async () => {
      // The backend refuses a finish whose version tag already exists on an
      // unrelated commit. That is OPERATION_FAILED, not MERGE_CONFLICT, so it
      // must land in the inline banner — routing it to the conflict dialog
      // would offer a resolution flow for a merge that never started.
      const collision =
        "Tag 'v1.0.0' already exists and does not contain 'release/1.0.0'. "
        + 'Delete or rename the tag, or finish with a different version.';
      setupMockPrompt('Release 1.0.0');
      mockInvoke = async (command: string) => {
        switch (command) {
          case 'get_gitflow_config':
            return DEFAULT_CONFIG;
          case 'get_branches':
            return releaseBranches;
          case 'gitflow_finish_release':
            throw { code: 'OPERATION_FAILED', message: collision };
          default:
            return null;
        }
      };

      const el = await renderPanel();

      let conflictOpened = false;
      el.addEventListener('open-conflict-dialog', () => {
        conflictOpened = true;
      });

      try {
        const finishBtns = el.shadowRoot!.querySelectorAll('.item-finish-btn:not(.item-squash-btn)');
        (finishBtns[0] as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 150));
        await el.updateComplete;

        const errorEl = el.shadowRoot!.querySelector('.error-banner');
        expect(errorEl, 'error banner should be shown').to.not.be.null;
        expect(errorEl!.textContent).to.include("Tag 'v1.0.0' already exists");
        expect(conflictOpened, 'conflict dialog must not open').to.be.false;

        // The release is still listed — the finish was refused, not applied.
        const items = Array.from(el.shadowRoot!.querySelectorAll('.item-name'))
          .map((n) => n.textContent?.trim());
        expect(items).to.include('1.0.0');
      } finally {
        cleanupMockPrompt();
      }
    });
  });

  // ── Loading state ──────────────────────────────────────────────────────
  describe('loading state', () => {
    it('shows loading indicator during initial fetch', async () => {
      let resolveConfig: ((value: unknown) => void) | null = null;
      mockInvoke = (command: string) => {
        if (command === 'get_gitflow_config') {
          return new Promise((resolve) => {
            resolveConfig = resolve;
          });
        }
        if (command === 'get_branches') {
          return Promise.resolve(emptyBranches);
        }
        return Promise.resolve(null);
      };

      const el = await fixture<GnGitflowPanel>(
        html`<gn-gitflow-panel .repositoryPath=${REPO_PATH}></gn-gitflow-panel>`
      );
      await el.updateComplete;

      const loadingEl = el.shadowRoot!.querySelector('.loading');
      expect(loadingEl).to.not.be.null;
      expect(loadingEl!.textContent).to.include('Loading Git Flow');

      // Resolve so the component finishes cleanly
      resolveConfig!(DEFAULT_CONFIG);
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;
    });

    it('removes loading indicator after fetch completes', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();

      const loadingEl = el.shadowRoot!.querySelector('.loading');
      expect(loadingEl).to.be.null;
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────
  describe('empty state', () => {
    it('shows "No active items" for sections with no branches', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();

      const emptySections = el.shadowRoot!.querySelectorAll('.empty-section');
      expect(emptySections.length).to.equal(3);

      Array.from(emptySections).forEach((section) => {
        expect(section.textContent).to.include('No active items');
      });
    });

    it('shows empty for hotfixes but items for features', async () => {
      setupMocks({ branches: featureBranches });
      const el = await renderPanel();

      const featureItems = el.shadowRoot!.querySelectorAll('.item');
      expect(featureItems.length).to.equal(2);

      const emptySections = el.shadowRoot!.querySelectorAll('.empty-section');
      expect(emptySections.length).to.equal(2);
    });
  });

  // ── Refresh ────────────────────────────────────────────────────────────
  describe('refresh', () => {
    it('public refresh() method reloads config and branches', async () => {
      setupMocks({ branches: emptyBranches });
      const el = await renderPanel();
      clearHistory();

      setupMocks({ branches: featureBranches });
      await el.refresh();
      await new Promise((r) => setTimeout(r, 100));
      await el.updateComplete;

      const configCalls = findCommands('get_gitflow_config');
      expect(configCalls.length).to.be.greaterThan(0);

      const items = el.shadowRoot!.querySelectorAll('.item');
      expect(items.length).to.equal(2);
    });
  });
});
