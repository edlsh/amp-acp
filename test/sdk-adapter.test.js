import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  adaptSdkMessage,
  sdkMessageToAcpNotifications,
  isSdkBashToolUse,
  getSdkToolResult,
  isSdkPlanToolUse,
  extractPlanFromSdkToolUse,
  extractSdkTerminalAndPlanActions,
} from '../src/sdk-adapter.js';
import { NestedToolTracker } from '../src/to-acp.js';
import { config } from '../src/config.js';

describe('adaptSdkMessage', () => {
  it('adapts system message to CLI format', () => {
    const sdkMsg = {
      type: 'system',
      session_id: 'T-123',
      tools: [{ name: 'Read' }, { name: 'Bash' }],
      mcp_servers: [{ name: 'test-server', status: 'connected' }],
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.type).toBe('system');
    expect(cliMsg.subtype).toBe('init');
    expect(cliMsg.session_id).toBe('T-123');
    expect(cliMsg.tools).toHaveLength(2);
    expect(cliMsg.mcp_servers).toHaveLength(1);
  });

  it('adapts assistant message with text to CLI format', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.type).toBe('assistant');
    expect(cliMsg.message.content[0].type).toBe('text');
    expect(cliMsg.message.content[0].text).toBe('Hello world');
  });

  it('adapts assistant message with tool_use to CLI format', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-123',
            name: 'Read',
            input: { path: '/file.txt' },
          },
        ],
      },
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.message.content[0].type).toBe('tool_use');
    expect(cliMsg.message.content[0].id).toBe('tool-123');
    expect(cliMsg.message.content[0].name).toBe('Read');
    expect(cliMsg.message.content[0].input.path).toBe('/file.txt');
  });

  it('adapts assistant message with thinking to CLI format', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Let me analyze...' }],
      },
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.message.content[0].type).toBe('thinking');
    expect(cliMsg.message.content[0].thinking).toBe('Let me analyze...');
  });

  it('adapts user message with tool_result to CLI format', () => {
    const sdkMsg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-123',
            content: 'file contents',
            is_error: false,
          },
        ],
      },
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.type).toBe('user');
    expect(cliMsg.message.content[0].type).toBe('tool_result');
    expect(cliMsg.message.content[0].tool_use_id).toBe('tool-123');
    expect(cliMsg.message.content[0].is_error).toBe(false);
  });

  it('adapts result message (success) to CLI format', () => {
    const sdkMsg = {
      type: 'result',
      subtype: 'success',
      result: 'Task completed',
      is_error: false,
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.type).toBe('result');
    expect(cliMsg.subtype).toBe('success');
    expect(cliMsg.result).toBe('Task completed');
    expect(cliMsg.is_error).toBe(false);
  });

  it('adapts result message (error) to CLI format', () => {
    const sdkMsg = {
      type: 'result',
      subtype: 'error_during_execution',
      result: 'Something failed',
      is_error: true,
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.type).toBe('result');
    expect(cliMsg.subtype).toBe('error_during_execution');
    expect(cliMsg.error).toBe('Something failed');
    expect(cliMsg.is_error).toBe(true);
  });

  it('returns null for unknown message types', () => {
    expect(adaptSdkMessage({ type: 'unknown' })).toBe(null);
    expect(adaptSdkMessage(null)).toBe(null);
    expect(adaptSdkMessage({})).toBe(null);
  });

  it('preserves parent_tool_use_id for nested assistant messages', () => {
    const sdkMsg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-123',
      message: {
        content: [{ type: 'text', text: 'Subagent response' }],
      },
    };

    const cliMsg = adaptSdkMessage(sdkMsg);

    expect(cliMsg.parent_tool_use_id).toBe('parent-123');
  });
});

