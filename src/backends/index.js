// Backend factory and exports
import { config } from '../config.js';
import { CliAmpBackend } from './cli-backend.js';
import { SdkAmpBackend } from './sdk-backend.js';

// Singleton instances
let cliBackend = null;
let sdkBackend = null;

/**
 * Get the configured backend instance.
 * @returns {CliAmpBackend|SdkAmpBackend}
 */
export function getBackend() {
  if (config.sdkEnabled) {
    if (!sdkBackend) {
      sdkBackend = new SdkAmpBackend();
    }
    return sdkBackend;
  }

  if (!cliBackend) {
    cliBackend = new CliAmpBackend();
  }
  return cliBackend;
}

/**
 * Check if SDK backend is enabled.
 */
export function isSdkBackend() {
  return config.sdkEnabled;
}

/**
 * Validate the configured backend at startup.
 * For SDK backend, this ensures @sourcegraph/amp-sdk is installed.
 * @throws {Error} if SDK backend is enabled but SDK is not available
 */
export async function validateBackend() {
  if (config.sdkEnabled) {
    const backend = getBackend();
    await backend.validate();
  }
}

/**
 * Reset backend singletons. Used for test isolation.
 */
export function resetBackends() {
  cliBackend = null;
  sdkBackend = null;
}

export { CliAmpBackend } from './cli-backend.js';
export { SdkAmpBackend } from './sdk-backend.js';
