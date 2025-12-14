import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toAcpNotifications, isBashToolUse, getToolResult, NestedToolTracker } from '../src/to-acp.js';
import { config } from '../src/config.js';

describe('toAcpNotifications', () => {
  const sessionId = 'test-session';

  describe('system messages', () => {
    it('handles init subtype', () => {
      const msg = {
        type: 'system',
        subtype: 'init',
        tools: [{ name: 'Read' }, { name: 'Bash' }],
        mcp_servers: [{ name: 'test-server', status: 'connected' }],
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe(sessionId);
      expect(result[0].update.sessionUpdate).toBe('agent_thought_chunk');
      expect(result[0].update.content.text).toContain('Tools: 2');
      expect(result[0].update.content.text).toContain('test-server (connected)');
    });

    it('handles init with no mcp servers', () => {
      const msg = { type: 'system', subtype: 'init', tools: [] };
      const result = toAcpNotifications(msg, sessionId);

      expect(result[0].update.content.text).toContain('MCP Servers: none');
    });
  });

  describe('user messages (tool results)', () => {
    it('handles successful tool_result', () => {
      const msg = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              is_error: false,
              content: [{ type: 'text', text: 'file contents here' }],
            },
          ],
        },
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('tool_call_update');
      expect(result[0].update.toolCallId).toBe('tool-123');
      expect(result[0].update.status).toBe('completed');
    });

    it('handles error tool_result', () => {
      const msg = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              is_error: true,
              content: 'Error: file not found',
            },
          ],
        },
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result[0].update.status).toBe('failed');
      expect(result[0].update.content[0].content.text).toContain('```');
    });

    it('ignores text chunks in user messages', () => {
      const msg = {
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'internal context' }],
        },
      };

      const result = toAcpNotifications(msg, sessionId);
      expect(result).toHaveLength(0);
    });
  });

  describe('assistant messages', () => {
    it('handles text content', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('agent_message_chunk');
      expect(result[0].update.content.text).toBe('Hello world');
    });

    it('handles tool_use', () => {
      const msg = {
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

      const result = toAcpNotifications(msg, sessionId);

      // Feature 5: Tool calls now emit 2 notifications (pending + in_progress)
      expect(result).toHaveLength(2);
      expect(result[0].update.sessionUpdate).toBe('tool_call');
      expect(result[0].update.toolCallId).toBe('tool-789');
      expect(result[0].update.title).toBe('Read some/file.txt');
      expect(result[0].update.kind).toBe('search');
      expect(result[0].update.status).toBe('pending');
      expect(result[0].update.locations).toEqual([{ path: '/some/file.txt' }]);
      
      // Second notification: in_progress status update
      expect(result[1].update.sessionUpdate).toBe('tool_call_update');
      expect(result[1].update.toolCallId).toBe('tool-789');
      expect(result[1].update.status).toBe('in_progress');
    });

    it('handles thinking content', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me analyze...' }],
        },
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result[0].update.sessionUpdate).toBe('agent_thought_chunk');
      expect(result[0].update.content.text).toBe('Let me analyze...');
    });

    it('adds subagent prefix for nested tool calls', () => {
      const msg = {
        type: 'assistant',
        parent_tool_use_id: 'parent-123',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-nested',
              name: 'Bash',
              input: { cmd: 'ls' },
            },
          ],
        },
      };

      const result = toAcpNotifications(msg, sessionId);
      expect(result[0].update.title).toBe('[Subagent] Bash: ls');
      expect(result[0].update._meta).toEqual({ parentToolCallId: 'parent-123' });
    });
  });

  describe('result messages', () => {
    it('handles execution errors', () => {
      const msg = {
        type: 'result',
        subtype: 'error_during_execution',
        error: 'Something went wrong',
      };

      const result = toAcpNotifications(msg, sessionId);

      expect(result).toHaveLength(1);
      expect(result[0].update.content.text).toContain('Error: Something went wrong');
    });

    it('handles max turns error', () => {
      const msg = {
        type: 'result',
        subtype: 'error_max_turns',
        error: 'Max turns exceeded',
      };

      const result = toAcpNotifications(msg, sessionId);
      expect(result[0].update.content.text).toContain('Max turns exceeded');
    });
  });

  describe('unknown message types', () => {
    it('returns empty array for unknown types', () => {
      const msg = { type: 'unknown_type' };
      const result = toAcpNotifications(msg, sessionId);
      expect(result).toHaveLength(0);
    });
  });
});

