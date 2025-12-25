// Adapters for converting @sourcegraph/amp-sdk messages to ACP notifications.
// Provides two approaches:
// 1. adaptSdkMessage: Converts SDK messages to Amp CLI JSON format (for reusing toAcpNotifications)
// 2. sdkMessageToAcpNotifications: Direct conversion from SDK to ACP notifications

import { config, getToolKind, getToolTitle, getToolLocations, isFileEditTool } from './config.js';
import { NestedToolTracker as _NestedToolTracker } from './to-acp.js';
import { randomUUID } from 'node:crypto';

/**
 * Adapt SDK message to Amp CLI JSON format.
 * Allows reuse of existing toAcpNotifications logic.
 *
 * @param {object} sdkMessage - Message from @sourcegraph/amp-sdk
 * @returns {object|null} - Amp CLI JSON message or null if no mapping
 */
export function adaptSdkMessage(sdkMessage) {
  if (!sdkMessage?.type) return null;

  switch (sdkMessage.type) {
    case 'system':
      // SDK system message → CLI system/init
      return {
        type: 'system',
        subtype: 'init',
        session_id: sdkMessage.session_id,
        tools: sdkMessage.tools || [],
        mcp_servers: sdkMessage.mcp_servers || [],
      };

    case 'assistant':
      // SDK assistant message → CLI assistant message
      return {
        type: 'assistant',
        parent_tool_use_id: sdkMessage.parent_tool_use_id,
        message: {
          content: adaptAssistantContent(sdkMessage.message?.content || []),
        },
      };

    case 'user':
      // SDK user message (tool results) → CLI user message
      return {
        type: 'user',
        message: {
          content: adaptUserContent(sdkMessage.message?.content || []),
        },
      };

    case 'result':
      // SDK result message → CLI result
      return {
        type: 'result',
        subtype: sdkMessage.subtype || (sdkMessage.is_error ? 'error_during_execution' : 'success'),
        result: sdkMessage.result,
        error: sdkMessage.is_error ? sdkMessage.result : undefined,
        is_error: sdkMessage.is_error,
      };

    default:
      return null;
  }
}

/**
 * Convert SDK assistant content array to CLI format.
 * @param {Array} content - SDK content array
 * @returns {Array} - CLI-compatible content array
 */
function adaptAssistantContent(content) {
  if (!Array.isArray(content)) return [];

  return content.map((chunk) => {
    switch (chunk.type) {
      case 'text':
        return { type: 'text', text: chunk.text };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: chunk.id,
          name: chunk.name,
          input: chunk.input || {},
        };
      case 'thinking':
        return { type: 'thinking', thinking: chunk.thinking };
      default:
        return chunk;
    }
  });
}

/**
 * Convert SDK user content array to CLI format.
 * @param {Array} content - SDK content array
 * @returns {Array} - CLI-compatible content array
 */
function adaptUserContent(content) {
  if (!Array.isArray(content)) return [];

  return content.map((chunk) => {
    if (chunk.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: chunk.tool_use_id,
        content: chunk.content,
        is_error: chunk.is_error || false,
      };
    }
    return chunk;
  });
}

/**
 * Convert SDK message directly to ACP notifications.
 * Provides consistent handling with CLI messages while working directly
 * with SDK message format.
 *
 * @param {object} sdkMessage - Message from @sourcegraph/amp-sdk
 * @param {string} sessionId - ACP session ID
 * @param {Map} activeToolCalls - Map tracking active tool calls
 * @param {object} clientCapabilities - ACP client capabilities (unused currently)
 * @param {NestedToolTracker|null} nestedTracker - Tracker for nested tool calls
 * @param {Map} ampToAcpToolIds - Persistent SDK→ACP ID mapping for tool result correlation
 * @returns {Array} - Array of ACP notification objects
 */
