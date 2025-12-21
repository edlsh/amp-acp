// CLI backend - spawns amp process and yields JSON messages
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config, buildSpawnEnv } from '../config.js';
import { createLogger } from '../logger.js';
import { CircuitBreaker } from '../circuit-breaker.js';

const logSpawn = createLogger('amp:spawn');
const logStderr = createLogger('amp:stderr');

// Global spawn circuit breaker - protects against repeated spawn failures
const spawnBreaker = new CircuitBreaker({
  name: 'amp-spawn',
  failureThreshold: 5,
  resetTimeMs: 30000,
});

/**
 * CLI backend for Amp - spawns amp process and streams JSON messages.
 */
export class CliAmpBackend {
  /**
   * Execute a prompt and yield Amp CLI JSON messages.
   * @param {Object} session - Session state
   * @param {string} textInput - Prompt text (with images/context already processed)
   * @param {Object} options - Execution options
   * @param {string} options.cwd - Working directory
   * @param {string|null} options.ampSettingsFile - Path to settings override file
   * @param {string} options.sessionId - ACP session ID (for logging)
   * @param {AbortSignal} [abortSignal] - Abort signal for cancellation
   * @yields {Object} - Amp CLI JSON messages
   * @returns {AsyncGenerator<Object, {exitCode: number|null, signal: string|null, hadOutput: boolean, spawnError: Error|null}>}
   */
  async *executePrompt(session, textInput, options, abortSignal) {
    const { cwd, ampSettingsFile, sessionId } = options;

    // Check circuit breaker before spawning
    if (!spawnBreaker.isAllowed()) {
      logSpawn.warn('Circuit breaker is open, rejecting spawn', { sessionId });
      yield { type: 'error', text: 'Error: Too many spawn failures. Please try again later.' };
      return {
        exitCode: null,
        signal: null,
        hadOutput: false,
        spawnError: new Error('Too many spawn failures. Please try again later.'),
        circuitBreakerOpen: true,
      };
    }

    const finalSpawnArgs = ampSettingsFile ? [...config.ampFlags, '--settings-file', ampSettingsFile] : config.ampFlags;

    logSpawn.debug('Spawning amp process', {
      sessionId,
      cwd,
      ampSettingsFile,
    });

    let spawnError = null;
    let hadOutput = false;
    let _procEnded = false;

    const proc = spawn(config.ampExecutable, finalSpawnArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSpawnEnv(),
    });

    // Store proc reference on session for cancellation
    session.proc = proc;

    // Message queue for yielding
    const messageQueue = [];
    let resolveNext = null;
    let rejectNext = null;
    let finished = false;

