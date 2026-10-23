/**
 * Settings Dialog AI error-reset tests.
 *
 * handleCancelDownload, handleDeleteModel and handleUnloadModel must clear a
 * stale aiError banner at the start, matching every sibling AI handler.
 */

import { expect, fixture, html } from '@open-wc/testing';

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;

let failingCommands: Set<string> = new Set();

const mockInvoke: MockInvoke = async (command: string) => {
  if (command === 'plugin:notification|is_permission_granted') return false;
  if (failingCommands.has(command)) {
    throw { code: 'AI_ERROR', message: 'AI operation failed' };
  }

  switch (command) {
    case 'get_ai_providers':
      return [];
    case 'get_app_version':
      return '0.1.0';
    case 'get_settings':
      return {};
    case 'get_system_capabilities':
      return { hasGpu: false, gpuName: null, totalRam: 8 };
    case 'get_downloaded_models':
      return [];
    case 'get_model_status':
    case 'get_local_model_status':
      return { loaded: false, modelId: null };
    case 'get_available_models':
      return [];
    case 'get_mcp_status':
      return { servers: [], totalTools: 0 };
    case 'get_available_diff_tools':
      return [];
    case 'get_merge_tool_info':
      return null;
    case 'get_graph_color_schemes':
      return [];
    case 'cancel_model_download':
    case 'delete_model':
    case 'unload_model':
      return null;
    default:
      return null;
  }
};

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } }).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

import '../gn-settings-dialog.ts';
import type { GnSettingsDialog } from '../gn-settings-dialog.ts';

async function createComponent(): Promise<GnSettingsDialog> {
  const el = await fixture<GnSettingsDialog>(html`<gn-settings-dialog></gn-settings-dialog>`);
  await el.updateComplete;
  return el;
}

describe('gn-settings-dialog AI error reset', () => {
  beforeEach(() => {
    failingCommands = new Set();
  });

  it('handleCancelDownload clears a stale aiError', async () => {
    const el = await createComponent();
    (el as unknown as { aiError: string | null }).aiError = 'stale error';

    await (el as unknown as { handleCancelDownload: (id: string) => Promise<void> }).handleCancelDownload('m1');

    expect((el as unknown as { aiError: string | null }).aiError).to.be.null;
  });

  it('handleCancelDownload removes the progress entry on success', async () => {
    const el = await createComponent();
    (el as unknown as { downloadProgress: Record<string, unknown> }).downloadProgress = {
      m1: { progress: 50 },
      m2: { progress: 10 },
    };

    await (el as unknown as { handleCancelDownload: (id: string) => Promise<void> }).handleCancelDownload('m1');

    const progress = (el as unknown as { downloadProgress: Record<string, unknown> }).downloadProgress;
    expect('m1' in progress, 'cancelled entry removed').to.be.false;
    expect('m2' in progress, 'other download untouched').to.be.true;
    expect((el as unknown as { aiError: string | null }).aiError).to.be.null;
  });

  it('handleCancelDownload keeps the progress entry and shows an error when cancel fails', async () => {
    failingCommands = new Set(['cancel_model_download']);
    const el = await createComponent();
    (el as unknown as { downloadProgress: Record<string, unknown> }).downloadProgress = {
      m1: { progress: 50 },
    };

    await (el as unknown as { handleCancelDownload: (id: string) => Promise<void> }).handleCancelDownload('m1');

    const progress = (el as unknown as { downloadProgress: Record<string, unknown> }).downloadProgress;
    expect('m1' in progress, 'progress entry retained on failed cancel').to.be.true;
    expect((el as unknown as { aiError: string | null }).aiError).to.equal('AI operation failed');
  });

  it('handleDeleteModel clears a stale aiError on success', async () => {
    const el = await createComponent();
    (el as unknown as { aiError: string | null }).aiError = 'stale error';

    await (el as unknown as { handleDeleteModel: (id: string) => Promise<void> }).handleDeleteModel('m1');

    expect((el as unknown as { aiError: string | null }).aiError).to.be.null;
  });

  it('handleUnloadModel clears a stale aiError on success', async () => {
    const el = await createComponent();
    (el as unknown as { aiError: string | null }).aiError = 'stale error';

    await (el as unknown as { handleUnloadModel: () => Promise<void> }).handleUnloadModel();

    expect((el as unknown as { aiError: string | null }).aiError).to.be.null;
  });
});
