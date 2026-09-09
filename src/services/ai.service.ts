/**
 * AI Service
 * Provides AI-powered commit message generation via configurable providers
 */

import { invokeCommand } from './tauri-api.ts';
import { checkOutboundHostAllowed, isNetworkPolicyActive } from './git.service.ts';
import { allowlistPermits } from '../utils/avatar-policy.ts';
import { settingsStore, type SettingsState } from '../stores/settings.store.ts';
import type { CommandResult } from '../types/api.types.ts';

/**
 * AI provider types
 *
 * These literals are the serde wire format of the Rust `AiProviderType` enum,
 * which is annotated `#[serde(rename_all = "snake_case")]`. That means the
 * `OpenAi` variant crosses the IPC boundary (and is persisted in the AI config
 * file) as `open_ai` — not `openai`.
 */
export type AiProviderType = 'ollama' | 'lm_studio' | 'open_ai' | 'anthropic' | 'github_copilot' | 'google_gemini' | 'local_inference';

/**
 * AI provider information
 */
export interface AiProviderInfo {
  providerType: AiProviderType;
  name: string;
  available: boolean;
  /**
   * Whether `available` is an answer or a guess.
   *
   * Listing providers must not itself be a network request: for a cloud
   * provider the reachability probe is an outbound models-list call, and this
   * list is exactly what Settings renders in order to offer the switch that
   * turns that provider off. So with offline mode on (or its host outside the
   * allowlist) the backend skips the probe and sends `false` here, meaning
   * "not probed" rather than "unavailable".
   */
  probed: boolean;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  endpoint: string;
  models: string[];
  selectedModel: string | null;
}

/**
 * Generated commit message result
 */
export interface GeneratedCommitMessage {
  summary: string;
  body: string | null;
}

/**
 * AI-generated conflict resolution suggestion
 */
export interface ConflictResolutionSuggestion {
  resolvedContent: string;
  explanation: string;
}

// ========================================================================
// Security gate
// ========================================================================

/**
 * Providers whose requests leave this machine.
 *
 * Ollama and LM Studio listen on localhost and local inference runs
 * in-process, so none of those three ever leaves the machine — offline mode
 * has no business refusing them, and this list is what keeps them working.
 */
const CLOUD_PROVIDERS: ReadonlySet<AiProviderType> = new Set<AiProviderType>([
  'open_ai',
  'anthropic',
  'github_copilot',
  'google_gemini',
]);

/**
 * Providers whose requests never leave this machine, named EXPLICITLY.
 *
 * The gate used to read this as "not in CLOUD_PROVIDERS", which makes any
 * provider this build has never heard of local — a new Rust variant against an
 * older frontend, say — and waves its requests through while offline mode is
 * on. Every other unknown destination in this gate fails closed; this one
 * failed open.
 *
 * The gate no longer decides anything on this set: a local provider is
 * permitted because its ENDPOINT is on this machine, not because of its name
 * (see `checkAiNetworkAllowed`). It still tells the refusal message which of
 * two things to say, and it is what Settings uses to group the providers.
 */
const LOCAL_PROVIDERS: ReadonlySet<AiProviderType> = new Set<AiProviderType>([
  'ollama',
  'lm_studio',
  'local_inference',
]);

/** True when a provider's requests leave this machine. */
export function isCloudAiProvider(providerType: AiProviderType): boolean {
  return CLOUD_PROVIDERS.has(providerType);
}

/** True when a provider is known to run on this machine. */
export function isLocalAiProvider(providerType: AiProviderType): boolean {
  return LOCAL_PROVIDERS.has(providerType);
}

