type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
let mockInvoke: MockInvoke = () => Promise.resolve(null);

(globalThis as unknown as { __TAURI_INTERNALS__: { invoke: MockInvoke } })
  .__TAURI_INTERNALS__ = {
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
};

import { expect, fixture, html } from '@open-wc/testing';
import { customElement } from 'lit/decorators.js';
import { GnProviderDialogBase, type PrReviewComment } from '../gn-provider-dialog-base.ts';
import { unifiedProfileStore } from '../../../stores/unified-profile.store.ts';
import type { CommandResult } from '../../../types/api.types.ts';

interface TestRepo {
  name: string;
}

interface TestConnection {
  connected: boolean;
}

type TestTab = 'connection' | 'pull-requests' | 'create-pr';

@customElement('test-provider-dialog-base')
class TestProviderDialog extends GnProviderDialogBase<TestRepo, TestConnection, TestTab> {
  protected readonly providerDisplayName = 'TestProvider';
  protected readonly integrationType = 'github' as const;

  public loadInitialCalls = 0;
  public detectCalls: Array<{ loadData: boolean; selectAccount: boolean }> = [];
  public draftText = '';

  protected async loadInitialData(): Promise<void> {
    this.loadInitialCalls++;
  }

  protected async detectRepo(loadData = true, selectAccount = true): Promise<void> {
    this.detectCalls.push({ loadData, selectAccount });
    if (this.repositoryPath) {
      this.detectedRepo = { name: this.repositoryPath };
    }
  }

  protected resetProviderRepoScopedState(): void {
    this.draftText = '';
  }

  protected async getTokenForComments(targetAccountId: string | null): Promise<string | undefined> {
    return targetAccountId ? `token-${targetAccountId}` : undefined;
  }

  protected getCommentsOutboundHost(): string {
    return 'api.example.com';
  }

  protected async fetchPrComments(): Promise<CommandResult<PrReviewComment[]>> {
    return { success: true, data: [] };
  }

  protected async postPrComment(): Promise<CommandResult<PrReviewComment>> {
    return {
      success: true,
      data: { id: 1, author: 'alice', body: 'hi', createdAt: new Date().toISOString() },
    };
  }
}

