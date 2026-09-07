/**
 * A clone in flight must be cancellable.
 *
 * The Cancel button was disabled while cloning and handleModalClose re-asserted
 * modal.open, so Escape, the overlay and the × could not dismiss the dialog
 * either. With no cancellation on the backend and no timeout passed from the
 * frontend, a clone against an unreachable host or an SSH remote waiting on
 * interactive auth locked the modal for the life of the application — the only
 * recovery was restarting it.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let cbId = 0;
let mockInvoke: MockInvoke = () => Promise.resolve(null);
const invoked: { command: string; args?: unknown }[] = [];

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return mockInvoke(command, args);
  },
  transformCallback: () => cbId++,
};

(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  convertCallback: (callback: unknown, once: boolean) => {
    void once;
    void callback;
    return 0;
  },
  unregisterListener: (_event: string, _eventId: number) => {},
};

import { expect, fixture, html, waitUntil } from '@open-wc/testing';
import '../lv-clone-dialog.ts';
import type { LvCloneDialog } from '../lv-clone-dialog.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import { uiStore } from '../../../stores/ui.store.ts';

/** Resolver for the pending clone, so the test controls when it finishes. */
let finishClone: ((value: unknown) => void) | null = null;

function footerButtons(el: LvCloneDialog): HTMLButtonElement[] {
  return Array.from(el.shadowRoot!.querySelectorAll('[slot="footer"] button'));
}

function cancelButton(el: LvCloneDialog): HTMLButtonElement {
  return footerButtons(el)[0];
}

function cloneButton(el: LvCloneDialog): HTMLButtonElement {
  return footerButtons(el)[1];
}

function urlInput(el: LvCloneDialog): HTMLInputElement {
  return el.shadowRoot!.querySelector('input') as HTMLInputElement;
}

function toastMessages(): string[] {
  return uiStore.getState().toasts.map((t) => t.message);
}

async function startClone(
  el: LvCloneDialog,
  options: { url?: string; submodules?: boolean } = {},
): Promise<void> {
  el.open();
  await el.updateComplete;

  const url = urlInput(el);
  url.value = options.url ?? 'https://example.com/hung/repo.git';
  url.dispatchEvent(new Event('input'));
  await el.updateComplete;

  const destInput = el.shadowRoot!.querySelectorAll('input')[1] as HTMLInputElement;
  destInput.value = '/tmp/clone-target';
  destInput.dispatchEvent(new Event('input'));
  await el.updateComplete;

  if (options.submodules) {
    const checkbox = el.shadowRoot!.querySelector('#clone-submodules') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await el.updateComplete;
  }

  cloneButton(el).click();
  // handleClone awaits the progress listener before invoking the clone, so a
  // single update tick is not enough for the command to have been sent.
  await flush();
  await el.updateComplete;
}