/**
 * The endpoint each provider talks to BY DEFAULT. Mirrors
 * `AiProviderType::default_endpoint` in `src-tauri/src/services/ai/mod.rs`
 * value for value, LOCAL PROVIDERS INCLUDED — a local provider's default is a
 * loopback URL, and `local_inference` is the embedded model, which has no
 * endpoint at all.
 *
 * Only the fallback: a provider whose endpoint has been overridden in the AI
 * config is judged on that endpoint, which is what the request will really
 * contact — see `resolveProviderEndpoint`. This table is what the gate falls
 * back to when the provider listing is unavailable.
 *
 * It covers every provider rather than only the cloud ones because the gate no
 * longer waves a local provider through on its NAME: the AI config can point
 * Ollama at a corporate gateway, and the backend judges that endpoint
 * (`guard_ai_request` -> `guard_endpoint(active_provider_endpoint())`, which
 * has no per-provider carve-out at all). A name-based pass here permitted what
 * the backend refuses.
 */
const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<AiProviderType, string>> = {
  ollama: 'http://localhost:11434',
  lm_studio: 'http://localhost:1234/v1',
  open_ai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  github_copilot: 'https://models.inference.ai.azure.com',
  google_gemini: 'https://generativelanguage.googleapis.com',
  local_inference: '',
};

/**
 * The refusal an AI call returns, in the shape callers already render.
 *
 * Always about a provider that is actually CHOSEN: with nothing chosen the
 * gate permits the call rather than refusing it, because the backend resolves
 * the fallback provider itself and skips every one the security settings
 * forbid (see `checkAiNetworkAllowed`). So there is no "no provider selected"
 * wording here — it would only ever have named a risk that cannot arise.
 *
 * Neither branch tells a user of a LOCAL provider to "select a local
 * provider": that would name the one already selected. Its endpoint is what is
 * wrong, and the endpoint lives in the AI config file — the app has no control
 * for it (there is no `set_ai_endpoint` command beside `set_ai_provider` /
 * `set_ai_api_key` / `set_ai_model`), so naming a Settings field for it sent
 * the user looking for something that does not exist. Removing the entry from
 * `ai_config.json` restores the provider's loopback default, which is exactly
 * what `endpoint_for` falls back to.
 */
function aiBlockedResult<T>(
  reason: 'offline' | 'allowlist',
  provider: AiProviderType,
  /**
   * The endpoint the gate actually judged, so the refusal names the host the
   * request would have reached. Naming the provider's DEFAULT host while the
   * config points somewhere else told the user to allowlist a domain the
   * request never contacts.
   */
  endpoint?: string | null,
): CommandResult<T> {
  const name = getProviderDisplayName(provider);
  const host = endpoint ?? PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null;
  const local = isLocalAiProvider(provider);
  /** The one remedy a user of a misconfigured local provider actually has. */
  const repoint =
    `point ${name} back at this machine by removing its "endpoint" from ` +
    'ai_config.json in the app config folder — the app has no setting for it.';
  const message =
    reason === 'offline'
      ? local
        ? // A local provider pointed somewhere else. "Select a local
          // provider" would name the one already selected, so this says what
          // is actually wrong: its endpoint is not on this machine.
          `Offline mode is enabled and ${name} is configured to use ` +
          `${host}, which is not on this machine. Turn offline mode off in ` +
          `Settings > Security, or ${repoint}`
        : `Offline mode is enabled and ${name} is a cloud AI provider. ` +
          'Turn offline mode off in Settings > Security, or select a local ' +
          'provider (Ollama, LM Studio or Local AI).'
      : local
        ? // Same split on the allowlist side. This branch used to end in
          // "select a local provider" while a local provider was selected.
          `${name} is configured to use ${host}, which is not in your remote ` +
          `allowlist. Add it in Settings > Security, or ${repoint}`
        : `${name} (${host}) is not in your remote allowlist. Add it in ` +
          'Settings > Security, or select a local provider (Ollama, LM Studio ' +
          'or Local AI).';

  // `BLOCKED` is the code the git gate uses, so `isNetworkGateRefusal` and the
  // suggestion service treat an AI refusal exactly like any other.
  return { success: false, error: { code: 'BLOCKED', message } };
}

