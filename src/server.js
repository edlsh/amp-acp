import { RequestError } from '@agentclientprotocol/sdk';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { toAcpNotifications, isBashToolUse, getToolResult, NestedToolTracker } from './to-acp.js';
import { config, buildSpawnEnv, slashCommands, getAmpSettingsOverridesForMode } from './config.js';
import { createLogger } from './logger.js';

const logSession = createLogger('acp:session');
const logProtocol = createLogger('acp:protocol');
const logSpawn = createLogger('amp:spawn');
const logStderr = createLogger('amp:stderr');

export class AmpAcpAgent {
  constructor(client, connectionSignalPromise) {
    this.client = client;
    // connectionSignalPromise resolves to AbortSignal after connection is fully initialized
    this.connectionSignalPromise = connectionSignalPromise;
    this.sessions = new Map();
  }

  async initialize(_request) {
    this.clientCapabilities = _request.clientCapabilities;
    return {
      protocolVersion: config.protocolVersion,
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        loadSession: true,
        sessionCapabilities: { fork: false, resume: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  }

  async newSession(_params) {
    const sessionId = `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(sessionId, {
      proc: null,
      rl: null,
      cancelled: false,
      active: false,
      chain: Promise.resolve(),
      plan: [],
      activeToolCalls: new Map(),
      currentModeId: 'default',
      terminals: new Map(),
      threadId: null,
      nestedTracker: new NestedToolTracker(),
      sentAvailableCommands: false,
    });

    logSession.info('Session created', { sessionId });

    // Defer command emission to ensure session/new response is processed first
    setImmediate(() => this._emitAvailableCommands(sessionId));

    return {
      sessionId,
      models: {
        currentModelId: 'default',
        availableModels: [{ modelId: 'default', name: 'Default', description: 'Amp default' }],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
          {
            id: 'acceptEdits',
            name: 'Accept Edits',
            description: 'Automatically accepts file edit permissions for the session',
          },
          { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skips all permission prompts' },
          { id: 'plan', name: 'Plan Mode', description: 'Analyze but not modify files or execute commands' },
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

  async _emitThreadInfo(sessionId, threadId) {
    try {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: `Thread: https://ampcode.com/threads/${threadId}`,
          },
        },
      });
    } catch (e) {
      logProtocol.warn('Failed to emit thread info', { sessionId, error: e.message });
    }
  }

  async authenticate(_params) {
    throw RequestError.authRequired();
  }

  async loadSession(params) {
    const threadId = params.sessionId;

    // Validate thread ID format
    if (!threadId || !threadId.startsWith('T-')) {
      throw new RequestError(-32602, 'Invalid thread ID format. Expected T-<uuid>');
    }

    logSession.info('Loading session', { threadId, cwd: params.workspaceRoot });

    // Create session with threadId preset
    this.sessions.set(threadId, {
      proc: null,
      rl: null,
      cancelled: false,
      active: false,
      chain: Promise.resolve(),
      plan: [],
      activeToolCalls: new Map(),
      currentModeId: 'default',
      terminals: new Map(),
      threadId,
      nestedTracker: new NestedToolTracker(),
      sentAvailableCommands: false,
    });

    // Fetch and replay history via amp threads markdown
    await this._replayThreadHistory(threadId, params.workspaceRoot);

    // Defer command emission to ensure session/load response is processed first
    setImmediate(() => this._emitAvailableCommands(threadId));

    return {
      sessionId: threadId,
      models: {
        currentModelId: 'default',
        availableModels: [{ modelId: 'default', name: 'Default', description: 'Amp default' }],
      },
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
          {
            id: 'acceptEdits',
            name: 'Accept Edits',
            description: 'Automatically accepts file edit permissions for the session',
          },
          { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skips all permission prompts' },
          { id: 'plan', name: 'Plan Mode', description: 'Analyze but not modify files or execute commands' },
        ],
      },
    };
  }

  async _replayThreadHistory(threadId, cwd) {
    return new Promise((resolve) => {
      execFile(
        config.ampExecutable,
        ['threads', 'markdown', threadId],
        { cwd: cwd || process.cwd(), env: buildSpawnEnv(), maxBuffer: 10 * 1024 * 1024 },
        async (error, stdout, stderr) => {
          if (error) {
            logSession.warn('Failed to fetch thread history', { threadId, error: error.message, stderr });
            // Emit a notice but don't fail - continuation will still work
            try {
              await this.client.sessionUpdate({
                sessionId: threadId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: {
                    type: 'text',
                    text: 'Note: Could not load full history. Thread continuation is available.',
                  },
                },
              });
            } catch (e) {
              logProtocol.warn('Failed to emit history notice', { threadId, error: e.message });
            }
            resolve();
            return;
          }

          // Emit history as agent message chunks
          if (stdout && stdout.trim()) {
            try {
              await this.client.sessionUpdate({
                sessionId: threadId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: stdout },
                },
              });
              logSession.debug('History replayed', { threadId, length: stdout.length });
            } catch (e) {
              logProtocol.warn('Failed to emit history', { threadId, error: e.message });
            }
          }
          resolve();
        }
      );
    });
  }

  async setSessionMode(params) {
    const s = this.sessions.get(params.sessionId);
    if (s) {
      s.currentModeId = params.modeId;
      logSession.debug('Mode changed', { sessionId: params.sessionId, modeId: params.modeId });
      // Emit mode update notification
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

  async prompt(params) {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw new RequestError(-32002, 'Session not found');
    s.cancelled = false;
    s.active = true;
    s.activeToolCalls.clear();
    s.nestedTracker.clear();

    const cwd = params.cwd || process.cwd();
    let ampSettingsFile = null;

    // Self-healing fallback: emit commands if not yet sent
    if (!s.sentAvailableCommands) {
      this._emitAvailableCommands(params.sessionId);
    }

    let procEnded = false;
    let hadOutput = false;
    let spawnError = null;

    // Check for slash command
    let textInput = this._buildTextInput(params.prompt);
    const commandMatch = textInput.trim().match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (commandMatch) {
      const [, cmdName, cmdArg] = commandMatch;
      const modeId = config.commandToMode[cmdName];
      if (modeId) {
        await this.setSessionMode({ sessionId: params.sessionId, modeId });
        // If there's additional text after the command, use that as the prompt
        if (cmdArg?.trim()) {
          textInput = cmdArg.trim() + '\n';
        } else {
          // Just the command, acknowledge and return
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
    }

    ampSettingsFile = await this._createAmpSettingsFileForMode(cwd, s.currentModeId);

    // Create AbortController for this prompt, linked to connection signal
    const abortController = new AbortController();
    // Await the deferred signal promise (resolves after connection is fully initialized)
    const connectionSignal = await this.connectionSignalPromise;
    const onConnectionClose = () => {
      logSpawn.warn('Connection closed, aborting prompt', { sessionId: params.sessionId });
      abortController.abort();
    };
    connectionSignal?.addEventListener('abort', onConnectionClose);

    // Determine spawn args: use 'threads continue' for sessions with existing threadId
    const useThreadContinue = s.threadId && s.threadId.startsWith('T-');
    const spawnArgs = useThreadContinue
      ? ['threads', 'continue', s.threadId, ...config.ampContinueFlags]
      : config.ampFlags;

    const finalSpawnArgs = ampSettingsFile ? [...spawnArgs, '--settings-file', ampSettingsFile] : spawnArgs;

    logSpawn.debug('Spawning amp process', {
      sessionId: params.sessionId,
      threadId: s.threadId,
      useThreadContinue,
      cwd,
      modeId: s.currentModeId,
      ampSettingsFile,
    });

    const proc = spawn(config.ampExecutable, finalSpawnArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSpawnEnv(),
    });

    proc.on('error', (err) => {
      spawnError = err;
      logSpawn.error('Failed to spawn amp', { sessionId: params.sessionId, error: err.message });
      if (!procEnded) {
        procEnded = true;
        this.client
          .sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Error: Failed to start amp: ${err.message}` },
            },
          })
          .catch(() => {});
      }
    });

    const rlOut = readline.createInterface({ input: proc.stdout });
    const rlErr = readline.createInterface({ input: proc.stderr });

    s.proc = proc;
    s.rl = rlOut;

    const processLine = async (line) => {
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        hadOutput = true;
        try {
          await this.client.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: line },
            },
          });
        } catch (e) {
          logProtocol.warn('sessionUpdate failed', { sessionId: params.sessionId, error: e.message });
        }
        return;
      }

      hadOutput = true;

      // Capture thread ID from Amp's session_id field (present in all messages).
      // ASSUMPTION: If multiple messages arrive before the first is processed via s.chain,
      // the first message with session_id wins. This is correct because Amp uses the same
      // thread ID for all messages in a session.
      if (msg.session_id && !s.threadId) {
        s.threadId = msg.session_id;
        logSession.debug('Thread established', { sessionId: params.sessionId, threadId: msg.session_id });
        // Emit thread URL for client reference
        this._emitThreadInfo(params.sessionId, msg.session_id);
      }

      // Handle plan updates from todo_write/todo_read
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const chunk of msg.message.content) {
          if (chunk.type === 'tool_use' && (chunk.name === 'todo_write' || chunk.name === 'todo_read')) {
            this._handlePlanToolUse(params.sessionId, s, chunk);
          }
          // Handle Terminal API for Bash tool
          if (this.clientCapabilities?.terminal && isBashToolUse(chunk)) {
            await this._createTerminalForBash(params.sessionId, s, chunk);
          }
        }
      }

      // Handle terminal release on tool result
      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const chunk of msg.message.content) {
          const toolResult = getToolResult(chunk);
          if (toolResult && s.terminals.has(toolResult.toolUseId)) {
            await this._releaseTerminal(s, toolResult.toolUseId);
          }
        }
      }

      const notifications = toAcpNotifications(
        msg,
        params.sessionId,
        s.activeToolCalls,
        this.clientCapabilities,
        s.nestedTracker
      );
      for (const notif of notifications) {
        try {
          await this.client.sessionUpdate(notif);
        } catch (e) {
          logProtocol.warn('sessionUpdate failed', { sessionId: params.sessionId, error: e.message });
        }
      }
    };

    rlOut.on('line', (line) => {
      s.chain = s.chain
        .then(() => processLine(line))
        .catch((e) => {
          logProtocol.error('Line processing error', { sessionId: params.sessionId, error: e.message });
        });
    });

    rlErr.on('line', (line) => {
      logStderr.debug('amp stderr', { sessionId: params.sessionId, line });
    });

    if (!textInput.endsWith('\n')) textInput += '\n';

    proc.stdin.on('error', (err) => {
      logSpawn.warn('stdin error', { sessionId: params.sessionId, error: err.message });
    });
    proc.stdin.write(textInput);
    proc.stdin.end();

    // Timer reference for cleanup
    let timeoutTimer = null;
    const clearTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    try {
      const result = await Promise.race([
        new Promise((resolve) => {
          proc.on('close', (code, signal) => {
            procEnded = true;
            clearTimeoutTimer();
            safeClose(rlOut);
            safeClose(rlErr);
            s.chain.then(() => resolve({ type: 'closed', code, signal }));
          });
        }),
        new Promise((resolve) => {
          timeoutTimer = setTimeout(() => resolve({ type: 'timeout' }), config.timeoutMs);
        }),
        new Promise((resolve) => {
          abortController.signal.addEventListener('abort', () => {
            clearTimeoutTimer();
            resolve({ type: 'connection_closed' });
          });
        }),
      ]);

      if (result.type === 'connection_closed') {
        logSpawn.warn('Connection closed during prompt, killing process', { sessionId: params.sessionId });
        safeKill(proc, 'SIGKILL');
        safeClose(rlOut);
        safeClose(rlErr);
        // Wait for queued event processing to complete before returning
        await s.chain;
        this._cleanupSession(params.sessionId);
        return { stopReason: 'cancelled' };
      }

      if (result.type === 'timeout') {
        logSpawn.error('Process timed out', { sessionId: params.sessionId, timeoutMs: config.timeoutMs });
        safeKill(proc, 'SIGKILL');
        safeClose(rlOut);
        safeClose(rlErr);
        // Wait for queued event processing to complete before returning
        await s.chain;
        await this.client
          .sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Error: Amp process timed out' },
            },
          })
          .catch(() => {});
        return { stopReason: 'refusal' };
      }

      if (spawnError) {
        return { stopReason: 'refusal' };
      }

      if (s.cancelled) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: hadOutput ? 'end_turn' : 'refusal' };
    } finally {
      connectionSignal?.removeEventListener('abort', onConnectionClose);
      s.active = false;
      s.cancelled = false;
      s.proc = null;
      s.rl = null;

      if (ampSettingsFile) {
        try {
          await fs.unlink(ampSettingsFile);
        } catch {}
      }
    }
  }

  async _createAmpSettingsFileForMode(cwd, modeId) {
    const overrides = getAmpSettingsOverridesForMode(modeId);

    // Preserve existing global + workspace settings while enforcing the selected mode.
    const baseSettings = {
      ...(await readJsonFile(getDefaultAmpSettingsPath())),
      ...(await readJsonFile(path.join(cwd, '.amp', 'settings.json'))),
    };

    const merged = { ...baseSettings };
    merged['amp.dangerouslyAllowAll'] = overrides.dangerouslyAllowAll;

    if (Array.isArray(overrides.prependPermissions) && overrides.prependPermissions.length > 0) {
      const existing = Array.isArray(merged['amp.permissions']) ? merged['amp.permissions'] : [];
      merged['amp.permissions'] = [...overrides.prependPermissions, ...existing];
    }

    if (Array.isArray(overrides.disableTools) && overrides.disableTools.length > 0) {
      const existing = Array.isArray(merged['amp.tools.disable']) ? merged['amp.tools.disable'] : [];
      merged['amp.tools.disable'] = uniqStrings([...existing, ...overrides.disableTools]);
    }

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

  _handlePlanToolUse(sessionId, session, chunk) {
    if (chunk.name === 'todo_write' && chunk.input?.todos) {
      session.plan = chunk.input.todos.map((t) => ({
        content: t.content,
        status: t.status === 'completed' ? 'completed' : t.status === 'in-progress' ? 'in_progress' : 'pending',
        priority: 'medium',
      }));
      this._emitPlanUpdate(sessionId, session);
    } else if (chunk.name === 'todo_read') {
      // Emit current plan state when Amp reads todos
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
      session.terminals.set(chunk.id, terminal);
      // Emit tool_call_update with terminal content
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
    const terminal = session.terminals.get(toolCallId);
    if (terminal) {
      try {
        await terminal.release();
      } catch (e) {
        logProtocol.warn('Failed to release terminal', { toolCallId, error: e.message });
      }
      session.terminals.delete(toolCallId);
    }
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
    if (!s) return {};
    if (s.active && s.proc) {
      s.cancelled = true;
      logSession.debug('Cancelling session', { sessionId: params.sessionId });
      safeKill(s.proc, 'SIGINT');
    }
    return {};
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
    for (const terminal of s.terminals.values()) {
      try {
        terminal.release();
      } catch {}
    }
    s.terminals.clear();
    s.nestedTracker.clear();
    this.sessions.delete(sessionId);
    logSession.debug('Session cleaned up', { sessionId });
  }
}

function getDefaultAmpSettingsPath() {
  // Environment variable takes precedence, mirroring `amp --settings-file` default resolution.
  if (process.env.AMP_SETTINGS_FILE) return process.env.AMP_SETTINGS_FILE;
  const home = os.homedir?.() || process.env.HOME;
  if (!home) return null;
  return path.join(home, '.config', 'amp', 'settings.json');
}

async function readJsonFile(filePath) {
  if (!filePath) return {};
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      logSpawn.warn('Failed to read Amp settings file', { filePath, error: e.message });
    }
    return {};
  }
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
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
