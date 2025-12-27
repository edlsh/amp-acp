import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, BreakerState } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetTimeMs: 1000 });
  });

  describe('constructor', () => {
    it('initializes with default values', () => {
      const defaultBreaker = new CircuitBreaker();
      expect(defaultBreaker.name).toBe('default');
      expect(defaultBreaker.failureThreshold).toBe(5);
      expect(defaultBreaker.resetTimeMs).toBe(30000);
      expect(defaultBreaker.halfOpenMaxAttempts).toBe(1);
      expect(defaultBreaker.state).toBe(BreakerState.CLOSED);
    });

    it('accepts custom options', () => {
      expect(breaker.name).toBe('test');
      expect(breaker.failureThreshold).toBe(3);
      expect(breaker.resetTimeMs).toBe(1000);
    });
  });

  describe('isAllowed', () => {
    it('returns true when closed', () => {
      expect(breaker.isAllowed()).toBe(true);
    });

    it('returns false when open and reset time not elapsed', () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.state).toBe(BreakerState.OPEN);
      expect(breaker.isAllowed()).toBe(false);
    });

    it('transitions to half-open after reset time', () => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.state).toBe(BreakerState.OPEN);

      // Fast-forward time
      breaker.lastFailureTime = Date.now() - 2000;
      expect(breaker.isAllowed()).toBe(true);
      expect(breaker.state).toBe(BreakerState.HALF_OPEN);
    });

    it('allows limited attempts in half-open state', () => {
      breaker.state = BreakerState.HALF_OPEN;
      breaker.halfOpenAttempts = 0;
      expect(breaker.isAllowed()).toBe(true);

      breaker.halfOpenAttempts = 1;
      expect(breaker.isAllowed()).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('closes circuit from half-open state', () => {
      breaker.state = BreakerState.HALF_OPEN;
      breaker.failureCount = 3;
      breaker.halfOpenAttempts = 1;

      breaker.recordSuccess();

      expect(breaker.state).toBe(BreakerState.CLOSED);
      expect(breaker.failureCount).toBe(0);
      expect(breaker.halfOpenAttempts).toBe(0);
    });

    it('resets failure count when closed with prior failures', () => {
      breaker.failureCount = 2;
      breaker.recordSuccess();
      expect(breaker.failureCount).toBe(0);
    });

    it('does nothing when closed with no failures', () => {
      breaker.recordSuccess();
      expect(breaker.state).toBe(BreakerState.CLOSED);
      expect(breaker.failureCount).toBe(0);
    });
  });

  describe('recordFailure', () => {
    it('increments failure count', () => {
      breaker.recordFailure();
      expect(breaker.failureCount).toBe(1);
      expect(breaker.lastFailureTime).not.toBeNull();
    });

    it('opens circuit when threshold reached', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.state).toBe(BreakerState.CLOSED);

      breaker.recordFailure();
      expect(breaker.state).toBe(BreakerState.OPEN);
      expect(breaker.failureCount).toBe(3);
    });

    it('reopens circuit from half-open after failed recovery', () => {
      breaker.state = BreakerState.HALF_OPEN;
      breaker.halfOpenAttempts = 0;

      breaker.recordFailure();

      expect(breaker.halfOpenAttempts).toBe(1);
      expect(breaker.state).toBe(BreakerState.OPEN);
    });
  });

  describe('getStatus', () => {
    it('returns current status', () => {
      breaker.recordFailure();
      const status = breaker.getStatus();

      expect(status.name).toBe('test');
      expect(status.state).toBe(BreakerState.CLOSED);
      expect(status.failureCount).toBe(1);
      expect(status.lastFailureTime).not.toBeNull();
      expect(status.isAllowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Put breaker in open state
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.state).toBe(BreakerState.OPEN);

      breaker.reset();

      expect(breaker.state).toBe(BreakerState.CLOSED);
      expect(breaker.failureCount).toBe(0);
      expect(breaker.lastFailureTime).toBeNull();
      expect(breaker.halfOpenAttempts).toBe(0);
    });
  });
});

describe('BreakerState', () => {
  it('exports expected states', () => {
    expect(BreakerState.CLOSED).toBe('closed');
    expect(BreakerState.OPEN).toBe('open');
    expect(BreakerState.HALF_OPEN).toBe('half_open');
  });
});