/**
 * The security gate every provider-reaching AI call passes through.
 *
 * Offline mode promises to block "every operation that leaves this machine",
 * and the AI providers were the one outbound path it never covered: with
 * OpenAI / Anthropic / Gemini / GitHub Models selected, "Generate commit
 * message" posted the staged diff, changelog generation posted the commit
 * history, and conflict help posted both sides of the file — all while the
 * setting said the app was offline.
 *
 * The active provider is resolved on every call rather than cached. It decides
 * whether a diff leaves the machine, so it has to be the value in force at the
 * moment of the call; a cache would need every writer of the AI config to
 * remember to invalidate it, and the one that forgot would fail open.
 * `get_active_ai_provider` reads in-memory config — it makes no request — and
 * it is skipped entirely unless a policy is actually in force.
 *
 * @param providerType The provider this call will use, when the caller names
 *   one — `testAiProvider` tests a provider that need not be the active one.
 *   Omitted means "whichever provider is active".
 * @returns null when the call may proceed, or the refusal to return as-is.
 */
async function checkAiNetworkAllowed<T>(
  providerType?: AiProviderType,
): Promise<CommandResult<T> | null> {
  if (!isNetworkPolicyActive()) return null;

  let provider = providerType ?? null;
  if (!provider) {
    const active = await getActiveAiProvider();
    provider = active.success ? (active.data ?? null) : null;
  }

  // Nothing chosen in Settings, and nothing for this gate to refuse. The
  // request falls back to whatever is reachable, and `resolve_provider`
  // (src-tauri/src/services/ai/mod.rs) tries the embedded model first and then
  // SKIPS every provider whose endpoint the security settings forbid
  // (`provider_network_allowed`) — so a fallback request can only ever go
  // somewhere this gate would have allowed anyway. The backend agrees and
  // refuses nothing up front either: `guard_ai_request` judges only
  // `active_provider_endpoint()`, which is `None` here.
  //
  // Refusing instead broke the local fallback outright. On a fresh install
  // with Ollama running on loopback and offline mode on, nothing selects a
  // provider — `set_ai_api_key` auto-selects only when a KEY is stored, and
  // Ollama and LM Studio need none — so every AI affordance was hidden behind
  // a refusal naming a cloud risk that could not arise.
  if (!provider) return null;

  // A local provider is NOT waved through on its name. Its requests normally
  // never leave the machine, and the loopback carve-out below permits them for
  // that reason — but the AI config can point Ollama or LM Studio at any host,
  // and the backend judges the endpoint with no per-provider exception
  // (`guard_ai_request`). Passing on the name permitted exactly what the
  // backend refuses, so the two gates disagreed about one request.
  //
  // `resolveProviderEndpoint` returns the empty string when the provider
  // reports NO endpoint (the embedded model) and null when the listing could
  // not be read at all, so `??` falls back only in the second case — an empty
  // endpoint is an answer, and the same answer the backend's `guard_endpoint`
  // treats as "nothing to reach". The second `??` still matters: a provider
  // this build has never heard of (a newer Rust variant) has no entry in the
  // default table, and an unknown destination fails closed.
  const resolved = await resolveProviderEndpoint(provider);
  const endpoint = resolved ?? (PROVIDER_DEFAULT_ENDPOINTS[provider] ?? null);
  // The same loopback carve-out the backend's `guard_endpoint` makes, applied
  // before the host is judged. This is what keeps a locally hosted model usable
  // with offline mode on, which is the whole point of running one.
  if (endpoint !== null && isLoopbackEndpoint(endpoint)) return null;
  const reason = await checkOutboundHostAllowed(endpoint);
  if (!reason) return null;
  return aiBlockedResult<T>(reason === 'allowlist' ? 'allowlist' : 'offline', provider, endpoint);
}

