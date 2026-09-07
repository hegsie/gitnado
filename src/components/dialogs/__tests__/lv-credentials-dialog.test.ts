/**
 * Credentials Dialog Tests
 *
 * Covers removing credential helpers: a URL-scoped helper can live in any git
 * config file, so the removal has to be aimed at the file git reported
 * (`configScope`), not at the "url" badge.
 */

import { expect, fixture, html } from '@open-wc/testing';
import type { CredentialHelper, CredentialTestResult } from '../../../services/git.service.ts';
import type { Remote } from '../../../types/git.types.ts';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

const invokeCalls: Array<{ command: string; args?: unknown }> = [];
let mockHelpers: CredentialHelper[] = [];
/**
 * When set, `unset_credential_helper` rejects with this — but only for a call
 * aimed at the config file the helper actually lives in. A removal pointed at
 * the wrong file resolves and changes nothing, which is what the backend does
 * (and the silent no-op this dialog used to produce).
 */
let unsetFailure: { message: string } | null = null;
let mockRemotes: Remote[] = [];
let mockTestResult: CredentialTestResult | null = null;

/** Does this `unset_credential_helper` call target `mockHelpers[0]`'s file? */
function aimedAtHelperFile(args: unknown): boolean {
  const params = (args ?? {}) as { path?: string | null; global?: boolean };
  return mockHelpers[0]?.configScope === 'global'
    ? params.global === true
    : params.global !== true && typeof params.path === 'string' && params.path.length > 0;
}

const mockInvoke: MockInvoke = async (command: string, args?: unknown) => {
  invokeCalls.push({ command, args });

  switch (command) {
    case 'get_credential_helpers':
      return mockHelpers;
    case 'get_available_helpers':
      return [];
    case 'get_remotes':
      return mockRemotes;
    case 'test_credentials':
      return mockTestResult;
    case 'erase_credentials':
      return null;
    case 'detect_credential_manager':
      return null;
    case 'unset_credential_helper':
      if (!aimedAtHelperFile(args)) return null;
      if (unsetFailure) throw unsetFailure;
      mockHelpers = [];
      return null;
    // showConfirm() resolves true when the dialog plugin answers "Ok".
    case 'plugin:dialog|message':
      return 'Ok';
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

// Import the component AFTER setting up the mock
import '../lv-credentials-dialog.ts';
import type { LvCredentialsDialog } from '../lv-credentials-dialog.ts';

function urlHelper(configScope: string): CredentialHelper {
  return {
    name: 'manager',
    command: 'manager',
    scope: 'url',
    configScope,
    urlPattern: 'https://github.com',
  };
}

async function openDialog(): Promise<LvCredentialsDialog> {
  const el = await fixture<LvCredentialsDialog>(
    html`<lv-credentials-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-credentials-dialog>`,
  );
  // Wait for loadData() to resolve and render the helper list.
  await waitFor(() => el.shadowRoot!.querySelectorAll('.helper-item').length > 0);
  return el;
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function unsetCalls(): Array<Record<string, unknown>> {
  return invokeCalls
    .filter((c) => c.command === 'unset_credential_helper')
    .map((c) => c.args as Record<string, unknown>);
}

function remote(url: string): Remote {
  return { name: 'origin', url, pushUrl: null };
}

function testResult(over: Partial<CredentialTestResult>): CredentialTestResult {
  return {
    success: true,
    host: 'git.example.test',
    protocol: 'https',
    username: 'someone',
    message: 'Credentials found',
    ...over,
  };
}

/** Open the dialog and switch to the "Test Credentials" tab. */
async function openTestTab(): Promise<LvCredentialsDialog> {
  const el = await fixture<LvCredentialsDialog>(
    html`<lv-credentials-dialog ?open=${true} .repositoryPath=${'/test/repo'}></lv-credentials-dialog>`,
  );
  const tabs = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tab');
  tabs[tabs.length - 1].click();
  await waitFor(() => el.shadowRoot!.querySelectorAll('.remote-item').length > 0);
  return el;
}

async function runTest(el: LvCredentialsDialog): Promise<void> {
  el.shadowRoot!.querySelector<HTMLButtonElement>('.form-actions .btn-primary')!.click();
  await waitFor(() => el.shadowRoot!.querySelector('.test-result') !== null);
  await el.updateComplete;
}

/** The result panel's text, lowercased — so a claim about it is case-blind. */
function panelText(el: LvCredentialsDialog): string {
  return (el.shadowRoot!.querySelector('.test-result')?.textContent ?? '').toLowerCase();
}

/** Is the "Erase Credentials" action offered on the current result panel? */
function offersErase(el: LvCredentialsDialog): boolean {
  return [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.test-result button')].some((b) =>
    b.textContent?.includes('Erase Credentials'),
  );
}

describe('lv-credentials-dialog helper removal', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    unsetFailure = null;
    mockHelpers = [];
  });

  it('unsets a URL helper stored in the global config with --global', async () => {
    mockHelpers = [urlHelper('global')];
    const el = await openDialog();

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.helper-item .btn-icon.danger')!;
    expect(btn.disabled).to.be.false;
    btn.click();

    await waitFor(() => unsetCalls().length > 0);
    expect(unsetCalls()[0]).to.deep.equal({
      path: null,
      global: true,
      urlPattern: 'https://github.com',
    });
  });

  it('unsets a URL helper stored in the repository config against the pinned repo', async () => {
    mockHelpers = [urlHelper('local')];
    const el = await openDialog();

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.helper-item .btn-icon.danger')!;
    btn.click();

    await waitFor(() => unsetCalls().length > 0);
    expect(unsetCalls()[0]).to.deep.equal({
      path: '/test/repo',
      global: false,
      urlPattern: 'https://github.com',
    });
  });

  it('refuses to remove a system-scoped helper and says why', async () => {
    mockHelpers = [urlHelper('system')];
    const el = await openDialog();

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.helper-item .btn-icon.danger')!;
    expect(btn.disabled).to.be.true;

    await (
      el as unknown as { handleRemoveHelper: (h: CredentialHelper) => Promise<void> }
    ).handleRemoveHelper(mockHelpers[0]);
    await el.updateComplete;

    expect(unsetCalls()).to.have.length(0);
    const banner = el.shadowRoot!.querySelector('.error-banner');
    expect(banner).to.not.be.null;
    expect(banner!.textContent).to.include('system');
  });

  it('shows the error when the backend refuses the removal', async () => {
    mockHelpers = [urlHelper('local')];
    unsetFailure = { message: 'could not lock config file' };
    const el = await openDialog();

    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.helper-item .btn-icon.danger')!;
    btn.click();

    await waitFor(() => el.shadowRoot!.querySelector('.error-banner') !== null);
    const banner = el.shadowRoot!.querySelector('.error-banner');
    expect(banner!.textContent).to.include('could not lock config file');
    // The helper it failed to remove is still listed.
    expect(el.shadowRoot!.querySelectorAll('.helper-item')).to.have.length(1);
  });
});

