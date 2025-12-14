// Convert Amp stream JSON events to ACP sessionUpdate notifications.
// Schema reference: https://ampcode.com/manual/appendix#stream-json-output

import { config, getToolKind, getToolTitle, getToolLocations, getInlineToolDescription } from './config.js';

/**
 * State tracker for nested tool call handling
 * Tracks mapping between Amp tool_use_id and child tool metadata
 */
export class NestedToolTracker {
  constructor() {
    // Map: childToolUseId → { parentToolUseId, name, input, status }
    this.childTools = new Map();
  }

  registerChild(childId, parentId, name, input) {
    this.childTools.set(childId, { parentToolUseId: parentId, name, input, status: 'running' });
  }

  getChild(childId) {
    return this.childTools.get(childId);
  }

  completeChild(childId, isError) {
    const child = this.childTools.get(childId);
    if (child) {
      child.status = isError ? 'failed' : 'completed';
    }
    return child;
  }

  isChildTool(childId) {
    return this.childTools.has(childId);
  }

  clear() {
    this.childTools.clear();
  }
}

export function toAcpNotifications(msg, sessionId, activeToolCalls = new Map(), clientCapabilities = {}, nestedTracker = null) {
  const output = [];
  const inlineMode = config.nestedToolMode === 'inline';

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

            // Check if this is a child tool result in inline mode
            if (inlineMode && nestedTracker) {
              const childInfo = nestedTracker.completeChild(chunk.tool_use_id, isError);
              if (childInfo) {
                // Emit update on PARENT with child completion status
                const statusIcon = isError ? '✗' : '✓';
                const desc = getInlineToolDescription(childInfo.name, childInfo.input);
                const statusText = isError ? ' (failed)' : '';
                output.push({
                  sessionId,
                  update: {
                    toolCallId: childInfo.parentToolUseId,
                    sessionUpdate: 'tool_call_update',
                    content: [{ type: 'content', content: { type: 'text', text: `${statusIcon} ${desc}${statusText}` } }],
                  },
                });
                continue; // Don't emit separate tool_call_update for child
              }
            }

            // Normal (non-child) tool result
            activeToolCalls.delete(chunk.tool_use_id);
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.tool_use_id,
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
            if (msg.parent_tool_use_id && inlineMode) {
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
            const isChildTool = !!msg.parent_tool_use_id;

            // In inline mode, embed child tool calls into parent's content
            if (inlineMode && isChildTool && nestedTracker) {
              // Register this child tool
              nestedTracker.registerChild(chunk.id, msg.parent_tool_use_id, chunk.name, chunk.input);

              // Emit a "running" indicator on the parent
              const desc = getInlineToolDescription(chunk.name, chunk.input);
              output.push({
                sessionId,
                update: {
                  toolCallId: msg.parent_tool_use_id,
                  sessionUpdate: 'tool_call_update',
                  content: [{ type: 'content', content: { type: 'text', text: `◐ ${desc}` } }],
                },
              });
              continue; // Don't emit separate tool_call for child
            }

            // Normal tool call (or separate mode)
            activeToolCalls.set(chunk.id, { name: chunk.name, startTime: Date.now() });

            // Build locations array for file-based tools
            const locations = getToolLocations(chunk.name, chunk.input);

            // Build _meta for nested tool calls (subagent/oracle) in separate mode
            const meta = msg.parent_tool_use_id
              ? { parentToolCallId: msg.parent_tool_use_id }
              : undefined;
            
            // Emit initial tool_call with status: pending
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.id,
                sessionUpdate: 'tool_call',
                rawInput: safeJson(chunk.input),
                status: 'pending',
                title: getToolTitle(chunk.name, msg.parent_tool_use_id, chunk.input),
                kind: getToolKind(chunk.name),
                content: [],
                ...(locations.length > 0 && { locations }),
                ...(meta && { _meta: meta }),
              },
            });
            
            // Immediately emit tool_call_update with status: in_progress
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.id,
                sessionUpdate: 'tool_call_update',
                status: 'in_progress',
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

function safeJson(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return undefined;
  }
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
