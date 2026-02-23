// Convert Amp stream JSON events to ACP sessionUpdate notifications.
// Schema reference: https://ampcode.com/manual/appendix#stream-json-output

import { randomUUID } from 'node:crypto';
import {
  config,
  getToolKind,
  getToolTitle,
  getToolLocations,
  getInlineToolDescription,
  isFileEditTool,
} from './config.js';
import { createLogger } from './logger.js';

const logProtocol = createLogger('acp:protocol');

/**
 * State tracker for nested tool call handling
 * Tracks mapping between Amp tool_use_id and child tool metadata
 * Also tracks per-parent progress counters for consolidated display
 */
export class NestedToolTracker {
  constructor() {
    // Map: childToolUseId → { parentToolUseId, name, input, status, index }
    this.childTools = new Map();
    // Map: parentToolUseId → { total, completed, failed, children: [{id, name, input, status}] }
    this.parentStats = new Map();
    // How many completed/failed items to show before collapsing
    this.maxVisibleCompleted = 3;
    this.maxVisibleFailed = 5; // Show first 2 + last 3 when collapsed
  }

  registerChild(childId, parentId, name, input) {
    // Initialize parent stats if needed
    if (!this.parentStats.has(parentId)) {
      this.parentStats.set(parentId, { total: 0, completed: 0, failed: 0, children: [] });
    }
    const stats = this.parentStats.get(parentId);
    const index = stats.total;
    stats.total++;
    stats.children.push({ id: childId, name, input, status: 'running' });

    this.childTools.set(childId, { parentToolUseId: parentId, name, input, status: 'running', index });
  }

  getChild(childId) {
    return this.childTools.get(childId);
  }

  completeChild(childId, isError) {
    const child = this.childTools.get(childId);
    if (child) {
      child.status = isError ? 'failed' : 'completed';

      // Update parent stats
      const stats = this.parentStats.get(child.parentToolUseId);
      if (stats) {
        if (isError) {
          stats.failed++;
        } else {
          stats.completed++;
        }
        // Update child in children array
        const childEntry = stats.children.find((c) => c.id === childId);
        if (childEntry) {
          childEntry.status = child.status;
        }
      }
    }
    return child;
  }

  getParentStats(parentId) {
    return this.parentStats.get(parentId);
  }

  isChildTool(childId) {
    return this.childTools.has(childId);
  }

  /**
   * Get full content array for a parent tool (ACP replaces content on each update)
   * Returns array of content objects ready for ACP tool_call_update
   */
  // eslint-disable-next-line complexity
  getContentArray(parentId) {
    const stats = this.parentStats.get(parentId);
    if (!stats) return [];

    const lines = [];
    // Separate children by status for smart display
    const running = [];
    const failed = [];
    const completed = [];
    for (const child of stats.children) {
      if (child.status === 'running') {
        running.push(child);
      } else if (child.status === 'failed') {
        failed.push(child);
      } else {
        completed.push(child);
      }
    }

    // Always show all running items (need visibility for active work)
    for (const child of running) {
      lines.push(`◐ ${getInlineToolDescription(child.name, child.input)}`);
    }

    // Collapse failed items if too many (show first N + last M)
    if (failed.length > this.maxVisibleFailed) {
      const firstCount = Math.min(2, this.maxVisibleFailed);
      const lastCount = Math.max(0, this.maxVisibleFailed - firstCount);
      const hiddenFailed = failed.length - this.maxVisibleFailed;
      for (const child of failed.slice(0, firstCount)) {
        lines.push(`✗ ${getInlineToolDescription(child.name, child.input)}`);
      }
      lines.push(`✗ ... ${hiddenFailed} more failed`);
      if (lastCount > 0) {
        for (const child of failed.slice(-lastCount)) {
          lines.push(`✗ ${getInlineToolDescription(child.name, child.input)}`);
        }
      }
    } else {
      for (const child of failed) {
        lines.push(`✗ ${getInlineToolDescription(child.name, child.input)}`);
      }
    }

    // Show only the most recent completed items, collapse older ones
    const hiddenCompleted = completed.length - this.maxVisibleCompleted;
    if (hiddenCompleted > 0) {
      lines.push(`✓ ... ${hiddenCompleted} more completed`);
    }
    const visibleCompleted = completed.slice(-this.maxVisibleCompleted);
    for (const child of visibleCompleted) {
      lines.push(`✓ ${getInlineToolDescription(child.name, child.input)}`);
    }

    // Add progress summary using stats counts (not local arrays)
    const completedCount = stats.completed;
    const failedCount = stats.failed;
    const totalCount = stats.total;
    const doneCount = completedCount + failedCount;
    const runningCount = totalCount - doneCount;
    const parts = [];
    if (runningCount > 0) parts.push(`${runningCount} running`);
    if (completedCount > 0) parts.push(`${completedCount} done`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);

    if (parts.length > 0) {
      lines.push(`── ${parts.join(', ')} (${doneCount}/${totalCount}) ──`);
    }

    // Return as ACP content array (single text block with all lines)
    return [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }];
  }

  clear() {
    this.childTools.clear();
    this.parentStats.clear();
  }
}