    const enqueue = (msg) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        rejectNext = null;
        r(msg);
      } else {
        messageQueue.push(msg);
      }
    };

    const finishWithError = (err) => {
      spawnError = err;
      finished = true;
      if (rejectNext) {
        const r = rejectNext;
        resolveNext = null;
        rejectNext = null;
        r(err);
      }
    };

    const finishNormally = () => {
      finished = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        rejectNext = null;
        r(null); // Signal end
      }
    };

    proc.on('error', (err) => {
      spawnError = err;
      spawnBreaker.recordFailure();
      logSpawn.error('Failed to spawn amp', { sessionId, error: err.message });
      finishWithError(err);
    });

    const rlOut = readline.createInterface({ input: proc.stdout });
    const rlErr = readline.createInterface({ input: proc.stderr });
    session.rl = rlOut;

    rlOut.on('line', (line) => {
      if (!line) return;
      hadOutput = true;
      try {
        const msg = JSON.parse(line);
        enqueue({ type: 'message', msg });
      } catch {
        // Non-JSON line - treat as text
        enqueue({ type: 'text', text: line });
      }
    });

    rlErr.on('line', (line) => {
      logStderr.debug('amp stderr', { sessionId, line });
    });

    // Write input to stdin
    let input = textInput;
    if (!input.endsWith('\n')) input += '\n';

    proc.stdin.on('error', (err) => {
      logSpawn.warn('stdin error', { sessionId, error: err.message });
    });
    proc.stdin.write(input);
    proc.stdin.end();

    // Handle process close
    let exitCode = null;
    let exitSignal = null;

    proc.on('close', (code, signal) => {
      _procEnded = true;
      exitCode = code;
      exitSignal = signal;
      if (code === 0) {
        spawnBreaker.recordSuccess();
      }
      safeClose(rlOut);
      safeClose(rlErr);
      finishNormally();
    });

    // Handle abort signal
    const onAbort = () => {
      logSpawn.warn('Abort signal received, killing process', { sessionId });
      safeKill(proc, 'SIGTERM');
    };
    abortSignal?.addEventListener('abort', onAbort);

    try {
      // Yield messages as they arrive
      while (!finished || messageQueue.length > 0) {
        // Check abort
        if (abortSignal?.aborted) {
          // Drain remaining messages before returning
          while (messageQueue.length > 0) {
            yield messageQueue.shift();
          }
          await gracefulKill(proc, 2000);
          safeClose(rlOut);
          safeClose(rlErr);
          return {
            exitCode: null,
            signal: 'SIGTERM',
            hadOutput,
            spawnError: null,
            aborted: true,
          };
        }

        if (messageQueue.length > 0) {
          const item = messageQueue.shift();
          yield item;
        } else if (!finished) {
          // Wait for next message or finish
          const result = await new Promise((resolve, reject) => {
            resolveNext = resolve;
            rejectNext = reject;
          });
          if (result === null) {
            // Finished
            break;
          }
          yield result;
        }
      }
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      session.proc = null;
      session.rl = null;
    }

    return {
      exitCode,
      signal: exitSignal,
      hadOutput,
      spawnError,
    };
  }

  /**
   * Check if circuit breaker allows spawning
   */
  isAllowed() {
    return spawnBreaker.isAllowed();
  }
}

function safeClose(rl) {
  try {
    rl?.close();
  } catch {}
}

function safeKill(proc, signal) {
  try {
    proc?.kill(signal);
  } catch {}
}

async function gracefulKill(proc, graceMs = 5000) {
  if (!proc || proc.exitCode !== null) {
    return 'exited';
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
    };

    const onExit = () => {
      cleanup();
      resolve('exited');
    };

    proc.once('exit', onExit);
    safeKill(proc, 'SIGTERM');

    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      safeKill(proc, 'SIGKILL');
      resolve('killed');
    }, graceMs);
  });
}

/**
 * Get thread history as markdown.
 * @param {string} threadId - Thread ID (T-xxx format)
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<string|null>} - Markdown content or null if not found
 */
export async function getThreadHistory(threadId, options = {}) {
  const { cwd = process.cwd() } = options;

  return new Promise((resolve, reject) => {
    const args = ['threads', 'markdown', threadId];
    const proc = spawn(config.ampExecutable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSpawnEnv(),
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      logSpawn.error('Failed to get thread history', { threadId, error: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        logSpawn.warn('Thread history fetch failed', { threadId, code, stderr: stderr.trim() });
        resolve(null);
      }
    });
  });
}

/**
 * Continue an existing thread with a new prompt.
 * @param {Object} session - Session state
 * @param {string} threadId - Thread ID to continue
 * @param {string} textInput - Prompt text
 * @param {Object} options - Execution options
 * @param {string} options.cwd - Working directory
 * @param {string|null} options.ampSettingsFile - Path to settings override file
 * @param {string} options.sessionId - ACP session ID (for logging)
 * @param {AbortSignal} [abortSignal] - Abort signal for cancellation
 * @yields {Object} - Amp CLI JSON messages
 */
