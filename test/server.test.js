/* eslint-disable max-nested-callbacks */
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

  describe('_buildTextInput', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('skips image chunks in _buildTextInput (handled separately via temp files)', () => {
      // Valid 1x1 transparent PNG for test data integrity
      const validPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const prompt = [
        { type: 'text', text: 'Describe this image:' },
        { type: 'image', mediaType: 'image/png', data: validPngBase64 },
      ];

      const result = agent._buildTextInput(prompt);

      expect(result).toContain('Describe this image:');
      expect(result).not.toContain(validPngBase64);
    });

    it('saves images to temp files and returns paths', async () => {
      const prompt = [
        { type: 'text', text: 'test' },
        {
          type: 'image',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ];

      const { paths, cleanup } = await agent._saveImagesToTempFiles(prompt);

      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain('amp-acp-image-');
      expect(paths[0]).toContain('.png');

      await cleanup();
    });

    it('handles image chunks without data gracefully', async () => {
      const prompt = [
        { type: 'text', text: 'test' },
        { type: 'image', mediaType: 'image/png' }, // no data
      ];

      const { paths, cleanup } = await agent._saveImagesToTempFiles(prompt);

      expect(paths).toHaveLength(0);
      await cleanup();
    });

    it('defaults extension to png when mediaType not provided', async () => {
      const prompt = [
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ];

      const { paths, cleanup } = await agent._saveImagesToTempFiles(prompt);

      expect(paths[0]).toContain('.png');
      await cleanup();
    });

    it('sanitizes malicious mediaType to prevent path traversal', async () => {
      const prompt = [
        {
          type: 'image',
          mediaType: 'image/../../etc/passwd',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ];

      const { paths, cleanup } = await agent._saveImagesToTempFiles(prompt);

      // ".." sanitizes to empty string, falls back to png
      expect(paths[0]).toMatch(/\.png$/);
      expect(paths[0]).not.toContain('..');
      await cleanup();
    });

    it('strips special chars from extension', async () => {
      const prompt = [
        {
          type: 'image',
          mediaType: 'image/svg+xml',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ];

      const { paths, cleanup } = await agent._saveImagesToTempFiles(prompt);

      // "svg+xml" sanitizes to "svgxml"
      expect(paths[0]).toMatch(/\.svgxml$/);
      await cleanup();
    });

    it('returns empty failedImages array on success', async () => {
      const prompt = [
        {
          type: 'image',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      ];

      const { failedImages, cleanup } = await agent._saveImagesToTempFiles(prompt);

      expect(failedImages).toEqual([]);
      await cleanup();
    });
  });

  describe('resumeSession', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('resumes existing session and updates lastActivityAt', async () => {
      vi.useFakeTimers();
      const { sessionId } = await agent.newSession({});
      const session = agent.sessions.get(sessionId);
      const initialActivity = session.lastActivityAt;

      // Advance time
      vi.advanceTimersByTime(1000);

      const result = await agent.resumeSession({ sessionId });

      expect(result.sessionId).toBe(sessionId);
      expect(session.lastActivityAt).toBeGreaterThan(initialActivity);
      vi.useRealTimers();
    });

    it('throws error for non-existent session', async () => {
      await expect(agent.resumeSession({ sessionId: 'non-existent' })).rejects.toThrow('Session not found');
    });

    it('throws error for failed session', async () => {
      vi.useFakeTimers();
      const { sessionId } = await agent.newSession({});
      const session = agent.sessions.get(sessionId);
      session.state = 'failed';

      await expect(agent.resumeSession({ sessionId })).rejects.toThrow('failed state');
      vi.useRealTimers();
    });
  });

  describe('forkSession', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('creates new session with same thread context', async () => {
      vi.useFakeTimers();
      const { sessionId } = await agent.newSession({});
      const originalSession = agent.sessions.get(sessionId);
      originalSession.threadId = 'T-test-thread';
      originalSession.currentModeId = 'plan';

      const result = await agent.forkSession({ sessionId });

      expect(result.sessionId).not.toBe(sessionId);
      const forkedSession = agent.sessions.get(result.sessionId);
      expect(forkedSession.threadId).toBe('T-test-thread');
      expect(forkedSession.currentModeId).toBe('plan');
      vi.useRealTimers();
    });

    it('throws error for non-existent session', async () => {
      await expect(agent.forkSession({ sessionId: 'non-existent' })).rejects.toThrow('Session not found');
    });
  });

  describe('listSessions', () => {
    let agent;
    let mockClient;

    beforeEach(() => {
      mockClient = {
        sessionUpdate: vi.fn().mockResolvedValue({}),
      };
      agent = new AmpAcpAgent(mockClient, Promise.resolve(null));
    });

    it('returns empty list when no sessions exist', async () => {
      const result = await agent.listSessions({});
      expect(result.sessions).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.nextCursor).toBeNull();
    });

    it('returns sessions sorted by lastActivityAt (most recent first)', async () => {
      vi.useFakeTimers();
      const { sessionId: id1 } = await agent.newSession({});
      vi.advanceTimersByTime(1000);
      const { sessionId: id2 } = await agent.newSession({});
      vi.advanceTimersByTime(1000);
      const { sessionId: id3 } = await agent.newSession({});

      const result = await agent.listSessions({});

      expect(result.sessions).toHaveLength(3);
      expect(result.sessions[0].sessionId).toBe(id3);
      expect(result.sessions[1].sessionId).toBe(id2);
      expect(result.sessions[2].sessionId).toBe(id1);
      vi.useRealTimers();
    });

    it('applies pagination with cursor and limit', async () => {
      vi.useFakeTimers();
      await agent.newSession({});
      vi.advanceTimersByTime(100);
      await agent.newSession({});
      vi.advanceTimersByTime(100);
      await agent.newSession({});

      const result = await agent.listSessions({ cursor: 0, limit: 2 });

      expect(result.sessions).toHaveLength(2);
      expect(result.nextCursor).toBe(2);
      expect(result.total).toBe(3);
      vi.useRealTimers();
    });

    it('returns null nextCursor when no more pages', async () => {
      vi.useFakeTimers();
      await agent.newSession({});
      await agent.newSession({});

      const result = await agent.listSessions({ cursor: 0, limit: 10 });

      expect(result.nextCursor).toBeNull();
      vi.useRealTimers();
    });
  });
});
