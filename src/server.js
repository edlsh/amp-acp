import { RequestError } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toAcpNotifications, isBashToolUse, getToolResult, NestedToolTracker } from './to-acp.js';
import { sdkMessageToAcpNotifications, extractSdkTerminalAndPlanActions } from './sdk-adapter.js';
import { config, slashCommands, loadMergedAmpSettings } from './config.js';
import { getBackend, isSdkBackend } from './backends/index.js';
import { getThreadHistory, continueThread } from './backends/cli-backend.js';
import { createLogger } from './logger.js';

const logSession = createLogger('acp:session');
const logProtocol = createLogger('acp:protocol');
const logSpawn = createLogger('amp:spawn');

/**
 * Session state machine for AmpAcpAgent.
 *
 * State transitions:
 * - IDLE → ACTIVE: on prompt() call
 * - ACTIVE → IDLE: on prompt completion (success or cancellation)
 * - ACTIVE → FAILED: on unrecoverable error (e.g., spawn failure)
 * - FAILED: terminal state, session cannot accept new prompts
 */
const SessionState = {
  IDLE: 'idle',
  ACTIVE: 'active',
  FAILED: 'failed',
};

export class AmpAcpAgent {
  constructor(client, connectionSignalPromise) {
    this.client = client;
    this.connectionSignalPromise = connectionSignalPromise;
    this.sessions = new Map();
  }

  async _sessionUpdate(notif, { critical = false } = {}) {
    try {
      await this.client.sessionUpdate(notif);
    } catch (e) {
      if (critical) {
        logProtocol.error('Critical sessionUpdate failed', {
          sessionId: notif.sessionId,
          updateType: notif.update?.sessionUpdate,
          error: e.message,
        });
        throw e;
      }
      logProtocol.warn('sessionUpdate failed (best-effort)', {
        sessionId: notif.sessionId,
        updateType: notif.update?.sessionUpdate,
        error: e.message,
      });
    }
  }

  /**
   * Queue a session update through the session's promise chain.
   * Ensures serial execution and proper error handling.
   *
   * @param {string} sessionId - Session ID
   * @param {object} notif - ACP notification object
   * @param {object} options - Options
   * @param {boolean} options.critical - If true, mark session as FAILED on error
   */
  _queueSessionUpdate(sessionId, notif, { critical = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logProtocol.warn('Cannot queue update for unknown session', { sessionId });
      return;
    }

    session.chain = session.chain
      .then(() => this._sessionUpdate(notif, { critical }))
      .catch((e) => {
        // Critical errors already logged by _sessionUpdate and re-thrown
        // Mark session as failed to prevent further prompts
        if (critical) {
          const s = this.sessions.get(sessionId);
          if (s) {
            s.state = SessionState.FAILED;
            logSession.error('Session marked FAILED due to critical update failure', { sessionId });
          }
        }
        // Re-throw to break the chain on critical errors
        // Non-critical errors are already logged by _sessionUpdate
        if (critical) throw e;
      });
  }

  async initialize(_request) {
    this.clientCapabilities = _request.clientCapabilities;
    return {
      protocolVersion: config.protocolVersion,
      agentCapabilities: {
        loadSession: !isSdkBackend(), // Only CLI backend supports thread loading
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {
          resume: {}, // Session resume support (in-memory only)
          fork: {}, // Session fork support
          // Note: list capability omitted - not part of stable ACP schema
        },
      },
      authMethods: [],
    };
  }

  async newSession(_params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(sessionId, this._createSessionState());

    logSession.info('Session created', { sessionId });
    setImmediate(() => this._emitAvailableCommands(sessionId));

    return this._buildSessionResponse(sessionId);
  }

