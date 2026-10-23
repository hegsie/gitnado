import { expect } from '@open-wc/testing';
import type {
  SystemCapabilities,
  ModelEntry,
  LocalModelStatus,
} from '../local-ai.service.ts';
import {
  formatBytes,
  getTierDisplayName,
  getBackendDisplayName,
  getSystemCapabilities,
  getAvailableModels,
  downloadModel,
  importCustomModel,
  getModelStatus,
  getLoadedModelName,
  loadModel,
  unloadModel,
} from '../local-ai.service.ts';

// Mock Tauri API
let aiSettingsChangedEvents = 0;
window.addEventListener('ai-settings-changed', () => aiSettingsChangedEvents++);

const mockResults: Record<string, unknown> = {
  load_model: null,
  unload_model: null,
  get_system_capabilities: {
    totalRamBytes: 17179869184,
    availableRamBytes: 8589934592,
    gpuInfo: {
      name: 'Apple M1',
      vendor: 'apple',
      vramBytes: 12884901888,
      metalSupported: true,
      cudaSupported: false,
      rocmSupported: false,
      vulkanSupported: false,
      unifiedMemory: true,
    },
    recommendedTier: 'standard',
    gpuAccelerationAvailable: true,
    activeBackend: 'metal',
    supportedBackends: ['metal', 'cpu'],
    npuInfo: {
      name: 'Apple Neural Engine (ANE)',
      vendor: 'apple_neural_engine',
      available: true,
    },
    unifiedMemory: true,
  } as SystemCapabilities,
  get_available_models: [
    {
      id: 'smollm2-360m',
      displayName: 'SmolLM2 360M',
      hfRepo: 'HuggingFaceTB/SmolLM2-360M-Instruct-GGUF',
      hfFilename: 'smollm2-360m-instruct-q8_0.gguf',
      sha256: 'abc123',
      sizeBytes: 386547056,
      minRamBytes: 8589934592,
      tier: 'ultra_light',
      architecture: 'llama',
      contextLength: 4096,
    },
  ] as ModelEntry[],
  download_model: null,
  import_custom_model: {
    id: 'custom-my-model',
    displayName: 'My Custom Model',
    sizeBytes: 4200000000,
    path: '/models/custom-my-model/model.gguf',
    status: 'downloaded',
  },
  get_model_status: 'ready' as LocalModelStatus,
  get_loaded_model_name: 'Test Model' as string | null,
};

const mockInvoke = (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
  return Promise.resolve(mockResults[command] ?? { success: false, error: 'Unknown command' });
};

(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
};

describe('Local AI Service - formatBytes', () => {
  it('should return 0 B for zero bytes', () => {
    expect(formatBytes(0)).to.equal('0 B');
  });

  it('should format bytes correctly', () => {
    expect(formatBytes(500)).to.equal('500 B');
  });

  it('should format kilobytes correctly', () => {
    expect(formatBytes(1024)).to.equal('1.0 KB');
    expect(formatBytes(1536)).to.equal('1.5 KB');
  });

  it('should format megabytes correctly', () => {
    expect(formatBytes(1048576)).to.equal('1.0 MB');
    expect(formatBytes(5242880)).to.equal('5.0 MB');
  });

  it('should format gigabytes correctly', () => {
    expect(formatBytes(1073741824)).to.equal('1.0 GB');
    expect(formatBytes(17179869184)).to.equal('16.0 GB');
  });

  it('should format terabytes correctly', () => {
    expect(formatBytes(1099511627776)).to.equal('1.0 TB');
  });
});

describe('Local AI Service - getTierDisplayName', () => {
  it('should return correct name for ultra_light', () => {
    expect(getTierDisplayName('ultra_light')).to.equal('Ultra-Light (8GB+ RAM)');
  });

  it('should return correct name for standard', () => {
    expect(getTierDisplayName('standard')).to.equal('Standard (16GB+ RAM)');
  });

  it('should return correct name for pro', () => {
    expect(getTierDisplayName('pro')).to.equal('Pro (32GB+ RAM)');
  });

  it('should return correct name for none', () => {
    expect(getTierDisplayName('none')).to.equal('Not Supported');
  });
});