/**
 * The endpoint the active provider will really be contacted at.
 *
 * The AI config can point any provider somewhere else — a corporate gateway,
 * an OpenAI-compatible server on this machine — and the BACKEND gate judges
 * exactly that value (`guard_ai_request` -> `guard_endpoint(endpoint_for(pt))`,
 * `src-tauri/src/commands/ai.rs`). This gate judged the fixed default host
 * instead, so it refused while naming a host the request would never contact,
 * and under offline mode a local gateway had no workaround at all even though
 * `resolve_provider` would have served it.
 *
 * `get_ai_providers` reports it: `AiProviderInfo.endpoint` is filled in from
 * the config, or the provider's default, for every provider unconditionally
 * (`get_providers_info`, `src-tauri/src/services/ai/mod.rs`). It is also not a
 * probe in the state this gate runs in: that same function sets `probed` from
 * `provider_network_allowed` and skips `is_available` / `list_models` entirely
 * for any provider the security settings forbid reaching. A provider the
 * policy DOES permit may still be probed — a round trip to a destination
 * already judged allowed, never a request the policy forbids.
 *
 * Returns the empty string when the provider reports NO endpoint at all (the
 * embedded model), which is an answer and matches the empty-endpoint carve-out
 * `guard_endpoint` makes. Returns null only when the listing could not be read
 * or does not mention the provider; the caller then falls back to
 * [`PROVIDER_DEFAULT_ENDPOINTS`], which is all this gate ever had.
 */
async function resolveProviderEndpoint(provider: AiProviderType): Promise<string | null> {
  const listing = await getAiProviders();
  if (!listing.success || !Array.isArray(listing.data)) return null;
  const info = listing.data.find((entry) => entry.providerType === provider);
  // Absent from the listing is "unknown", the same as no listing at all. An
  // entry whose endpoint is empty is an ANSWER — the embedded model has none —
  // so it is returned as `''` rather than collapsed into null, which would send
  // the caller to the default table for a provider that just told it the truth.
  if (!info) return null;
  return info.endpoint?.trim() ?? '';
}

/**
 * An endpoint that never leaves this machine, mirroring `guard_endpoint` in
 * `src-tauri/src/services/security.rs`: an empty endpoint is the embedded
 * model, which has none at all, and a loopback host opens no socket that
 * leaves the machine — so neither offline mode nor a list of remote HOSTS has
 * anything to say about it. Without this, a provider pointed at an
 * OpenAI-compatible server on localhost was refused here and permitted there,
 * which is the two gates disagreeing about one endpoint.
 */
function isLoopbackEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim();
  if (!trimmed) return true;
  const host = endpointHost(trimmed);
  // Unparseable, or a URL with no host at all: not something that can be shown
  // to stay on this machine, so it does not get the carve-out.
  if (!host) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    // 127.0.0.0/8, the whole of it — `is_loopback()` on the Rust side.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The host an endpoint string names, lower-cased and without IPv6 brackets, or
 * the empty string when it names none. `URL` keeps an IPv6 literal in its
 * brackets; the Rust side strips them too.
 */
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

/** The security policy that is refusing to reach a provider right now. */
export type AiProviderBlockReason = 'offline' | 'allowlist';

/** The slice of settings that decides whether a provider may be reached. */
export type AiNetworkPolicy = Pick<SettingsState, 'offlineMode' | 'remoteAllowlist'>;