  /**
   * Create initial session state object.
   * Shared by newSession, loadSession, and forkSession.
   *
   * @param {object} options - Optional overrides
   * @param {string} options.threadId - Amp thread ID for continuation
   * @param {boolean} options.isLoaded - Whether session was loaded from thread
   * @param {string} options.loadedCwd - Working directory from loaded thread
   * @returns {object} - Session state object
   */
  _createSessionState({ threadId = null, isLoaded = false, loadedCwd = undefined } = {}) {
    return {
      state: SessionState.IDLE,
      proc: null,
      rl: null,
      cancelled: false,
      active: false,
      chain: Promise.resolve(),
      plan: [],
      activeToolCalls: new Map(),
      ampToAcpToolIds: new Map(),
      currentModeId: 'default',
      terminals: new Map(),
      nestedTracker: new NestedToolTracker(),
      sentAvailableCommands: false,
      threadId,
      isLoaded,
      loadedCwd,
      lastActivityAt: Date.now(), // Track for session list sorting
    };
  }

  /**
   * Load an existing Amp thread as a session.
   * @param {Object} params - Load session parameters
   * @param {string} params.sessionId - Amp thread ID (T-xxx format)
   * @param {string} [params.cwd] - Working directory
   * @returns {Promise<Object>} - Session info
   */
  async loadSession(params) {
    const threadId = params.sessionId;
    const cwd = params.cwd || process.cwd();

    // Validate thread ID format: T-{uuid}
    const threadIdPattern = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!threadIdPattern.test(threadId)) {
      throw new RequestError(-32602, `Invalid thread ID format: ${threadId}. Expected T-{uuid} format.`);
    }

    // SDK backend limitation: thread operations require CLI.
    if (isSdkBackend()) {
      throw new RequestError(
        -32002,
        'Thread history is not available with SDK backend. ' +
          'Set AMP_ACP_BACKEND=cli for thread support, or wait for amp-sdk to add thread APIs.'
      );
    }

    // Fetch thread history to validate thread exists
    const markdown = await getThreadHistory(threadId, { cwd });
    if (markdown === null) {
      throw new RequestError(-32002, `Thread not found: ${threadId}`);
    }

    // Create session state using shared helper
    const sessionId = threadId; // Use thread ID as session ID for continuation
    this.sessions.set(sessionId, this._createSessionState({ threadId, isLoaded: true, loadedCwd: cwd }));

    logSession.info('Session loaded from thread', { sessionId, threadId });
    setImmediate(() => this._emitAvailableCommands(sessionId));