export function sdkMessageToAcpNotifications(
  sdkMessage,
  sessionId,
  activeToolCalls = new Map(),
  _clientCapabilities = {},
  nestedTracker = null,
  ampToAcpToolIds = new Map()
) {
  if (!sdkMessage?.type) return [];

  const output = [];
  const inlineMode = config.nestedToolMode === 'inline';
  const flatMode = config.nestedToolMode === 'flat';

  /**
   * Generate a session-unique ACP tool call ID from an SDK tool_use_id.
   * Uses cryptographic UUID to prevent collisions under concurrency.
   * Persists mapping in ampToAcpToolIds for correlation on tool_result.
   */
  const getUniqueToolCallId = (sdkId) => {
    // If we've already mapped this SDK ID, reuse it (idempotent for replays)
    const existing = ampToAcpToolIds.get(sdkId);
    if (existing) return existing;

    // Check if sdkId is already unique in activeToolCalls
    if (!activeToolCalls.has(sdkId)) {
      ampToAcpToolIds.set(sdkId, sdkId);
      return sdkId;
    }

    // Generate cryptographically unique ID to prevent collision
    let acpId;
    do {
      acpId = `${sdkId}_${randomUUID().slice(0, 8)}`;
    } while (activeToolCalls.has(acpId));

    ampToAcpToolIds.set(sdkId, acpId);
    return acpId;
  };

  /**
   * Find the ACP tool call ID for a given SDK tool_use_id.
   * Uses ampToAcpToolIds for persistent mapping that survives activeToolCalls.delete().
   */
  const findAcpToolCallId = (sdkId) => {
    // Check persistent mapping first (survives activeToolCalls cleanup)
    const mapped = ampToAcpToolIds.get(sdkId);
    if (mapped) return mapped;

    // Direct match in activeToolCalls (legacy fallback)
    if (activeToolCalls.has(sdkId)) {
      return sdkId;
    }

    // Search for mapped ID in activeToolCalls (defensive fallback)
    for (const [acpId, toolCall] of activeToolCalls) {
      if (toolCall.sdkId === sdkId) {
        return acpId;
      }
    }
    return null;
  };

  switch (sdkMessage.type) {
    case 'system':
      // Emit session info as thought (like CLI thread URL)
      if (sdkMessage.session_id) {
        const mcpList = sdkMessage.mcp_servers?.map((s) => `${s.name} (${s.status})`).join(', ') || 'none';
        output.push({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: {
              type: 'text',
              text: `Session started. Tools: ${sdkMessage.tools?.length || 0}, MCP Servers: ${mcpList}`,
            },
          },
        });
      }
      break;

    case 'assistant':
      if (Array.isArray(sdkMessage.message?.content)) {
        for (const chunk of sdkMessage.message.content) {
          if (chunk.type === 'text') {
            // Text from subagent goes to parent in inline mode
            if (sdkMessage.parent_tool_use_id && inlineMode && !flatMode) {
              continue;
            }
            output.push({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: chunk.text },
              },
            });
          } else if (chunk.type === 'tool_use') {
            const sdkId = chunk.id;
            const acpToolCallId = getUniqueToolCallId(sdkId);
            const isChildTool = !!sdkMessage.parent_tool_use_id;

            // Inline mode: embed child tools in parent content
            if (inlineMode && !flatMode && isChildTool && nestedTracker) {
              nestedTracker.registerChild(sdkId, sdkMessage.parent_tool_use_id, chunk.name, chunk.input);
              output.push({
                sessionId,
                update: {
                  toolCallId: sdkMessage.parent_tool_use_id,
                  sessionUpdate: 'tool_call_update',
                  content: nestedTracker.getContentArray(sdkMessage.parent_tool_use_id),
                },
              });
              continue;
            }

            const locations = getToolLocations(chunk.name, chunk.input);
            const meta =
              !flatMode && sdkMessage.parent_tool_use_id
                ? { parentToolCallId: sdkMessage.parent_tool_use_id }
                : undefined;

            activeToolCalls.set(acpToolCallId, {
              sdkId,
              name: chunk.name,
              input: chunk.input, // Store input for diff content generation
              startTime: Date.now(),
              lastStatus: 'in_progress',
            });

            const parentIdForTitle = flatMode ? null : sdkMessage.parent_tool_use_id;

            output.push({
              sessionId,
              update: {
                toolCallId: acpToolCallId,
                sessionUpdate: 'tool_call',
                rawInput: JSON.stringify(chunk.input),
                status: 'in_progress',
                title: getToolTitle(chunk.name, parentIdForTitle, chunk.input),
                kind: getToolKind(chunk.name),
                content: [],
                ...(locations.length > 0 && { locations }),
                ...(meta && { _meta: meta }),
              },
            });
          } else if (chunk.type === 'thinking') {
            output.push({
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: chunk.thinking },
              },
            });
          }
        }
      }
      break;

    case 'user':
      if (Array.isArray(sdkMessage.message?.content)) {
        for (const chunk of sdkMessage.message.content) {
          // Note: Unlike CLI path, SDK doesn't need validateStatusTransition() because
          // tool_use and tool_result arrive in strict pairs from the SDK (no streaming timing issues)
          if (chunk.type === 'tool_result') {
            const isError = chunk.is_error;
            const status = isError ? 'failed' : 'completed';
            const sdkId = chunk.tool_use_id;
            const acpToolCallId = findAcpToolCallId(sdkId) || sdkId;

            // Handle child tool results in inline mode
            if (inlineMode && !flatMode && nestedTracker) {
              const childInfo = nestedTracker.completeChild(sdkId, isError);
              if (childInfo) {
                output.push({
                  sessionId,
                  update: {
                    toolCallId: childInfo.parentToolUseId,
                    sessionUpdate: 'tool_call_update',
                    content: nestedTracker.getContentArray(childInfo.parentToolUseId),
                  },
                });
                continue;
              }
            }

            const toolCall = activeToolCalls.get(acpToolCallId);
            activeToolCalls.delete(acpToolCallId);

            // Generate diff content for file edit tools, regular content otherwise
            const content =
              !isError && toolCall && isFileEditTool(toolCall.name)
                ? toAcpDiffContent(toolCall.name, toolCall.input, chunk.content)
                : toAcpContentArray(chunk.content, isError);

            output.push({
              sessionId,
              update: {
                toolCallId: acpToolCallId,
                sessionUpdate: 'tool_call_update',
                status,
                content,
              },
            });
          }
        }
      }
      break;

    case 'result':
      if (
        sdkMessage.subtype === 'error_during_execution' ||
        sdkMessage.subtype === 'error_max_turns' ||
        sdkMessage.is_error
      ) {
        const errorText = sdkMessage.error || sdkMessage.result || 'Unknown error';
        output.push({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${errorText}` },
          },
        });
      }
      break;
  }

  return output;
}

/**
 * Convert content to ACP content array format.
 */
function toAcpContentArray(content, isError = false) {
  if (Array.isArray(content) && content.length > 0) {
    return content.map((c) => ({
      type: 'content',
      content: c.type === 'text' ? { type: 'text', text: isError ? wrapCode(c.text) : c.text } : c,
    }));
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'content', content: { type: 'text', text: isError ? wrapCode(content) : content } }];
  }
  return [];
}

function wrapCode(t) {
  return '```\n' + t + '\n```';
}

/**
 * Convert file edit tool result to ACP diff content format.
 * Extracts path, oldText, and newText from stored tool input.
 *
 * @param {string} toolName - 'edit_file' or 'create_file'
 * @param {object} input - Original tool input (path, old_str/new_str or content)
 * @param {string|Array} resultContent - Tool result content (for fallback)
 * @returns {Array} - ACP content array with diff type
 */
function toAcpDiffContent(toolName, input, resultContent) {
  if (!input?.path) {
    // Missing path - fall back to regular content
    return toAcpContentArray(resultContent, false);
  }

  if (toolName === 'create_file') {
    // create_file: newText only (file didn't exist)
    return [
      {
        type: 'content',
        content: {
          type: 'diff',
          path: input.path,
          newText: input.content || '',
        },
      },
    ];
  }

  if (toolName === 'edit_file') {
    // edit_file: old_str → new_str as partial diff
    return [
      {
        type: 'content',
        content: {
          type: 'diff',
          path: input.path,
          oldText: input.old_str || '',
          newText: input.new_str || '',
        },
      },
    ];
  }

  // Unknown tool - fall back to regular content
  return toAcpContentArray(resultContent, false);
}

/**
 * Check if an SDK content chunk is a Bash tool_use
 */
export function isSdkBashToolUse(chunk) {
  return chunk?.type === 'tool_use' && chunk?.name === 'Bash';
}

/**
 * Extract tool result info from an SDK tool_result chunk
 */
export function getSdkToolResult(chunk) {
  if (chunk?.type !== 'tool_result') return null;
  return { toolUseId: chunk.tool_use_id };
}

/**
 * Check if an SDK content chunk is a Plan tool (todo_write or todo_read)
 * Used for triggering ACP plan updates
 */
export function isSdkPlanToolUse(chunk) {
  return chunk?.type === 'tool_use' && (chunk?.name === 'todo_write' || chunk?.name === 'todo_read');
}

/**
 * Extract plan data from an SDK todo_write tool_use chunk
 * Returns null if not a todo_write or missing todos
 * @param {object} chunk - SDK content chunk
 * @returns {{todos: Array}|null} - Plan data or null
 */
export function extractPlanFromSdkToolUse(chunk) {
  if (chunk?.type !== 'tool_use' || chunk?.name !== 'todo_write') return null;
  if (!chunk?.input?.todos) return null;
  return { todos: chunk.input.todos };
}

/**
 * Process SDK message for Terminal and Plan features
 * Returns actions that should be taken by the server
 *
 * This helper allows server.js to detect Terminal/Plan tool calls from SDK messages
 * without duplicating detection logic.
 *
 * @param {object} sdkMessage - Message from @sourcegraph/amp-sdk
 * @returns {{terminals: Array, plans: Array}} - Actions to take
 *   - terminals: Array of {toolUseId, cmd, cwd} for Bash tools needing terminal creation
 *   - plans: Array of {type: 'write'|'read', toolUseId, todos?} for plan updates
 *   - terminalReleases: Array of {toolUseId} for completed Bash tools
 */
export function extractSdkTerminalAndPlanActions(sdkMessage) {
  const result = {
    terminals: [],
    plans: [],
    terminalReleases: [],
  };

  if (!sdkMessage?.type) return result;

  // Handle assistant messages (tool_use)
  if (sdkMessage.type === 'assistant' && Array.isArray(sdkMessage.message?.content)) {
    for (const chunk of sdkMessage.message.content) {
      // Bash tool → terminal creation
      if (isSdkBashToolUse(chunk) && chunk.input?.cmd) {
        result.terminals.push({
          toolUseId: chunk.id,
          cmd: chunk.input.cmd,
          cwd: chunk.input.cwd,
        });
      }

      // Plan tool → plan update
      if (isSdkPlanToolUse(chunk)) {
        if (chunk.name === 'todo_write' && chunk.input?.todos) {
          result.plans.push({
            type: 'write',
            toolUseId: chunk.id,
            todos: chunk.input.todos,
          });
        } else if (chunk.name === 'todo_read') {
          result.plans.push({
            type: 'read',
            toolUseId: chunk.id,
          });
        }
      }
    }
  }

  // Handle user messages (tool_result) → terminal release
  if (sdkMessage.type === 'user' && Array.isArray(sdkMessage.message?.content)) {
    for (const chunk of sdkMessage.message.content) {
      const toolResult = getSdkToolResult(chunk);
      if (toolResult) {
        // Server will check if this toolUseId has an active terminal
        result.terminalReleases.push({ toolUseId: toolResult.toolUseId });
      }
    }
  }

  return result;
}
