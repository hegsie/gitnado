/**
 * AI provider default-endpoint contract test.
 *
 * The frontend AI gate falls back to `PROVIDER_DEFAULT_ENDPOINTS` whenever the
 * provider listing cannot be read, and judges offline mode and the remote
 * allowlist on the host it finds there. The backend judges
 * `AiProviderType::default_endpoint`. Every unit test and every E2E spec mocks
 * the listing, so the fallback never runs under test and a drift between the
 * two tables shows up only in a real build — as the two gates disagreeing
 * about one request, or as a provider the frontend refuses because it has no
 * endpoint for it at all.
 *
 * This test compares the two halves directly, and fails on an arm or entry it
 * cannot read rather than skipping it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareDefaults,
  extractBackendDefaults,
  extractFrontendDefaults,
  readContract,
  serdeSnakeCase,
} from './ai-endpoint-contract.mjs';

test('renames variants the way serde does', () => {
  assert.equal(serdeSnakeCase('Ollama'), 'ollama');
  assert.equal(serdeSnakeCase('LmStudio'), 'lm_studio');
  assert.equal(serdeSnakeCase('OpenAi'), 'open_ai');
  assert.equal(serdeSnakeCase('GithubCopilot'), 'github_copilot');
  assert.equal(serdeSnakeCase('LocalInference'), 'local_inference');
});

test('reads a match arm per provider, empty endpoints included', () => {
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::OpenAi => "https://api.openai.com/v1",
            AiProviderType::LocalInference => "",
        }
    }
  `);
  assert.deepEqual(endpoints, {
    ollama: 'http://localhost:11434',
    open_ai: 'https://api.openai.com/v1',
    local_inference: '',
  });
  assert.deepEqual(unparsed, []);
});

test('reports a backend arm whose endpoint is not a literal', () => {
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::OpenAi => computed_default(),
        }
    }
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, ['OpenAi']);
});

test('reads a grouped or-pattern arm as one entry per variant', () => {
  // The enum already groups variants this way in `requires_api_key`, so
  // `default_endpoint` may at any point. Read as two entries, not skipped.
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::Mistral | AiProviderType::Cohere => "https://api.mistral.ai/v1",
        }
    }
  `);
  assert.deepEqual(endpoints, {
    ollama: 'http://localhost:11434',
    mistral: 'https://api.mistral.ai/v1',
    cohere: 'https://api.mistral.ai/v1',
  });
  assert.deepEqual(unparsed, []);
});

test('reports every variant of a grouped arm whose endpoint is not a literal', () => {
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::Mistral | AiProviderType::Cohere => computed_default(),
        }
    }
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, ['Mistral', 'Cohere']);
});

test('reports a wildcard arm rather than skipping it', () => {
  // A `_ =>` arm gives every remaining variant an endpoint no per-variant scan
  // would ever see. Dropping it left the contract green while a provider was
  // redirected.
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            _ => "https://api.evil.test/v1",
        }
    }
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, ['_ => "https://api.evil.test/v1",']);
});

test('reports a block-bodied arm rather than skipping its contents', () => {
  const { endpoints, unparsed } = extractBackendDefaults(`
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::OpenAi => {
                OPENAI
            }
        }
    }
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, ['OpenAi', 'OPENAI']);
});

test('reports a frontend line that is not a plain key at all', () => {
  // A spread fills the table from somewhere this module never reads, and a
  // quoted key is not matched by the entry shapes. Both used to vanish.
  const { endpoints, unparsed } = extractFrontendDefaults(`
const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<AiProviderType, string>> = {
  ...OTHER_ENDPOINTS,
  'open_ai': 'https://api.evil.test/v1',
  ollama: 'http://localhost:11434',
};
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, [
    '...OTHER_ENDPOINTS,',
    "'open_ai': 'https://api.evil.test/v1',",
  ]);
});

test('reports a frontend entry whose endpoint is not a literal', () => {
  const { endpoints, unparsed } = extractFrontendDefaults(`
const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<AiProviderType, string>> = {
  ollama: 'http://localhost:11434',
  open_ai: OPENAI_HOST,
};
  `);
  assert.deepEqual(Object.keys(endpoints), ['ollama']);
  assert.deepEqual(unparsed, ['open_ai']);
});

test('names every kind of drift', () => {
  const drift = compareDefaults(
    { ollama: 'http://localhost:11434', open_ai: 'https://api.openai.com/v1' },
    { ollama: 'http://localhost:11434', anthropic: 'https://api.anthropic.com' },
  );
  assert.deepEqual(drift.missing, ['open_ai']);
  assert.deepEqual(drift.extra, ['anthropic']);
  assert.deepEqual(drift.different, []);

  const changed = compareDefaults(
    { open_ai: 'https://api.openai.com/v1' },
    { open_ai: 'https://api.openai.com' },
  );
  assert.deepEqual(changed.different, [
    { provider: 'open_ai', backend: 'https://api.openai.com/v1', frontend: 'https://api.openai.com' },
  ]);
});

test('every provider default is readable on both sides', () => {
  const { backend, frontend } = readContract();
  assert.deepEqual(
    backend.unparsed,
    [],
    'a backend default_endpoint arm is not a string literal, so this test cannot check it',
  );
  assert.deepEqual(
    frontend.unparsed,
    [],
    'a PROVIDER_DEFAULT_ENDPOINTS entry is not a string literal, so this test cannot check it',
  );
  assert.ok(Object.keys(backend.endpoints).length > 0, 'no backend defaults were read at all');
});

test('the frontend default endpoints mirror the Rust ones exactly', () => {
  const { backend, frontend } = readContract();
  const { missing, extra, different } = compareDefaults(backend.endpoints, frontend.endpoints);

  assert.deepEqual(
    missing,
    [],
    'PROVIDER_DEFAULT_ENDPOINTS has no entry for these providers, so the gate has no endpoint ' +
      'to judge when the provider listing cannot be read, and fails closed on a provider the ' +
      'backend would have served',
  );
  assert.deepEqual(
    extra,
    [],
    'PROVIDER_DEFAULT_ENDPOINTS names providers the backend does not have',
  );
  assert.deepEqual(
    different,
    [],
    'the two gates would judge different endpoints for these providers',
  );
});