describe('GnProviderDialogBase', () => {
  it('reconciles a repository switch deferred during an in-flight account operation', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const gen = (el as unknown as { beginAccountOp: () => number }).beginAccountOp();
    el.detectCalls = [];

    // Switch repository while account operation is in flight
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    // During accountOpInFlight, detectRepo is called with (false, false)
    expect(el.detectCalls).to.deep.equal([{ loadData: false, selectAccount: false }]);

    // Finishing the account operation triggers full reconciliation detectRepo(true, true)
    (el as unknown as { finishAccountOp: (g?: number) => void }).finishAccountOp(gen);
    expect(el.detectCalls).to.deep.equal([
      { loadData: false, selectAccount: false },
      { loadData: true, selectAccount: true },
    ]);
  });

  it('aborts runCreateOperation before execute when selectedAccountId changes mid-getToken', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    (el as unknown as { detectedRepo: TestRepo | null }).detectedRepo = { name: '/repo/a' };
    (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'acc-1';

    let executed = false;
    let onSuccessCalled = false;

    await (
      el as unknown as {
        runCreateOperation: (cfg: {
          successMessage: string;
          failureMessage: string;
          getToken: (id: string | null) => Promise<string | undefined>;
          execute: () => Promise<CommandResult<{ id: number }>>;
          onSuccess: () => void;
        }) => Promise<void>;
      }
    ).runCreateOperation({
      successMessage: 'Created',
      failureMessage: 'Failed',
      getToken: async (id) => {
        // Simulate account switch while token is being retrieved
        (el as unknown as { selectedAccountId: string | null }).selectedAccountId = 'acc-2';
        return `tok-${id}`;
      },
      execute: async () => {
        executed = true;
        return { success: true, data: { id: 1 } };
      },
      onSuccess: () => {
        onSuccessCalled = true;
      },
    });

    expect(executed).to.be.false;
    expect(onSuccessCalled).to.be.false;
  });

  it('resets create-* activeTab and provider drafts when repositoryPath changes', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    (el as unknown as { activeTab: TestTab }).activeTab = 'create-pr';
    el.draftText = 'my draft';

    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    expect((el as unknown as { activeTab: TestTab }).activeTab).to.equal('connection');
    expect(el.draftText).to.equal('');
  });

  it('reconciles a repository switch that occurred while filling in Add Account once save completes', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    (el as unknown as { beginAddAccount: () => void }).beginAddAccount();
    el.detectCalls = [];

    // Switch repository while user is typing in Add Account form (before save starts)
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    expect(el.detectCalls).to.deep.equal([{ loadData: false, selectAccount: false }]);

    // Now user clicks Save: beginAccountOp -> save completes (isAddingAccount = false) -> finishAccountOp
    const gen = (el as unknown as { beginAccountOp: () => number }).beginAccountOp();
    (el as unknown as { isAddingAccount: boolean }).isAddingAccount = false;
    (el as unknown as { finishAccountOp: (g?: number) => void }).finishAccountOp(gen);

    expect(el.detectCalls).to.deep.equal([
      { loadData: false, selectAccount: false },
      { loadData: true, selectAccount: true },
    ]);
  });

  it('preserves manual account selection and clears comment drawer on beginAccountSwitch', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const priv = el as unknown as {
      expandedPrNumber: number | null;
      prComments: Record<number, PrReviewComment[]>;
      commentBodyInput: string;
      selectedAccountId: string | null;
      beginAccountSwitch: (id: string) => void;
    };
    priv.expandedPrNumber = 42;
    priv.prComments = { 42: [{ id: 1, author: 'bob', body: 'old', createdAt: '' }] };
    priv.commentBodyInput = 'draft comment';

    priv.beginAccountSwitch('manual-acc-2');

    expect(priv.expandedPrNumber).to.be.null;
    expect(priv.prComments).to.deep.equal({});
    expect(priv.commentBodyInput).to.equal('');
    expect(priv.selectedAccountId).to.equal('manual-acc-2');

    // Switch repository while connectionStatus is still null during manual account switch
    el.repositoryPath = '/repo/b';
    await el.updateComplete;

    expect(priv.selectedAccountId).to.equal('manual-acc-2');
  });

  it('runDisconnectOperation clears connection state, resets comment drawer, and invokes onDisconnected', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const priv = el as unknown as {
      selectedAccountId: string | null;
      connectionStatus: TestConnection | null;
      expandedPrNumber: number | null;
      isLoading: boolean;
      runDisconnectOperation: (
        deleteCredentials: () => Promise<void>,
        onDisconnected?: () => void,
      ) => Promise<void>;
    };

    priv.selectedAccountId = 'acc-1';
    priv.connectionStatus = { connected: true };
    priv.expandedPrNumber = 10;

    let deletedCreds = false;
    let onDisconnectedCalled = false;

    await priv.runDisconnectOperation(
      async () => {
        deletedCreds = true;
      },
      () => {
        onDisconnectedCalled = true;
      },
    );

    expect(deletedCreds).to.be.true;
    expect(onDisconnectedCalled).to.be.true;
    expect(priv.connectionStatus).to.be.null;
    expect(priv.expandedPrNumber).to.be.null;
    expect(priv.isLoading).to.be.false;
    expect(unifiedProfileStore.getState().accountConnectionStatus['acc-1']?.status).to.equal(
      'disconnected',
    );
  });

  it('runDisconnectOperation skips UI state reset when loadGeneration advances mid-flight', async () => {
    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const priv = el as unknown as {
      selectedAccountId: string | null;
      connectionStatus: TestConnection | null;
      loadGeneration: number;
      runDisconnectOperation: (
        deleteCredentials: () => Promise<void>,
        onDisconnected?: () => void,
      ) => Promise<void>;
    };

    priv.selectedAccountId = 'acc-1';
    priv.connectionStatus = { connected: true };

    let onDisconnectedCalled = false;

    await priv.runDisconnectOperation(
      async () => {
        // Simulate a newer load superseding this disconnect
        priv.loadGeneration++;
      },
      () => {
        onDisconnectedCalled = true;
      },
    );

    expect(onDisconnectedCalled).to.be.false;
    expect(priv.connectionStatus).to.deep.equal({ connected: true });
  });

  it('runDeleteIntegrationOperation deletes account, cleans up credentials, and transitions to remaining account', async () => {
    const callOrder: string[] = [];
    mockInvoke = async (command: string) => {
      if (command.startsWith('plugin:dialog|')) return 'Ok';
      if (command === 'delete_global_account') {
        callOrder.push('delete_global_account');
        return null;
      }
      if (command === 'get_unified_profiles_config') {
        callOrder.push('get_unified_profiles_config');
        return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
      }
      return null;
    };

    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const priv = el as unknown as {
      selectedAccountId: string | null;
      connectionStatus: TestConnection | null;
      expandedPrNumber: number | null;
      hasManualAccountSelection: boolean;
      runDeleteIntegrationOperation: (opts: {
        account: { id: string; name: string } | undefined;
        providerLabel: string;
        deleteCredentials: (account: { id: string; name: string }) => Promise<void>;
        getRemainingAccounts: () => Array<{ id: string; name: string }>;
        onDeleted: (nextAccountId: string | null) => Promise<void>;
      }) => Promise<void>;
    };

    priv.selectedAccountId = 'acc-1';
    priv.connectionStatus = { connected: true };
    priv.expandedPrNumber = 7;
    priv.hasManualAccountSelection = true;

    let deletedNextId: string | null | undefined;

    await priv.runDeleteIntegrationOperation({
      account: { id: 'acc-1', name: 'Primary' },
      providerLabel: 'TestProvider',
      deleteCredentials: async (acc) => {
        callOrder.push(`deleteCredentials:${acc.id}`);
      },
      getRemainingAccounts: () => [{ id: 'acc-2', name: 'Secondary' }],
      onDeleted: async (nextAccountId) => {
        deletedNextId = nextAccountId;
      },
    });

    expect(callOrder).to.deep.equal([
      'delete_global_account',
      'get_unified_profiles_config',
      'deleteCredentials:acc-1',
    ]);
    expect(priv.selectedAccountId).to.equal('acc-2');
    expect(priv.connectionStatus).to.be.null;
    expect(priv.expandedPrNumber).to.be.null;
    expect(priv.hasManualAccountSelection).to.be.false;
    expect(deletedNextId).to.equal('acc-2');
  });

  it('runDeleteIntegrationOperation guards against stale generation after deleting credentials', async () => {
    mockInvoke = async (command: string) => {
      if (command.startsWith('plugin:dialog|')) return 'Ok';
      if (command === 'get_unified_profiles_config') {
        return { version: 3, profiles: [], accounts: [], repositoryAssignments: {} };
      }
      return null;
    };

    const el = await fixture<TestProviderDialog>(
      html`<test-provider-dialog-base .open=${true} .repositoryPath=${'/repo/a'}></test-provider-dialog-base>`,
    );
    await el.updateComplete;

    const priv = el as unknown as {
      selectedAccountId: string | null;
      connectionStatus: TestConnection | null;
      loadGeneration: number;
      runDeleteIntegrationOperation: (opts: {
        account: { id: string; name: string } | undefined;
        providerLabel: string;
        deleteCredentials: (account: { id: string; name: string }) => Promise<void>;
        getRemainingAccounts: () => Array<{ id: string; name: string }>;
        onDeleted: (nextAccountId: string | null) => Promise<void>;
      }) => Promise<void>;
    };

    priv.selectedAccountId = 'acc-newer';
    priv.connectionStatus = { connected: true };

    let credsDeleted = false;
    let onDeletedCalled = false;

    await priv.runDeleteIntegrationOperation({
      account: { id: 'acc-1', name: 'Primary' },
      providerLabel: 'TestProvider',
      deleteCredentials: async () => {
        credsDeleted = true;
        // Advance generation while delete operation is in-flight
        priv.loadGeneration++;
      },
      getRemainingAccounts: () => [],
      onDeleted: async () => {
        onDeletedCalled = true;
      },
    });

    expect(credsDeleted).to.be.true;
    expect(onDeletedCalled).to.be.false;
    expect(priv.selectedAccountId).to.equal('acc-newer');
    expect(priv.connectionStatus).to.deep.equal({ connected: true });
  });
});
