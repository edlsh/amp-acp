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

      // Tool calls now emit single notification with status: in_progress (atomic emission)
      expect(result).toHaveLength(1);
      expect(result[0].update.sessionUpdate).toBe('tool_call');
      expect(result[0].update.toolCallId).toBe('tool-789');
      expect(result[0].update.title).toBe('Read some/file.txt');
      expect(result[0].update.kind).toBe('read');
      expect(result[0].update.status).toBe('in_progress');
      expect(result[0].update.locations).toEqual([{ path: '/some/file.txt' }]);
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

    it('adds subagent prefix for nested tool calls in separate mode', () => {
      const originalMode = config.nestedToolMode;
      config.nestedToolMode = 'separate';
      try {
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
      } finally {
        config.nestedToolMode = originalMode;
      }
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

  describe('tool call status validation', () => {
    it('validates status transitions and prevents invalid ones', () => {
      const activeToolCalls = new Map();

      // First tool_use - should work (now emits single in_progress notification)
      const msg1 = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'Read',
              input: { path: '/test' },
            },
          ],
        },
      };

      let result = toAcpNotifications(msg1, sessionId, activeToolCalls);
      expect(result).toHaveLength(1); // Single tool_call with in_progress
      expect(result[0].update.status).toBe('in_progress');

      // Valid transition: in_progress -> completed
      const msg2 = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              is_error: false,
              content: 'success',
            },
          ],
        },
      };

      result = toAcpNotifications(msg2, sessionId, activeToolCalls);
      expect(result).toHaveLength(1);
      expect(result[0].update.status).toBe('completed');
      expect(activeToolCalls.has('tool-123')).toBe(false); // Should be cleaned up
    });

    it('handles duplicate toolCallId by generating unique replacement', () => {
      const activeToolCalls = new Map([
        ['tool-123', { name: 'Read', startTime: Date.now(), lastStatus: 'in_progress' }],
      ]);

      const msg = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-123', // Duplicate
              name: 'Grep',
              input: { pattern: 'test' },
            },
          ],
        },
      };

      const result = toAcpNotifications(msg, sessionId, activeToolCalls);
      expect(result).toHaveLength(1); // Single tool_call with in_progress
      const newToolCallId = result[0].update.toolCallId;
      expect(newToolCallId).not.toBe('tool-123');
      // ID format: {originalId}_{base36timestamp}_{random4chars}
      expect(newToolCallId).toMatch(/^tool-123_[a-z0-9]+_[a-z0-9]+$/);
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

  it('embeds child tool_use as full content array update on parent', () => {
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

    // Should emit full content array on PARENT (ACP replaces, not appends)
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    // Content shows running indicator and progress summary
    const text = result[0].update.content[0].content.text;
    expect(text).toContain('◐'); // running indicator
    expect(text).toContain('Read');
    expect(text).toContain('1 running');

    // Child should be registered in tracker
    expect(tracker.isChildTool('child-read-456')).toBe(true);
  });

  it('embeds child tool_result with updated full content array on parent', () => {
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

    // Should emit full content array on PARENT with completion status
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('parent-task-123');
    const text = result[0].update.content[0].content.text;
    expect(text).toContain('✓'); // completed indicator
    expect(text).toContain('Read');
    expect(text).toContain('1 done');
  });

  it('shows failure indicator in full content array for failed child tools', () => {
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

    const text = result[0].update.content[0].content.text;
    expect(text).toContain('✗');
    expect(text).toContain('1 failed');
  });
});

