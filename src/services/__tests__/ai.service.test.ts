import { expect } from '@open-wc/testing';
import type {
  AiProviderType,
  AiProviderInfo,
  GeneratedCommitMessage,
  ConflictResolutionSuggestion,
} from '../ai.service.ts';
import {
  getAiUnavailableReason,
  getProviderDisplayName,
  providerRequiresApiKey,
  suggestConflictResolution,
} from '../ai.service.ts';

// Mock Tauri API
const mockResults: Record<string, unknown> = {
  get_ai_providers: {
    success: true,
    data: [
      {
        providerType: 'ollama',
        name: 'Ollama',
        available: true,
        probed: true,
        requiresApiKey: false,
        hasApiKey: false,
        endpoint: 'http://localhost:11434',
        models: ['llama3.2', 'codellama'],
        selectedModel: 'llama3.2',
      },
      {
        providerType: 'open_ai',
        name: 'OpenAI',
        available: false,
        probed: true,
        requiresApiKey: true,
        hasApiKey: false,
        endpoint: 'https://api.openai.com/v1',
        models: [],
        selectedModel: null,
      },
    ] as AiProviderInfo[],
  },
  get_active_ai_provider: { success: true, data: 'ollama' as AiProviderType },
  set_ai_provider: { success: true, data: null },
  set_ai_api_key: { success: true, data: null },
  set_ai_model: { success: true, data: null },
  test_ai_provider: { success: true, data: true },
  auto_detect_ai_providers: { success: true, data: ['ollama'] as AiProviderType[] },
  is_ai_available: { success: true, data: true },
  generate_commit_message: {
    success: true,
    data: {
      summary: 'feat: add new feature',
      body: 'This commit adds a new feature that...',
    } as GeneratedCommitMessage,
  },
  suggest_conflict_resolution: {
    resolvedContent: 'merged content here',
    explanation: 'Combined both changes preserving function signatures',
  } as ConflictResolutionSuggestion,
};

