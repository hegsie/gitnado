/**
 * AI Review & CI Diagnostics Service
 *
 * Provides frontend wrappers for:
 * - Local AI Branch / PR Review (#623)
 * - PR Review Comment -> Suggested Patch (#624)
 * - "Explain This CI Failure" (#626)
 *
 * All AI-provider-reaching commands enforce the same outbound network policy gate
 * as `ai.service.ts`.
 */

import { invokeCommand } from './tauri-api.ts';
import { checkOutboundHostAllowed, isNetworkPolicyActive } from './git.service.ts';
import {
  getActiveAiProvider,
  getAiProviders,
  getProviderDisplayName,
  isLocalAiProvider,
  type AiProviderType,
} from './ai.service.ts';
import type { CommandResult } from '../types/api.types.ts';

export type AiReviewSeverity = 'critical' | 'warning' | 'suggestion';
export type AiReviewCategory = 'bug' | 'security' | 'performance' | 'maintainability';
export type AiReviewRiskLevel = 'low' | 'medium' | 'high';

export interface AiReviewFinding {
  filePath: string;
  line: number | null;
  severity: AiReviewSeverity;
  category: AiReviewCategory;
  title: string;
  message: string;
  suggestedFix: string | null;
}

export interface AiBranchReviewResult {
  summary: string;
  riskLevel: AiReviewRiskLevel;
  findings: AiReviewFinding[];
  filesReviewed: number;
}

export interface CommentResolutionPatch {
  filePath: string;
  explanation: string;
  unifiedDiff: string;
  canApplyCleanly: boolean;
}

export interface CiFailureExplanation {
  checkName: string;
  rootCause: string;
  failingStep: string | null;
  suggestedFix: string;
  relevantFiles: string[];
}

const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<AiProviderType, string>> = {
  ollama: 'http://localhost:11434',
  lm_studio: 'http://localhost:1234/v1',
  open_ai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  github_copilot: 'https://models.inference.ai.azure.com',
  google_gemini: 'https://generativelanguage.googleapis.com',
  local_inference: '',
};

function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return '';
  try {
    const { hostname } = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim();
  if (!trimmed) return true;
  const host = endpointHost(trimmed);
  if (!host) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

async function resolveProviderEndpoint(provider: AiProviderType): Promise<string | null> {
  const listing = await getAiProviders();
  if (!listing.success || !Array.isArray(listing.data)) return null;
  const info = listing.data.find((entry) => entry.providerType === provider);
  if (!info) return null;
  return info.endpoint?.trim() ?? '';
}

function aiBlockedResult<T>(
  reason: 'offline' | 'allowlist',
  provider: AiProviderType,
  endpoint?: string | null,
): CommandResult<T> {
  const name = getProviderDisplayName(provider);
  const host = endpoint ?? PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null;
  const local = isLocalAiProvider(provider);
  const repoint =
    `point ${name} back at this machine by removing its "endpoint" from ` +
    'ai_config.json in the app config folder — the app has no setting for it.';
  const message =
    reason === 'offline'
      ? local
        ? `Offline mode is enabled and ${name} is configured to use ` +
          `${host}, which is not on this machine. Turn offline mode off in ` +
          `Settings > Security, or ${repoint}`
        : `Offline mode is enabled and ${name} is a cloud AI provider. ` +
          'Turn offline mode off in Settings > Security, or select a local ' +
          'provider (Ollama, LM Studio or Local AI).'
      : local
        ? `${name} is configured to use ${host}, which is not in your remote ` +
          `allowlist. Add it in Settings > Security, or ${repoint}`
        : `${name} (${host}) is not in your remote allowlist. Add it in ` +
          'Settings > Security, or select a local provider (Ollama, LM Studio ' +
          'or Local AI).';

  return { success: false, error: { code: 'BLOCKED', message } };
}

async function checkAiNetworkAllowed<T>(): Promise<CommandResult<T> | null> {
  if (!isNetworkPolicyActive()) return null;

  const active = await getActiveAiProvider();
  const provider = active.success ? (active.data ?? null) : null;
  if (!provider) return null;

  const resolved = await resolveProviderEndpoint(provider);
  const endpoint = resolved ?? (PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null);
  if (endpoint !== null && isLoopbackEndpoint(endpoint)) return null;

  const reason = await checkOutboundHostAllowed(endpoint);
  if (!reason) return null;

  return aiBlockedResult<T>(
    reason === 'allowlist' ? 'allowlist' : 'offline',
    provider,
    endpoint,
  );
}

/**
 * Run an AI + local secret/debug review across the diff between `baseRef` and `headRef` (or HEAD) (#623).
 */
export async function reviewBranchDiff(
  path: string,
  baseRef: string,
  headRef?: string | null,
): Promise<CommandResult<AiBranchReviewResult>> {
  const blocked = await checkAiNetworkAllowed<AiBranchReviewResult>();
  if (blocked) return blocked;
  return invokeCommand<AiBranchReviewResult>('review_branch_diff', {
    path,
    baseRef,
    headRef: headRef ?? null,
  });
}

/**
 * Generate a suggested unified diff patch to resolve a PR/MR review comment (#624).
 */
export async function suggestCommentResolutionPatch(
  path: string,
  filePath: string,
  line: number | null | undefined,
  commentBody: string,
): Promise<CommandResult<CommentResolutionPatch>> {
  const blocked = await checkAiNetworkAllowed<CommentResolutionPatch>();
  if (blocked) return blocked;
  return invokeCommand<CommentResolutionPatch>('suggest_comment_resolution_patch', {
    path,
    filePath,
    line: line ?? null,
    commentBody,
  });
}

/**
 * Apply a generated comment resolution patch to the working tree (#624).
 * This operation is strictly local (writes to the local working directory).
 */
export async function applyCommentResolutionPatch(
  path: string,
  unifiedDiff: string,
): Promise<CommandResult<void>> {
  return invokeCommand<void>('apply_comment_resolution_patch', {
    path,
    unifiedDiff,
  });
}

/**
 * Analyze a failing CI check or pipeline run and explain the root cause and fix (#626).
 */
export async function explainCiFailure(
  checkName: string,
  failureLogOrSummary: string,
  path?: string | null,
): Promise<CommandResult<CiFailureExplanation>> {
  const blocked = await checkAiNetworkAllowed<CiFailureExplanation>();
  if (blocked) return blocked;
  return invokeCommand<CiFailureExplanation>('explain_ci_failure', {
    path: path ?? null,
    checkName,
    failureLogOrSummary,
  });
}
