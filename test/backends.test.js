import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../src/config.js';
import { getBackend, isSdkBackend, CliAmpBackend, SdkAmpBackend, resetBackends } from '../src/backends/index.js';

// Store original config values for reset
let originalBackend;

describe('backends', () => {
  beforeEach(() => {
    originalBackend = config.backend;
    resetBackends();
  });

  afterEach(() => {
    config.backend = originalBackend;
    resetBackends();
  });

  describe('getBackend factory', () => {
    it('returns CliAmpBackend when backend is cli', () => {
      config.backend = 'cli';
      const backend = getBackend();

      expect(backend).toBeInstanceOf(CliAmpBackend);
    });

    it('returns SdkAmpBackend when backend is sdk', () => {
      config.backend = 'sdk';
      const backend = getBackend();

      expect(backend).toBeInstanceOf(SdkAmpBackend);
    });

    it('caches and reuses instances (singleton pattern)', () => {
      config.backend = 'cli';
      const backend1 = getBackend();
      const backend2 = getBackend();

      expect(backend1).toBe(backend2);
    });
  });

  describe('isSdkBackend', () => {
    it('returns true when backend is sdk', () => {
      config.backend = 'sdk';
      expect(isSdkBackend()).toBe(true);
    });

    it('returns false when backend is cli', () => {
      config.backend = 'cli';
      expect(isSdkBackend()).toBe(false);
    });
  });

  describe('resetBackends', () => {
    it('allows switching backends by resetting cache', () => {
      config.backend = 'cli';
      const cliBackend = getBackend();
      expect(cliBackend).toBeInstanceOf(CliAmpBackend);

      config.backend = 'sdk';
      resetBackends();
      const sdkBackend = getBackend();
      expect(sdkBackend).toBeInstanceOf(SdkAmpBackend);
    });
  });
});

describe('CliAmpBackend', () => {
  it('has isAllowed method', async () => {
    const { CliAmpBackend } = await import('../src/backends/cli-backend.js');
    const backend = new CliAmpBackend();

    expect(typeof backend.isAllowed).toBe('function');
    expect(backend.isAllowed()).toBe(true);
  });

  it('has executePrompt async generator method', async () => {
    const { CliAmpBackend } = await import('../src/backends/cli-backend.js');
    const backend = new CliAmpBackend();

    expect(typeof backend.executePrompt).toBe('function');
  });
});

describe('SdkAmpBackend', () => {
  it('has isAllowed method that always returns true', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    expect(typeof backend.isAllowed).toBe('function');
    expect(backend.isAllowed()).toBe(true);
  });

  it('has executePrompt async generator method', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    expect(typeof backend.executePrompt).toBe('function');
  });

  it('lazily imports SDK on first execute call', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    // _execute should be null before any call
    expect(backend._execute).toBe(null);
  });

  it('has validate method', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    expect(typeof backend.validate).toBe('function');
    expect(backend._validated).toBe(false);
  });

  it('validate throws if SDK not installed', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    // First check if SDK is actually available
    try {
      await import('@sourcegraph/amp-sdk');
      // SDK is installed, skip this test
      return;
    } catch {
      // SDK not installed, test should pass
    }

    await expect(backend.validate()).rejects.toThrow('SDK backend requires @sourcegraph/amp-sdk');
  });

  it('has executeMultiMessage async generator method', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    expect(typeof backend.executeMultiMessage).toBe('function');
  });

  it('has _getCreateUserMessage lazy loader', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    expect(typeof backend._getCreateUserMessage).toBe('function');
    expect(backend._createUserMessage).toBe(null);
  });

  it('_getCreateUserMessage returns function when SDK installed', async () => {
    const { SdkAmpBackend } = await import('../src/backends/sdk-backend.js');
    const backend = new SdkAmpBackend();

    try {
      await import('@sourcegraph/amp-sdk');
    } catch {
      // SDK not installed, skip this test
      return;
    }

    const createUserMessage = await backend._getCreateUserMessage();
    expect(typeof createUserMessage).toBe('function');
    expect(backend._createUserMessage).toBe(createUserMessage);
  });
});