describe('isBashToolUse', () => {
  it('returns true for Bash tool_use', () => {
    const chunk = { type: 'tool_use', name: 'Bash', id: 'test-123', input: { cmd: 'ls' } };
    expect(isBashToolUse(chunk)).toBe(true);
  });

  it('returns false for other tool_use', () => {
    const chunk = { type: 'tool_use', name: 'Read', id: 'test-123', input: { path: '/file' } };
    expect(isBashToolUse(chunk)).toBe(false);
  });

  it('returns false for non-tool_use', () => {
    expect(isBashToolUse({ type: 'text', text: 'hello' })).toBe(false);
    expect(isBashToolUse(null)).toBe(false);
    expect(isBashToolUse(undefined)).toBe(false);
  });
});

describe('getToolResult', () => {
  it('returns toolUseId for tool_result', () => {
    const chunk = { type: 'tool_result', tool_use_id: 'tool-123', content: 'output' };
    expect(getToolResult(chunk)).toEqual({ toolUseId: 'tool-123' });
  });

  it('returns null for non-tool_result', () => {
    expect(getToolResult({ type: 'text' })).toBe(null);
    expect(getToolResult(null)).toBe(null);
  });
});

describe('inline nested tool mode', () => {
  const sessionId = 'test-session';
  let originalMode;

  beforeEach(() => {
    originalMode = config.nestedToolMode;
    config.nestedToolMode = 'inline';
  });

  afterEach(() => {
    config.nestedToolMode = originalMode;
  });

  it('embeds child tool_use as update on parent instead of separate tool_call', () => {
    const tracker = new NestedToolTracker();
    const msg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-task-123',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'child-read-456',
            name: 'Read',
            input: { path: '/foo/bar.ts' },
          },
        ],
      },
    };

    const result = toAcpNotifications(msg, sessionId, new Map(), {}, tracker);

    // Should emit tool_call_update on PARENT, not a new tool_call
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    expect(result[0].update.content[0].content.text).toContain('Read');
    expect(result[0].update.content[0].content.text).toContain('bar.ts');

    // Child should be registered in tracker
    expect(tracker.isChildTool('child-read-456')).toBe(true);
  });

  it('embeds child tool_result as completion update on parent', () => {
    const tracker = new NestedToolTracker();
    // First, register the child
    tracker.registerChild('child-read-456', 'parent-task-123', 'Read', { path: '/foo/bar.ts' });

    const msg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'child-read-456',
            content: 'file contents here',
            is_error: false,
          },
        ],
      },
    };

    const result = toAcpNotifications(msg, sessionId, new Map(), {}, tracker);

    // Should emit tool_call_update on PARENT with success indicator
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    expect(result[0].update.content[0].content.text).toContain('✓');
    expect(result[0].update.content[0].content.text).toContain('Read');
  });

  it('shows failure indicator for failed child tools', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-bash-789', 'parent-task-123', 'Bash', { cmd: 'npm test' });

    const msg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'child-bash-789',
            content: 'Command failed',
            is_error: true,
          },
        ],
      },
    };

    const result = toAcpNotifications(msg, sessionId, new Map(), {}, tracker);

    expect(result[0].update.content[0].content.text).toContain('✗');
    expect(result[0].update.content[0].content.text).toContain('failed');
  });
});

describe('NestedToolTracker', () => {
  it('tracks child tools and their parents', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Read', { path: '/test' });

    expect(tracker.isChildTool('child-1')).toBe(true);
    expect(tracker.isChildTool('unknown')).toBe(false);

    const child = tracker.getChild('child-1');
    expect(child.parentToolUseId).toBe('parent-1');
    expect(child.name).toBe('Read');
  });

  it('updates status on completion', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Bash', { cmd: 'ls' });

    tracker.completeChild('child-1', false);
    expect(tracker.getChild('child-1').status).toBe('completed');

    tracker.registerChild('child-2', 'parent-1', 'Bash', { cmd: 'fail' });
    tracker.completeChild('child-2', true);
    expect(tracker.getChild('child-2').status).toBe('failed');
  });

  it('clears all tracked children', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Read', {});
    tracker.registerChild('child-2', 'parent-1', 'Grep', {});

    tracker.clear();

    expect(tracker.isChildTool('child-1')).toBe(false);
    expect(tracker.isChildTool('child-2')).toBe(false);
  });
});
