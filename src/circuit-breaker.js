// Circuit breaker pattern for spawn failure protection
import { createLogger } from './logger.js';

const logBreaker = createLogger('circuit:breaker');

/**
 * Circuit breaker states
 */
const BreakerState = {
  CLOSED: 'closed', // Normal operation
  OPEN: 'open', // Failing, rejecting requests
  HALF_OPEN: 'half_open', // Testing if recovery is possible
};

/**
 * Circuit breaker for protecting against repeated failures
 */
export class CircuitBreaker {
  /**
   * @param {object} options
   * @param {string} options.name - Breaker name for logging
   * @param {number} options.failureThreshold - Number of failures before opening (default: 5)
   * @param {number} options.resetTimeMs - Time before attempting recovery (default: 30000)
   * @param {number} options.halfOpenMaxAttempts - Max attempts in half-open state (default: 1)
   */
  constructor({ name = 'default', failureThreshold = 5, resetTimeMs = 30000, halfOpenMaxAttempts = 1 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeMs = resetTimeMs;
    this.halfOpenMaxAttempts = halfOpenMaxAttempts;

    this.state = BreakerState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
  }

  /**
   * Check if the circuit breaker allows the operation
   * @returns {boolean} - True if operation is allowed
   */
  isAllowed() {
    if (this.state === BreakerState.CLOSED) {
      return true;
    }

    if (this.state === BreakerState.OPEN) {
      // Check if enough time has passed to try again
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeMs) {
        this.state = BreakerState.HALF_OPEN;
        this.halfOpenAttempts = 0;
        logBreaker.info('Circuit breaker transitioning to half-open', { name: this.name });
        return true;
      }
      return false;
    }

    // HALF_OPEN state
    if (this.halfOpenAttempts < this.halfOpenMaxAttempts) {
      return true;
    }
    return false;
  }

  /**
   * Record a successful operation
   */
  recordSuccess() {
    if (this.state === BreakerState.HALF_OPEN) {
      // Recovery successful - close the circuit
      this.state = BreakerState.CLOSED;
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
      logBreaker.info('Circuit breaker closed after successful recovery', { name: this.name });
    } else if (this.state === BreakerState.CLOSED && this.failureCount > 0) {
      // Reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure() {
    this.lastFailureTime = Date.now();

    if (this.state === BreakerState.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        // Recovery failed - reopen the circuit
        this.state = BreakerState.OPEN;
        logBreaker.warn('Circuit breaker reopened after failed recovery', { name: this.name });
      }
      return;
    }

    this.failureCount++;
    logBreaker.debug('Failure recorded', {
      name: this.name,
      failureCount: this.failureCount,
      threshold: this.failureThreshold,
    });

    if (this.failureCount >= this.failureThreshold) {
      this.state = BreakerState.OPEN;
      logBreaker.warn('Circuit breaker opened', {
        name: this.name,
        failureCount: this.failureCount,
        resetTimeMs: this.resetTimeMs,
      });
    }
  }

  /**
   * Get current circuit breaker status
   * @returns {object} - Status info
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      isAllowed: this.isAllowed(),
    };
  }

  /**
   * Reset the circuit breaker to closed state
   */
  reset() {
    this.state = BreakerState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
    logBreaker.info('Circuit breaker reset', { name: this.name });
  }
}

export { BreakerState };
