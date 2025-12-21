// SDK backend - uses @sourcegraph/amp-sdk for direct execution
//
// LIMITATION: Thread operations (history, continuation) are not supported.
// The amp-sdk does not yet expose thread retrieval/continuation APIs.
// Threads ARE persisted by Amp's backend during execution, but cannot be
// retrieved or continued via SDK. Use CLI backend for thread support.
//
// TODO: Once amp-sdk adds thread APIs, implement:
//   - getThreadHistory(threadId, options)
//   - continueThread(session, threadId, textInput, options, abortSignal)
//
import { buildAmpOptions } from '../config.js';
import { createLogger } from '../logger.js';

const logSdk = createLogger('amp:sdk');

/**
 * SDK backend for Amp - uses @sourcegraph/amp-sdk execute().
 * Messages are yielded in SDK format (different from CLI JSON format).
 *
 * Note: Thread history and continuation are not supported. The SDK persists
 * threads to Amp's backend, but does not expose APIs to retrieve them.
 * Use CLI backend (AMP_ACP_BACKEND=cli) if thread support is required.
 */
export class SdkAmpBackend {
  constructor() {
    this._execute = null;
    this._createUserMessage = null;
    this._validated = false;
  }

  /**
   * Validate that the SDK is available. Call at startup to fail fast.
   * @throws {Error} if @sourcegraph/amp-sdk is not installed
   */
  async validate() {
    if (this._validated) return;
    try {
      await import('@sourcegraph/amp-sdk');
      this._validated = true;
      logSdk.info('SDK validated successfully');
    } catch {
      throw new Error(
        `SDK backend requires @sourcegraph/amp-sdk but it is not installed. ` +
          `Install it with: npm install @sourcegraph/amp-sdk`
      );
    }
  }

  /**
   * Lazily import the SDK execute function.
   * This allows the module to load even if SDK is not installed.
   */
  async _getExecute() {
    if (!this._execute) {
      try {
        const sdk = await import('@sourcegraph/amp-sdk');
        this._execute = sdk.execute;
      } catch (err) {
        throw new Error(`Failed to load @sourcegraph/amp-sdk: ${err.message}`);
      }
    }
    return this._execute;
  }

  /**
   * Lazily import the SDK message creator function.
   * @returns {Promise<Function>} createUserMessage function
   */
  async _getCreateUserMessage() {
    if (!this._createUserMessage) {
      try {
        const sdk = await import('@sourcegraph/amp-sdk');
        this._createUserMessage = sdk.createUserMessage;
      } catch (err) {
        throw new Error(`Failed to load @sourcegraph/amp-sdk: ${err.message}`);
      }
    }
    return this._createUserMessage;
  }

  /**
   * Execute a prompt and yield SDK messages.
   * @param {Object} session - Session state (for consistency with CLI backend)
   * @param {string} textInput - Prompt text
   * @param {Object} options - Execution options
   * @param {string} options.cwd - Working directory
   * @param {string} options.modeId - Mode identifier
   * @param {Object} [options.clientCapabilities] - ACP client capabilities
   * @param {string} options.sessionId - ACP session ID (for logging)
   * @param {AbortSignal} [abortSignal] - Abort signal for cancellation
   * @yields {Object} - SDK messages (type: 'message', msg: sdkMessage) or (type: 'sdk_message', msg: sdkMessage)
   * @returns {AsyncGenerator<Object, {hadOutput: boolean, error: Error|null}>}
   */
  async *executePrompt(session, textInput, options, abortSignal) {
    const { cwd, modeId, sessionId } = options;
    let hadOutput = false;
    let error = null;
    let capturedThreadId = null;

    // Note: SDK reads user permissions/disabled tools from settings file directly.
    // Pass threadId to continue conversation (enables persistent memory).
    const ampOptions = buildAmpOptions({
      modeId: modeId || 'default',
      cwd: cwd || process.cwd(),
      threadId: session.threadId, // Continue existing thread if available
    });

    logSdk.debug('Executing via SDK', {
      sessionId,
      modeId,
      cwd,
      threadId: session.threadId || null,
    });

    try {
      const execute = await this._getExecute();
      const iterable = execute({ prompt: textInput, options: ampOptions, signal: abortSignal });

      for await (const msg of iterable) {
        if (abortSignal?.aborted) {
          logSdk.warn('Abort signal received during SDK execution', { sessionId });
          return { hadOutput, error: null, aborted: true, threadId: capturedThreadId };
        }

        hadOutput = true;

        // Capture thread ID from SDK messages for session persistence
        if (msg.session_id && !capturedThreadId) {
          capturedThreadId = msg.session_id;
          logSdk.debug('Captured thread ID from SDK', { sessionId, threadId: capturedThreadId });
        }

        yield { type: 'sdk_message', msg };
      }
    } catch (err) {
      error = err;
      logSdk.error('SDK execution error', { sessionId, error: err.message });
      yield { type: 'sdk_error', error: err };
    }

    return { hadOutput, error, threadId: capturedThreadId };
  }

