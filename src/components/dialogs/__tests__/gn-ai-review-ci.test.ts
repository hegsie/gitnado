/**
 * Unit tests for Wave 2 Track 4 (`ai-review-ci-diagnostics`):
 * - Local AI Branch / PR Review (#623)
 * - PR Review Comment -> Suggested Patch (#624)
 * - "Explain This CI Failure" (#626)
 * - `<gn-ai-review-panel>` and `GnProviderDialogBase` integration
 * - Outbound network policy gating in `ai-review.service.ts`
 */

import { expect, fixture, html } from '@open-wc/testing';
import { customElement } from 'lit/decorators.js';
import {
  GnProviderDialogBase,
  providerDialogBaseStyles,
  type PrReviewComment,
} from '../gn-provider-dialog-base.ts';
import type { GnAiReviewPanel } from '../gn-ai-review-panel.ts';
import '../gn-ai-review-panel.ts';
import {
  reviewBranchDiff,
  suggestCommentResolutionPatch,
  explainCiFailure,
  type AiBranchReviewResult,
  type CommentResolutionPatch,
  type CiFailureExplanation,
} from '../../../services/ai-review.service.ts';
import { settingsStore } from '../../../stores/settings.store.ts';
import type { CommandResult } from '../../../types/api.types.ts';

