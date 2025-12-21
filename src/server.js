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

  async initialize(_request) {
    this.clientCapabilities = _request.clientCapabilities;
    return {
      protocolVersion: config.protocolVersion,
      agentCapabilities: {
        loadSession: !isSdkBackend(), // Only CLI backend supports thread loading
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
      },
      authMethods: [],
    };
  }

  async newSession(_params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(sessionId, {
      state: SessionState.IDLE,
      proc: null,
      rl: null,
      cancelled: false,
      active: false,
      chain: Promise.resolve(),
      plan: [],
      activeToolCalls: new Map(),
      currentModeId: 'default',
      terminals: new Map(),
      nestedTracker: new NestedToolTracker(),
      sentAvailableCommands: false,
      threadId: null,
      isLoaded: false,
    });

    logSession.info('Session created', { sessionId });
    setImmediate(() => this._emitAvailableCommands(sessionId));

    return this._buildSessionResponse(sessionId);
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
    // The amp-sdk does not yet expose thread retrieval/continuation APIs.
    // Once amp-sdk adds these APIs, this restriction can be removed.
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

    // Create session state
    const sessionId = threadId; // Use thread ID as session ID for continuation
    this.sessions.set(sessionId, {
      state: SessionState.IDLE,
      proc: null,
      rl: null,
      cancelled: false,
      active: false,
      chain: Promise.resolve(),
      plan: [],
      activeToolCalls: new Map(),
      currentModeId: 'default',
      terminals: new Map(),
      nestedTracker: new NestedToolTracker(),
      sentAvailableCommands: false,
      threadId,
      isLoaded: true,
      loadedCwd: cwd,
    });

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

    // Cleanup stale tool calls (>30 min old) before clearing
    const staleThreshold = Date.now() - 30 * 60 * 1000;
    for (const [toolCallId, toolCall] of s.activeToolCalls) {
      if (toolCall.startTime < staleThreshold) {
        logProtocol.warn('Cleaning up stale tool call', {
          sessionId: params.sessionId,
          toolCallId,
          name: toolCall.name,
          ageMinutes: Math.round((Date.now() - toolCall.startTime) / (60 * 1000)),
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
    const commandMatch = textInput.trim().match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (commandMatch) {
      const [, cmdName, cmdArg] = commandMatch;

      // Mode commands (change permission settings)
      const modeId = config.commandToMode[cmdName];
      if (modeId) {
        await this.setSessionMode({ sessionId: params.sessionId, modeId });
        if (cmdArg?.trim()) {
          textInput = cmdArg.trim() + '\n';
        } else {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Switched to ${modeId} mode.` },
            },
          });
          s.active = false;
          return { stopReason: 'end_turn' };
        }
      }

      // Agent commands (prepend prompt to trigger specific tools)
      const promptPrefix = config.commandToPrompt[cmdName];
      if (promptPrefix) {
        if (!cmdArg?.trim()) {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Usage: /${cmdName} <your request>` },
            },
          });
          s.active = false;
          return { stopReason: 'end_turn' };
        }
        textInput = promptPrefix + cmdArg.trim() + '\n';
        logSession.debug('Agent command applied', { sessionId: params.sessionId, command: cmdName });
      }
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

    if (imagePaths.length > 0) {
      textInput += '\n\n[Attached images:]\n';
      for (const imgPath of imagePaths) {
        textInput += `${imgPath}\n`;
      }
    }

    if (failedImages.length > 0) {
      textInput += '\n\n[Warning: Some image attachments failed to load:]\n';
      for (const f of failedImages) {
        textInput += `- Image ${f.index}: ${f.error}\n`;
      }
    }

    // Plan mode: inject system instruction for robustness (hybrid approach)
    // This supplements the tool disabling with explicit prompting
    if (s.currentModeId === 'plan') {
      const planPrefix =
        '[PLAN MODE ACTIVE: You are in read-only analysis mode. ' +
        'Analyze, research, and plan but do NOT write code or modify files. ' +
        'If the user asks you to implement something, explain your plan instead.]\n\n';
      textInput = planPrefix + textInput;
    }

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
      session.nestedTracker
    );
    for (const notif of notifications) {
      session.chain = session.chain
        .then(() => this.client.sessionUpdate(notif))
        .catch((e) => {
          logProtocol.warn('sessionUpdate failed', { sessionId, error: e.message });
        });
    }
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
      session.nestedTracker
    );
    for (const notif of notifications) {
      session.chain = session.chain
        .then(() => this.client.sessionUpdate(notif))
        .catch((e) => {
          logProtocol.warn('sessionUpdate failed', { sessionId, error: e.message });
        });
    }
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

  async _emitPlanUpdate(sessionId, session) {
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: session.plan,
        },
      });
    } catch (e) {
      logProtocol.warn('Failed to emit plan update', { sessionId, error: e.message });
    }
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