describe('flat nested tool mode', () => {
  const sessionId = 'test-session';
  let originalMode;

  beforeEach(() => {
    originalMode = config.nestedToolMode;
    config.nestedToolMode = 'flat';
  });

  afterEach(() => {
    config.nestedToolMode = originalMode;
  });

  it('emits child tool_use as independent top-level tool_call without _meta', () => {
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

    // Should emit as independent top-level tool_call
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call');
    expect(result[0].update.toolCallId).toBe('child-read-456');
    // No [Subagent] prefix in flat mode
    expect(result[0].update.title).toBe('Read foo/bar.ts');
    // No _meta in flat mode
    expect(result[0].update._meta).toBeUndefined();

    // Child should NOT be registered in tracker in flat mode
    expect(tracker.isChildTool('child-read-456')).toBe(false);
  });

  it('emits child tool_result as independent tool_call_update', () => {
    const activeToolCalls = new Map([
      ['child-read-456', { ampId: 'child-read-456', name: 'Read', startTime: Date.now(), lastStatus: 'in_progress' }],
    ]);

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

    const result = toAcpNotifications(msg, sessionId, activeToolCalls, {}, null);

    // Should emit as independent tool_call_update with status
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('child-read-456');
    expect(result[0].update.status).toBe('completed');
    expect(result[0].update.content[0].content.text).toBe('file contents here');

    // Should be cleaned up from activeToolCalls
    expect(activeToolCalls.has('child-read-456')).toBe(false);
  });

  it('shows subagent text as agent_message_chunk', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: 'parent-task-123',
      message: {
        content: [{ type: 'text', text: 'Subagent thinking out loud' }],
      },
    };

    const result = toAcpNotifications(msg, sessionId, new Map(), {}, null);

    // In flat mode, subagent text should be shown
    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('agent_message_chunk');
    expect(result[0].update.content.text).toBe('Subagent thinking out loud');
  });

  it('handles failed child tool_result as independent notification', () => {
    const activeToolCalls = new Map([
      ['child-bash-789', { ampId: 'child-bash-789', name: 'Bash', startTime: Date.now(), lastStatus: 'in_progress' }],
    ]);

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

    const result = toAcpNotifications(msg, sessionId, activeToolCalls, {}, null);

    expect(result).toHaveLength(1);
    expect(result[0].update.sessionUpdate).toBe('tool_call_update');
    expect(result[0].update.toolCallId).toBe('child-bash-789');
    expect(result[0].update.status).toBe('failed');
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

  it('tracks parent stats with total, completed, failed counts', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Read', { path: '/a.ts' });
    tracker.registerChild('child-2', 'parent-1', 'Read', { path: '/b.ts' });
    tracker.registerChild('child-3', 'parent-1', 'Bash', { cmd: 'npm test' });

    const stats = tracker.getParentStats('parent-1');
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);

    tracker.completeChild('child-1', false);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);

    tracker.completeChild('child-3', true);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('generates full content array for ACP updates', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Read', { path: '/a.ts' });
    tracker.registerChild('child-2', 'parent-1', 'Read', { path: '/b.ts' });

    // Both running
    let content = tracker.getContentArray('parent-1');
    expect(content).toHaveLength(1);
    let text = content[0].content.text;
    expect(text).toContain('◐'); // running indicator
    expect(text).toContain('2 running');
    expect(text).toContain('(0/2)');

    // One completed
    tracker.completeChild('child-1', false);
    content = tracker.getContentArray('parent-1');
    text = content[0].content.text;
    expect(text).toContain('✓'); // completed indicator
    expect(text).toContain('1 running');
    expect(text).toContain('1 done');
    expect(text).toContain('(1/2)');

    // Both completed
    tracker.completeChild('child-2', false);
    content = tracker.getContentArray('parent-1');
    text = content[0].content.text;
    expect(text).toContain('2 done');
    expect(text).toContain('(2/2)');
  });

  it('collapses completed items beyond maxVisibleCompleted', () => {
    const tracker = new NestedToolTracker();

    // Register 5 child tools
    for (let i = 1; i <= 5; i++) {
      tracker.registerChild(`child-${i}`, 'parent-1', 'Read', { path: `/file${i}.ts` });
    }

    // Complete all of them
    for (let i = 1; i <= 5; i++) {
      tracker.completeChild(`child-${i}`, false);
    }

    const content = tracker.getContentArray('parent-1');
    const text = content[0].content.text;
    // Only maxVisibleCompleted (3) items shown, plus 1 collapse indicator
    expect((text.match(/✓/g) || []).length).toBe(4); // 3 visible + "... 2 more completed"
    expect(text).toContain('2 more completed');
    expect(text).toContain('5 done');
  });

  it('groups items by status (running, failed, completed)', () => {
    const tracker = new NestedToolTracker();
    tracker.registerChild('child-1', 'parent-1', 'Read', { path: '/a.ts' });
    tracker.registerChild('child-2', 'parent-1', 'Bash', { cmd: 'fail' });
    tracker.registerChild('child-3', 'parent-1', 'Read', { path: '/b.ts' });

    tracker.completeChild('child-2', true); // failed
    tracker.completeChild('child-1', false); // completed

    const content = tracker.getContentArray('parent-1');
    const text = content[0].content.text;
    const lines = text.split('\n');

    // Items grouped by status: running first, then failed, then completed
    expect(lines[0]).toContain('◐'); // child-3 running
    expect(lines[1]).toContain('✗'); // child-2 failed
    expect(lines[2]).toContain('✓'); // child-1 completed
  });

  it('collapses failed items beyond maxVisibleFailed (first 2 + last 3)', () => {
    const tracker = new NestedToolTracker();
    tracker.maxVisibleFailed = 5; // Explicit for test stability

    // Register 8 child tools and fail all of them
    for (let i = 1; i <= 8; i++) {
      tracker.registerChild(`child-${i}`, 'parent-1', 'Bash', { cmd: `cmd${i}` });
      tracker.completeChild(`child-${i}`, true); // all failed
    }

    const content = tracker.getContentArray('parent-1');
    const text = content[0].content.text;
    const lines = text.split('\n').filter((l) => l.startsWith('✗'));

    // maxVisibleFailed=5: first 2 + collapse indicator + last 3 = 6 lines with ✗
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain('cmd1'); // first
    expect(lines[1]).toContain('cmd2'); // second
    expect(lines[2]).toContain('3 more failed'); // 8-5=3 hidden
    expect(lines[3]).toContain('cmd6'); // last 3
    expect(lines[4]).toContain('cmd7');
    expect(lines[5]).toContain('cmd8');
    expect(text).toContain('8 failed');
  });
});