// eslint-disable-next-line complexity
export function toAcpNotifications(
  msg,
  sessionId,
  activeToolCalls = new Map(),
  _clientCapabilities = {},
  nestedTracker = null,
  ampToAcpToolIds = new Map()
) {
  const output = [];
  const inlineMode = config.nestedToolMode === 'inline';
  const flatMode = config.nestedToolMode === 'flat';

  /**
   * Generate a session-unique ACP tool call ID from an Amp tool_use_id.
   * Uses cryptographic UUID to prevent collisions under concurrency.
   * Persists mapping in ampToAcpToolIds for correlation on tool_result.
   * @param {string} ampId - Original Amp tool_use_id
   * @returns {string} - Session-unique ACP tool call ID
   */
  const getUniqueToolCallId = (ampId) => {
    // If we've already mapped this Amp ID, reuse it (idempotent for replays)
    const existing = ampToAcpToolIds.get(ampId);
    if (existing) return existing;

    // Check if ampId is already unique in activeToolCalls
    if (!activeToolCalls.has(ampId)) {
      ampToAcpToolIds.set(ampId, ampId);
      return ampId;
    }

    // Generate cryptographically unique ID to prevent collision
    let acpId;
    do {
      acpId = `${ampId}_${randomUUID().slice(0, 8)}`;
    } while (activeToolCalls.has(acpId));

    ampToAcpToolIds.set(ampId, acpId);
    logProtocol.warn('Generated unique toolCallId for duplicate', {
      originalId: ampId,
      uniqueId: acpId,
      sessionId,
    });
    return acpId;
  };

  /**
   * Find the ACP tool call ID for a given Amp tool_use_id.
   * Uses ampToAcpToolIds for persistent mapping that survives activeToolCalls.delete().
   * @param {string} ampId - Original Amp tool_use_id from tool_result
   * @returns {string|null} - ACP tool call ID or null if not found
   */
  const findAcpToolCallId = (ampId) => {
    // Check persistent mapping first (survives activeToolCalls cleanup)
    const mapped = ampToAcpToolIds.get(ampId);
    if (mapped) return mapped;

    // Direct match in activeToolCalls (legacy fallback)
    if (activeToolCalls.has(ampId)) {
      return ampId;
    }

    // Search for mapped ID in activeToolCalls (defensive fallback)
    for (const [acpId, toolCall] of activeToolCalls) {
      if (toolCall.ampId === ampId) {
        return acpId;
      }
    }
    return null;
  };

  // Track tool call state transitions for validation
  // Allow repeated terminal statuses for idempotent duplicate handling
  const validateStatusTransition = (toolCallId, newStatus) => {
    const existingCall = activeToolCalls.get(toolCallId);
    if (!existingCall) return true; // New tool call

    const currentStatus = existingCall.lastStatus;
    const validTransitions = {
      in_progress: ['completed', 'failed'],
      completed: ['completed'], // Allow repeated for idempotent duplicates
      failed: ['failed'], // Allow repeated for idempotent duplicates
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      logProtocol.warn('Invalid status transition', {
        toolCallId,
        from: currentStatus,
        to: newStatus,
        validTransitions: validTransitions[currentStatus],
      });
      return false;
    }
    return true;
  };

  /* eslint-disable max-depth */
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        const mcpList = msg.mcp_servers?.map((s) => `${s.name} (${s.status})`).join(', ') || 'none';
        output.push({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: {
              type: 'text',
              text: `Session started. Tools: ${msg.tools?.length || 0}, MCP Servers: ${mcpList}`,
            },
          },
        });
      }
      break;

    case 'user':
      // User messages contain tool_result content
      if (Array.isArray(msg.message?.content)) {
        for (const chunk of msg.message.content) {
          if (chunk.type === 'tool_result') {
            const isError = chunk.is_error;
            const status = isError ? 'failed' : 'completed';
            const ampId = chunk.tool_use_id;

            // Find the ACP tool call ID (handles remapped IDs)
            const acpToolCallId = findAcpToolCallId(ampId) || ampId;

            // Validate status transition before emitting
            if (!validateStatusTransition(acpToolCallId, status)) {
              logProtocol.warn('Skipping invalid tool result status transition', {
                toolCallId: acpToolCallId,
                ampId,
                attemptedStatus: status,
              });
              continue;
            }

            // Check if this is a child tool result in inline mode
            // In flat mode, child results are emitted as independent tool_call_updates
            if (inlineMode && !flatMode && nestedTracker) {
              const childInfo = nestedTracker.completeChild(ampId, isError);
              if (childInfo) {
                // Emit full content array on PARENT (ACP replaces content, not appends)
                output.push({
                  sessionId,
                  update: {
                    toolCallId: childInfo.parentToolUseId,
                    sessionUpdate: 'tool_call_update',
                    content: nestedTracker.getContentArray(childInfo.parentToolUseId),
                  },
                });
                continue; // Don't emit separate tool_call_update for child
              }
            }

            // Normal (non-child) tool result
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
          // Ignore text chunks in user messages - they're internal model context, not user input
        }
      }
      break;

    case 'assistant':
      if (Array.isArray(msg.message?.content)) {
        for (const chunk of msg.message.content) {
          if (chunk.type === 'text') {
            // Text from subagent goes to parent as thought, not message
            // In flat mode, show subagent text as regular messages
            if (msg.parent_tool_use_id && inlineMode && !flatMode) {
              // Skip subagent text in inline mode - the summary comes in tool_result
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
            // Generate session-unique tool call ID (handles duplicates)
            const ampId = chunk.id;
            const acpToolCallId = getUniqueToolCallId(ampId);

            const isChildTool = !!msg.parent_tool_use_id;

            // In inline mode, embed child tool calls into parent's content
            // In flat mode, emit all tools as independent top-level calls
            if (inlineMode && !flatMode && isChildTool && nestedTracker) {
              // Register this child tool (use original ampId for Amp correlation)
              nestedTracker.registerChild(ampId, msg.parent_tool_use_id, chunk.name, chunk.input);

              // Emit full content array on the parent (ACP replaces content, not appends)
              output.push({
                sessionId,
                update: {
                  toolCallId: msg.parent_tool_use_id,
                  sessionUpdate: 'tool_call_update',
                  content: nestedTracker.getContentArray(msg.parent_tool_use_id),
                },
              });
              continue; // Don't emit separate tool_call for child
            }

            // Build locations array for file-based tools
            const locations = getToolLocations(chunk.name, chunk.input);

            // Build _meta for nested tool calls (subagent/oracle) in separate mode
            // In flat mode, omit _meta to treat all tools as independent
            const meta = !flatMode && msg.parent_tool_use_id ? { parentToolCallId: msg.parent_tool_use_id } : undefined;

            // Track tool call state with ampId mapping - start directly as in_progress
            activeToolCalls.set(acpToolCallId, {
              ampId, // Store original Amp ID for correlation
              name: chunk.name,
              input: chunk.input, // Store input for diff content generation
              startTime: Date.now(),
              lastStatus: 'in_progress',
            });

            // In flat mode, omit [Subagent] prefix since tools appear independent
            const parentIdForTitle = flatMode ? null : msg.parent_tool_use_id;

            // Emit tool_call with status: in_progress directly (skip pending for atomic emission)
            // This prevents orphan states if the first emission fails
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

    case 'result': {
      const usageUpdate = toAcpUsageUpdate(msg);
      if (usageUpdate) {
        output.push({
          sessionId,
          update: usageUpdate,
        });
      }

      // Final result - could emit a summary if needed
      if (msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
        output.push({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Error: ${msg.error}` },
          },
        });
      }
      break;
    }

    default:
      break;
  }
  /* eslint-enable max-depth */

  return output;
}

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

function getNumericValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Extract ACP usage_update payload from an Amp result message.
 * Supports both ACP-native shape ({size, used, cost}) and token-based shape
 * ({input_tokens, output_tokens, total_tokens}).
 *
 * @param {object} msg - Amp result message
 * @returns {object|null} ACP usage_update object or null when unavailable
 */
// eslint-disable-next-line complexity
function toAcpUsageUpdate(msg) {
  const usage =
    msg?.usage && typeof msg.usage === 'object'
      ? msg.usage
      : msg?.result?.usage && typeof msg.result.usage === 'object'
        ? msg.result.usage
        : null;

  if (!usage) return null;

  let size = getNumericValue(usage, ['size', 'context_size', 'window_size']);
  let used = getNumericValue(usage, ['used', 'context_used', 'used_tokens', 'total_tokens', 'totalTokens']);

  if (used === null) {
    const inputTokens = getNumericValue(usage, ['input_tokens', 'inputTokens']) || 0;
    const outputTokens = getNumericValue(usage, ['output_tokens', 'outputTokens']) || 0;
    const thoughtTokens = getNumericValue(usage, ['thought_tokens', 'thoughtTokens']) || 0;
    const cachedReadTokens = getNumericValue(usage, ['cached_read_input_tokens', 'cachedReadTokens']) || 0;
    const cachedWriteTokens = getNumericValue(usage, ['cached_write_input_tokens', 'cachedWriteTokens']) || 0;
    const tokenSum = inputTokens + outputTokens + thoughtTokens + cachedReadTokens + cachedWriteTokens;

    if (tokenSum > 0) {
      used = tokenSum;
    }
  }

  if (size === null && used !== null) {
    size = used;
  }

  if (size === null || used === null) {
    return null;
  }

  const usageUpdate = {
    sessionUpdate: 'usage_update',
    size,
    used,
  };

  const cost = usage.cost;
  if (cost && typeof cost === 'object') {
    const amount = getNumericValue(cost, ['amount']);
    const currency = typeof cost.currency === 'string' ? cost.currency : null;
    if (amount !== null && currency) {
      usageUpdate.cost = { amount, currency };
    }
  } else {
    const amount = getNumericValue(usage, ['cost_usd', 'costUsd']);
    if (amount !== null) {
      usageUpdate.cost = { amount, currency: 'USD' };
    }
  }

  return usageUpdate;
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
 * Check if a message chunk is a Bash tool_use
 */
export function isBashToolUse(chunk) {
  return chunk?.type === 'tool_use' && chunk?.name === 'Bash';
}

/**
 * Extract tool result info from a tool_result chunk
 */
export function getToolResult(chunk) {
  if (chunk?.type !== 'tool_result') return null;
  // Return the tool_use_id; caller tracks which tool type it was
  return { toolUseId: chunk.tool_use_id };
}