  /**
   * SDK backend doesn't use circuit breaker - always allowed.
   *
   * Design rationale: The SDK is in-process and doesn't have the same
   * failure modes as spawning external processes. SDK errors are
   * typically recoverable (network issues, API errors) and the SDK
   * handles its own retry logic internally.
   */
  isAllowed() {
    return true;
  }

  /**
   * Get thread history - not supported via SDK yet.
   * @param {string} threadId - Thread ID
   * @param {Object} options - Options
   * @returns {Promise<null>} - Always returns null (not supported)
   */
  async getThreadHistory(threadId, _options = {}) {
    logSdk.warn('Thread history not supported via SDK', { threadId });
    return null;
  }

  /**
   * Continue thread - not supported via SDK yet.
   * @param {Object} session - Session state
   * @param {string} threadId - Thread ID
   * @param {string} textInput - Prompt text
   * @param {Object} options - Options
   * @param {AbortSignal} [abortSignal] - Abort signal
   * @yields {Object} - SDK error message
   */
  async *continueThread(session, threadId, textInput, options, _abortSignal) {
    logSdk.warn('Thread continuation not supported via SDK', { threadId, sessionId: options.sessionId });
    yield {
      type: 'sdk_error',
      error: new Error('Thread continuation is not supported via SDK backend. Use CLI backend instead.'),
    };
    return { hadOutput: false, error: new Error('Not supported') };
  }

  /**
   * Execute multiple user messages as an async generator flow.
   * Enables multi-turn conversations within a single execute call.
   *
   * Note: amp-sdk only supports user messages (no system messages).
   * System-like instructions should be prepended to the first user message.
   *
   * @param {Object} session - Session state
   * @param {Array<{role: 'user', content: string}>} messages - Array of user messages
   * @param {Object} options - Execution options (same as executePrompt)
   * @param {AbortSignal} [abortSignal] - Abort signal for cancellation
   * @yields {Object} - SDK messages (type: 'sdk_message')
   * @returns {AsyncGenerator<Object, {hadOutput: boolean, error: Error|null}>}
   */
  async *executeMultiMessage(session, messages, options, abortSignal) {
    const { cwd, modeId, sessionId } = options;
    let hadOutput = false;
    let error = null;
    let capturedThreadId = null;

    // Note: SDK reads user permissions/disabled tools from settings file directly.
    // Pass threadId to continue conversation (enables persistent memory).
    const ampOptions = buildAmpOptions({
      modeId: modeId || 'default',
      cwd: cwd || process.cwd(),
      threadId: session.threadId,
    });

    logSdk.debug('Executing multi-message via SDK', {
      sessionId,
      modeId,
      messageCount: messages.length,
      threadId: session.threadId || null,
    });

    try {
      const execute = await this._getExecute();
      const createUserMessage = await this._getCreateUserMessage();

      async function* messageGenerator() {
        for (const msg of messages) {
          if (msg.role === 'user') {
            yield createUserMessage(msg.content);
          }
        }
      }

      const iterable = execute({ prompt: messageGenerator(), options: ampOptions, signal: abortSignal });

      for await (const msg of iterable) {
        if (abortSignal?.aborted) {
          logSdk.warn('Abort signal received during SDK multi-message execution', { sessionId });
          return { hadOutput, error: null, aborted: true, threadId: capturedThreadId };
        }

        hadOutput = true;

        // Capture thread ID from SDK messages for session persistence
        if (msg.session_id && !capturedThreadId) {
          capturedThreadId = msg.session_id;
          logSdk.debug('Captured thread ID from SDK (multi-message)', { sessionId, threadId: capturedThreadId });
        }

        yield { type: 'sdk_message', msg };
      }
    } catch (err) {
      error = err;
      logSdk.error('SDK multi-message execution error', { sessionId, error: err.message });
      yield { type: 'sdk_error', error: err };
    }

    return { hadOutput, error, threadId: capturedThreadId };
  }
}