/**
 * Which security policy currently forbids reaching `endpoint`, or `null` when
 * neither does.
 *
 * This is an EXPLAINER, not a gate — `checkAiNetworkAllowed` above is still the
 * only thing that decides whether a request may go out, and it resolves the
 * provider's real endpoint over IPC first. This one answers the question the
 * Settings list has to answer for an already-fetched `AiProviderInfo`: the
 * backend reports `probed: false` for EITHER policy (`provider_network_allowed`
 * -> `security::endpoint_allowed`, `src-tauri/src/services/ai/mod.rs`) and
 * never says which, so the caller has to work it out — and it has to work BOTH
 * halves out from ONE evaluation of the live settings, the way
 * `avatarFetchBlockReason` and `aiBlockedResult` do. Pairing a cached backend
 * verdict with a single live flag is what made the label blame a remote
 * allowlist the user had never configured the instant offline mode went off.
 *
 * Order matches the gate: the loopback carve-out first (a locally hosted model
 * is neither policy's business), then offline mode, then the allowlist — which
 * fails CLOSED for an endpoint whose host cannot be read, exactly as
 * `checkNetworkAllowed` does.
 */
export function providerNetworkBlockReason(
  endpoint: string | null | undefined,
  policy: AiNetworkPolicy = settingsStore.getState(),
): AiProviderBlockReason | null {
  const target = (endpoint ?? '').trim();
  if (isLoopbackEndpoint(target)) return null;
  if (policy.offlineMode) return 'offline';
  // `allowlistPermits` is the shared host-matching rule (an empty list permits
  // everything, a parent domain permits its subdomains, no substring matches);
  // it lives beside the avatar policy because that was the first surface to
  // need it outside the gate, and a second copy of the matching is precisely
  // how these two came to disagree before.
  return allowlistPermits(endpointHost(target), policy.remoteAllowlist) ? null : 'allowlist';
}

/**
 * Get all AI providers with their status
 *
 * Deliberately ungated: this is how Settings lists the providers and how the
 * user reaches the controls that turn a cloud provider off. Blocking it would
 * make offline mode hide the way out of offline mode.
 */
export async function getAiProviders(): Promise<CommandResult<AiProviderInfo[]>> {
  return invokeCommand<AiProviderInfo[]>('get_ai_providers');
}

/**
 * Get the currently active AI provider
 */
export async function getActiveAiProvider(): Promise<CommandResult<AiProviderType | null>> {
  return invokeCommand<AiProviderType | null>('get_active_ai_provider');
}

/**
 * Set the active AI provider
 */
export async function setAiProvider(
  providerType: AiProviderType
): Promise<CommandResult<void>> {
  return invokeCommand<void>('set_ai_provider', { providerType });
}

/**
 * Set API key for a provider
 */
export async function setAiApiKey(
  providerType: AiProviderType,
  apiKey: string | null
): Promise<CommandResult<void>> {
  return invokeCommand<void>('set_ai_api_key', { providerType, apiKey });
}

/**
 * Set the model for a provider
 */
export async function setAiModel(
  providerType: AiProviderType,
  model: string | null
): Promise<CommandResult<void>> {
  return invokeCommand<void>('set_ai_model', { providerType, model });
}

/**
 * Test if a provider is available
 *
 * Gated on the provider *named here*, not the active one: "Test" on the OpenAI
 * row reaches OpenAI whatever is selected elsewhere in Settings.
 */
export async function testAiProvider(
  providerType: AiProviderType
): Promise<CommandResult<boolean>> {
  const blocked = await checkAiNetworkAllowed<boolean>(providerType);
  if (blocked) return blocked;
  return invokeCommand<boolean>('test_ai_provider', { providerType });
}

/**
 * Auto-detect available local AI providers (Ollama, LM Studio)
 *
 * Deliberately ungated: `auto_detect_providers` probes only Ollama and LM
 * Studio, both of which listen on localhost. Nothing here leaves the machine,
 * and gating it would break the one path that finds the local providers a
 * user is meant to fall back to while offline.
 */
export async function autoDetectAiProviders(): Promise<CommandResult<AiProviderType[]>> {
  return invokeCommand<AiProviderType[]>('auto_detect_ai_providers');
}

/**
 * Generate a commit message from staged changes
 */
export async function generateCommitMessage(
  repoPath: string
): Promise<CommandResult<GeneratedCommitMessage>> {
  const blocked = await checkAiNetworkAllowed<GeneratedCommitMessage>();
  if (blocked) return blocked;
  return invokeCommand<GeneratedCommitMessage>('generate_commit_message', {
    repoPath,
  });
}