describe('sdkMessageToAcpNotifications', () => {
  const sessionId = 'test-session';

  describe('system messages', () => {
    it('emits thought chunk for session start', () => {
      const sdkMsg = {
        type: 'system',
        session_id: 'T-123',
        tools: [{ name: 'Read' }, { name: 'Bash' }],
        mcp_servers: [{ name: 'test-server', status: 'connected' }],
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe(sessionId);
      expect(result[0].update.sessionUpdate).toBe('agent_thought_chunk');
      expect(result[0].update.content.text).toContain('Tools: 2');
      expect(result[0].update.content.text).toContain('test-server (connected)');
    });

    it('handles system message with no tools or mcp servers', () => {
      const sdkMsg = { type: 'system', session_id: 'T-123' };
      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result[0].update.content.text).toContain('Tools: 0');
      expect(result[0].update.content.text).toContain('MCP Servers: none');
    });
  });

  describe('assistant messages', () => {
    it('converts text content to agent_message_chunk', () => {
      const sdkMsg = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('agent_message_chunk');
      expect(result[0].update.content.text).toBe('Hello world');
    });

    it('converts tool_use to tool_call notification', () => {
      const sdkMsg = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-789',
              name: 'Read',
              input: { path: '/some/file.txt' },
            },
          ],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('tool_call');
      expect(result[0].update.toolCallId).toBe('tool-789');
      expect(result[0].update.title).toBe('Read some/file.txt');
      expect(result[0].update.kind).toBe('read');
      expect(result[0].update.status).toBe('in_progress');
      expect(result[0].update.locations).toEqual([{ path: '/some/file.txt' }]);
    });

    it('converts thinking to agent_thought_chunk', () => {
      const sdkMsg = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me analyze...' }],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result[0].update.sessionUpdate).toBe('agent_thought_chunk');
      expect(result[0].update.content.text).toBe('Let me analyze...');
    });

    it('handles mixed content types', () => {
      const sdkMsg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Analyzing...' },
            { type: 'text', text: 'Here is my response' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/test' } },
          ],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(3);
      expect(result[0].update.sessionUpdate).toBe('agent_thought_chunk');
      expect(result[1].update.sessionUpdate).toBe('agent_message_chunk');
      expect(result[2].update.sessionUpdate).toBe('tool_call');
    });
  });

  describe('user messages (tool results)', () => {
    it('converts successful tool_result to completed status', () => {
      const sdkMsg = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              content: [{ type: 'text', text: 'file contents here' }],
              is_error: false,
            },
          ],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('tool_call_update');
      expect(result[0].update.toolCallId).toBe('tool-123');
      expect(result[0].update.status).toBe('completed');
    });

    it('converts error tool_result to failed status with code wrap', () => {
      const sdkMsg = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: 'Error: file not found',
              is_error: true,
            },
          ],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result[0].update.status).toBe('failed');
      expect(result[0].update.content[0].content.text).toContain('```');
    });
  });

  describe('result messages', () => {
    it('emits error message for error_during_execution', () => {
      const sdkMsg = {
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Something went wrong',
        is_error: true,
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.content.text).toContain('Error: Something went wrong');
    });

    it('emits error message for is_error flag', () => {
      const sdkMsg = {
        type: 'result',
        result: 'Execution failed',
        is_error: true,
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.content.text).toContain('Error: Execution failed');
    });

    it('returns empty for success result', () => {
      const sdkMsg = {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        is_error: false,
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);
      expect(result).toHaveLength(0);
    });

    it('emits usage_update when usage payload is present', () => {
      const sdkMsg = {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 42,
          output_tokens: 8,
          total_tokens: 50,
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update).toEqual({
        sessionUpdate: 'usage_update',
        size: 50,
        used: 50,
      });
    });

    it('emits usage_update alongside error notifications', () => {
      const sdkMsg = {
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Execution failed',
        is_error: true,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId);

      expect(result).toHaveLength(2);
      expect(result[0].update.sessionUpdate).toBe('usage_update');
      expect(result[0].update.used).toBe(5);
      expect(result[1].update.sessionUpdate).toBe('agent_message_chunk');
    });
  });

  describe('tool call tracking', () => {
    it('tracks tool calls and removes on completion', () => {
      const activeToolCalls = new Map();

      // Tool use
      const toolUseMsg = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-123', name: 'Read', input: { path: '/test' } }],
        },
      };

      sdkMessageToAcpNotifications(toolUseMsg, sessionId, activeToolCalls);
      expect(activeToolCalls.has('tool-123')).toBe(true);

      // Tool result
      const toolResultMsg = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'done', is_error: false }],
        },
      };

      sdkMessageToAcpNotifications(toolResultMsg, sessionId, activeToolCalls);
      expect(activeToolCalls.has('tool-123')).toBe(false);
    });

    it('generates unique ID for duplicate tool calls', () => {
      const activeToolCalls = new Map([
        ['tool-123', { name: 'Read', startTime: Date.now(), lastStatus: 'in_progress' }],
      ]);

      const sdkMsg = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-123', name: 'Grep', input: { pattern: 'test' } }],
        },
      };

      const result = sdkMessageToAcpNotifications(sdkMsg, sessionId, activeToolCalls);
      const newToolCallId = result[0].update.toolCallId;

      expect(newToolCallId).not.toBe('tool-123');
      expect(newToolCallId).toMatch(/^tool-123_[a-f0-9]{8}$/);
    });
  });
});

