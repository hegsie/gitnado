/**
 * AI Explain & Naming Service (#621, #622)
 *
 * Provides structured explanations for commits, branch comparisons, and
 * working tree changes, plus AI-assisted branch naming and stash message
 * suggestions. Respects the security network gate in offline/allowlist modes.
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

export type ExplainTargetType = 'commit' | 'branch_compare' | 'working_tree';

export interface AiExplanation {
  title: string;
  summary: string;
  intent: string;
  keyChanges: string[];
  risks: string[];
  providerUsed: string;
  isLocal: boolean;
}

export interface AiExplainTokenEvent {
  targetId: string;
  token: string;
  done: boolean;
}

export interface BranchNameSuggestion {
  name: string;
  alternatives: string[];
  rationale: string;
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

/**
 * Guard an AI request against offline mode and the remote host allowlist.
 */
export async function guardAiRequest<T>(): Promise<CommandResult<T> | null> {
  if (!isNetworkPolicyActive()) return null;

  const active = await getActiveAiProvider();
  const provider = active.success ? (active.data ?? null) : null;
  if (!provider) return null;

  const resolved = await resolveProviderEndpoint(provider);
  const endpoint = resolved ?? (PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null);
  if (endpoint !== null && isLoopbackEndpoint(endpoint)) return null;
  const reason = await checkOutboundHostAllowed(endpoint);
  if (!reason) return null;
  return aiBlockedResult<T>(reason === 'allowlist' ? 'allowlist' : 'offline', provider, endpoint);
}

/**
 * Generate a structured AI explanation for a commit, branch comparison, or working tree diff.
 */
export async function explainGitTarget(
  path: string,
  targetType: ExplainTargetType,
  targetId: string,
  baseRef?: string,
  filePath?: string,
): Promise<CommandResult<AiExplanation>> {
  const blocked = await guardAiRequest<AiExplanation>();
  if (blocked) return blocked;
  return invokeCommand<AiExplanation>('explain_git_target', {
    path,
    targetType,
    targetId,
    baseRef: baseRef ?? null,
    filePath: filePath ?? null,
  });
}

/**
 * Stream an AI explanation for a git target, emitting `ai-explain-token` events
 * and resolving with the final structured `AiExplanation`.
 */
export async function explainGitTargetStream(
  path: string,
  targetType: ExplainTargetType,
  targetId: string,
  baseRef?: string,
): Promise<CommandResult<AiExplanation>> {
  const blocked = await guardAiRequest<AiExplanation>();
  if (blocked) return blocked;
  return invokeCommand<AiExplanation>('explain_git_target_stream', {
    path,
    targetType,
    targetId,
    baseRef: baseRef ?? null,
  });
}

/**
 * Suggest a conventional git branch name and alternatives from working tree changes.
 */
export async function suggestBranchName(
  path: string,
  issueContext?: string,
): Promise<CommandResult<BranchNameSuggestion>> {
  const blocked = await guardAiRequest<BranchNameSuggestion>();
  if (blocked) return blocked;
  return invokeCommand<BranchNameSuggestion>('suggest_branch_name', {
    path,
    issueContext: issueContext ?? null,
  });
}

/**
 * Suggest a concise git stash message from working tree changes.
 */
export async function suggestStashMessage(
  path: string,
  includeUntracked?: boolean,
): Promise<CommandResult<string>> {
  const blocked = await guardAiRequest<string>();
  if (blocked) return blocked;
  return invokeCommand<string>('suggest_stash_message', {
    path,
    includeUntracked: includeUntracked ?? null,
  });
}
