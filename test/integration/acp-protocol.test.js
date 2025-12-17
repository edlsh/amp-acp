import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmpAcpAgent } from '../../src/server.js';

/**
 * Integration tests for ACP protocol flows.
 * These tests verify end-to-end behavior with mocked child processes.
 */
describe('ACP Protocol Integration', () => {
  let agent;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue({}),
      createTerminal: vi.fn().mockResolvedValue({ id: 'term-1', release: vi.fn() }),
      readTextFile: vi.fn().mockResolvedValue({ content: 'test' }),
      writeTextFile: vi.fn().mockResolvedValue({}),
    };
    agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Full Session Lifecycle', () => {
    it('completes initialize -> newSession -> cleanup flow', async () => {
      // Initialize
      const initResult = await agent.initialize({
        clientCapabilities: { terminal: true },
      });

      expect(initResult.protocolVersion).toBeDefined();
      expect(initResult.agentCapabilities.loadSession).toBe(true);
      expect(initResult.agentCapabilities.promptCapabilities.image).toBe(true);

      // Create session
      const sessionResult = await agent.newSession({});

      expect(sessionResult.sessionId).toMatch(/^S-/);
      expect(sessionResult.models.currentModelId).toBe('default');
      expect(sessionResult.modes.availableModes).toHaveLength(4);

      // Verify session is tracked
      expect(agent.sessions.has(sessionResult.sessionId)).toBe(true);

      // Run deferred command emission
      vi.useFakeTimers();
      await vi.runAllTimersAsync();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: sessionResult.sessionId,
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
          }),
        })
      );
    });

    it('handles session not found error', async () => {
      await expect(
        agent.prompt({ sessionId: 'nonexistent', prompt: [{ type: 'text', text: 'test' }] })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('Session Load (Thread Continuation)', () => {
    it('validates thread ID format', async () => {
      await expect(agent.loadSession({ sessionId: 'invalid-id', workspaceRoot: '/tmp' })).rejects.toThrow(
        'Invalid thread ID format'
      );
    });

    it('accepts valid thread ID format', async () => {
      // Mock _replayThreadHistory to avoid actual exec
      agent._replayThreadHistory = vi.fn().mockResolvedValue(undefined);

      const result = await agent.loadSession({
        sessionId: 'T-12345678-1234-1234-1234-123456789abc',
        workspaceRoot: '/tmp',
      });

      expect(result.sessionId).toBe('T-12345678-1234-1234-1234-123456789abc');
      expect(agent.sessions.has(result.sessionId)).toBe(true);

      const session = agent.sessions.get(result.sessionId);
      expect(session.threadId).toBe('T-12345678-1234-1234-1234-123456789abc');
    });
  });

  describe('Slash Command Interception', () => {
    it('intercepts /plan command and switches mode', async () => {
      vi.useFakeTimers();

      const session = await agent.newSession({});
      await vi.runAllTimersAsync();

      // Clear previous calls
      mockClient.sessionUpdate.mockClear();

      // Spy on setSessionMode
      const setModeSpy = vi.spyOn(agent, 'setSessionMode');

      // Send /plan command with no follow-up text
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/plan' }],
      });

      expect(setModeSpy).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        modeId: 'plan',
      });
      expect(result.stopReason).toBe('end_turn');
    });

    it('intercepts /yolo command and switches to bypassPermissions mode', async () => {
      vi.useFakeTimers();

      const session = await agent.newSession({});
      await vi.runAllTimersAsync();

      const setModeSpy = vi.spyOn(agent, 'setSessionMode');

      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/yolo' }],
      });

      expect(setModeSpy).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        modeId: 'bypassPermissions',
      });
    });
  });

  describe('Mode Management', () => {
    it('updates session mode and emits notification', async () => {
      vi.useFakeTimers();

      const session = await agent.newSession({});
      await vi.runAllTimersAsync();
      mockClient.sessionUpdate.mockClear();

      await agent.setSessionMode({
        sessionId: session.sessionId,
        modeId: 'acceptEdits',
      });

      const s = agent.sessions.get(session.sessionId);
      expect(s.currentModeId).toBe('acceptEdits');

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'acceptEdits',
        },
      });
    });
  });

  describe('Cancel Operation', () => {
    it('returns outcome cancelled for nonexistent session', async () => {
      const result = await agent.cancel({ sessionId: 'nonexistent' });
      expect(result).toEqual({ outcome: 'cancelled' });
    });

    it('sets cancelled flag on active session', async () => {
      vi.useFakeTimers();

      const session = await agent.newSession({});
      await vi.runAllTimersAsync();

      const s = agent.sessions.get(session.sessionId);
      s.active = true;
      s.proc = { kill: vi.fn() };

      await agent.cancel({ sessionId: session.sessionId });

      expect(s.cancelled).toBe(true);
      expect(s.proc.kill).toHaveBeenCalledWith('SIGINT');
    });
  });

  describe('Available Commands', () => {
    it('emits commands only once per session (idempotency)', async () => {
      vi.useFakeTimers();

      const session = await agent.newSession({});
      await vi.runAllTimersAsync();

      const initialCallCount = mockClient.sessionUpdate.mock.calls.filter(
        (call) => call[0]?.update?.sessionUpdate === 'available_commands_update'
      ).length;

      // Try to emit again
      await agent._emitAvailableCommands(session.sessionId);

      const finalCallCount = mockClient.sessionUpdate.mock.calls.filter(
        (call) => call[0]?.update?.sessionUpdate === 'available_commands_update'
      ).length;

      expect(finalCallCount).toBe(initialCallCount);
    });
  });
});