describe('inline nested tool mode with SDK adapter', () => {
  const sessionId = 'test-session';
  let originalMode;

  beforeEach(() => {
    originalMode = config.nestedToolMode;
    config.nestedToolMode = 'inline';
  });

  afterEach(() => {
    config.nestedToolMode = originalMode;
  });

  it('embeds child tool_use in parent content', () => {
    const tracker = new NestedToolTracker();
    const sdkMsg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-task-123',
      message: {
        content: [{ type: 'tool_use', id: 'child-read-456', name: 'Read', input: { path: '/foo/bar.ts' } }],
      },
    };

    const result = sdkMessageToAcpNotifications(sdkMsg, sessionId, new Map(), {}, tracker);

    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    const text = result[0].update.content[0].content.text;
    expect(text).toContain('◐');
    expect(text).toContain('Read');
    expect(tracker.isChildTool('child-read-456')).toBe(true);
  });

  it('updates parent content on child tool_result', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-read-456', 'parent-task-123', 'Read', { path: '/foo/bar.ts' });

    const sdkMsg = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'child-read-456', content: 'file contents', is_error: false }],
      },
    };

    const result = sdkMessageToAcpNotifications(sdkMsg, sessionId, new Map(), {}, tracker);

    expect(result).toHaveLength(1);
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    const text = result[0].update.content[0].content.text;
    expect(text).toContain('✓');
    expect(text).toContain('1 done');
  });
});

describe('flat nested tool mode with SDK adapter', () => {
  const sessionId = 'test-session';
  let originalMode;

  beforeEach(() => {
    originalMode = config.nestedToolMode;
    config.nestedToolMode = 'flat';
  });

  afterEach(() => {
    config.nestedToolMode = originalMode;
  });

  it('emits child tool as independent tool_call without _meta', () => {
    const tracker = new NestedToolTracker();
    const sdkMsg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-task-123',
      message: {
        content: [{ type: 'tool_use', id: 'child-read-456', name: 'Read', input: { path: '/foo/bar.ts' } }],
      },
    };

    const result = sdkMessageToAcpNotifications(sdkMsg, sessionId, new Map(), {}, tracker);

    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call');
    expect(result[0].update.toolCallId).toBe('child-read-456');
    expect(result[0].update.title).toBe('Read foo/bar.ts');
    expect(result[0].update._meta).toBeUndefined();
    expect(tracker.isChildTool('child-read-456')).toBe(false);
  });

  it('shows subagent text as agent_message_chunk', () => {
    const sdkMsg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-task-123',
      message: {
        content: [{ type: 'text', text: 'Subagent thinking out loud' }],
      },
    };

    const result = sdkMessageToAcpNotifications(sdkMsg, sessionId, new Map(), {}, null);

    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('agent_message_chunk');
    expect(result[0].update.content.text).toBe('Subagent thinking out loud');
  });
});

describe('isSdkBashToolUse', () => {
  it('returns true for Bash tool_use', () => {
    expect(isSdkBashToolUse({ type: 'tool_use', name: 'Bash', id: 'test', input: { cmd: 'ls' } })).toBe(true);
  });

  it('returns false for other tool_use', () => {
    expect(isSdkBashToolUse({ type: 'tool_use', name: 'Read', id: 'test', input: {} })).toBe(false);
  });

  it('returns false for non-tool_use', () => {
    expect(isSdkBashToolUse({ type: 'text', text: 'hello' })).toBe(false);
    expect(isSdkBashToolUse(null)).toBe(false);
  });
});

describe('getSdkToolResult', () => {
  it('returns toolUseId for tool_result', () => {
    const chunk = { type: 'tool_result', tool_use_id: 'tool-123', content: 'output' };
    expect(getSdkToolResult(chunk)).toEqual({ toolUseId: 'tool-123' });
  });

  it('returns null for non-tool_result', () => {
    expect(getSdkToolResult({ type: 'text' })).toBe(null);
    expect(getSdkToolResult(null)).toBe(null);
  });
});

describe('isSdkPlanToolUse', () => {
  it('returns true for todo_write tool_use', () => {
    expect(isSdkPlanToolUse({ type: 'tool_use', name: 'todo_write', id: 'test', input: { todos: [] } })).toBe(true);
  });

  it('returns true for todo_read tool_use', () => {
    expect(isSdkPlanToolUse({ type: 'tool_use', name: 'todo_read', id: 'test', input: {} })).toBe(true);
  });

  it('returns false for other tool_use', () => {
    expect(isSdkPlanToolUse({ type: 'tool_use', name: 'Read', id: 'test', input: {} })).toBe(false);
    expect(isSdkPlanToolUse({ type: 'tool_use', name: 'Bash', id: 'test', input: { cmd: 'ls' } })).toBe(false);
  });

  it('returns false for non-tool_use', () => {
    expect(isSdkPlanToolUse({ type: 'text', text: 'hello' })).toBe(false);
    expect(isSdkPlanToolUse(null)).toBe(false);
  });
});

