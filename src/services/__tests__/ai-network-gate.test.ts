/**
 * Exhaustive guard on the AI security gate's coverage.
 *
 * Offline mode says it blocks "every operation that leaves this machine", and
 * every git and hosting-provider call honours that (see
 * network-gate-coverage.test.ts). The AI service did not: with OpenAI,
 * Anthropic, Gemini or GitHub Models selected, generating a commit message
 * posted the staged diff, the changelog posted the commit history and conflict
 * help posted both sides of the file — while the toggle said the app was
 * offline.
 *
 * Like its git counterpart this sweeps EVERY exported function rather than a
 * hand-written list, so a new provider-reaching call fails the test without
 * anyone having to remember to register it.
 */

type MockInvoke = (command: string, args?: unknown) => Promise<unknown>;
const invoked: string[] = [];
let activeProvider: string | null = null;
/**
 * What `get_ai_providers` reports. The gate reads the ACTIVE provider's real
 * `endpoint` from here, because the AI config can point any provider at a
 * corporate gateway or an OpenAI-compatible server on this machine and the
 * backend gate judges exactly that value.
 */
let providerListing: Array<{ providerType: string; endpoint: string }> = [];

(globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: ((command: string) => {
    invoked.push(command);
    if (command === 'get_active_ai_provider') return Promise.resolve(activeProvider);
    if (command === 'get_ai_providers') return Promise.resolve(providerListing);
    if (command === 'auto_detect_ai_providers') return Promise.resolve([]);
    if (command === 'is_ai_available') return Promise.resolve(true);
    return Promise.resolve(null);
  }) as MockInvoke,
  transformCallback: () => 0,
};

import { expect } from '@open-wc/testing';
import * as aiService from '../ai.service.ts';
import type { AiProviderType } from '../ai.service.ts';
import { settingsStore } from '../../stores/settings.store.ts';

/**
 * Tauri commands that reach whichever AI provider is configured. Each either
 * ships repository content to it (diffs, commit history, conflict text) or
 * asks it whether it is reachable — for an OpenAI-compatible cloud provider
 * that probe is itself an outbound request carrying the API key.
 */
const PROVIDER_COMMANDS = new Set([
  'generate_commit_message',
  'suggest_conflict_resolution',
  'generate_changelog',
  'analyze_staged_changes',
  'generate_pr_description',
  'suggest_commit_splits',
  'explain_conflict',
  'find_reflog_entry',
  'test_ai_provider',
  'is_ai_available',
  'ai_unavailable_reason',
]);

/**
 * Commands that must NEVER be gated. `get_ai_providers` is how Settings lists
 * the providers — blocking it would make offline mode hide the way out of
 * offline mode — and `auto_detect_ai_providers` probes only Ollama and LM
 * Studio, both on localhost. The setters and the active-provider read touch a
 * local config file.
 */
const LOCAL_COMMANDS = new Set([
  'get_ai_providers',
  'get_active_ai_provider',
  'set_ai_provider',
  'set_ai_api_key',
  'set_ai_model',
  'auto_detect_ai_providers',
]);

const CLOUD_PROVIDERS: AiProviderType[] = [
  'open_ai',
  'anthropic',
  'github_copilot',
  'google_gemini',
];
const LOCAL_PROVIDERS: AiProviderType[] = ['ollama', 'lm_studio', 'local_inference'];

/**
 * Arguments wide enough to get every exported function to its invoke. The
 * first is the provider under test so `testAiProvider` — the one function
 * gated on a provider it is *given* rather than the active one — is exercised
 * for the same provider as the rest of the sweep.
 */
function argsFor(provider: AiProviderType | null): unknown[] {
  return [provider ?? 'ollama', 'main', 'feature', 'title', 'base', 'head'];
}

/** Call every exported ai.service function; return the commands they reached. */
async function sweep(provider: AiProviderType | null): Promise<Set<string>> {
  const reached = new Set<string>();
  for (const [, value] of Object.entries(aiService)) {
    if (typeof value !== 'function') continue;
    invoked.length = 0;
    try {
      await (value as (...a: unknown[]) => unknown)(...argsFor(provider));
    } catch {
      // A rejected call is fine — it certainly didn't reach a provider.
    }
    for (const c of invoked) reached.add(c);
  }
  return reached;
}

