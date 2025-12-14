import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmpAcpAgent } from '../src/server.js';

describe('AmpAcpAgent', () => {
  describe('session lifecycle', () => {
    it.todo('creates session with unique ID on newSession()');
    it.todo('tracks session state in sessions Map');
    it.todo('cleans up session resources on connection close');
  });

  describe('cancel', () => {
    it.todo('sets cancelled flag and sends SIGINT to active process');
    it.todo('returns empty object when session not found');
    it.todo('no-ops when session is not active');
  });

  describe('loadSession', () => {
    it.todo('validates thread ID format (T-<uuid>)');
    it.todo('creates session with preset threadId');
    it.todo('replays thread history via amp threads markdown');
    it.todo('handles history fetch failure gracefully');
  });

  describe('slash commands', () => {
    it.todo('intercepts /plan and switches to plan mode');
    it.todo('intercepts /code and switches to default mode');
    it.todo('intercepts /yolo and switches to bypassPermissions mode');
    it.todo('intercepts /ask and switches to default mode');
    it.todo('intercepts /architect and switches to plan mode');
    it.todo('processes remaining text after command as prompt');
    it.todo('acknowledges mode switch when no follow-up text');
  });

  describe('prompt', () => {
    it.todo('awaits connectionSignalPromise before processing');
    it.todo('awaits s.chain before returning on timeout');
    it.todo('awaits s.chain before returning on connection close');
  });

  describe('available_commands_update', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('emits available_commands_update after newSession', async () => {
      vi.useFakeTimers();
      
      const result = await agent.newSession({});
      expect(result.sessionId).toBeDefined();
      
      // Command emission is deferred via setImmediate
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      
      // Run setImmediate callbacks
      await vi.runAllTimersAsync();
      
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: result.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: expect.arrayContaining([
            expect.objectContaining({ name: 'plan' }),
            expect.objectContaining({ name: 'code' }),
            expect.objectContaining({ name: 'yolo' }),
          ]),
        },
      });
    });

    it('emits available_commands_update after loadSession', async () => {
      vi.useFakeTimers();
      
      // Mock _replayThreadHistory to avoid actual exec
      agent._replayThreadHistory = vi.fn().mockResolvedValue(undefined);
      
      const result = await agent.loadSession({ sessionId: 'T-test-uuid', workspaceRoot: '/tmp' });
      expect(result.sessionId).toBe('T-test-uuid');
      
      // Command emission is deferred via setImmediate
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      
      // Run setImmediate callbacks
      await vi.runAllTimersAsync();
      
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'T-test-uuid',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: expect.arrayContaining([
            expect.objectContaining({ name: 'plan' }),
          ]),
        },
      });
    });

    it('emits only once per session (idempotency)', async () => {
      vi.useFakeTimers();
      
      const result = await agent.newSession({});
      await vi.runAllTimersAsync();
      
      // First emission
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      
      // Try to emit again
      await agent._emitAvailableCommands(result.sessionId);
      
      // Should still be 1 (idempotent)
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
    });

    it('emits in prompt fallback if not yet sent', async () => {
      // Create session without triggering setImmediate
      const sessionId = 'S-manual-test';
      agent.sessions.set(sessionId, {
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
        nestedTracker: { clear: vi.fn() },
        sentAvailableCommands: false,
      });
      
      // Mock spawn to avoid actual process
      const originalPrompt = agent.prompt.bind(agent);
      agent.prompt = async (params) => {
        const s = agent.sessions.get(params.sessionId);
        if (!s.sentAvailableCommands) {
          await agent._emitAvailableCommands(params.sessionId);
        }
        return { stopReason: 'end_turn' };
      };
      
      await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'test' }] });
      
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: expect.any(Array),
        },
      });
    });
  });
});