const mockInvoke = (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (Object.prototype.hasOwnProperty.call(mockResults, command)) {
    const value = mockResults[command];
    // An Error entry models a command that rejects, the way Tauri surfaces a
    // Rust `Err` — distinct from a command that resolves with `null`.
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }
  return Promise.resolve({ success: false, error: 'Unknown command' });
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

describe('AI Service Types', () => {
  describe('AiProviderType', () => {
    it('should have correct display names', () => {
      expect(getProviderDisplayName('ollama')).to.equal('Ollama');
      expect(getProviderDisplayName('lm_studio')).to.equal('LM Studio');
      expect(getProviderDisplayName('open_ai')).to.equal('OpenAI');
      expect(getProviderDisplayName('anthropic')).to.equal('Anthropic Claude');
      expect(getProviderDisplayName('github_copilot')).to.equal('GitHub Models');
      expect(getProviderDisplayName('google_gemini')).to.equal('Google Gemini');
      expect(getProviderDisplayName('local_inference')).to.equal('Local AI (Embedded)');
    });

    it('should correctly identify API key requirements', () => {
      expect(providerRequiresApiKey('ollama')).to.be.false;
      expect(providerRequiresApiKey('lm_studio')).to.be.false;
      expect(providerRequiresApiKey('open_ai')).to.be.true;
      expect(providerRequiresApiKey('anthropic')).to.be.true;
      expect(providerRequiresApiKey('github_copilot')).to.be.true;
      expect(providerRequiresApiKey('google_gemini')).to.be.true;
      expect(providerRequiresApiKey('local_inference')).to.be.false;
    });
  });

  describe('AiProviderType wire contract', () => {
    // The exact strings serde emits for the Rust AiProviderType enum
    // (`#[serde(rename_all = "snake_case")]`). Keep in sync with the Rust
    // guard test `test_ai_provider_type_serialization`.
    const wireProviderTypes: AiProviderType[] = [
      'ollama',
      'lm_studio',
      'open_ai',
      'anthropic',
      'github_copilot',
      'google_gemini',
      'local_inference',
    ];

    it('maps every providerType the backend emits to a display name', () => {
      wireProviderTypes.forEach((type) => {
        const displayName = getProviderDisplayName(type);
        expect(displayName, `no display name for "${type}"`).to.be.a('string');
        expect(displayName, `empty display name for "${type}"`).to.not.equal('');
      });
    });

    it('agrees with the requiresApiKey flag the backend sends', () => {
      // Shaped exactly as get_ai_providers serializes its payload.
      const payload: AiProviderInfo[] = [
        {
          providerType: 'open_ai',
          name: 'OpenAI',
          available: false,
          probed: true,
          requiresApiKey: true,
          hasApiKey: true,
          endpoint: 'https://api.openai.com/v1',
          models: [],
          selectedModel: null,
        },
        {
          providerType: 'local_inference',
          name: 'Local AI (Embedded)',
          available: false,
          probed: true,
          requiresApiKey: false,
          hasApiKey: false,
          endpoint: '',
          models: [],
          selectedModel: null,
        },
      ];

      payload.forEach((provider) => {
        expect(
          providerRequiresApiKey(provider.providerType),
          `requiresApiKey mismatch for "${provider.providerType}"`,
        ).to.equal(provider.requiresApiKey);
      });
    });

    it('does not recognise the legacy openai spelling', () => {
      // 'openai' is not a value the backend can emit or deserialize, so the
      // helpers must not treat it as a known provider.
      const legacy = 'openai' as AiProviderType;
      expect(getProviderDisplayName(legacy)).to.be.undefined;
      expect(providerRequiresApiKey(legacy)).to.be.false;
    });
  });

  describe('AiProviderInfo', () => {
    it('should have correct structure for local provider', () => {
      const provider: AiProviderInfo = {
        providerType: 'ollama',
        name: 'Ollama',
        available: true,
        probed: true,
        requiresApiKey: false,
        hasApiKey: false,
        endpoint: 'http://localhost:11434',
        models: ['llama3.2', 'codellama'],
        selectedModel: 'llama3.2',
      };

      expect(provider.providerType).to.equal('ollama');
      expect(provider.available).to.be.true;
      expect(provider.requiresApiKey).to.be.false;
      expect(provider.models).to.have.length(2);
    });

    it('should have correct structure for cloud provider', () => {
      const provider: AiProviderInfo = {
        providerType: 'open_ai',
        name: 'OpenAI',
        available: false,
        probed: true,
        requiresApiKey: true,
        hasApiKey: false,
        endpoint: 'https://api.openai.com/v1',
        models: [],
        selectedModel: null,
      };

      expect(provider.providerType).to.equal('open_ai');
      expect(provider.available).to.be.false;
      expect(provider.requiresApiKey).to.be.true;
      expect(provider.hasApiKey).to.be.false;
    });

    it('should show available when API key is set', () => {
      const provider: AiProviderInfo = {
        providerType: 'anthropic',
        name: 'Anthropic Claude',
        available: true,
        probed: true,
        requiresApiKey: true,
        hasApiKey: true,
        endpoint: 'https://api.anthropic.com',
        models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'],
        selectedModel: 'claude-sonnet-4-20250514',
      };

      expect(provider.available).to.be.true;
      expect(provider.hasApiKey).to.be.true;
    });
  });

  describe('GeneratedCommitMessage', () => {
    it('should have summary only', () => {
      const message: GeneratedCommitMessage = {
        summary: 'fix: resolve null pointer exception',
        body: null,
      };

      expect(message.summary).to.equal('fix: resolve null pointer exception');
      expect(message.body).to.be.null;
    });

    it('should have summary and body', () => {
      const message: GeneratedCommitMessage = {
        summary: 'feat: add user authentication',
        body: 'Implements JWT-based authentication.\n\n- Add login endpoint\n- Add token validation\n- Add middleware',
      };

      expect(message.summary).to.include('feat:');
      expect(message.body).to.include('JWT');
      expect(message.body).to.include('login endpoint');
    });

    it('should use conventional commit prefixes', () => {
      const validPrefixes = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert'];

      validPrefixes.forEach((prefix) => {
        const message: GeneratedCommitMessage = {
          summary: `${prefix}: example message`,
          body: null,
        };
        expect(message.summary).to.match(new RegExp(`^${prefix}:`));
      });
    });
  });
});

describe('AI Service Behavior', () => {
  describe('Diff truncation', () => {
    it('should truncate long diffs', () => {
      // Max diff chars is 12000 as per ai/mod.rs
      const MAX_DIFF_CHARS = 12000;
      const longDiff = 'a'.repeat(15000);

      const truncated = longDiff.length > MAX_DIFF_CHARS
        ? `${longDiff.substring(0, MAX_DIFF_CHARS)}...\n[Diff truncated for length]`
        : longDiff;

      expect(truncated.length).to.be.lessThan(longDiff.length);
      expect(truncated).to.include('[Diff truncated for length]');
    });

    it('should not truncate short diffs', () => {
      const MAX_DIFF_CHARS = 12000;
      const shortDiff = 'a'.repeat(5000);

      const processed = shortDiff.length > MAX_DIFF_CHARS
        ? `${shortDiff.substring(0, MAX_DIFF_CHARS)}...\n[Diff truncated for length]`
        : shortDiff;

      expect(processed).to.equal(shortDiff);
    });
  });

  describe('Response parsing', () => {
    it('should split summary and body correctly', () => {
      const response = 'feat: add login feature\n\nThis implements the login feature with:\n- Form validation\n- Error handling';

      const lines = response.split('\n');
      const summary = lines[0].trim();
      const body = lines.slice(2).join('\n').trim() || null;

      expect(summary).to.equal('feat: add login feature');
      expect(body).to.include('Form validation');
      expect(body).to.include('Error handling');
    });

    it('should handle summary-only response', () => {
      const response = 'fix: typo in readme';

      const lines = response.split('\n');
      const summary = lines[0].trim();
      const body = lines.length > 2 ? lines.slice(2).join('\n').trim() : null;

      expect(summary).to.equal('fix: typo in readme');
      expect(body).to.be.null;
    });
  });
});

describe('AI Provider Workflow', () => {
  it('should check provider availability before generation', () => {
    const provider: AiProviderInfo = {
      providerType: 'open_ai',
      name: 'OpenAI',
      available: false,
      probed: true,
      requiresApiKey: true,
      hasApiKey: false,
      endpoint: 'https://api.openai.com/v1',
      models: [],
      selectedModel: null,
    };

    const canGenerate = provider.available;
    expect(canGenerate).to.be.false;
  });

  it('should enable generation when provider is available', () => {
    const provider: AiProviderInfo = {
      providerType: 'ollama',
      name: 'Ollama',
      available: true,
      probed: true,
      requiresApiKey: false,
      hasApiKey: false,
      endpoint: 'http://localhost:11434',
      models: ['llama3.2'],
      selectedModel: 'llama3.2',
    };

    const canGenerate = provider.available;
    expect(canGenerate).to.be.true;
  });

  it('should require API key for cloud providers', () => {
    const cloudProviders: AiProviderType[] = ['open_ai', 'anthropic', 'github_copilot', 'google_gemini'];
    const localProviders: AiProviderType[] = ['ollama', 'lm_studio'];

    cloudProviders.forEach((type) => {
      expect(providerRequiresApiKey(type)).to.be.true;
    });

    localProviders.forEach((type) => {
      expect(providerRequiresApiKey(type)).to.be.false;
    });
  });
});

describe('ConflictResolutionSuggestion', () => {
  it('should have correct structure', () => {
    const suggestion: ConflictResolutionSuggestion = {
      resolvedContent: 'function merged() {}',
      explanation: 'Combined both implementations',
    };

    expect(suggestion.resolvedContent).to.equal('function merged() {}');
    expect(suggestion.explanation).to.equal('Combined both implementations');
  });

  it('should allow empty explanation', () => {
    const suggestion: ConflictResolutionSuggestion = {
      resolvedContent: 'some code',
      explanation: '',
    };

    expect(suggestion.resolvedContent).to.equal('some code');
    expect(suggestion.explanation).to.equal('');
  });
});

describe('suggestConflictResolution', () => {
  it('should invoke the command and return a suggestion', async () => {
    const result = await suggestConflictResolution(
      'src/test.ts',
      'const a = 1;',
      'const a = 2;',
      'const a = 0;',
    );

    expect(result.success).to.be.true;
    expect(result.data).to.not.be.undefined;
    expect(result.data!.resolvedContent).to.equal('merged content here');
    expect(result.data!.explanation).to.include('Combined both changes');
  });

  it('should handle optional parameters', async () => {
    const result = await suggestConflictResolution(
      'src/test.ts',
      'const a = 1;',
      'const a = 2;',
    );

    expect(result.success).to.be.true;
    expect(result.data).to.not.be.undefined;
  });
});

describe('getAiUnavailableReason', () => {
  afterEach(() => {
    delete mockResults.ai_unavailable_reason;
  });

  it('returns the reason and whether a provider is selected', async () => {
    mockResults.ai_unavailable_reason = {
      reason: 'Anthropic Claude is not available. Please check its API key in Settings.',
      providerSelected: true,
    };

    const result = await getAiUnavailableReason();

    expect(result).to.not.be.null;
    expect(result!.reason).to.include('Anthropic Claude');
    expect(result!.providerSelected).to.be.true;
  });

  it('returns null when AI is usable', async () => {
    mockResults.ai_unavailable_reason = null;

    expect(await getAiUnavailableReason()).to.be.null;
  });

  it('returns null when the command fails, so the UI keeps its generic message', async () => {
    mockResults.ai_unavailable_reason = new Error('backend unreachable');

    expect(await getAiUnavailableReason()).to.be.null;
  });
});