describe('extractPlanFromSdkToolUse', () => {
  it('extracts todos from todo_write', () => {
    const chunk = {
      type: 'tool_use',
      name: 'todo_write',
      id: 'test',
      input: {
        todos: [
          { content: 'Task 1', status: 'pending' },
          { content: 'Task 2', status: 'completed' },
        ],
      },
    };
    const result = extractPlanFromSdkToolUse(chunk);
    expect(result).toEqual({
      todos: [
        { content: 'Task 1', status: 'pending' },
        { content: 'Task 2', status: 'completed' },
      ],
    });
  });

  it('returns null for todo_read', () => {
    const chunk = { type: 'tool_use', name: 'todo_read', id: 'test', input: {} };
    expect(extractPlanFromSdkToolUse(chunk)).toBe(null);
  });

  it('returns null for todo_write without todos', () => {
    const chunk = { type: 'tool_use', name: 'todo_write', id: 'test', input: {} };
    expect(extractPlanFromSdkToolUse(chunk)).toBe(null);
  });

  it('returns null for non-todo tool', () => {
    expect(extractPlanFromSdkToolUse({ type: 'tool_use', name: 'Read', input: {} })).toBe(null);
    expect(extractPlanFromSdkToolUse(null)).toBe(null);
  });
});

describe('extractSdkTerminalAndPlanActions', () => {
  it('extracts terminal creation for Bash tool_use', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'bash-123', name: 'Bash', input: { cmd: 'ls -la', cwd: '/tmp' } }],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0]).toEqual({ toolUseId: 'bash-123', cmd: 'ls -la', cwd: '/tmp' });
    expect(result.plans).toHaveLength(0);
    expect(result.terminalReleases).toHaveLength(0);
  });

  it('skips Bash tool_use without cmd', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'bash-123', name: 'Bash', input: {} }],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);
    expect(result.terminals).toHaveLength(0);
  });

  it('extracts plan write action for todo_write', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'plan-123',
            name: 'todo_write',
            input: { todos: [{ content: 'Do X', status: 'pending' }] },
          },
        ],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toEqual({
      type: 'write',
      toolUseId: 'plan-123',
      todos: [{ content: 'Do X', status: 'pending' }],
    });
    expect(result.terminals).toHaveLength(0);
  });

  it('extracts plan read action for todo_read', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'plan-456', name: 'todo_read', input: {} }],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toEqual({ type: 'read', toolUseId: 'plan-456' });
  });

  it('extracts terminal release from tool_result', () => {
    const sdkMsg = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'bash-123', content: 'output', is_error: false }],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.terminalReleases).toHaveLength(1);
    expect(result.terminalReleases[0]).toEqual({ toolUseId: 'bash-123' });
    expect(result.terminals).toHaveLength(0);
    expect(result.plans).toHaveLength(0);
  });

  it('handles mixed content with multiple actions', () => {
    const sdkMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { cmd: 'echo hi' } },
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: '/test' } },
          {
            type: 'tool_use',
            id: 'plan-1',
            name: 'todo_write',
            input: { todos: [{ content: 'X', status: 'pending' }] },
          },
          { type: 'text', text: 'Some explanation' },
        ],
      },
    };

    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.terminals).toHaveLength(1);
    expect(result.terminals[0].toolUseId).toBe('bash-1');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].toolUseId).toBe('plan-1');
  });

  it('returns empty arrays for system message', () => {
    const sdkMsg = { type: 'system', session_id: 'T-123' };
    const result = extractSdkTerminalAndPlanActions(sdkMsg);

    expect(result.terminals).toHaveLength(0);
    expect(result.plans).toHaveLength(0);
    expect(result.terminalReleases).toHaveLength(0);
  });

  it('returns empty arrays for null/undefined', () => {
    expect(extractSdkTerminalAndPlanActions(null).terminals).toHaveLength(0);
    expect(extractSdkTerminalAndPlanActions(undefined).terminals).toHaveLength(0);
    expect(extractSdkTerminalAndPlanActions({}).terminals).toHaveLength(0);
  });
});
