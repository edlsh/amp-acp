import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmpAcpAgent } from '../src/server.js';

describe('AmpAcpAgent', () => {
  describe('session lifecycle', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('creates session with unique ID on newSession()', async () => {
      vi.useFakeTimers();
      const result1 = await agent.newSession({});
      const result2 = await agent.newSession({});

      expect(result1.sessionId).toMatch(/^S-[a-z0-9]+-[a-z0-9]+$/);
      expect(result2.sessionId).toMatch(/^S-[a-z0-9]+-[a-z0-9]+$/);
      expect(result1.sessionId).not.toBe(result2.sessionId);
      vi.useRealTimers();
    });

    it('tracks session state in sessions Map', async () => {
      vi.useFakeTimers();
      const result = await agent.newSession({});

      const session = agent.sessions.get(result.sessionId);
      expect(session).toBeDefined();
      expect(session.state).toBe('idle');
      expect(session.cancelled).toBe(false);
      expect(session.active).toBe(false);
      expect(session.activeToolCalls).toBeInstanceOf(Map);
      expect(session.terminals).toBeInstanceOf(Map);
      vi.useRealTimers();
    });

    it('cleans up session resources on _cleanupSession()', async () => {
      vi.useFakeTimers();
      const result = await agent.newSession({});
      const sessionId = result.sessionId;

      // Add some state to clean up
      const session = agent.sessions.get(sessionId);
      session.activeToolCalls.set('tool-1', { name: 'Read', lastStatus: 'in_progress', startTime: Date.now() });

      // Cleanup
      agent._cleanupSession(sessionId);

      expect(agent.sessions.has(sessionId)).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('cancel', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('returns outcome cancelled when session not found', async () => {
      const result = await agent.cancel({ sessionId: 'non-existent' });
      expect(result).toEqual({ outcome: 'cancelled' });
    });

    it('sets cancelled flag and sends SIGINT to active process', async () => {
      vi.useFakeTimers();
      const sessionResult = await agent.newSession({});
      const sessionId = sessionResult.sessionId;

      const session = agent.sessions.get(sessionId);
      const mockProc = { kill: vi.fn() };
      session.active = true;
      session.proc = mockProc;

      const result = await agent.cancel({ sessionId });

      expect(result).toEqual({ outcome: 'cancelled' });
      expect(session.cancelled).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGINT');
      vi.useRealTimers();
    });

    it('no-ops when session is not active', async () => {
      vi.useFakeTimers();
      const sessionResult = await agent.newSession({});
      const sessionId = sessionResult.sessionId;

      const session = agent.sessions.get(sessionId);
      session.active = false;

      const result = await agent.cancel({ sessionId });

      expect(result).toEqual({ outcome: 'cancelled' });
      expect(session.cancelled).toBe(false); // Should not be set
      vi.useRealTimers();
    });
  });

  describe('slash commands', () => {
    it.todo('intercepts /plan and switches to plan mode');
    it.todo('intercepts /code and switches to default mode');
    it.todo('intercepts /yolo and switches to bypassPermissions mode');
  });

  describe('prompt', () => {
    it.todo('awaits connectionSignalPromise before processing');
    it.todo('awaits s.chain before returning on timeout');
    it.todo('awaits s.chain before returning on connection close');

    describe('session state machine', () => {
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

      it('rejects prompts when session is in failed state', async () => {
        vi.useFakeTimers();
        const result = await agent.newSession({});
        const sessionId = result.sessionId;

        // Manually set session to failed state
        const session = agent.sessions.get(sessionId);
        session.state = 'failed';

        await expect(
          agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'test' }], cwd: '/tmp' })
        ).rejects.toThrow('Session is in failed state');
      });
    });
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
        state: 'idle',
      });

      // Emit should work since not yet sent
      await agent._emitAvailableCommands(sessionId);

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);

      // Second call should be no-op
      await agent._emitAvailableCommands(sessionId);
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