describe('AI provider network gate', () => {
  beforeEach(() => {
    activeProvider = null;
    providerListing = [];
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  afterEach(() => {
    activeProvider = null;
    providerListing = [];
    settingsStore.setState({ offlineMode: false, confirmNetworkOps: false, remoteAllowlist: [] });
  });

  for (const provider of CLOUD_PROVIDERS) {
    it(`offline mode stops every exported function reaching ${provider}`, async () => {
      activeProvider = provider;
      settingsStore.setState({ offlineMode: true });

      const reached = await sweep(provider);
      const leaked = [...reached].filter((c) => PROVIDER_COMMANDS.has(c));

      expect(leaked, `these reached ${provider} with offline mode on`).to.deep.equal([]);
    });
  }

  for (const provider of LOCAL_PROVIDERS) {
    it(`offline mode leaves ${provider} working`, async () => {
      // Ollama and LM Studio listen on localhost and local inference runs
      // in-process. Refusing them would break the very providers a user is
      // meant to fall back to while offline.
      activeProvider = provider;
      settingsStore.setState({ offlineMode: true });

      const reached = await sweep(provider);
      const missing = [...PROVIDER_COMMANDS].filter((c) => !reached.has(c));

      expect(missing, `${provider} is local and must not be gated`).to.deep.equal([]);
    });
  }

  it('a cloud provider still works when offline mode is off', async () => {
    // Guards the test itself: if the sweep stopped exercising anything, the
    // assertions above would pass vacuously.
    activeProvider = 'open_ai';

    const reached = await sweep('open_ai');
    const missing = [...PROVIDER_COMMANDS].filter((c) => !reached.has(c));

    expect(missing, 'nothing is blocked when no policy is in force').to.deep.equal([]);
  });

  it('never gates the commands that stay on this machine', async () => {
    settingsStore.setState({ offlineMode: true, remoteAllowlist: ['example.test'] });
    activeProvider = 'open_ai';

    const reached = await sweep('open_ai');
    const missing = [...LOCAL_COMMANDS].filter((c) => !reached.has(c));

    expect(missing, 'these never leave the machine and must not be gated').to.deep.equal([]);
  });

  it('a command cannot be both local and provider-reaching', () => {
    const both = [...LOCAL_COMMANDS].filter((c) => PROVIDER_COMMANDS.has(c));
    expect(both).to.deep.equal([]);
  });

  it('an allowlist that omits the provider host refuses it', async () => {
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'open_ai';

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
    expect(result.error?.message).to.contain('allowlist');
    expect(invoked.includes('generate_commit_message')).to.equal(false);
  });

  it('an allowlist that names the provider host permits it', async () => {
    settingsStore.setState({ remoteAllowlist: ['api.openai.com'] });
    activeProvider = 'open_ai';

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('an allowlist does not touch a local provider', async () => {
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'ollama';

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  /**
   * With nothing chosen the backend refuses nothing up front — `guard_ai_request`
   * judges `active_provider_endpoint()`, which is `None` — because
   * `resolve_provider` tries the embedded model first and then SKIPS every
   * provider whose endpoint the security settings forbid. A fallback request
   * therefore cannot reach a destination this gate would have refused.
   *
   * Refusing here instead broke the local fallback outright: on a fresh install
   * with Ollama on loopback and offline mode on, nothing selects a provider
   * (`set_ai_api_key` auto-selects only when a KEY is stored, and Ollama and LM
   * Studio need none), so every AI affordance was hidden behind a refusal
   * naming a cloud risk that could not arise.
   */
  it('permits the local fallback when offline and no provider is selected', async () => {
    settingsStore.setState({ offlineMode: true });
    activeProvider = null;

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'the backend resolves a permitted provider itself').to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
    expect(await aiService.isAiAvailable(), 'the AI affordances stay usable').to.equal(true);
  });

  it('permits the fallback when an allowlist is configured and no provider is selected', async () => {
    // Same rule on the allowlist side: `resolve_provider` skips every provider
    // whose host the allowlist omits, so there is nothing to refuse up front.
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = null;

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('allows an unselected provider when no policy is in force', async () => {
    activeProvider = null;

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('does not ask for the active provider when no policy is in force', async () => {
    // The gate costs one local IPC read per AI call; it must not spend it when
    // nothing could refuse the call anyway.
    activeProvider = 'open_ai';

    invoked.length = 0;
    await aiService.generateCommitMessage('/repo');

    expect(invoked.includes('get_active_ai_provider')).to.equal(false);
  });

  /**
   * A provider's endpoint is configurable, and the BACKEND gate judges the
   * configured value (`guard_ai_request` -> `guard_endpoint(endpoint_for(pt))`
   * in src-tauri/src/commands/ai.rs). This gate judged a fixed table of
   * default hosts, so it refused while naming a host the request would never
   * contact — and offline mode left no workaround at all for a gateway on this
   * machine, which `resolve_provider` would happily have used.
   */
  it('judges a provider on its configured endpoint, not its default host', async () => {
    settingsStore.setState({ remoteAllowlist: ['gateway.internal'] });
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: 'https://gateway.internal/v1' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'the allowlist names the host this request reaches').to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('offline mode permits a provider pointed at this machine', async () => {
    // The same loopback carve-out `guard_endpoint` makes on the Rust side.
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: 'http://localhost:8080/v1' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'an OpenAI-compatible server on localhost opens no outbound socket')
      .to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('a configured endpoint that does leave the machine is still refused', async () => {
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: 'https://gateway.example.test/v1' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
    expect(invoked.includes('generate_commit_message')).to.equal(false);
  });

  it('names the endpoint the request would have reached', async () => {
    // Telling the user to allowlist api.openai.com when the config points at a
    // gateway sends them to a domain the request never contacts.
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: 'https://gateway.example.test/v1' }];

    const result = await aiService.generateCommitMessage('/repo');

    expect(result.error?.message).to.contain('gateway.example.test');
    expect(result.error?.message).to.not.contain('api.openai.com');
  });

  it('falls back to the default endpoint when the listing cannot be read', async () => {
    // The listing can fail, and it can omit a provider. Either way the gate
    // must still fail closed, on the default endpoint it does know — which is
    // all it ever had before.
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'open_ai';
    providerListing = [];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success).to.equal(false);
    expect(result.error?.message).to.contain('api.openai.com');
    expect(invoked.includes('generate_commit_message')).to.equal(false);
  });

  it('treats an endpoint the backend calls none as none too', async () => {
    // `endpoint_for` returns the configured value when there is one, and
    // `guard_endpoint` permits an empty one — "nothing to reach". Falling back
    // to the default host here instead would refuse a request the backend
    // permits, which is the two gates disagreeing about one endpoint.
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: '   ' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'an empty endpoint reaches nothing').to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  /**
   * A local provider is permitted because its ENDPOINT is on this machine, not
   * because of its name. The gate used to return early on the name, so an
   * Ollama or LM Studio endpoint pointed at a corporate gateway was permitted
   * here and refused by the backend, which judges the endpoint with no
   * per-provider carve-out at all (`guard_ai_request` ->
   * `guard_endpoint(active_provider_endpoint())`).
   */
  it('refuses a local provider pointed off this machine', async () => {
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'https://ollama.corp.example' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'this Ollama is not on this machine').to.equal(false);
    expect(result.error?.code).to.equal('BLOCKED');
    expect(invoked.includes('generate_commit_message')).to.equal(false);
  });

  it('says what is actually wrong when a local provider points elsewhere', async () => {
    // "Select a local provider" would name the one already selected.
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'https://ollama.corp.example' }];

    const result = await aiService.generateCommitMessage('/repo');

    expect(result.error?.message).to.contain('ollama.corp.example');
    expect(result.error?.message).to.not.contain('is a cloud AI provider');
  });

  it('does not tell a local-provider user to select a local provider', async () => {
    // The offline branch was split for exactly this reason in an earlier
    // round; the allowlist branch beside it still ended in "select a local
    // provider" while Ollama — a local provider — was the one selected.
    settingsStore.setState({ remoteAllowlist: ['github.com'] });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'https://ollama.corp.example' }];

    const result = await aiService.generateCommitMessage('/repo');

    expect(result.error?.code).to.equal('BLOCKED');
    expect(result.error?.message).to.contain('ollama.corp.example');
    expect(result.error?.message, 'Ollama IS the local provider').to.not.contain(
      'select a local provider',
    );
  });

  it('names a remedy that exists when a local provider points off this machine', async () => {
    // There is no endpoint control anywhere in the app: no `set_ai_endpoint`
    // command beside set_ai_provider / set_ai_api_key / set_ai_model, and no
    // field for it in the settings dialog. "Point it back at this machine in
    // Settings > AI" sent the user looking for something that does not exist —
    // the endpoint lives in ai_config.json, and removing it there restores the
    // provider's loopback default (`endpoint_for`).
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'https://ollama.corp.example' }];

    const offline = await aiService.generateCommitMessage('/repo');
    expect(offline.error?.message).to.contain('ai_config.json');
    expect(offline.error?.message, 'no such setting exists').to.not.contain('Settings > AI');

    settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });
    const allowlisted = await aiService.generateCommitMessage('/repo');
    expect(allowlisted.error?.message).to.contain('ai_config.json');
    expect(allowlisted.error?.message, 'no such setting exists').to.not.contain('Settings > AI');
  });

  it('judges a local provider against the allowlist on its endpoint', async () => {
    settingsStore.setState({ remoteAllowlist: ['ollama.corp.example'] });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'https://ollama.corp.example' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'the allowlist names the host this request reaches')
      .to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('still permits a local provider on its own loopback endpoint', async () => {
    // The guard against a rule that refuses every local provider.
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'ollama';
    providerListing = [{ providerType: 'ollama', endpoint: 'http://localhost:11434' }];

    invoked.length = 0;
    const result = await aiService.generateCommitMessage('/repo');

    expect(result.success, 'Ollama on localhost opens no outbound socket').to.not.equal(false);
    expect(invoked.includes('generate_commit_message')).to.equal(true);
  });

  it('does not list the providers when no policy is in force', async () => {
    // The endpoint lookup is a round trip; it must not be spent when nothing
    // could refuse the call anyway.
    activeProvider = 'open_ai';
    providerListing = [{ providerType: 'open_ai', endpoint: 'https://api.openai.com/v1' }];

    invoked.length = 0;
    await aiService.generateCommitMessage('/repo');

    expect(invoked.includes('get_ai_providers')).to.equal(false);
  });

  it('gates testAiProvider on the provider it is given, not the active one', async () => {
    // "Test" on the OpenAI row reaches OpenAI whatever is selected elsewhere.
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'ollama';

    invoked.length = 0;
    const blocked = await aiService.testAiProvider('open_ai');
    expect(blocked.success).to.equal(false);
    expect(blocked.error?.code).to.equal('BLOCKED');
    expect(invoked.includes('test_ai_provider')).to.equal(false);

    invoked.length = 0;
    const allowed = await aiService.testAiProvider('ollama');
    expect(allowed.success).to.not.equal(false);
    expect(invoked.includes('test_ai_provider')).to.equal(true);
  });

  it('names the provider and the way out in the refusal', async () => {
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'anthropic';

    const result = await aiService.generateChangelog('/repo', 'v1', 'HEAD');

    expect(result.error?.message).to.contain('Anthropic Claude');
    expect(result.error?.message).to.contain('Offline mode');
    expect(result.error?.message).to.contain('Settings');
  });

  it('reports AI as unavailable, with a reason, while blocked', async () => {
    settingsStore.setState({ offlineMode: true });
    activeProvider = 'open_ai';

    expect(await aiService.isAiAvailable()).to.equal(false);

    const reason = await aiService.getAiUnavailableReason();
    expect(reason?.reason).to.contain('Offline mode');
    // Selected-but-unreachable keeps the AI buttons visible and disabled with
    // an explanation, instead of hiding them as "never configured".
    expect(reason?.providerSelected).to.equal(true);
  });

  it('classifies every provider as cloud or local exactly once', () => {
    const all: AiProviderType[] = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS];
    expect(all.filter((p) => aiService.isCloudAiProvider(p))).to.deep.equal(CLOUD_PROVIDERS);
    expect(all.filter((p) => !aiService.isCloudAiProvider(p))).to.deep.equal(LOCAL_PROVIDERS);
  });
});