describe('Local AI Service - getBackendDisplayName', () => {
  const baseCaps: SystemCapabilities = {
    totalRamBytes: 17179869184,
    availableRamBytes: 8589934592,
    gpuInfo: null,
    recommendedTier: 'standard',
    gpuAccelerationAvailable: true,
  };

  it('should return Metal display name', () => {
    expect(getBackendDisplayName({ ...baseCaps, activeBackend: 'metal' })).to.equal(
      'Metal (Apple Silicon)'
    );
  });

  it('should return CUDA display name', () => {
    expect(getBackendDisplayName({ ...baseCaps, activeBackend: 'cuda' })).to.equal(
      'NVIDIA CUDA'
    );
  });

  it('should return ROCm display name', () => {
    expect(getBackendDisplayName({ ...baseCaps, activeBackend: 'rocm' })).to.equal(
      'AMD ROCm'
    );
  });

  it('should return Vulkan display name', () => {
    expect(getBackendDisplayName({ ...baseCaps, activeBackend: 'vulkan' })).to.equal(
      'Vulkan GPU'
    );
  });

  it('should return CPU Only when activeBackend is cpu or acceleration unavailable', () => {
    expect(
      getBackendDisplayName({ ...baseCaps, activeBackend: 'cpu', gpuAccelerationAvailable: false })
    ).to.equal('CPU Only');
    expect(getBackendDisplayName({ ...baseCaps, gpuAccelerationAvailable: false })).to.equal(
      'CPU Only'
    );
  });

  it('should fall back to GPU Accelerated when activeBackend is omitted', () => {
    expect(getBackendDisplayName(baseCaps)).to.equal('GPU Accelerated');
  });
});

describe('Local AI Service - getSystemCapabilities', () => {
  it('should return system capabilities', async () => {
    const result = await getSystemCapabilities();
    expect(result.success).to.be.true;
    expect(result.data).to.not.be.undefined;
    expect(result.data!.totalRamBytes).to.equal(17179869184);
    expect(result.data!.availableRamBytes).to.equal(8589934592);
    expect(result.data!.recommendedTier).to.equal('standard');
  });

  it('should return GPU info when available', async () => {
    const result = await getSystemCapabilities();
    expect(result.success).to.be.true;
    expect(result.data!.gpuInfo).to.not.be.null;
    expect(result.data!.gpuInfo!.vendor).to.equal('apple');
    expect(result.data!.gpuInfo!.metalSupported).to.be.true;
    expect(result.data!.gpuInfo!.cudaSupported).to.be.false;
  });
});

describe('Local AI Service - getAvailableModels', () => {
  it('should return available models', async () => {
    const result = await getAvailableModels();
    expect(result.success).to.be.true;
    expect(result.data).to.not.be.undefined;
    expect(result.data!).to.have.length(1);
  });

  it('should have correct model properties', async () => {
    const result = await getAvailableModels();
    const model = result.data![0];
    expect(model.id).to.equal('smollm2-360m');
    expect(model.displayName).to.equal('SmolLM2 360M');
    expect(model.tier).to.equal('ultra_light');
    expect(model.contextLength).to.equal(4096);
    expect(model.sizeBytes).to.equal(386547056);
  });
});

describe('Local AI Service - downloadModel', () => {
  it('should invoke download_model command', async () => {
    const result = await downloadModel('smollm2-360m');
    expect(result.success).to.be.true;
  });
});

describe('Local AI Service - getModelStatus', () => {
  it('should return the model status', async () => {
    const result = await getModelStatus();
    expect(result.success).to.be.true;
    expect(result.data).to.equal('ready');
  });
});

describe('Local AI Service - getLoadedModelName', () => {
  it('should return the loaded model name', async () => {
    const result = await getLoadedModelName();
    expect(result.success).to.be.true;
    expect(result.data).to.equal('Test Model');
  });
});

describe('Local AI Service - loadModel', () => {
  it('should invoke load_model command', async () => {
    aiSettingsChangedEvents = 0;
    const result = await loadModel('test-model');
    expect(result.success).to.be.true;
  });

  it('should dispatch ai-settings-changed event on success', async () => {
    aiSettingsChangedEvents = 0;
    await loadModel('test-model');
    expect(aiSettingsChangedEvents).to.equal(1);
  });
});

describe('Local AI Service - unloadModel', () => {
  it('should invoke unload_model command', async () => {
    const result = await unloadModel();
    expect(result.success).to.be.true;
  });

  it('should dispatch ai-settings-changed event on success', async () => {
    aiSettingsChangedEvents = 0;
    await unloadModel();
    expect(aiSettingsChangedEvents).to.equal(1);
  });
});

describe('Local AI Service - importCustomModel', () => {
  it('should invoke import_custom_model command and return downloaded model info', async () => {
    const result = await importCustomModel('/path/to/my-model.gguf', 'My Custom Model', 'qwen2');
    expect(result.success).to.be.true;
    expect(result.data?.id).to.equal('custom-my-model');
    expect(result.data?.displayName).to.equal('My Custom Model');
  });
});