    // Replay thread history as agent_message_chunk notifications
    if (markdown.trim()) {
      setImmediate(async () => {
        try {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: markdown },
            },
          });
        } catch (e) {
          logProtocol.warn('Failed to replay thread history', { sessionId, error: e.message });
        }
      });
    }

    return this._buildSessionResponse(sessionId);
  }

  /**
   * Resume an existing in-memory session.
   * Lighter weight than loadSession - just reattaches without replaying history.
   *
   * @param {Object} params - Resume session parameters
   * @param {string} params.sessionId - Session ID to resume
   * @returns {Promise<Object>} - Session info
   */
  async resumeSession(params) {
    const { sessionId } = params;
    const s = this.sessions.get(sessionId);

    if (!s) {
      throw new RequestError(-32002, `Session not found: ${sessionId}`);
    }

    if (s.state === SessionState.FAILED) {
      throw new RequestError(-32002, `Session is in failed state and cannot be resumed: ${sessionId}`);
    }

    // Update last activity
    s.lastActivityAt = Date.now();

    logSession.info('Session resumed', { sessionId });

    // Re-emit available commands and plan if present
    setImmediate(() => this._emitAvailableCommands(sessionId));
    if (s.plan?.length > 0) {
      setImmediate(() => this._emitPlanUpdate(sessionId, s));
    }

    return this._buildSessionResponse(sessionId);
  }

  /**
   * Fork an existing session to create an independent copy.
   * The forked session shares the same thread context but operates independently.
   *
   * @param {Object} params - Fork session parameters
   * @param {string} params.sessionId - Session ID to fork from
   * @returns {Promise<Object>} - New session info
   */
  async forkSession(params) {
    const { sessionId } = params;
    const base = this.sessions.get(sessionId);

    if (!base) {
      throw new RequestError(-32002, `Session not found: ${sessionId}`);
    }

    // Generate new session ID
    const newSessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Create forked session with same thread context
    this.sessions.set(
      newSessionId,
      this._createSessionState({
        threadId: base.threadId,
        isLoaded: base.isLoaded,
        loadedCwd: base.loadedCwd,
      })
    );

    // Copy current mode from parent
    const forkedSession = this.sessions.get(newSessionId);
    forkedSession.currentModeId = base.currentModeId;

    logSession.info('Session forked', { from: sessionId, to: newSessionId, threadId: base.threadId });
    setImmediate(() => this._emitAvailableCommands(newSessionId));

    return this._buildSessionResponse(newSessionId);
  }

  /**
   * List all active sessions with pagination.
   *
   * @param {Object} params - List parameters
   * @param {number} [params.cursor=0] - Pagination cursor (offset)
   * @param {number} [params.limit=50] - Maximum sessions to return
   * @param {string} [params.cwd] - Filter by working directory
   * @returns {Promise<Object>} - Sessions list with pagination
   */
  async listSessions(params = {}) {
    const { cursor = 0, limit = 50, cwd } = params;

    // Build list of sessions with metadata
    let sessions = Array.from(this.sessions.entries()).map(([id, s]) => ({
      sessionId: id,
      state: s.state,
      threadId: s.threadId,
      isLoaded: s.isLoaded,
      loadedCwd: s.loadedCwd,
      currentModeId: s.currentModeId,
      lastActivityAt: s.lastActivityAt || 0,
      hasActivePlan: s.plan?.length > 0,
    }));

    // Filter by cwd if provided
    if (cwd) {
      sessions = sessions.filter((s) => s.loadedCwd === cwd || (!s.loadedCwd && !s.isLoaded));
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    // Apply pagination
    const slice = sessions.slice(cursor, cursor + limit);
    const nextCursor = cursor + slice.length < sessions.length ? cursor + slice.length : null;

    return {
      sessions: slice,
      nextCursor,
      total: sessions.length,
    };
  }

  /**
   * Build standard session response object.
   */
  _buildSessionResponse(sessionId) {
    return {
      sessionId,
      models: {
        currentModelId: 'default',
        availableModels: [{ modelId: 'default', name: 'Default', description: 'Amp default' }],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          {
            id: 'default',
            name: 'Default',
            description: 'Prompts for permission based on your amp.permissions settings',
          },
          {
            id: 'acceptEdits',
            name: 'Auto-accept File Changes',
            description: 'Automatically allows file create/edit/delete without prompting',
          },
          {
            id: 'bypassPermissions',
            name: 'Bypass Permissions',
            description: 'Skips all permission prompts (dangerouslyAllowAll)',
          },
          {
            id: 'plan',
            name: 'Plan Mode',
            description: 'Read-only analysis mode - tools that modify files are disabled',
          },
        ],
      },
    };
  }

  async _emitAvailableCommands(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.sentAvailableCommands) return;
    s.sentAvailableCommands = true;
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: slashCommands,
        },
      });
    } catch (e) {
      logProtocol.warn('Failed to emit available commands', { sessionId, error: e.message });
    }
  }

  async authenticate(_params) {
    throw RequestError.authRequired();
  }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    if (s) {
      s.currentModeId = params.modeId;
      logSession.debug('Mode changed', { sessionId: params.sessionId, modeId: params.modeId });
      try {
        await this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: params.modeId,
          },
        });
      } catch (e) {
        logProtocol.warn('Failed to emit mode update', { sessionId: params.sessionId, error: e.message });
      }
    }
    return {};
  }

  async setSessionModel(_params) {
    return {};
  }

  /**
   * Process slash commands from user input.
   * Handles mode commands (/plan, /code, /yolo) and agent commands (/oracle, /librarian, etc.)
   *
   * @param {string} sessionId - Session ID
   * @param {object} session - Session state object
   * @param {string} textInput - Raw text input from user
   * @returns {object} - { textInput, earlyReturn } where earlyReturn is stop reason if command handled inline
   */
  async _processSlashCommands(sessionId, session, textInput) {
    const commandMatch = textInput.trim().match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (!commandMatch) {
      return { textInput, earlyReturn: null };
    }

    const [, cmdName, cmdArg] = commandMatch;

    // Mode commands (change permission settings)
    const modeId = config.commandToMode[cmdName];
    if (modeId) {
      await this.setSessionMode({ sessionId, modeId });
      if (cmdArg?.trim()) {
        return { textInput: cmdArg.trim() + '\n', earlyReturn: null };
      }
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Switched to ${modeId} mode.` },
        },
      });
      session.active = false;
      return { textInput: '', earlyReturn: 'end_turn' };
    }

    // Agent commands (prepend prompt to trigger specific tools)
    const promptPrefix = config.commandToPrompt[cmdName];
    if (promptPrefix) {
      if (!cmdArg?.trim()) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Usage: /${cmdName} <your request>` },
          },
        });
        session.active = false;
        return { textInput: '', earlyReturn: 'end_turn' };
      }
      logSession.debug('Agent command applied', { sessionId, command: cmdName });
      return { textInput: promptPrefix + cmdArg.trim() + '\n', earlyReturn: null };
    }

    // Unknown command - pass through as regular input
    return { textInput, earlyReturn: null };
  }

  /**
   * Prepare final text input with images and mode prefixes.
   *
   * @param {string} textInput - Base text input
   * @param {string[]} imagePaths - Array of saved image file paths
   * @param {object[]} failedImages - Array of failed image info
   * @param {string} modeId - Current mode ID
   * @returns {string} - Final text input ready for backend
   */
  _buildFinalInput(textInput, imagePaths, failedImages, modeId) {
    let finalInput = textInput;

    if (imagePaths.length > 0) {
      finalInput += '\n\n[Attached images:]\n';
      for (const imgPath of imagePaths) {
        finalInput += `${imgPath}\n`;
      }
    }

    if (failedImages.length > 0) {
      finalInput += '\n\n[Warning: Some image attachments failed to load:]\n';
      for (const f of failedImages) {
        finalInput += `- Image ${f.index}: ${f.error}\n`;
      }
    }

    // Plan mode: inject system instruction for robustness
    if (modeId === 'plan') {
      const planPrefix =
        '[PLAN MODE ACTIVE: You are in read-only analysis mode. ' +
        'Analyze, research, and plan but do NOT write code or modify files. ' +
        'If the user asks you to implement something, explain your plan instead.]\n\n';
      finalInput = planPrefix + finalInput;
    }

    return finalInput;
  }

  /**
   * Handle a prompt request from the ACP client.
   *
   * Flow:
   * 1. Validate session state (reject if FAILED)
   * 2. Process slash commands (mode switching)
   * 3. Save images to temp files for attachment
   * 4. Execute via configured backend (CLI or SDK)
   * 5. Stream notifications to client
   * 6. Cleanup and return stop reason
   */
  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new RequestError(-32002, 'Session not found');

    // Block prompts on sessions that have entered failed state
    if (s.state === SessionState.FAILED) {
      throw new RequestError(-32002, 'Session is in failed state and cannot accept new prompts');
    }

    s.state = SessionState.ACTIVE;
    s.cancelled = false;
    s.active = true;
    s.lastActivityAt = Date.now(); // Update activity timestamp

    // Cleanup stale tool calls before clearing
    const staleThreshold = Date.now() - config.staleToolTimeoutMs;
    for (const [toolCallId, toolCall] of s.activeToolCalls) {
      if (toolCall.startTime < staleThreshold) {
        logProtocol.warn('Cleaning up orphaned tool call', {
          sessionId: params.sessionId,
          toolCallId,
          name: toolCall.name,
          status: toolCall.lastStatus,
          startTime: toolCall.startTime,
        });
        s.activeToolCalls.delete(toolCallId);
      }
    }

    s.activeToolCalls.clear();
    s.nestedTracker.clear();

    const cwd = s.loadedCwd || params.cwd || process.cwd();
    let ampSettingsFile = null;

    if (!s.sentAvailableCommands) {
      this._emitAvailableCommands(params.sessionId);
    }

    // Get the configured backend and check circuit breaker BEFORE allocating resources
    const backend = getBackend();
    if (!backend.isAllowed()) {
      logSpawn.warn('Backend not allowed (circuit breaker open)', { sessionId: params.sessionId });
      s.state = SessionState.FAILED;
      s.active = false;
      await this.client
        .sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Error: Too many spawn failures. Please try again later.' },
          },
        })
        .catch((e) => {
          logProtocol.warn('Failed to send spawn failure message', { sessionId: params.sessionId, error: e.message });
        });
      return { stopReason: 'refusal' };
    }

    let hadOutput = false;

    // Handle slash commands
    let textInput = this._buildTextInput(params.prompt);
    const { textInput: processedInput, earlyReturn } = await this._processSlashCommands(params.sessionId, s, textInput);
    if (earlyReturn) {
      return { stopReason: earlyReturn };
    }

    // Create settings file for CLI backend (SDK uses buildAmpOptions instead)
    if (!isSdkBackend()) {
      ampSettingsFile = await this._createAmpSettingsFileForMode(cwd, s.currentModeId);
    }

    // Create AbortController for this prompt
    const abortController = new AbortController();
    s.abortController = abortController; // Store on session for cancel() access
    const connectionSignal = await this.connectionSignalPromise;
    const onConnectionClose = () => {
      logSpawn.warn('Connection closed, aborting prompt', { sessionId: params.sessionId });
      abortController.abort();
    };
    connectionSignal?.addEventListener('abort', onConnectionClose);

    // Save images to temp files
    const {
      paths: imagePaths,
      cleanup: cleanupImages,
      failedImages,
    } = await this._saveImagesToTempFiles(params.prompt);

    // Build final input with images and mode prefixes
    textInput = this._buildFinalInput(processedInput, imagePaths, failedImages, s.currentModeId);

    // Timeout handling
    let timeoutTimer = null;
    let timedOut = false;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, config.timeoutMs);

    const clearTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    try {
      const backendOptions = {
        cwd,
        ampSettingsFile,
        modeId: s.currentModeId,
        sessionId: params.sessionId,
        clientCapabilities: this.clientCapabilities,
      };

      // Use continueThread for loaded sessions, executePrompt for new sessions
      // Note: Thread continuation only works with CLI backend; SDK backend doesn't support it yet
      const generator =
        s.threadId && !isSdkBackend()
          ? continueThread(s, s.threadId, textInput, backendOptions, abortController.signal)
          : backend.executePrompt(s, textInput, backendOptions, abortController.signal);

      // Process messages from backend
      for await (const item of generator) {
        if (timedOut) break;
        if (abortController.signal.aborted) break;

        hadOutput = true;

        if (isSdkBackend()) {
          // SDK backend yields { type: 'sdk_message', msg } or { type: 'sdk_error', error }
          if (item.type === 'sdk_error') {
            logSpawn.error('SDK execution error during iteration', {
              sessionId: params.sessionId,
              error: item.error?.message,
            });
            await this.client
              .sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `Error: ${item.error?.message || 'SDK execution failed'}` },
                },
              })
              .catch((e) => {
                logProtocol.warn('Failed to send SDK error message', { sessionId: params.sessionId, error: e.message });
              });
            break;
          }
          await this._processSdkMessage(params.sessionId, s, item.msg);
        } else {
          // CLI backend yields { type: 'message', msg } or { type: 'text', text }
          await this._processCliMessage(params.sessionId, s, item);
        }
      }

      clearTimeoutTimer();

      // Check for timeout
      if (timedOut) {
        logSpawn.error('Process timed out', { sessionId: params.sessionId, timeoutMs: config.timeoutMs });
        await s.chain;
        await this.client
          .sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Error: Amp process timed out' },
            },
          })
          .catch((e) => {
            logProtocol.warn('Failed to send timeout message', { sessionId: params.sessionId, error: e.message });
          });
        return { stopReason: 'refusal' };
      }

      // Handle abort (connection closed)
      if (abortController.signal.aborted) {
        await s.chain;
        this._cleanupSession(params.sessionId);
        return { stopReason: 'cancelled' };
      }

      if (s.cancelled) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: hadOutput ? 'end_turn' : 'refusal' };
    } catch (err) {
      logSpawn.error('Backend execution error', { sessionId: params.sessionId, error: err.message });
      await s.chain;
      await this.client
        .sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: Failed to start amp - ${err.message}` },
          },
        })
        .catch((e) => {
          logProtocol.warn('Failed to send error message', { sessionId: params.sessionId, error: e.message });
        });
      s.state = SessionState.FAILED;
      return { stopReason: 'refusal' };
    } finally {
      clearTimeoutTimer();
      connectionSignal?.removeEventListener('abort', onConnectionClose);
      s.active = false;
      s.cancelled = false;
      s.proc = null;
      s.rl = null;

      if (s.state !== SessionState.FAILED) {
        s.state = SessionState.IDLE;
      }

      await this._releaseAllTerminals(s);

      if (ampSettingsFile) {
        try {
          await fs.unlink(ampSettingsFile);
        } catch (e) {
          logSpawn.warn('Failed to cleanup temp Amp settings file', { ampSettingsFile, error: e.message });
        }
      }

      await cleanupImages();
    }
  }

  /**
   * Emit ACP notifications through the session's promise chain.
   * Common helper for both CLI and SDK message processing.
   *
   * @param {string} sessionId - Session ID
   * @param {Array} notifications - Array of ACP notification objects
   */
  _emitNotifications(sessionId, notifications) {
    for (const notif of notifications) {
      this._queueSessionUpdate(sessionId, notif);
    }
  }

  /**
   * Process a CLI backend message.
   */
  async _processCliMessage(sessionId, session, item) {
    if (item.type === 'text' || item.type === 'error') {
      // Non-JSON line or error message
      await this.client
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: item.text },
          },
        })
        .catch((e) => {
          logProtocol.warn('sessionUpdate failed', { sessionId, error: e.message });
        });
      return;
    }

    if (item.type !== 'message') {
      logProtocol.warn('Unexpected CLI message type', { sessionId, type: item.type });
      return;
    }

    const msg = item.msg;

    // Capture thread ID from result message for session persistence
    if (msg.type === 'result' && msg.session_id && !session.threadId) {
      session.threadId = msg.session_id;
      logSession.debug('Captured thread ID from CLI', { sessionId, threadId: msg.session_id });
    }

    // Handle plan updates from todo_write/todo_read
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const chunk of msg.message.content) {
        if (chunk.type === 'tool_use' && (chunk.name === 'todo_write' || chunk.name === 'todo_read')) {
          this._handlePlanToolUse(sessionId, session, chunk);
        }
        if (this.clientCapabilities?.terminal && isBashToolUse(chunk)) {
          await this._createTerminalForBash(sessionId, session, chunk);
        }
      }
    }

    // Handle terminal release on tool result
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const chunk of msg.message.content) {
        const toolResult = getToolResult(chunk);
        if (toolResult && session.terminals.has(toolResult.toolUseId)) {
          await this._releaseTerminal(session, toolResult.toolUseId);
        }
      }
    }

    const notifications = toAcpNotifications(
      msg,
      sessionId,
      session.activeToolCalls,
      this.clientCapabilities,
      session.nestedTracker,
      session.ampToAcpToolIds
    );
    this._emitNotifications(sessionId, notifications);
  }

  /**
   * Process an SDK backend message.
   */
  async _processSdkMessage(sessionId, session, msg) {
    // Capture thread ID from SDK messages for session persistence
    if (msg.session_id && !session.threadId) {
      session.threadId = msg.session_id;
      logSession.debug('Captured thread ID from SDK', { sessionId, threadId: msg.session_id });
    }

    // Extract terminal and plan actions using shared helper
    const actions = extractSdkTerminalAndPlanActions(msg);

    // Handle plan updates
    for (const plan of actions.plans) {
      this._handlePlanToolUse(sessionId, session, {
        id: plan.toolUseId,
        name: plan.type === 'write' ? 'todo_write' : 'todo_read',
        input: plan.todos ? { todos: plan.todos } : {},
      });
    }

    // Handle terminal creation for Bash tools
    if (this.clientCapabilities?.terminal) {
      for (const term of actions.terminals) {
        await this._createTerminalForBash(sessionId, session, {
          id: term.toolUseId,
          input: { cmd: term.cmd, cwd: term.cwd },
        });
      }
    }

    // Handle terminal release on tool results
    for (const release of actions.terminalReleases) {
      if (session.terminals.has(release.toolUseId)) {
        await this._releaseTerminal(session, release.toolUseId);
      }
    }

    const notifications = sdkMessageToAcpNotifications(
      msg,
      sessionId,
      session.activeToolCalls,
      this.clientCapabilities,
      session.nestedTracker,
      session.ampToAcpToolIds
    );
    this._emitNotifications(sessionId, notifications);
  }

  async _createAmpSettingsFileForMode(cwd, modeId) {
    const merged = await loadMergedAmpSettings(cwd, modeId, logSpawn);

    const tmpPath = path.join(os.tmpdir(), `amp-acp-settings-${modeId}-${randomUUID()}.json`);
    try {
      await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf8');
      return tmpPath;
    } catch (e) {
      logSpawn.warn('Failed to write temp Amp settings file', { modeId, tmpPath, error: e.message });
      return null;
    }
  }

  _buildTextInput(prompt) {
    let textInput = '';
    for (const chunk of prompt) {
      switch (chunk.type) {
        case 'text':
          textInput += chunk.text;
          break;
        case 'resource_link':
          textInput += `\n${chunk.uri}\n`;
          break;
        case 'resource':
          if ('text' in chunk.resource) {
            textInput += `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>\n`;
          }
          break;
        case 'image':
          break;
        default:
          break;
      }
    }
    return textInput;
  }

  async _saveImagesToTempFiles(prompt) {
    const imagePaths = [];
    const failedImages = [];
    const imageChunks = prompt.filter((chunk) => chunk.type === 'image' && chunk.data);

    for (let i = 0; i < imageChunks.length; i++) {
      const chunk = imageChunks[i];
      const rawExt = chunk.mediaType?.split('/')[1] || 'png';
      const ext = rawExt.replace(/[^a-z0-9]/gi, '') || 'png';
      const filename = `amp-acp-image-${randomUUID()}.${ext}`;
      const filepath = path.join(os.tmpdir(), filename);

      try {
        const buffer = Buffer.from(chunk.data, 'base64');
        await fs.writeFile(filepath, buffer);
        imagePaths.push(filepath);
      } catch (e) {
        logSpawn.warn('Failed to save image to temp file', { filepath, error: e.message });
        failedImages.push({ index: i + 1, error: e.message });
      }
    }

    const cleanup = async () => {
      for (const p of imagePaths) {
        try {
          await fs.unlink(p);
        } catch (e) {
          logSpawn.warn('Failed to cleanup temp image', { path: p, error: e.message });
        }
      }
    };

    return { paths: imagePaths, cleanup, failedImages };
  }

  _handlePlanToolUse(sessionId, session, chunk) {
    if (chunk.name === 'todo_write' && chunk.input?.todos) {
      session.plan = chunk.input.todos.map((t) => ({
        content: t.content,
        status: t.status === 'completed' ? 'completed' : t.status === 'in-progress' ? 'in_progress' : 'pending',
        priority: 'medium',
      }));
      this._emitPlanUpdate(sessionId, session);
    } else if (chunk.name === 'todo_read') {
      this._emitPlanUpdate(sessionId, session);
    }
  }

  async _createTerminalForBash(sessionId, session, chunk) {
    if (!chunk.input?.cmd) return;
    try {
      const terminal = await this.client.createTerminal({
        sessionId,
        command: 'sh',
        args: ['-c', chunk.input.cmd],
        cwd: chunk.input.cwd || process.cwd(),
      });
      session.terminals.set(chunk.id, {
        terminal,
        createdAt: Date.now(),
        leaseMs: 5 * 60 * 1000,
      });
      await this.client.sessionUpdate({
        sessionId,
        update: {
          toolCallId: chunk.id,
          sessionUpdate: 'tool_call_update',
          content: [{ type: 'terminal', terminalId: terminal.id }],
        },
      });
    } catch (e) {
      logProtocol.warn('Failed to create terminal for Bash', { sessionId, toolCallId: chunk.id, error: e.message });
    }
  }

  async _releaseTerminal(session, toolCallId) {
    const entry = session.terminals.get(toolCallId);
    if (entry) {
      try {
        await entry.terminal.release();
      } catch (e) {
        logProtocol.warn('Failed to release terminal', { toolCallId, error: e.message });
      }
      session.terminals.delete(toolCallId);
    }
  }

  async _releaseAllTerminals(session) {
    for (const [toolCallId, entry] of session.terminals) {
      try {
        await entry.terminal.release();
      } catch (e) {
        logProtocol.warn('Failed to release terminal during cleanup', { toolCallId, error: e.message });
      }
    }
    session.terminals.clear();
  }

  /**
   * Emit plan update notification.
   */
  _emitPlanUpdate(sessionId, session) {
    if (!session.plan?.length) return;

    this._queueSessionUpdate(sessionId, {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: session.plan.map((todo) => ({
          id: todo.id,
          content: todo.content,
          status: todo.status,
        })),
      },
    });
  }

  async cancel(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) return { outcome: 'cancelled' };
    if (s.active) {
      s.cancelled = true;
      logSession.debug('Cancelling session', { sessionId: params.sessionId });
      if (s.proc) {
        // CLI backend: kill the process
        safeKill(s.proc, 'SIGINT');
      } else if (s.abortController) {
        // SDK backend: abort via signal
        s.abortController.abort();
      }
    }
    return { outcome: 'cancelled' };
  }

  async readTextFile(params) {
    return this.client.readTextFile(params);
  }
  async writeTextFile(params) {
    return this.client.writeTextFile(params);
  }

  _cleanupSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    for (const [toolCallId, toolCall] of s.activeToolCalls) {
      const status = toolCall.lastStatus;
      if (status !== 'completed' && status !== 'failed') {
        logProtocol.warn('Cleaning up orphaned tool call', {
          sessionId,
          toolCallId,
          name: toolCall.name,
          status,
          startTime: toolCall.startTime,
        });
        this.client
          .sessionUpdate({
            sessionId,
            update: {
              toolCallId,
              sessionUpdate: 'tool_call_update',
              status: 'failed',
              content: [{ type: 'content', content: { type: 'text', text: 'Tool call was interrupted' } }],
            },
          })
          .catch((e) => {
            logProtocol.warn('Failed to send tool interruption message', { toolCallId, error: e.message });
          });
      }
    }

    this._releaseAllTerminals(s);
    s.nestedTracker.clear();
    s.activeToolCalls.clear();
    this.sessions.delete(sessionId);
    logSession.debug('Session cleaned up', { sessionId });
  }
}

function safeKill(proc, signal) {
  try {
    proc?.kill(signal);
  } catch {}
}