/**
 * Suggest a conflict resolution using AI
 */
export async function suggestConflictResolution(
  filePath: string,
  oursContent: string,
  theirsContent: string,
  baseContent?: string,
  contextBefore?: string,
  contextAfter?: string,
): Promise<CommandResult<ConflictResolutionSuggestion>> {
  const blocked = await checkAiNetworkAllowed<ConflictResolutionSuggestion>();
  if (blocked) return blocked;
  return invokeCommand<ConflictResolutionSuggestion>('suggest_conflict_resolution', {
    filePath,
    oursContent,
    theirsContent,
    baseContent: baseContent ?? null,
    contextBefore: contextBefore ?? null,
    contextAfter: contextAfter ?? null,
  });
}

/**
 * Generated changelog result
 */
export interface GeneratedChangelog {
  content: string;
}

/**
 * Generate a changelog from commits between two refs
 */
export async function generateChangelog(
  repoPath: string,
  baseRef: string,
  compareRef: string,
  maxCommits?: number,
): Promise<CommandResult<GeneratedChangelog>> {
  const blocked = await checkAiNetworkAllowed<GeneratedChangelog>();
  if (blocked) return blocked;
  return invokeCommand<GeneratedChangelog>('generate_changelog', {
    repoPath,
    baseRef,
    compareRef,
    maxCommits: maxCommits ?? null,
  });
}

// ========================================================================
// Phase 3: "Local Bouncer" types and functions
// ========================================================================

export type FindingCategory = 'secret' | 'complexity' | 'quality';
export type FindingSeverity = 'info' | 'warning' | 'error';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface AnalysisFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  filePath: string | null;
}

export interface StagedAnalysis {
  findings: AnalysisFinding[];
  summary: string;
  riskLevel: RiskLevel;
  /** Whether the AI half of the check ran and parsed. False means the result
   *  is the regex secret scan alone. */
  aiAnalysisRan: boolean;
  /** Why the AI pass did not run, when it did not. */
  aiError: string | null;
}

export interface GeneratedPrDescription {
  body: string;
}

export interface CommitGroup {
  label: string;
  files: string[];
  suggestedMessage: string;
}

export interface CommitSplitSuggestion {
  shouldSplit: boolean;
  groups: CommitGroup[];
  explanation: string;
}

/**
 * Analyze staged changes for secrets, complexity, and quality issues
 */
export async function analyzeStagedChanges(
  repoPath: string,
): Promise<CommandResult<StagedAnalysis>> {
  const blocked = await checkAiNetworkAllowed<StagedAnalysis>();
  if (blocked) return blocked;
  return invokeCommand<StagedAnalysis>('analyze_staged_changes', { repoPath });
}

/**
 * Generate a PR description from branch commits
 */
export async function generatePrDescription(
  repoPath: string,
  baseRef: string,
  headRef: string,
  title: string,
): Promise<CommandResult<GeneratedPrDescription>> {
  const blocked = await checkAiNetworkAllowed<GeneratedPrDescription>();
  if (blocked) return blocked;
  return invokeCommand<GeneratedPrDescription>('generate_pr_description', {
    repoPath,
    baseRef,
    headRef,
    title,
  });
}

/**
 * Suggest splitting staged changes into multiple commits
 */
export async function suggestCommitSplits(
  repoPath: string,
): Promise<CommandResult<CommitSplitSuggestion>> {
  const blocked = await checkAiNetworkAllowed<CommitSplitSuggestion>();
  if (blocked) return blocked;
  return invokeCommand<CommitSplitSuggestion>('suggest_commit_splits', { repoPath });
}

// ========================================================================
// Phase 4: "Rebase Pilot" types and functions
// ========================================================================