/** Let pending microtasks and timers settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('lv-clone-dialog cancellation', () => {
  let el: LvCloneDialog;

  beforeEach(async () => {
    invoked.length = 0;
    finishClone = null;
    uiStore.setState({ toasts: [] });
    settingsStore.getState().setDefaultClonePath('');

    mockInvoke = (command) => {
      if (command === 'clone_repository') {
        // Never resolves on its own — this is the hung clone.
        return new Promise((resolve) => {
          finishClone = resolve;
        });
      }
      return Promise.resolve(null);
    };

    el = await fixture<LvCloneDialog>(html`<lv-clone-dialog></lv-clone-dialog>`);
  });

  afterEach(() => {
    finishClone?.(null);
  });

  it('offers a usable Cancel button while the clone is in flight', async () => {
    await startClone(el);

    const cancel = cancelButton(el);
    expect(cancel.disabled, 'Cancel must be pressable during a clone').to.be.false;
    expect(cancel.textContent?.trim()).to.contain('Cancel');
  });

  it('asks the backend to cancel when Cancel is pressed', async () => {
    await startClone(el);

    cancelButton(el).click();
    await flush();
    await el.updateComplete;

    expect(
      invoked.some((c) => c.command === 'cancel_clone'),
      'pressing Cancel must invoke cancel_clone',
    ).to.be.true;
  });

  it('cancels rather than silently ignoring an Escape/overlay dismissal', async () => {
    await startClone(el);

    const modal = el.shadowRoot!.querySelector('lv-modal')!;
    modal.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    await flush();
    await el.updateComplete;

    expect(
      invoked.some((c) => c.command === 'cancel_clone'),
      'dismissing the modal during a clone must cancel it',
    ).to.be.true;
  });

  it('sends a network timeout so a hung clone cannot run forever', async () => {
    settingsStore.getState().setNetworkOperationTimeout?.(30);
    await startClone(el);

    const cloneCall = invoked.find((c) => c.command === 'clone_repository');
    expect(cloneCall, 'clone should have been invoked').to.exist;

    const args = cloneCall!.args as Record<string, unknown> | undefined;
    // Tauri nests command args under the parameter name.
    const payload = (args?.args ?? args) as Record<string, unknown> | undefined;
    expect(payload?.timeoutSecs, 'clone must carry the network timeout like fetch/pull/push').to
      .not.be.undefined;
  });

  // The success path leaves isCloning set across a 500ms close delay so a
  // second clone cannot start into the same destination. The footer button and
  // the modal-close handler both routed to cancellation while it was set, so a
  // FINISHED clone still offered "Cancel Clone" — and Escape or the x fired a
  // cancel request for an operation that had already succeeded.
  it('stops offering to cancel once the clone has succeeded', async () => {
    await startClone(el);

    finishClone?.(
      Promise.resolve({ path: '/tmp/clone-target', name: 'repo', currentBranch: null }),
    );
    await flush();
    await el.updateComplete;

    expect(cancelButton(el).textContent!.trim(), 'a finished clone is not cancellable').to.equal(
      'Cancel',
    );

    invoked.length = 0;
    cancelButton(el).click();
    await flush();
    await el.updateComplete;
    expect(
      invoked.some((c) => c.command === 'cancel_clone'),
      'clicking Cancel after success must not cancel the finished clone',
    ).to.be.false;
  });

  it('does not cancel a succeeded clone when the modal is dismissed', async () => {
    await startClone(el);

    finishClone?.(
      Promise.resolve({ path: '/tmp/clone-target', name: 'repo', currentBranch: null }),
    );
    await flush();
    await el.updateComplete;

    invoked.length = 0;
    const modal = el.shadowRoot!.querySelector('lv-modal')!;
    modal.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
    await flush();
    await el.updateComplete;

    expect(
      invoked.some((c) => c.command === 'cancel_clone'),
      'dismissing after success must not cancel the finished clone',
    ).to.be.false;
  });

  it('releases the dialog once the cancelled clone returns', async () => {
    await startClone(el);
    cancelButton(el).click();
    await flush();
    await el.updateComplete;

    // The backend reports the cancellation with the code every other
    // cancellable operation uses (`OperationCancelled`).
    finishClone?.(Promise.reject({ code: 'OPERATION_CANCELLED', message: 'Operation cancelled' }));
    await flush();
    await el.updateComplete;

    // The dialog must now be closable: Cancel goes back to plain dismissal.
    expect(cancelButton(el).disabled).to.be.false;
    // And the user's own Cancel is not painted back at them as a red failure,
    // the way a declined network confirm already is not.
    // Compared as text rather than as nodes: a DOM node in an assertion
    // failure does not serialise out of the browser.
    expect(
      el.shadowRoot!.querySelector('.error-message')?.textContent ?? '',
      'a cancelled clone must not be shown as an error',
    ).to.equal('');
    expect(el.shadowRoot!.querySelector('.progress-text') === null).to.equal(true);
    // The progress section is gone, so without this the user's Cancel left no
    // trace at all — fetch, pull and push each toast the same acknowledgement.
    expect(toastMessages(), 'the cancellation is acknowledged').to.include('Clone cancelled');
    expect(uiStore.getState().toasts.find((t) => t.message === 'Clone cancelled')?.type).to.equal(
      'info',
    );
  });

  it('does not toast a cancellation for a real clone failure', async () => {
    await startClone(el);

    finishClone?.(Promise.reject({ code: 'CUSTOM_ERROR', message: 'git clone failed: boom' }));
    await flush();
    await el.updateComplete;

    expect(toastMessages()).to.not.include('Clone cancelled');
  });

  // `handleClone` shows "Cancel Clone" from the moment it starts, but the
  // service still awaits the network gate and the keyring token lookup before
  // it sends `clone_repository` — and the backend resets its cancellation
  // flag when the clone starts. A Cancel pressed in that window used to be
  // acknowledged by `cancel_clone`, then ignored: the clone ran anyway with the
  // footer stuck on a disabled "Cancelling…" and every dismissal routed back
  // into the same refused cancel.
  it('stops a clone cancelled while the token lookup is still pending', async () => {
    let releaseKeyring: ((value: unknown) => void) | null = null;
    mockInvoke = (command) => {
      if (command === 'get_keyring_token') {
        return new Promise((resolve) => {
          releaseKeyring = resolve;
        });
      }
      if (command === 'clone_repository') {
        return new Promise((resolve) => {
          finishClone = resolve;
        });
      }
      return Promise.resolve(null);
    };

    // A github.com URL is what sends the clone through the stored-token lookup.
    await startClone(el, { url: 'https://github.com/hung/repo.git' });
    await waitUntil(() => releaseKeyring !== null, 'the clone is waiting on the keyring');
    expect(cancelButton(el).textContent!.trim()).to.equal('Cancel Clone');
    expect(
      invoked.some((c) => c.command === 'clone_repository'),
      'control: the clone command has not been sent yet',
    ).to.be.false;

    cancelButton(el).click();
    await flush();
    await el.updateComplete;
    expect(invoked.some((c) => c.command === 'cancel_clone')).to.be.true;

    releaseKeyring!(null);
    await waitUntil(
      async () => {
        await el.updateComplete;
        return cancelButton(el).textContent!.trim() === 'Cancel';
      },
      'the dialog was released',
    );

    expect(
      invoked.some((c) => c.command === 'clone_repository'),
      'a clone cancelled before it was sent must never be sent',
    ).to.be.false;
    expect(cancelButton(el).disabled, 'Cancel is pressable again').to.be.false;
    expect(urlInput(el).disabled, 'the form is editable again').to.be.false;
    expect(cloneButton(el).disabled, 'a fresh clone can be started').to.be.false;
    expect(el.shadowRoot!.querySelector('.error-message')?.textContent ?? '').to.equal('');
    expect(toastMessages()).to.include('Clone cancelled');
  });

  // The CLI clone path reaps the child on cancel; a child that had already
  // finished makes that cancel return success. `isCancelling` then stayed set,
  // so with "Clone submodules" ticked the footer button was disabled for the
  // whole submodule phase and the dialog could not be closed.
  it('leaves the dialog closable when a cancel lands after the clone already succeeded', async () => {
    let listSubmodules: ((value: unknown) => void) | null = null;
    mockInvoke = (command) => {
      if (command === 'clone_repository') {
        return new Promise((resolve) => {
          finishClone = resolve;
        });
      }
      if (command === 'get_submodules') {
        // Parked so the submodule phase stays on screen.
        return new Promise((resolve) => {
          listSubmodules = resolve;
        });
      }
      return Promise.resolve(null);
    };

    await startClone(el, { submodules: true });
    cancelButton(el).click();
    await flush();
    await el.updateComplete;
    expect(cancelButton(el).disabled, 'control: Cancel is held while cancelling').to.be.true;

    finishClone?.(
      Promise.resolve({ path: '/tmp/clone-target', name: 'repo', currentBranch: null }),
    );
    await waitUntil(() => listSubmodules !== null, 'the submodule phase started');
    await el.updateComplete;

    expect(cancelButton(el).textContent!.trim()).to.equal('Close');
    expect(cancelButton(el).disabled, 'the submodule phase must be dismissable').to.be.false;

    listSubmodules!([]);
    await flush();
  });

  it('still shows a real clone failure as an error', async () => {
    await startClone(el);

    finishClone?.(
      Promise.reject({ code: 'CUSTOM_ERROR', message: 'git clone failed: repository not found' }),
    );
    await flush();
    await el.updateComplete;

    const error = el.shadowRoot!.querySelector('.error-message')?.textContent ?? '';
    expect(error, 'a failed clone must be reported').to.contain('repository not found');
    expect(cancelButton(el).disabled).to.be.false;
  });
});