/**
 * The explainer beside the gate.
 *
 * `AiProviderInfo.probed` is false for EITHER policy and the backend never says
 * which, so Settings has to work it out — and it must work BOTH halves out from
 * one evaluation of the live settings. Reading one policy from a live flag and
 * the other by elimination is what made the provider label blame a remote
 * allowlist the user had never configured the instant offline mode went off.
 *
 * This is not a gate and must never be used as one: it judges the endpoint the
 * listing already reported, where `checkAiNetworkAllowed` resolves it first.
 */
describe('providerNetworkBlockReason', () => {
  const CLOUD = 'https://api.openai.com/v1';

  it('blames offline mode while offline mode is on', () => {
    expect(
      aiService.providerNetworkBlockReason(CLOUD, { offlineMode: true, remoteAllowlist: [] }),
    ).to.equal('offline');
  });

  // Offline mode first, exactly as the gate orders them: it is the setting the
  // user has to undo first, and naming the allowlist instead would send them to
  // a field that would change nothing.
  it('blames offline mode ahead of the allowlist when both would refuse', () => {
    expect(
      aiService.providerNetworkBlockReason(CLOUD, {
        offlineMode: true,
        remoteAllowlist: ['github.com'],
      }),
    ).to.equal('offline');
  });

  it('blames the allowlist only when one is configured and excludes the host', () => {
    expect(
      aiService.providerNetworkBlockReason(CLOUD, {
        offlineMode: false,
        remoteAllowlist: ['github.com'],
      }),
    ).to.equal('allowlist');
    expect(
      aiService.providerNetworkBlockReason(CLOUD, {
        offlineMode: false,
        remoteAllowlist: ['api.openai.com'],
      }),
    ).to.equal(null);
    // A parent domain permits its subdomains, the same rule the gate applies.
    expect(
      aiService.providerNetworkBlockReason(CLOUD, {
        offlineMode: false,
        remoteAllowlist: ['openai.com'],
      }),
    ).to.equal(null);
    // ...and a look-alike does not pass on a substring.
    expect(
      aiService.providerNetworkBlockReason('https://api.openai.com.evil.test/v1', {
        offlineMode: false,
        remoteAllowlist: ['openai.com'],
      }),
    ).to.equal('allowlist');
  });

  it('blames neither policy when neither is in force', () => {
    expect(
      aiService.providerNetworkBlockReason(CLOUD, { offlineMode: false, remoteAllowlist: [] }),
    ).to.equal(null);
  });

  // The same loopback and empty-endpoint carve-outs `guard_endpoint` makes: a
  // model hosted on this machine opens no socket that leaves it, so neither
  // setting has anything to say about it.
  it('never blames a policy for an endpoint that never leaves the machine', () => {
    const blocking = { offlineMode: true, remoteAllowlist: ['github.com'] };
    for (const endpoint of ['http://localhost:11434', 'http://127.0.0.1:1234', '', null, undefined]) {
      expect(aiService.providerNetworkBlockReason(endpoint, blocking)).to.equal(null);
    }
  });

  // Fails CLOSED, exactly as `checkNetworkAllowed` does for a destination it
  // cannot read: an allowlist that cannot see the host must refuse.
  it('refuses an unreadable endpoint once an allowlist is configured', () => {
    expect(
      aiService.providerNetworkBlockReason('https://', {
        offlineMode: false,
        remoteAllowlist: ['github.com'],
      }),
    ).to.equal('allowlist');
    // ...and permits it when no allowlist is configured, which is what an
    // empty list means everywhere else.
    expect(
      aiService.providerNetworkBlockReason('https://', {
        offlineMode: false,
        remoteAllowlist: [],
      }),
    ).to.equal(null);
  });

  it('reads the live settings store when no policy is passed', () => {
    settingsStore.setState({ offlineMode: true, remoteAllowlist: [] });
    try {
      expect(aiService.providerNetworkBlockReason(CLOUD)).to.equal('offline');
      settingsStore.setState({ offlineMode: false, remoteAllowlist: ['github.com'] });
      expect(aiService.providerNetworkBlockReason(CLOUD)).to.equal('allowlist');
      settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
      expect(aiService.providerNetworkBlockReason(CLOUD)).to.equal(null);
    } finally {
      settingsStore.setState({ offlineMode: false, remoteAllowlist: [] });
    }
  });
});