export interface ConflictExplanation {
  explanation: string;
  oursSummary: string;
  theirsSummary: string;
}

export interface ReflogMatch {
  index: number;
  description: string;
}

/**
 * Explain why a conflict occurred in plain language
 */
export async function explainConflict(
  filePath: string,
  oursContent: string,
  theirsContent: string,
  baseContent?: string,
  ourRef?: string,
  theirRef?: string,
): Promise<CommandResult<ConflictExplanation>> {
  const blocked = await checkAiNetworkAllowed<ConflictExplanation>();
  if (blocked) return blocked;
  return invokeCommand<ConflictExplanation>('explain_conflict', {
    filePath,
    oursContent,
    theirsContent,
    baseContent: baseContent ?? null,
    ourRef: ourRef ?? null,
    theirRef: theirRef ?? null,
  });
}

/**
 * Find a reflog entry matching a natural language query
 */
export async function findReflogEntry(
  repoPath: string,
  query: string,
): Promise<CommandResult<ReflogMatch>> {
  const blocked = await checkAiNetworkAllowed<ReflogMatch>();
  if (blocked) return blocked;
  return invokeCommand<ReflogMatch>('find_reflog_entry', { repoPath, query });
}

/**
 * Check if AI is available (provider configured and working)
 *
 * Gated as well as the generation calls, for two reasons: `is_ai_available`
 * asks the active provider whether it is reachable, and for an
 * OpenAI-compatible cloud provider that is itself an outbound request; and a
 * surface that offers "Generate" while the gate is guaranteed to refuse it is
 * a button that exists only to fail. Blocked reads as unavailable, and
 * `getAiUnavailableReason` says why.
 */
export async function isAiAvailable(): Promise<boolean> {
  if (await checkAiNetworkAllowed()) return false;
  const result = await invokeCommand<boolean>('is_ai_available');
  return result.success && result.data === true;
}

/** Why AI is unavailable, mirroring the Rust `AiUnavailable`. */
export interface AiUnavailable {
  /** Human-readable reason, naming the provider when one is at fault. */
  reason: string;
  /**
   * True when a provider is chosen in Settings but unreachable, rather than no
   * provider being configured at all. A surface that hides its AI affordances
   * when AI was never set up still shows them, disabled, in this case — they
   * worked before and the user needs to know why they stopped.
   */
  providerSelected: boolean;
}

/**
 * Why AI is unavailable, or null when it is usable.
 *
 * `isAiAvailable()` only says yes/no. When it says no, the provider selected in
 * Settings may simply be unreachable — and since a selected provider is never
 * substituted, the UI has to name it rather than claim nothing is configured.
 */
export async function getAiUnavailableReason(): Promise<AiUnavailable | null> {
  const blocked = await checkAiNetworkAllowed();
  if (blocked) {
    // `providerSelected: true` keeps the AI affordances visible-but-disabled
    // rather than hidden: they worked a moment ago and the user needs to see
    // which setting stopped them.
    return { reason: blocked.error?.message ?? 'Blocked by security settings', providerSelected: true };
  }
  const result = await invokeCommand<AiUnavailable | null>('ai_unavailable_reason');
  return result.success ? (result.data ?? null) : null;
}

/**
 * Get display name for a provider type
 */
export function getProviderDisplayName(providerType: AiProviderType): string {
  switch (providerType) {
    case 'ollama':
      return 'Ollama';
    case 'lm_studio':
      return 'LM Studio';
    case 'open_ai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic Claude';
    case 'github_copilot':
      return 'GitHub Models';
    case 'google_gemini':
      return 'Google Gemini';
    case 'local_inference':
      return 'Local AI (Embedded)';
  }
}

/**
 * Check if a provider requires an API key
 */
export function providerRequiresApiKey(providerType: AiProviderType): boolean {
  return providerType === 'open_ai' || providerType === 'anthropic' || providerType === 'github_copilot' || providerType === 'google_gemini';
}
