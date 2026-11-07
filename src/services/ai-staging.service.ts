/**
 * AI Staging Service (#619 Hunk-Level AI Staging & #620 AI Fixup Targeting)
 */

import { invokeCommand } from './tauri-api.ts';
import { checkOutboundHostAllowed, isNetworkPolicyActive } from './git/shared.ts';
import {
  getActiveAiProvider,
  getAiProviders,
  getProviderDisplayName,
  isLocalAiProvider,
  type AiProviderType,
} from './ai.service.ts';
import type { CommandResult } from '../types/api.types.ts';

/**
 * Reference to a single diff hunk within a modified file.
 */
export interface HunkRef {
  filePath: string;
  hunkIndex: number;
  header: string;
  summary: string;
}

/**
 * A logical atomic commit group of diff hunks suggested by AI or deterministic clustering.
 */
export interface AiHunkSplitGroup {
  commitMessage: string;
  description: string;
  hunks: HunkRef[];
}

/**
 * Suggested target commit for a `fixup!` commit (`git absorb` + AI rationale).
 */
export interface FixupTargetSuggestion {
  commitOid: string;
  shortOid: string;
  commitSummary: string;
  author: string;
  confidence: number;
  overlappingFiles: string[];
  overlappingHunks: number;
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

function aiStagingBlockedResult<T>(
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
 * Enforce the outbound network security gate before invoking an AI-backed staging command.
 */
async function checkAiStagingNetworkAllowed<T>(): Promise<CommandResult<T> | null> {
  if (!isNetworkPolicyActive()) return null;

  const active = await getActiveAiProvider();
  const provider = active.success ? (active.data ?? null) : null;
  if (!provider) return null;

  const resolved = await resolveProviderEndpoint(provider);
  const endpoint = resolved ?? (PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null);
  if (endpoint !== null && isLoopbackEndpoint(endpoint)) return null;

  const reason = await checkOutboundHostAllowed(endpoint);
  if (!reason) return null;
  return aiStagingBlockedResult<T>(
    reason === 'allowlist' ? 'allowlist' : 'offline',
    provider,
    endpoint,
  );
}

/**
 * Suggest hunk-level atomic commit splits across modified files in the repository.
 */
export async function suggestHunkSplits(
  path: string,
): Promise<CommandResult<AiHunkSplitGroup[]>> {
  const blocked = await checkAiStagingNetworkAllowed<AiHunkSplitGroup[]>();
  if (blocked) return blocked;
  return invokeCommand<AiHunkSplitGroup[]>('suggest_hunk_splits', { path });
}

/**
 * Stage the specified hunks into the git index, returning the number of staged hunks.
 */
export async function stageHunkGroup(
  path: string,
  hunks: HunkRef[],
): Promise<CommandResult<number>> {
  return invokeCommand<number>('stage_hunk_group', { path, hunks });
}

/**
 * Suggest target commits for a `fixup!` commit by combining deterministic
 * hunk/line overlap scoring with optional AI rationale enrichment.
 */
export async function suggestFixupTargets(
  path: string,
  maxCommits?: number,
): Promise<CommandResult<FixupTargetSuggestion[]>> {
  const blocked = await checkAiStagingNetworkAllowed<FixupTargetSuggestion[]>();
  if (blocked) return blocked;
  return invokeCommand<FixupTargetSuggestion[]>('suggest_fixup_targets', {
    path,
    maxCommits: maxCommits ?? null,
  });
}