/**
 * The credential test reports the protocol git would actually use. An scp-form
 * remote whose login is not `git` (`deploy@host:team/app.git`) is SSH, and used
 * to be reported as HTTPS: a working remote came back "No Credentials Found",
 * and the erase button then offered to drop `https` credentials that were never
 * in play.
 */
describe('lv-credentials-dialog credential test result', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    mockHelpers = [];
    mockRemotes = [remote('deploy@git.example.test:team/app.git')];
    mockTestResult = null;
  });

  it('offers to erase the credential an HTTPS remote actually stores', async () => {
    mockRemotes = [remote('https://git.example.test/team/app.git')];
    mockTestResult = testResult({ protocol: 'https' });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('Credentials Working');
    expect(offersErase(el), 'HTTPS keeps its erase button').to.be.true;
  });

  it('does not offer to erase anything for an SSH remote', async () => {
    mockTestResult = testResult({
      protocol: 'ssh',
      username: 'deploy',
      message: "Hi deploy! You've successfully authenticated",
    });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('Protocol: ssh');
    // SSH authenticates with a key: there is no credential entry to reject, so
    // the button would be a silent no-op.
    expect(offersErase(el), 'SSH has no stored credential to erase').to.be.false;
    expect(invokeCalls.some((c) => c.command === 'erase_credentials')).to.be.false;
  });

  it('reports a failed SSH handshake as an authentication failure, not a missing credential', async () => {
    mockTestResult = testResult({
      success: false,
      protocol: 'ssh',
      username: null,
      message: 'Permission denied (publickey).',
    });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('SSH Authentication Failed');
    expect(el.shadowRoot!.textContent).to.not.include('No Credentials Found');
    // A rejected key IS a fault to go and fix, so this one stays red.
    expect(el.shadowRoot!.querySelector('.test-result')!.className).to.match(/\berror\b/);
  });

  it('erases the http credential an http remote actually stores', async () => {
    mockRemotes = [remote('http://git.internal.test/team/app.git')];
    mockTestResult = testResult({ protocol: 'http', host: 'git.internal.test' });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('Protocol: http');
    expect(offersErase(el), 'http stores a credential just as https does').to.be.true;

    [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.test-result button')]
      .find((b) => b.textContent?.includes('Erase Credentials'))!
      .click();
    await waitFor(() => invokeCalls.some((c) => c.command === 'erase_credentials'));

    // The erase has to name the protocol the credential was found under, or it
    // rejects an entry that does not exist and the re-authentication warning
    // the user just confirmed describes nothing.
    expect(invokeCalls.find((c) => c.command === 'erase_credentials')!.args).to.deep.equal({
      path: '/test/repo',
      host: 'git.internal.test',
      protocol: 'http',
    });
  });

  it('tells a git:// remote it needs no stored credential instead of reporting one missing', async () => {
    mockRemotes = [remote('git://git.internal.test/team/app.git')];
    mockTestResult = testResult({
      success: false,
      protocol: 'git',
      host: 'git.internal.test',
      username: null,
      message: 'No credentials found for git.internal.test',
    });
    const el = await openTestTab();
    await runTest(el);

    // `git://` never authenticates, so "No Credentials Found" reads as a fault
    // to go and fix when there is nothing to fix.
    expect(el.shadowRoot!.textContent).to.include('No Credentials Needed');
    // Case-INSENSITIVELY: the line this panel actually carried was the
    // backend's own lowercase `No credentials found for <host>`, rendered
    // verbatim underneath a header saying the opposite. Asserting the
    // title-case spelling alone sailed straight past it.
    expect(panelText(el)).to.not.include('no credentials found');
  });

  it('does not draw a transport that stores nothing as a failure', async () => {
    mockRemotes = [remote('git://git.internal.test/team/app.git')];
    mockTestResult = testResult({
      success: false,
      protocol: 'git',
      host: 'git.internal.test',
      username: null,
      message: 'No credentials found for git.internal.test',
    });
    const el = await openTestTab();
    await runTest(el);

    // `success: false` is not a fault here, so the red border, the error
    // background and the ✗ icon all say something untrue.
    const panel = el.shadowRoot!.querySelector('.test-result')!;
    const header = el.shadowRoot!.querySelector('.test-result-header')!;
    expect(panel.className, 'panel not styled as an error').to.not.match(/\berror\b/);
    expect(header.className, 'header not styled as an error').to.not.match(/\berror\b/);
    expect(panel.className, 'panel reads as information').to.match(/\binfo\b/);
    // ...and it says why nothing was found, in place of the backend's line.
    expect(panelText(el)).to.include('do not authenticate');
  });

  it('reports a missing file:// credential as nothing to find either', async () => {
    // The backend reports a scheme-carrying URL under its own scheme, so a
    // local `file://` remote arrives here as `protocol: 'file'` — the second
    // transport this branch was written for.
    mockRemotes = [remote('file:///srv/git/app.git')];
    mockTestResult = testResult({
      success: false,
      protocol: 'file',
      host: '/srv/git/app.git',
      username: null,
      message: 'No credentials found for /srv/git/app.git',
    });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('No Credentials Needed');
    expect(panelText(el)).to.not.include('no credentials found');
    expect(el.shadowRoot!.querySelector('.test-result')!.className).to.not.match(/\berror\b/);
    expect(offersErase(el), 'a file:// remote stores no credential either').to.be.false;
  });

  it('offers no erase for a transport that stores no credential', async () => {
    mockRemotes = [remote('git://git.internal.test/team/app.git')];
    mockTestResult = testResult({ protocol: 'git', host: 'git.internal.test' });
    const el = await openTestTab();
    await runTest(el);

    // git reaches `git://` and `file://` without ever consulting a credential
    // helper, so erasing an entry there promises a re-authentication that
    // never happens.
    expect(offersErase(el), 'nothing git will ever use is stored here').to.be.false;
    expect(invokeCalls.some((c) => c.command === 'erase_credentials')).to.be.false;
  });

  it('still reports a missing HTTPS credential as one', async () => {
    mockRemotes = [remote('https://git.example.test/team/app.git')];
    mockTestResult = testResult({ success: false, username: null, message: 'No credentials found' });
    const el = await openTestTab();
    await runTest(el);

    expect(el.shadowRoot!.textContent).to.include('No Credentials Found');
    // https DOES store a credential, so a missing one is a real failure and
    // keeps the failure styling the neutral branch drops.
    expect(el.shadowRoot!.querySelector('.test-result')!.className).to.match(/\berror\b/);
    expect(el.shadowRoot!.querySelector('.test-result-header')!.className).to.match(/\berror\b/);
    expect(offersErase(el), 'nothing to erase when nothing was found').to.be.false;
  });
});
