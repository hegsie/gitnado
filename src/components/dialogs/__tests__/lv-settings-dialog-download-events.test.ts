/**
 * Settings Dialog — download event reporting.
 *
 * `download_model` reports its outcome over Tauri events long after the command
 * returned. A download that failed already showed in the AI banner, but a model
 * that downloaded and then could NOT be loaded (`loaded: false` plus a
 * `loadError`) was dropped on the floor: the handler only refreshed the model
 * list, so the user saw the download finish and no AI appear, with no error
 * anywhere. Both outcomes must reach the banner.
 */

// ── Tauri mock (must be set before any imports) ────────────────────────────
type EventCallback = (e: { event: string; id: number; payload: unknown }) => void;

const listeners = new Map<number, { event: string; cb: EventCallback }>();
const callbacks = new Map<number, EventCallback>();
let nextId = 1;

const mockInvoke = (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'plugin:event|listen') {
    const cb = callbacks.get(args?.handler as number);
    const id = nextId++;
    if (cb) listeners.set(id, { event: args?.event as string, cb });
    return Promise.resolve(id);
  }
  if (command === 'plugin:event|unlisten') {
    listeners.delete(args?.eventId as number);
    return Promise.resolve(null);
  }

  switch (command) {
    case 'plugin:notification|is_permission_granted':
      return Promise.resolve(false);
    case 'get_ai_providers':
      return Promise.resolve([]);
    case 'get_app_version':
      return Promise.resolve('0.1.0');
    case 'get_settings':
      return Promise.resolve({});
    case 'get_system_capabilities':
      return Promise.resolve({ hasGpu: false, gpuName: null, totalRam: 8 });
    case 'get_downloaded_models':
    case 'get_available_models':
    case 'get_available_diff_tools':
    case 'get_graph_color_schemes':
      return Promise.resolve([]);
    case 'get_model_status':
    case 'get_local_model_status':
      return Promise.resolve({ loaded: false, modelId: null });
    case 'get_mcp_status':
      return Promise.resolve({ servers: [], totalTools: 0 });
    default:
      return Promise.resolve(null);
  }
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  transformCallback: (cb: EventCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  },
};

// `unlisten()` pokes the event plugin's own internals before the IPC call.
(globalThis as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};

/** Deliver a backend event exactly as the Tauri event plugin would. */
function emit(event: string, payload: unknown): void {
  for (const listener of [...listeners.values()]) {
    if (listener.event === event) listener.cb({ event, id: 1, payload });
  }
}

// ── Imports (after Tauri mock) ─────────────────────────────────────────────
import { expect, fixture, html } from '@open-wc/testing';
import '../lv-settings-dialog.ts';
import type { LvSettingsDialog } from '../lv-settings-dialog.ts';
import { setAppLocale } from '../../../i18n/index.ts';

async function waitForListener(event: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ([...listeners.values()].some((l) => l.event === event)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no listener was ever registered for ${event}`);
}

async function createDialog(): Promise<LvSettingsDialog> {
  const el = await fixture<LvSettingsDialog>(html`<lv-settings-dialog></lv-settings-dialog>`);
  await el.updateComplete;
  await waitForListener('model-download-complete');
  await waitForListener('model-download-error');
  return el;
}

function bannerText(el: LvSettingsDialog): string {
  return el.shadowRoot!.querySelector('.error-text')?.textContent ?? '';
}

describe('lv-settings-dialog download events', () => {
  beforeEach(() => {
    listeners.clear();
  });

  // Control: proves the harness really delivers events to the dialog, so the
  // load-failure assertion below is about the handler, not a dead emit().
  it('shows a download failure in the AI banner', async () => {
    const el = await createDialog();

    emit('model-download-error', { modelId: 'm1', error: 'Network unreachable' });
    await el.updateComplete;

    expect(bannerText(el)).to.contain('m1');
    expect(bannerText(el)).to.contain('Network unreachable');
  });

  it('shows a load failure in the AI banner', async () => {
    const el = await createDialog();

    emit('model-download-complete', {
      modelId: 'qwen-2.5-1.5b',
      loaded: false,
      loadError: 'Insufficient memory',
    });
    await el.updateComplete;

    expect(bannerText(el), 'a model that downloaded but will not load must be reported')
      .to.contain('qwen-2.5-1.5b');
    expect(bannerText(el)).to.contain('Insufficient memory');
  });

  it('falls back to a generic reason when the backend sends no loadError', async () => {
    const el = await createDialog();

    emit('model-download-complete', { modelId: 'm1', loaded: false });
    await el.updateComplete;

    expect(bannerText(el)).to.contain('m1');
    expect(bannerText(el)).to.contain('unknown error');
  });

  // Both messages reach the banner through events, outside the two-locale
  // render diff the language test runs, so their translation is pinned here.
  it('reports download and load failures in the UI language', async () => {
    await setAppLocale('fr');
    try {
      const el = await createDialog();

      emit('model-download-error', { modelId: 'm1', error: 'Network unreachable' });
      await el.updateComplete;
      expect(bannerText(el).trim()).to.equal(
        'Échec du téléchargement de m1 : Network unreachable',
      );

      emit('model-download-complete', { modelId: 'm1', loaded: false, loadError: 'bad weights' });
      await el.updateComplete;
      expect(bannerText(el).trim()).to.equal('Échec du chargement de m1 : bad weights');

      emit('model-download-complete', { modelId: 'm1', loaded: false });
      await el.updateComplete;
      expect(bannerText(el).trim(), 'the fallback reason is translated too').to.equal(
        'Échec du chargement de m1 : erreur inconnue',
      );
    } finally {
      await setAppLocale('en');
    }
  });

  it('clears the progress row and reports no error when the model loads', async () => {
    const el = await createDialog();
    const dialog = el as unknown as {
      downloadProgress: Record<string, unknown>;
      aiError: string | null;
    };
    dialog.downloadProgress = {
      m1: { modelId: 'm1', downloadedBytes: 1, totalBytes: 2, percentage: 50 },
    };

    let notified = false;
    const onChanged = () => {
      notified = true;
    };
    window.addEventListener('ai-settings-changed', onChanged);

    emit('model-download-complete', { modelId: 'm1', loaded: true });
    await el.updateComplete;
    window.removeEventListener('ai-settings-changed', onChanged);

    expect(dialog.downloadProgress).to.not.have.property('m1');
    expect(dialog.aiError, 'a successful load is not an error').to.be.null;
    expect(notified, 'other components must hear about the new provider').to.be.true;
  });
});
