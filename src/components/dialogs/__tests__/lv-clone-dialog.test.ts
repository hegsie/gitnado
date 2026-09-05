/**
 * Tests for lv-clone-dialog component
 *
 * Tests URL parsing, form validation, clone flow, progress tracking,
 * error handling, and event dispatching.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

// Mock the Tauri event plugin internals (used by @tauri-apps/api/event)
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => { void once; void callback; return 0; },
  unregisterListener: (_event: string, _eventId: number) => {},
};

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../lv-clone-dialog.ts';
import type { LvCloneDialog } from '../lv-clone-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';

// ── Tests ──────────────────────────────────────────────────────────────────
describe('lv-clone-dialog', () => {
  let el: LvCloneDialog;

  beforeEach(async () => {
    mockInvoke = () => Promise.resolve(null);
    settingsStore.getState().setDefaultClonePath('');

    el = await fixture<LvCloneDialog>(html`
      <lv-clone-dialog></lv-clone-dialog>
    `);
  });

  // ── Rendering ──────────────────────────────────────────────────────────
  describe('rendering', () => {
    it('renders without errors', () => {
      expect(el).to.exist;
      expect(el.tagName.toLowerCase()).to.equal('lv-clone-dialog');
    });

    it('renders URL input field', () => {
      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      expect(urlInput).to.exist;
      expect(urlInput.placeholder).to.include('github.com');
    });

    it('renders destination input field', () => {
      const destInput = el.shadowRoot!.querySelector('#destination') as HTMLInputElement;
      expect(destInput).to.exist;
    });

    it('renders Browse button', () => {
      const browseBtn = el.shadowRoot!.querySelector('.browse-btn') as HTMLButtonElement;
      expect(browseBtn).to.exist;
      expect(browseBtn.textContent).to.include('Browse');
    });

    it('renders Clone and Cancel buttons', () => {
      const buttons = el.shadowRoot!.querySelectorAll('.btn');
      const buttonTexts = Array.from(buttons).map(b => b.textContent!.trim());
      expect(buttonTexts).to.include('Cancel');
      expect(buttonTexts).to.include('Clone');
    });

    it('renders shallow clone depth field', () => {
      const depthInput = el.shadowRoot!.querySelector('#depth') as HTMLInputElement;
      expect(depthInput).to.exist;
      expect(depthInput.type).to.equal('number');
    });

    it('renders partial clone filter select', () => {
      const filterSelect = el.shadowRoot!.querySelector('#filter') as HTMLSelectElement;
      expect(filterSelect).to.exist;
      const options = filterSelect.querySelectorAll('option');
      expect(options.length).to.be.greaterThanOrEqual(3);
    });

    it('renders single-branch checkbox', () => {
      const checkbox = el.shadowRoot!.querySelector('#single-branch') as HTMLInputElement;
      expect(checkbox).to.exist;
      expect(checkbox.type).to.equal('checkbox');
    });
  });

  // ── URL parsing ────────────────────────────────────────────────────────
  describe('URL parsing', () => {
    it('extracts repo name from HTTPS URL', async () => {
      const input = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      input.value = 'https://github.com/user/my-repo.git';
      input.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const preview = el.shadowRoot!.querySelector('.repo-name-preview');
      expect(preview).to.exist;
      expect(preview!.textContent).to.include('my-repo');
    });

    it('extracts repo name from SSH URL', async () => {
      const input = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      input.value = 'git@github.com:user/my-repo.git';
      input.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const preview = el.shadowRoot!.querySelector('.repo-name-preview');
      expect(preview).to.exist;
      expect(preview!.textContent).to.include('my-repo');
    });

    it('extracts repo name without .git suffix', async () => {
      const input = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      input.value = 'https://github.com/user/repo-name';
      input.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const preview = el.shadowRoot!.querySelector('.repo-name-preview');
      expect(preview!.textContent).to.include('repo-name');
    });

    it('handles trailing slash in URL', async () => {
      const input = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      input.value = 'https://github.com/user/my-repo/';
      input.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const preview = el.shadowRoot!.querySelector('.repo-name-preview');
      expect(preview!.textContent).to.include('my-repo');
    });

    it('returns empty repo name for empty URL', () => {
      const extractRepoName = (el as unknown as {
        extractRepoName: (url: string) => string;
      }).extractRepoName.bind(el);

      expect(extractRepoName('')).to.equal('');
    });
  });

  // ── Form validation ────────────────────────────────────────────────────
  describe('form validation', () => {
    it('disables Clone button when URL is empty', async () => {
      const cloneBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(cloneBtn.disabled).to.be.true;
    });

    it('disables Clone button when destination is empty', async () => {
      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      urlInput.value = 'https://github.com/user/repo.git';
      urlInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const cloneBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(cloneBtn.disabled).to.be.true;
    });

    it('enables Clone button when URL and destination are provided', async () => {
      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      urlInput.value = 'https://github.com/user/repo.git';
      urlInput.dispatchEvent(new Event('input'));

      const destInput = el.shadowRoot!.querySelector('#destination') as HTMLInputElement;
      destInput.value = '/home/user/projects';
      destInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const cloneBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(cloneBtn.disabled).to.be.false;
    });

    it('shows error when cloning with empty URL', async () => {
      // Directly call handleClone
      const handleClone = (el as unknown as {
        handleClone: () => Promise<void>;
      }).handleClone.bind(el);

      await handleClone();
      await el.updateComplete;

      const error = el.shadowRoot!.querySelector('.error-message');
      expect(error).to.exist;
      expect(error!.textContent).to.include('URL');
    });

    it('shows error when cloning with empty destination', async () => {
      // Set URL but not destination
      const internal = el as unknown as { url: string; destination: string };
      internal.url = 'https://github.com/user/repo.git';
      internal.destination = '';

      const handleClone = (el as unknown as {
        handleClone: () => Promise<void>;
      }).handleClone.bind(el);

      await handleClone();
      await el.updateComplete;

      const error = el.shadowRoot!.querySelector('.error-message');
      expect(error).to.exist;
      expect(error!.textContent).to.include('destination');
    });

    it('clears error when URL is changed', async () => {
      // Set error first
      const internal = el as unknown as { error: string };
      internal.error = 'Some error';
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      urlInput.value = 'https://github.com/user/repo.git';
      urlInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const error = el.shadowRoot!.querySelector('.error-message');
      expect(error).to.not.exist;
    });
  });

  // ── Full path computation ──────────────────────────────────────────────
  describe('full path', () => {
    it('computes full path with repo name', async () => {
      const internal = el as unknown as { url: string; destination: string; repoName: string };
      internal.url = 'https://github.com/user/my-repo.git';
      internal.repoName = 'my-repo';
      internal.destination = '/home/user/projects';
      await el.updateComplete;

      const fullPath = (el as unknown as { fullPath: string }).fullPath;
      expect(fullPath).to.equal('/home/user/projects/my-repo');
    });

    it('returns just destination when no repo name', () => {
      const internal = el as unknown as { destination: string; repoName: string };
      internal.destination = '/home/user/projects';
      internal.repoName = '';

      const fullPath = (el as unknown as { fullPath: string }).fullPath;
      expect(fullPath).to.equal('/home/user/projects');
    });

    it('returns empty string when no destination', () => {
      const internal = el as unknown as { destination: string };
      internal.destination = '';

      const fullPath = (el as unknown as { fullPath: string }).fullPath;
      expect(fullPath).to.equal('');
    });
  });

  // ── Clone state ────────────────────────────────────────────────────────
  describe('clone state', () => {
    it('disables inputs during clone', async () => {
      const internal = el as unknown as { isCloning: boolean };
      internal.isCloning = true;
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      const destInput = el.shadowRoot!.querySelector('#destination') as HTMLInputElement;
      const browseBtn = el.shadowRoot!.querySelector('.browse-btn') as HTMLButtonElement;

      expect(urlInput.disabled).to.be.true;
      expect(destInput.disabled).to.be.true;
      expect(browseBtn.disabled).to.be.true;
    });

    it('shows progress section during clone', async () => {
      const internal = el as unknown as { isCloning: boolean; progressText: string; progress: number };
      internal.isCloning = true;
      internal.progressText = 'Receiving objects: 50/100';
      internal.progress = 50;
      await el.updateComplete;

      const progressSection = el.shadowRoot!.querySelector('.progress-section');
      expect(progressSection).to.exist;

      const progressText = el.shadowRoot!.querySelector('.progress-text');
      expect(progressText!.textContent).to.include('50/100');
    });

    it('shows progress bar with correct width', async () => {
      const internal = el as unknown as { isCloning: boolean; progress: number; progressText: string };
      internal.isCloning = true;
      internal.progress = 75;
      internal.progressText = 'Cloning...';
      await el.updateComplete;

      const fill = el.shadowRoot!.querySelector('.progress-bar-fill') as HTMLElement;
      expect(fill.style.width).to.equal('75%');
    });

    it('shows "Cloning..." button text during clone', async () => {
      const internal = el as unknown as { isCloning: boolean; url: string; destination: string };
      internal.isCloning = true;
      internal.url = 'https://github.com/user/repo.git';
      internal.destination = '/path';
      await el.updateComplete;

      const cloneBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(cloneBtn.textContent!.trim()).to.include('Cloning');
    });
  });

  // ── Depth and options ──────────────────────────────────────────────────
  describe('depth and options', () => {
    it('sets depth from input', async () => {
      const depthInput = el.shadowRoot!.querySelector('#depth') as HTMLInputElement;
      depthInput.value = '5';
      depthInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const internal = el as unknown as { depth: number | null };
      expect(internal.depth).to.equal(5);
    });

    it('sets depth to null for empty input', async () => {
      const depthInput = el.shadowRoot!.querySelector('#depth') as HTMLInputElement;
      depthInput.value = '';
      depthInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const internal = el as unknown as { depth: number | null };
      expect(internal.depth).to.be.null;
    });

    it('sets depth to null for non-numeric input', async () => {
      const depthInput = el.shadowRoot!.querySelector('#depth') as HTMLInputElement;
      depthInput.value = 'abc';
      depthInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const internal = el as unknown as { depth: number | null };
      expect(internal.depth).to.be.null;
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────
  describe('reset', () => {
    it('resets all state when reset is called', async () => {
      const internal = el as unknown as {
        url: string;
        destination: string;
        repoName: string;
        depth: number | null;
        isCloning: boolean;
        progress: number;
        progressText: string;
        error: string;
        reset: () => void;
      };

      // Set some state
      internal.url = 'https://github.com/user/repo.git';
      internal.destination = '/path';
      internal.repoName = 'repo';
      internal.depth = 5;
      internal.error = 'some error';
      internal.progress = 50;
      internal.progressText = 'cloning';

      internal.reset();

      expect(internal.url).to.equal('');
      expect(internal.destination).to.equal('');
      expect(internal.repoName).to.equal('');
      expect(internal.depth).to.be.null;
      expect(internal.isCloning).to.be.false;
      expect(internal.progress).to.equal(0);
      expect(internal.progressText).to.equal('');
      expect(internal.error).to.equal('');
    });
  });

  // ── formatBytes ────────────────────────────────────────────────────────
  describe('formatBytes', () => {
    it('formats bytes correctly', () => {
      const formatBytes = (el as unknown as {
        formatBytes: (bytes: number) => string;
      }).formatBytes.bind(el);

      expect(formatBytes(500)).to.equal('500 B');
      expect(formatBytes(1024)).to.equal('1.0 KB');
      expect(formatBytes(1536)).to.equal('1.5 KB');
      expect(formatBytes(1048576)).to.equal('1.0 MB');
      expect(formatBytes(2621440)).to.equal('2.5 MB');
    });
  });

  // ── Default clone path from settings ───────────────────────────────────
  describe('default clone path', () => {
    it('prefills destination from settings on open()', async () => {
      settingsStore.getState().setDefaultClonePath('/home/user/projects');

      el.open();
      await el.updateComplete;

      const internal = el as unknown as { destination: string };
      expect(internal.destination).to.equal('/home/user/projects');

      const destInput = el.shadowRoot!.querySelector('#destination') as HTMLInputElement;
      expect(destInput.value).to.equal('/home/user/projects');
    });

    it('leaves destination empty when no default is set', async () => {
      settingsStore.getState().setDefaultClonePath('');

      el.open();
      await el.updateComplete;

      const internal = el as unknown as { destination: string };
      expect(internal.destination).to.equal('');
    });

    it('reapplies the default each time open() is called', async () => {
      settingsStore.getState().setDefaultClonePath('/home/a');
      el.open();
      await el.updateComplete;

      const internal = el as unknown as { destination: string };
      internal.destination = '/something/else';

      settingsStore.getState().setDefaultClonePath('/home/b');
      el.open();
      await el.updateComplete;

      expect(internal.destination).to.equal('/home/b');
    });
  });

  // ── Modal close behavior ───────────────────────────────────────────────
  describe('modal close', () => {
    it('does not reset when cloning is in progress', async () => {
      const internal = el as unknown as {
        isCloning: boolean;
        url: string;
        handleModalClose: () => void;
      };

      internal.isCloning = true;
      internal.url = 'https://github.com/user/repo.git';

      internal.handleModalClose();

      // URL should still be set since cloning is in progress
      expect(internal.url).to.equal('https://github.com/user/repo.git');
    });

    it('resets when not cloning', async () => {
      const internal = el as unknown as {
        isCloning: boolean;
        url: string;
        handleModalClose: () => void;
      };

      internal.isCloning = false;
      internal.url = 'https://github.com/user/repo.git';

      internal.handleModalClose();

      expect(internal.url).to.equal('');
    });
  });

  describe('re-entrancy guard', () => {
    // open() refuses while a clone is in flight, so the in-flight flag MUST be
    // cleared on every terminating path. The success branch closes via
    // setTimeout and never cleared it, and open()'s guard returns before
    // reset() can — so one successful clone made "Clone Repository" a silent
    // no-op for the rest of the session.
    it('can be reopened after a clone succeeds', async () => {
      const internal = el as unknown as {
        url: string;
        destination: string;
        isCloning: boolean;
        handleClone: () => Promise<void>;
      };

      mockInvoke = (command: string) => {
        if (command === 'clone_repository') {
          return Promise.resolve({ path: '/cloned/repo', name: 'repo' });
        }
        return Promise.resolve(null);
      };

      internal.url = 'https://github.com/user/repo.git';
      internal.destination = '/dest';
      await internal.handleClone();
      await el.updateComplete;

      // The success path schedules close() on a 500ms timer.
      await new Promise((r) => setTimeout(r, 600));
      await el.updateComplete;

      expect(internal.isCloning, 'in-flight flag cleared after success').to.be.false;

      el.open();
      await el.updateComplete;

      const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & { open: boolean };
      expect(modal.open, 'dialog reopens after a successful clone').to.be.true;
    });
  });

  // ── Cloning from a connected account ───────────────────────────────────
  describe('account source', () => {
    const pickedRepository = {
      id: '1',
      name: 'my-repo',
      owner: 'octocat',
      fullName: 'octocat/my-repo',
      description: null,
      isPrivate: true,
      cloneUrl: 'https://github.com/octocat/my-repo.git',
      webUrl: 'https://github.com/octocat/my-repo',
      defaultBranch: 'main',
      lastPushedAt: null,
    };

    function selectSource(source: 'url' | 'account'): void {
      const tab = el.shadowRoot!.querySelector(
        `#source-${source}`,
      ) as HTMLButtonElement;
      tab.click();
    }

    function picker(): HTMLElement | null {
      return el.shadowRoot!.querySelector('lv-account-repo-picker');
    }

    it('offers both sources and starts on the URL one', async () => {
      expect(el.shadowRoot!.querySelector('#source-url')!.getAttribute('aria-selected')).to.equal(
        'true',
      );
      expect(
        el.shadowRoot!.querySelector('#source-account')!.getAttribute('aria-selected'),
      ).to.equal('false');
      // The picker is not even mounted, so opening the dialog cannot call a
      // provider API.
      expect(picker()).to.equal(null);
    });

    it('shows the account picker once the account source is chosen', async () => {
      selectSource('account');
      await el.updateComplete;

      expect(picker()).to.exist;
      expect(
        el.shadowRoot!.querySelector('#source-account')!.getAttribute('aria-selected'),
      ).to.equal('true');
    });

    it('fills the URL and destination from the selected repository', async () => {
      settingsStore.getState().setDefaultClonePath('/home/user/projects');
      selectSource('account');
      await el.updateComplete;

      picker()!.dispatchEvent(
        new CustomEvent('repository-selected', {
          detail: { repository: pickedRepository },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      const destInput = el.shadowRoot!.querySelector('#destination') as HTMLInputElement;
      expect(urlInput.value).to.equal('https://github.com/octocat/my-repo.git');
      expect(destInput.value).to.equal('/home/user/projects');

      const previews = Array.from(
        el.shadowRoot!.querySelectorAll('.repo-name-preview'),
      ).map((n) => n.textContent);
      expect(previews.join(' ')).to.contain('octocat/my-repo');
      expect(previews.join(' ')).to.contain('/home/user/projects/my-repo');

      const cloneBtn = el.shadowRoot!.querySelector('.btn-primary') as HTMLButtonElement;
      expect(cloneBtn.disabled, 'Clone is ready once a repository is picked').to.be.false;
    });

    it('hands the picked repository to the unchanged clone flow', async () => {
      settingsStore.getState().setDefaultClonePath('/home/user/projects');
      const calls: { command: string; args?: unknown }[] = [];
      mockInvoke = (command: string, args?: unknown) => {
        calls.push({ command, args });
        if (command === 'clone_repository') {
          return Promise.resolve({ path: '/home/user/projects/my-repo', name: 'my-repo' });
        }
        return Promise.resolve(null);
      };

      selectSource('account');
      await el.updateComplete;
      picker()!.dispatchEvent(
        new CustomEvent('repository-selected', {
          detail: { repository: pickedRepository },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;

      await (el as unknown as { handleClone: () => Promise<void> }).handleClone();
      await el.updateComplete;

      const clone = calls.find((c) => c.command === 'clone_repository');
      expect(clone, 'the existing clone command runs').to.exist;
      const args = clone!.args as { url: string; path: string };
      expect(args.url).to.equal('https://github.com/octocat/my-repo.git');
      expect(args.path).to.equal('/home/user/projects/my-repo');
    });

    it('drops the selected-repository label once the URL is edited by hand', async () => {
      selectSource('account');
      await el.updateComplete;
      picker()!.dispatchEvent(
        new CustomEvent('repository-selected', {
          detail: { repository: pickedRepository },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      urlInput.value = 'https://example.test/other.git';
      urlInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const previews = Array.from(
        el.shadowRoot!.querySelectorAll('.repo-name-preview'),
      ).map((n) => n.textContent);
      expect(previews.join(' ')).to.not.contain('octocat/my-repo');
    });

    /** Drive the picker's "Connect an account" request and return the event
     *  the host actually received. */
    async function requestAccountsManager(): Promise<CustomEvent[]> {
      const seen: CustomEvent[] = [];
      const listener = (e: Event): void => {
        seen.push(e as CustomEvent);
      };
      el.addEventListener('manage-accounts', listener);
      picker()!.dispatchEvent(
        new CustomEvent('manage-accounts', {
          detail: { integrationType: 'github' },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;
      el.removeEventListener('manage-accounts', listener);
      return seen;
    }

    it('closes so the accounts manager is not stacked under this dialog', async () => {
      selectSource('account');
      await el.updateComplete;

      const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & {
        open: boolean;
      };
      modal.open = true;

      const seen = await requestAccountsManager();

      expect(modal.open, 'the clone dialog closes').to.be.false;
      expect(seen.length, 'the host still hears the request').to.equal(1);
    });

    it('asks for the manager without a provider, so the host records no return target', async () => {
      selectSource('account');
      await el.updateComplete;

      const seen = await requestAccountsManager();

      // The picker names the provider it was listing; the host reads that as
      // "reopen THAT provider's integration dialog when the manager closes".
      // The user came from Clone and has never seen that dialog, so the
      // request that leaves this component must carry no provider at all.
      expect(seen.length).to.equal(1);
      expect(
        (seen[0].detail as { integrationType?: string } | null)?.integrationType,
        'no provider travels to the host',
      ).to.equal(undefined);
    });

    it('comes back when the accounts manager closes, with the clone intact', async () => {
      settingsStore.getState().setDefaultClonePath('/home/user/projects');
      selectSource('account');
      await el.updateComplete;

      const urlInput = el.shadowRoot!.querySelector('#url') as HTMLInputElement;
      urlInput.value = 'https://github.com/octocat/my-repo.git';
      urlInput.dispatchEvent(new Event('input'));
      await el.updateComplete;

      const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & {
        open: boolean;
      };
      modal.open = true;

      await requestAccountsManager();
      expect(modal.open, 'stepped aside for the manager').to.be.false;

      window.dispatchEvent(new CustomEvent('profile-manager-closed'));
      await el.updateComplete;

      expect(modal.open, 'the user is returned to the clone they started').to.be.true;
      expect(
        el.shadowRoot!.querySelector('#source-account')!.getAttribute('aria-selected'),
        'still on the account source',
      ).to.equal('true');
      expect(picker(), 'the picker is mounted again').to.exist;
      expect(
        (el.shadowRoot!.querySelector('#url') as HTMLInputElement).value,
        'what the user had typed survives',
      ).to.equal('https://github.com/octocat/my-repo.git');
    });

    it('does not reopen on a later manager close it never asked for', async () => {
      selectSource('account');
      await el.updateComplete;

      const modal = el.shadowRoot!.querySelector('lv-modal') as HTMLElement & {
        open: boolean;
      };
      modal.open = true;

      await requestAccountsManager();
      window.dispatchEvent(new CustomEvent('profile-manager-closed'));
      await el.updateComplete;
      expect(modal.open).to.be.true;

      // The user dismisses the clone dialog (Escape / × / overlay all route
      // through the modal's own close). A manager closed later for some
      // unrelated reason must not pop this dialog back up.
      (modal as unknown as { close: () => void }).close();
      await el.updateComplete;
      expect(modal.open, 'dismissed').to.be.false;
      window.dispatchEvent(new CustomEvent('profile-manager-closed'));
      await el.updateComplete;

      expect(modal.open, 'stays closed').to.be.false;
    });

    it('locks the source tabs while a clone is running', async () => {
      const internal = el as unknown as { isCloning: boolean };
      internal.isCloning = true;
      await el.updateComplete;

      const tabs = el.shadowRoot!.querySelectorAll('.source-tab');
      expect(Array.from(tabs).every((t) => (t as HTMLButtonElement).disabled)).to.be.true;
    });

    it('returns to the URL source on reset', async () => {
      selectSource('account');
      await el.updateComplete;
      expect(picker()).to.exist;

      (el as unknown as { reset: () => void }).reset();
      await el.updateComplete;

      expect(picker()).to.equal(null);
    });
  });

  describe('security-gate refusals are not shown as clone errors', () => {
    it('a declined network confirm leaves no error in the dialog', async () => {
      const { settingsStore } = await import('../../../stores/settings.store.ts');
      settingsStore.setState({ confirmNetworkOps: true });
      mockInvoke = (command: string) => {
        if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') {
          return Promise.resolve('Cancel');
        }
        return Promise.resolve(null);
      };
      try {
        const internal = el as unknown as {
          url: string;
          destination: string;
          error: string;
          isCloning: boolean;
          handleClone: () => Promise<void>;
        };
        internal.url = 'https://github.com/user/repo.git';
        internal.destination = '/home/user/projects';

        await internal.handleClone();
        await el.updateComplete;

        expect(internal.error, "the user's own Cancel is not an error").to.equal('');
        expect(internal.isCloning, 'the dialog is usable again').to.equal(false);
      } finally {
        settingsStore.setState({ confirmNetworkOps: false });
      }
    });

    it('offline mode leaves the gate to explain, without a second red error', async () => {
      const { settingsStore } = await import('../../../stores/settings.store.ts');
      settingsStore.setState({ offlineMode: true });
      mockInvoke = () => Promise.resolve(null);
      try {
        const internal = el as unknown as {
          url: string;
          destination: string;
          error: string;
          handleClone: () => Promise<void>;
        };
        internal.url = 'https://github.com/user/repo.git';
        internal.destination = '/home/user/projects';

        await internal.handleClone();
        await el.updateComplete;

        expect(internal.error).to.equal('');
      } finally {
        settingsStore.setState({ offlineMode: false });
      }
    });

    it('a genuine clone failure is still reported', async () => {
      mockInvoke = (command: string) => {
        if (command === 'clone_repository') {
          return Promise.reject({ code: 'COMMAND_ERROR', message: 'repository not found' });
        }
        return Promise.resolve(null);
      };
      const internal = el as unknown as {
        url: string;
        destination: string;
        error: string;
        handleClone: () => Promise<void>;
      };
      internal.url = 'https://github.com/user/repo.git';
      internal.destination = '/home/user/projects';

      await internal.handleClone();
      await el.updateComplete;

      expect(internal.error).to.contain('repository not found');
    });
  });
});
