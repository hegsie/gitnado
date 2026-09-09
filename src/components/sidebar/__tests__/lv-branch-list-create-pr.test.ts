/**
 * Tests for the "Create pull request..." entry on the branch context menu.
 *
 * Covers the enabled/disabled conditions (upstream present, provider
 * detected), the provider-specific label, and the event the entry dispatches
 * for app-shell to route into the provider dialog's existing create flow.
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
import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import type { LvBranchList } from '../lv-branch-list.ts';
import { invalidateProviderDetection } from '../../../services/pull-request.service.ts';
import '../lv-branch-list.ts';

const REPO_PATH = '/test/repo';

interface BranchFields {
  name: string;
  shorthand: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
  targetOid: string;
  isStale: boolean;
}

function makeBranch(overrides: Partial<BranchFields> = {}): BranchFields {
  return {
    name: 'feature/prs',
    shorthand: 'feature/prs',
    isHead: false,
    isRemote: false,
    upstream: null,
    targetOid: 'abc123',
    isStale: false,
    ...overrides,
  };
}

type Provider = 'github' | 'gitlab' | 'none';

function setupMocks(branches: BranchFields[], provider: Provider): void {
  mockInvoke = async (command: string) => {
    switch (command) {
      case 'get_branches':
        return branches;
      case 'get_remotes':
        return [];
      case 'detect_github_repo':
        return provider === 'github'
          ? { owner: 'octo', repo: 'leviathan', remoteName: 'origin' }
          : null;
      case 'detect_gitlab_repo':
        return provider === 'gitlab'
          ? { instanceUrl: 'https://gitlab.com', projectPath: 'octo/lev', remoteName: 'origin' }
          : null;
      case 'detect_ado_repo':
      case 'detect_bitbucket_repo':
        return null;
      default:
        return null;
    }
  };
}

async function createComponent(
  branches: BranchFields[],
  provider: Provider,
): Promise<LvBranchList> {
  setupMocks(branches, provider);
  const el = await fixture<LvBranchList>(
    html`<lv-branch-list .repositoryPath=${REPO_PATH}></lv-branch-list>`,
  );
  // connectedCallback loads the branches and then detects the provider; the
  // resolved flag flips at the end of that chain.
  await waitUntil(
    () => (el as unknown as { prProviderResolved: boolean }).prProviderResolved,
    'the provider detection to resolve',
  );
  await el.updateComplete;
  return el;
}

/** Open the context menu over `branch` and return the create-request entry. */
async function openMenuFor(
  el: LvBranchList,
  branch: BranchFields,
): Promise<HTMLButtonElement | undefined> {
  (el as unknown as { contextMenu: unknown }).contextMenu = {
    visible: true,
    x: 0,
    y: 0,
    branch,
  };
  await el.updateComplete;
  return Array.from(
    el.shadowRoot!.querySelectorAll('.context-menu-item'),
  ).find((b) => /Create (pull|merge) request/.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

describe('lv-branch-list create pull request entry', () => {
  beforeEach(() => {
    invalidateProviderDetection();
  });

  afterEach(() => {
    invalidateProviderDetection();
  });

  it('is enabled for a local branch with an upstream on a detected provider', async () => {
    const branch = makeBranch({ upstream: 'origin/feature/prs' });
    const el = await createComponent([branch], 'github');

    const entry = await openMenuFor(el, branch);
    expect(entry, 'entry present').to.exist;
    expect(entry!.disabled).to.equal(false);
    expect(entry!.textContent).to.contain('Create pull request');
  });

  it('is disabled, and says why, when the branch has no upstream', async () => {
    const branch = makeBranch({ upstream: null });
    const el = await createComponent([branch], 'github');

    const entry = await openMenuFor(el, branch);
    expect(entry!.disabled).to.equal(true);
    expect(entry!.title).to.contain('upstream');
  });

  it('is disabled, and says why, when no provider is detected', async () => {
    const branch = makeBranch({ upstream: 'origin/feature/prs' });
    const el = await createComponent([branch], 'none');

    const entry = await openMenuFor(el, branch);
    expect(entry!.disabled).to.equal(true);
    expect(entry!.title).to.contain('No GitHub, GitLab, Bitbucket or Azure DevOps');
  });

  it('says "merge request" on GitLab', async () => {
    const branch = makeBranch({ upstream: 'origin/feature/prs' });
    const el = await createComponent([branch], 'gitlab');

    const entry = await openMenuFor(el, branch);
    expect(entry!.textContent).to.contain('Create merge request');
    expect(entry!.disabled).to.equal(false);
  });

  it('is offered for the checked-out branch too', async () => {
    const branch = makeBranch({
      name: 'main',
      shorthand: 'main',
      isHead: true,
      upstream: 'origin/main',
    });
    const el = await createComponent([branch], 'github');

    const entry = await openMenuFor(el, branch);
    expect(entry, 'entry present on HEAD').to.exist;
    expect(entry!.disabled).to.equal(false);
  });

  it('is not offered on a remote branch', async () => {
    const remote = makeBranch({
      name: 'origin/feature/prs',
      shorthand: 'feature/prs',
      isRemote: true,
      upstream: null,
    });
    const el = await createComponent([remote], 'github');

    const entry = await openMenuFor(el, remote);
    expect(entry).to.be.undefined;
  });

  it('dispatches create-pull-request with the branch as the source', async () => {
    const branch = makeBranch({ upstream: 'origin/feature/prs' });
    const main = makeBranch({ name: 'main', shorthand: 'main', upstream: 'origin/main' });
    const el = await createComponent([main, branch], 'github');

    let detail: { provider?: string; sourceBranch?: string; baseBranch?: string } | null = null;
    el.addEventListener('create-pull-request', (e) => {
      detail = (e as CustomEvent<typeof detail>).detail;
    });

    const entry = await openMenuFor(el, branch);
    entry!.click();
    await el.updateComplete;

    expect(detail, 'event dispatched').to.not.be.null;
    expect(detail!.provider).to.equal('github');
    expect(detail!.sourceBranch).to.equal('feature/prs');
    // "main" exists locally, so it is suggested as the base.
    expect(detail!.baseBranch).to.equal('main');
    // The menu closes after the hand-off.
    expect(
      (el as unknown as { contextMenu: { visible: boolean } }).contextMenu.visible,
    ).to.equal(false);
  });

  it('suggests no base branch when no conventional trunk exists locally', async () => {
    const branch = makeBranch({ upstream: 'origin/feature/prs' });
    const el = await createComponent([branch], 'github');

    let detail: { baseBranch?: string } | null = null;
    el.addEventListener('create-pull-request', (e) => {
      detail = (e as CustomEvent<typeof detail>).detail;
    });

    const entry = await openMenuFor(el, branch);
    entry!.click();
    await el.updateComplete;

    expect(detail).to.not.be.null;
    expect(detail!.baseBranch).to.equal(undefined);
  });

  it('dispatches nothing when the guard conditions are not met', async () => {
    const branch = makeBranch({ upstream: null });
    const el = await createComponent([branch], 'github');

    let fired = 0;
    el.addEventListener('create-pull-request', () => {
      fired++;
    });

    // Bypassing the disabled attribute, as a stale menu surviving a repository
    // switch would: the handler must refuse on its own.
    (el as unknown as { contextMenu: unknown }).contextMenu = {
      visible: true,
      x: 0,
      y: 0,
      branch,
    };
    (el as unknown as { handleCreatePullRequest: () => void }).handleCreatePullRequest();

    expect(fired).to.equal(0);
  });
});
