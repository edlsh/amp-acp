// Convert Amp stream JSON events to ACP sessionUpdate notifications.
// Schema reference: https://ampcode.com/manual/appendix#stream-json-output

import { config, getToolKind, getToolTitle, getToolLocations, getInlineToolDescription } from './config.js';
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

export function toAcpNotifications(
  msg,
  sessionId,
  activeToolCalls = new Map(),
  _clientCapabilities = {},
  nestedTracker = null
) {
  const output = [];
  const inlineMode = config.nestedToolMode === 'inline';
  const flatMode = config.nestedToolMode === 'flat';

  /**
   * Generate a session-unique ACP tool call ID from an Amp tool_use_id
   * If the ID already exists, generate a unique replacement and track the mapping
   * @param {string} ampId - Original Amp tool_use_id
   * @returns {string} - Session-unique ACP tool call ID
   */
  const getUniqueToolCallId = (ampId) => {
    if (!activeToolCalls.has(ampId)) {
      return ampId; // ID is unique, use as-is
    }
    // Generate unique replacement ID
    const uniqueId = `${ampId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    logProtocol.warn('Generated unique toolCallId for duplicate', {
      originalId: ampId,
      uniqueId,
      sessionId,
    });
    return uniqueId;
  };

  /**
   * Find the ACP tool call ID for a given Amp tool_use_id
   * Handles both direct matches and ampId->acpId mappings
   * @param {string} ampId - Original Amp tool_use_id from tool_result
   * @returns {string|null} - ACP tool call ID or null if not found
   */
  const findAcpToolCallId = (ampId) => {
    // Direct match (most common case - ID wasn't remapped)
    if (activeToolCalls.has(ampId)) {
      return ampId;
    }
    // Search for mapped ID
    for (const [acpId, toolCall] of activeToolCalls) {
      if (toolCall.ampId === ampId) {
        return acpId;
      }
    }
    return null;
  };

  // Track tool call state transitions for validation
  const validateStatusTransition = (toolCallId, newStatus) => {
    const existingCall = activeToolCalls.get(toolCallId);
    if (!existingCall) return true; // New tool call

    const currentStatus = existingCall.lastStatus;
    const validTransitions = {
      in_progress: ['completed', 'failed'],
      completed: [], // Terminal state
      failed: [], // Terminal state
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
            activeToolCalls.delete(acpToolCallId);
            output.push({
              sessionId,
              update: {
                toolCallId: acpToolCallId,
                sessionUpdate: 'tool_call_update',
                status,
                content: toAcpContentArray(chunk.content, isError),
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

    case 'result':
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

    default:
      break;
  }

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