type TauriGlobal = {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

interface FakeRepo {
  owner: string;
  repo: string;
}

interface FakeStatus {
  connected: boolean;
}

@customElement('test-ai-provider-dialog')
class TestAiProviderDialog extends GnProviderDialogBase<
  FakeRepo,
  FakeStatus,
  'connection' | 'prs' | 'ci'
> {
  static styles = [providerDialogBaseStyles];

  protected readonly providerDisplayName = 'TestHost';
  protected readonly integrationType = 'github' as const;

  public postedComments: Array<{
    prNumber: number;
    body: string;
    path?: string;
    line?: number;
    commitId?: string;
  }> = [];

  public mockComments: PrReviewComment[] = [];

  protected async loadInitialData(): Promise<void> {}
  protected async detectRepo(): Promise<void> {}
  protected resetProviderRepoScopedState(): void {}

  protected async getTokenForComments(): Promise<string | null> {
    return 'test-token';
  }

  protected getCommentsOutboundHost(): string {
    return 'api.github.com';
  }

  protected async fetchPrComments(): Promise<CommandResult<PrReviewComment[]>> {
    return { success: true, data: this.mockComments };
  }

  protected async postPrComment(
    _repo: FakeRepo,
    prNumber: number,
    body: string,
    path: string | undefined,
    line: number | undefined,
    commitId: string | undefined,
  ): Promise<CommandResult<PrReviewComment>> {
    this.postedComments.push({ prNumber, body, path, line, commitId });
    const created: PrReviewComment = {
      id: `posted-${this.postedComments.length}`,
      body,
      author: 'ai-bot',
      createdAt: '2026-03-01T12:00:00Z',
      filePath: path ?? null,
      line: line ?? null,
    };
    this.mockComments = [...this.mockComments, created];
    return { success: true, data: created };
  }

  public openTestDrawer(
    prNumber: number,
    comments: PrReviewComment[],
  ): void {
    this.detectedRepo = { owner: 'octocat', repo: 'hello-world' };
    this.connectionStatus = { connected: true };
    this.expandedPrNumber = prNumber;
    this.mockComments = comments;
    this.prComments = { [prNumber]: comments };
  }

  override render() {
    return html`
      <div>
        ${this.expandedPrNumber !== null
          ? this.renderPrCommentDrawer(this.expandedPrNumber, 'sha-head-123', {
              baseRef: 'main',
              headRef: 'feature/ai-review',
            })
          : ''}
        <div class="ci-row">
          ${this.renderCiFailureExplainerButton(
            'cargo test',
            'cargo test #45 on feature/ai-review: failure in tests::auth_token',
          )}
        </div>
      </div>
    `;
  }
}

describe('AI Review & CI Diagnostics (Issues #623, #624, #626)', () => {
  let originalTauri: TauriGlobal['__TAURI_INTERNALS__'];
  let invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let invokeResponder: (
    command: string,
    args?: Record<string, unknown>,
  ) => unknown | Promise<unknown>;

  beforeEach(() => {
    invokeCalls = [];
    originalTauri = (globalThis as unknown as TauriGlobal).__TAURI_INTERNALS__;
    invokeResponder = () => null;
    (globalThis as unknown as TauriGlobal).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        invokeCalls.push({ command, args });
        return await invokeResponder(command, args);
      },
    };
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
    if (originalTauri === undefined) {
      delete (globalThis as unknown as TauriGlobal).__TAURI_INTERNALS__;
    } else {
      (globalThis as unknown as TauriGlobal).__TAURI_INTERNALS__ = originalTauri;
    }
  });

  describe('<gn-ai-review-panel>', () => {
    it('renders AI Branch Review findings and emits post-finding-comment (#623)', async () => {
      const reviewResult: AiBranchReviewResult = {
        summary: 'Found 1 high-priority issue in src/auth.ts.',
        riskLevel: 'high',
        filesReviewed: 2,
        findings: [
          {
            filePath: 'src/auth.ts',
            line: 27,
            severity: 'critical',
            category: 'security',
            title: 'Unvalidated token payload',
            message: 'Token signature must be verified before decoding claims.',
            suggestedFix: 'verifyJwtSignature(token, secret);',
          },
        ],
      };

      const el = await fixture<GnAiReviewPanel>(html`
        <gn-ai-review-panel
          .reviewResult=${reviewResult}
          .canPostComment=${true}
        ></gn-ai-review-panel>
      `);

      const riskBadge = el.shadowRoot!.querySelector(
        '[data-testid="ai-review-risk-badge"]',
      );
      expect(riskBadge?.textContent?.trim()).to.include('high risk');

      const summary = el.shadowRoot!.querySelector(
        '[data-testid="ai-review-summary"]',
      );
      expect(summary?.textContent?.trim()).to.equal(
        'Found 1 high-priority issue in src/auth.ts.',
      );

      let postedFinding: unknown = null;
      el.addEventListener('post-finding-comment', ((e: CustomEvent) => {
        postedFinding = e.detail.finding;
      }) as EventListener);

      const postBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="ai-finding-post-comment-0"]',
      );
      expect(postBtn).to.exist;
      postBtn!.click();

      expect(postedFinding).to.deep.equal(reviewResult.findings[0]);
    });

    it('renders Comment-to-Patch unified diff preview and emits apply-patch (#624)', async () => {
      const patchPreview: CommentResolutionPatch = {
        filePath: 'src/lib.ts',
        explanation: 'Guard against null input before reading length.',
        unifiedDiff:
          '--- a/src/lib.ts\n+++ b/src/lib.ts\n@@ -1,2 +1,3 @@\n+if (!input) return 0;\n return input.length;\n',
        canApplyCleanly: true,
      };

      const el = await fixture<GnAiReviewPanel>(html`
        <gn-ai-review-panel .patchPreview=${patchPreview}></gn-ai-review-panel>
      `);

      const cleanBadge = el.shadowRoot!.querySelector(
        '[data-testid="ai-patch-clean-badge"]',
      );
      expect(cleanBadge?.textContent?.trim()).to.equal('Applies cleanly');

      let appliedPatch: unknown = null;
      el.addEventListener('apply-patch', ((e: CustomEvent) => {
        appliedPatch = e.detail.patch;
      }) as EventListener);

      const applyBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="ai-patch-apply-btn"]',
      );
      expect(applyBtn).to.exist;
      applyBtn!.click();

      expect(appliedPatch).to.deep.equal(patchPreview);
    });

    it('renders CI Failure Diagnosis with root cause, failing step, and suggested fix (#626)', async () => {
      const ciExplanation: CiFailureExplanation = {
        checkName: 'Build & Test',
        rootCause: 'Missing environment variable DATABASE_URL during migration step.',
        failingStep: 'Run DB migrations',
        suggestedFix: 'Configure DATABASE_URL in the workflow env section.',
        relevantFiles: ['.github/workflows/ci.yml', 'src/db.rs'],
      };

      const el = await fixture<GnAiReviewPanel>(html`
        <gn-ai-review-panel .ciExplanation=${ciExplanation}></gn-ai-review-panel>
      `);

      expect(
        el.shadowRoot!.querySelector('[data-testid="ai-ci-root-cause"]')
          ?.textContent?.trim(),
      ).to.equal(ciExplanation.rootCause);
      expect(
        el.shadowRoot!.querySelector('[data-testid="ai-ci-failing-step"]')
          ?.textContent?.trim(),
      ).to.equal('Run DB migrations');
      expect(
        el.shadowRoot!.querySelector('[data-testid="ai-ci-suggested-fix"]')
          ?.textContent?.trim(),
      ).to.equal(ciExplanation.suggestedFix);
    });
  });

  describe('GnProviderDialogBase integration', () => {
    it('runs AI Branch Review from the PR drawer and posts a finding as a PR comment (#623)', async () => {
      const mockReview: AiBranchReviewResult = {
        summary: 'Detected 1 potential null dereference.',
        riskLevel: 'medium',
        filesReviewed: 1,
        findings: [
          {
            filePath: 'src/handler.ts',
            line: 14,
            severity: 'warning',
            category: 'bug',
            title: 'Unchecked optional user',
            message: 'Verify user is defined before accessing user.id.',
            suggestedFix: 'if (!user) return;',
          },
        ],
      };

      invokeResponder = (command) => {
        if (command === 'review_branch_diff') return mockReview;
        return null;
      };

      const dialog = await fixture<TestAiProviderDialog>(html`
        <test-ai-provider-dialog
          .open=${true}
          .repositoryPath=${'/tmp/test-repo'}
        ></test-ai-provider-dialog>
      `);

      dialog.openTestDrawer(42, []);
      await dialog.updateComplete;

      const reviewBtn = dialog.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="ai-review-branch-btn-42"]',
      );
      expect(reviewBtn).to.exist;
      reviewBtn!.click();

      await new Promise((r) => setTimeout(r, 20));
      await dialog.updateComplete;

      const reviewCall = invokeCalls.find(
        (c) => c.command === 'review_branch_diff',
      );
      expect(reviewCall).to.exist;
      expect(reviewCall?.args).to.deep.equal({
        path: '/tmp/test-repo',
        baseRef: 'main',
        headRef: 'feature/ai-review',
      });

      const panel = dialog.shadowRoot!.querySelector<GnAiReviewPanel>(
        'gn-ai-review-panel',
      );
      expect(panel).to.exist;
      await panel!.updateComplete;

      const postBtn = panel!.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="ai-finding-post-comment-0"]',
      );
      expect(postBtn).to.exist;
      postBtn!.click();

      await new Promise((r) => setTimeout(r, 20));
      await dialog.updateComplete;

      expect(dialog.postedComments.length).to.equal(1);
      expect(dialog.postedComments[0].prNumber).to.equal(42);
      expect(dialog.postedComments[0].path).to.equal('src/handler.ts');
      expect(dialog.postedComments[0].line).to.equal(14);
      expect(dialog.postedComments[0].body).to.include('Unchecked optional user');
    });

    it('generates a comment resolution patch and applies it to the working tree (#624)', async () => {
      const mockPatch: CommentResolutionPatch = {
        filePath: 'src/utils.ts',
        explanation: 'Replaced var with const as requested.',
        unifiedDiff:
          '--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,1 +1,1 @@\n-var x = 1;\n+const x = 1;\n',
        canApplyCleanly: true,
      };

      invokeResponder = (command) => {
        if (command === 'suggest_comment_resolution_patch') return mockPatch;
        if (command === 'apply_comment_resolution_patch') return null;
        return null;
      };

      const dialog = await fixture<TestAiProviderDialog>(html`
        <test-ai-provider-dialog
          .open=${true}
          .repositoryPath=${'/tmp/test-repo'}
        ></test-ai-provider-dialog>
      `);

      dialog.openTestDrawer(7, [
        {
          id: 'c-101',
          author: 'reviewer',
          body: 'Please use const instead of var here.',
          createdAt: '2026-03-01T10:00:00Z',
          filePath: 'src/utils.ts',
          line: 1,
        },
      ]);
      await dialog.updateComplete;

      const genFixBtn = dialog.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="generate-fix-btn-c-101"]',
      );
      expect(genFixBtn).to.exist;
      genFixBtn!.click();

      await new Promise((r) => setTimeout(r, 20));
      await dialog.updateComplete;

      const suggestCall = invokeCalls.find(
        (c) => c.command === 'suggest_comment_resolution_patch',
      );
      expect(suggestCall).to.exist;
      expect(suggestCall?.args).to.deep.equal({
        path: '/tmp/test-repo',
        filePath: 'src/utils.ts',
        line: 1,
        commentBody: 'Please use const instead of var here.',
      });

      const panel = dialog.shadowRoot!.querySelector<GnAiReviewPanel>(
        'gn-ai-review-panel',
      );
      expect(panel).to.exist;
      await panel!.updateComplete;

      let refreshEvents = 0;
      const onRefresh = () => {
        refreshEvents++;
      };
      window.addEventListener('repository-refresh', onRefresh);

      try {
        const applyBtn = panel!.shadowRoot!.querySelector<HTMLButtonElement>(
          '[data-testid="ai-patch-apply-btn"]',
        );
        expect(applyBtn).to.exist;
        applyBtn!.click();

        await new Promise((r) => setTimeout(r, 20));
        await dialog.updateComplete;

        const applyCall = invokeCalls.find(
          (c) => c.command === 'apply_comment_resolution_patch',
        );
        expect(applyCall).to.exist;
        expect(applyCall?.args).to.deep.equal({
          path: '/tmp/test-repo',
          unifiedDiff: mockPatch.unifiedDiff,
        });
        expect(refreshEvents).to.be.greaterThan(0);
      } finally {
        window.removeEventListener('repository-refresh', onRefresh);
      }
    });

    it('explains a failing CI check via renderCiFailureExplainerButton (#626)', async () => {
      const mockExplanation: CiFailureExplanation = {
        checkName: 'cargo test',
        rootCause: 'Assertion failed in tests::auth_token due to expired fixture timestamp.',
        failingStep: 'cargo test --workspace',
        suggestedFix: 'Update fixture timestamp in src/auth_test.rs.',
        relevantFiles: ['src/auth_test.rs'],
      };

      invokeResponder = (command) => {
        if (command === 'explain_ci_failure') return mockExplanation;
        return null;
      };

      const dialog = await fixture<TestAiProviderDialog>(html`
        <test-ai-provider-dialog
          .open=${true}
          .repositoryPath=${'/tmp/test-repo'}
        ></test-ai-provider-dialog>
      `);
      await dialog.updateComplete;

      const explainBtn = dialog.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-testid="explain-ci-failure-btn"]',
      );
      expect(explainBtn).to.exist;
      explainBtn!.click();

      await new Promise((r) => setTimeout(r, 20));
      await dialog.updateComplete;

      const explainCall = invokeCalls.find(
        (c) => c.command === 'explain_ci_failure',
      );
      expect(explainCall).to.exist;
      expect(explainCall?.args?.checkName).to.equal('cargo test');

      const panels = dialog.shadowRoot!.querySelectorAll<GnAiReviewPanel>(
        'gn-ai-review-panel',
      );
      const ciPanel = Array.from(panels).find((p) => p.ciExplanation !== null);
      expect(ciPanel).to.exist;
      await ciPanel!.updateComplete;

      expect(
        ciPanel!.shadowRoot!.querySelector('[data-testid="ai-ci-root-cause"]')
          ?.textContent?.trim(),
      ).to.include('Assertion failed in tests::auth_token');
    });
  });

  describe('ai-review.service network policy gate', () => {
    it('blocks cloud AI provider calls when offlineMode is enabled', async () => {
      settingsStore.setState({ offlineMode: true, remoteAllowlist: [] });
      invokeResponder = (command) => {
        if (command === 'get_active_ai_provider') return 'open_ai';
        if (command === 'get_ai_providers') {
          return [
            {
              providerType: 'open_ai',
              name: 'OpenAI',
              available: true,
              requiresApiKey: true,
              hasApiKey: true,
              endpoint: 'https://api.openai.com/v1',
              models: ['gpt-4o'],
              selectedModel: 'gpt-4o',
            },
          ];
        }
        return null;
      };

      const reviewRes = await reviewBranchDiff('/tmp/repo', 'main', 'HEAD');
      expect(reviewRes.success).to.be.false;
      expect(reviewRes.error?.code).to.equal('BLOCKED');

      const patchRes = await suggestCommentResolutionPatch(
        '/tmp/repo',
        'src/a.ts',
        1,
        'Fix this',
      );
      expect(patchRes.success).to.be.false;
      expect(patchRes.error?.code).to.equal('BLOCKED');

      const ciRes = await explainCiFailure('test', 'failed log', '/tmp/repo');
      expect(ciRes.success).to.be.false;
      expect(ciRes.error?.code).to.equal('BLOCKED');
    });
  });
});