export async function* continueThread(session, threadId, textInput, options, abortSignal) {
  const { cwd, ampSettingsFile, sessionId } = options;

  if (!spawnBreaker.isAllowed()) {
    logSpawn.warn('Circuit breaker is open, rejecting spawn', { sessionId });
    yield { type: 'error', text: 'Error: Too many spawn failures. Please try again later.' };
    return {
      exitCode: null,
      signal: null,
      hadOutput: false,
      spawnError: new Error('Too many spawn failures. Please try again later.'),
      circuitBreakerOpen: true,
    };
  }

  const args = ['threads', 'continue', threadId, '--execute', '--stream-json', '--no-notifications'];
  if (ampSettingsFile) {
    args.push('--settings-file', ampSettingsFile);
  }

  logSpawn.debug('Continuing thread', {
    sessionId,
    threadId,
    cwd,
    ampSettingsFile,
  });

  let spawnError = null;
  let hadOutput = false;
  let _procEnded = false;

  const proc = spawn(config.ampExecutable, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSpawnEnv(),
  });

  session.proc = proc;

  const messageQueue = [];
  let resolveNext = null;
  let rejectNext = null;
  let finished = false;

  const enqueue = (msg) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r(msg);
    } else {
      messageQueue.push(msg);
    }
  };

  const finishWithError = (err) => {
    spawnError = err;
    finished = true;
    if (rejectNext) {
      const r = rejectNext;
      resolveNext = null;
      rejectNext = null;
      r(err);
    }
  };

  const finishNormally = () => {
    finished = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r(null);
    }
  };

  proc.on('error', (err) => {
    spawnError = err;
    spawnBreaker.recordFailure();
    logSpawn.error('Failed to spawn amp for thread continuation', { sessionId, threadId, error: err.message });
    finishWithError(err);
  });

  const rlOut = readline.createInterface({ input: proc.stdout });
  const rlErr = readline.createInterface({ input: proc.stderr });
  session.rl = rlOut;

  rlOut.on('line', (line) => {
    if (!line) return;
    hadOutput = true;
    try {
      const msg = JSON.parse(line);
      enqueue({ type: 'message', msg });
    } catch {
      enqueue({ type: 'text', text: line });
    }
  });

  rlErr.on('line', (line) => {
    logStderr.debug('amp stderr (continue)', { sessionId, threadId, line });
  });

  let input = textInput;
  if (!input.endsWith('\n')) input += '\n';

  proc.stdin.on('error', (err) => {
    logSpawn.warn('stdin error (continue)', { sessionId, error: err.message });
  });
  proc.stdin.write(input);
  proc.stdin.end();

  let exitCode = null;
  let exitSignal = null;

  proc.on('close', (code, signal) => {
    _procEnded = true;
    exitCode = code;
    exitSignal = signal;
    if (code === 0) {
      spawnBreaker.recordSuccess();
    }
    safeClose(rlOut);
    safeClose(rlErr);
    finishNormally();
  });

  const onAbort = () => {
    logSpawn.warn('Abort signal received, killing process', { sessionId, threadId });
    safeKill(proc, 'SIGTERM');
  };
  abortSignal?.addEventListener('abort', onAbort);

  try {
    while (!finished || messageQueue.length > 0) {
      if (abortSignal?.aborted) {
        while (messageQueue.length > 0) {
          yield messageQueue.shift();
        }
        await gracefulKill(proc, 2000);
        safeClose(rlOut);
        safeClose(rlErr);
        return {
          exitCode: null,
          signal: 'SIGTERM',
          hadOutput,
          spawnError: null,
          aborted: true,
        };
      }

      if (messageQueue.length > 0) {
        const item = messageQueue.shift();
        yield item;
      } else if (!finished) {
        const result = await new Promise((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
        if (result === null) {
          break;
        }
        yield result;
      }
    }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    session.proc = null;
    session.rl = null;
  }

  return {
    exitCode,
    signal: exitSignal,
    hadOutput,
    spawnError,
  };
}
