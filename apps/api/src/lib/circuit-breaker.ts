import { logger } from "./logger";

// =============================================================
// Generic circuit breaker
// =============================================================
//
// Three-state machine:
//
//   CLOSED ─(failures ≥ threshold)──▶ OPEN
//     ▲                                   │
//     │                          (resetTimeoutMs)
//     │                                   ▼
//     └───(halfOpenRequests succeed)── HALF_OPEN
//                                         │
//                  (any failure) ──────────┘ ──▶ OPEN
//
// A `CircuitBreaker` wraps an async function. While CLOSED it
// passes calls through; once enough consecutive failures trip
// the circuit OPEN it fast-fails without invoking the function.
// After the reset timeout the circuit enters HALF_OPEN and lets
// a limited number of "probe" requests through — if they all
// succeed the circuit returns to CLOSED, otherwise it re-opens.

const log = logger.child("circuit-breaker");

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenRequests: number;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: Date | null;
}

export class CircuitBreaker {
  readonly name: string;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenRequests: number;

  private _state = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private halfOpenSuccessCount = 0;
  private halfOpenInFlight = 0;
  private lastFailureAt: Date | null = null;
  private openedAt: number | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.halfOpenRequests = options.halfOpenRequests;
  }

  get state(): CircuitState {
    if (
      this._state === CircuitState.OPEN &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      return CircuitState.HALF_OPEN;
    }
    return this._state;
  }

  stats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
    };
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.state;

    if (current === CircuitState.OPEN) {
      throw new Error(
        `Circuit breaker '${this.name}' is OPEN — request rejected`,
      );
    }

    if (current === CircuitState.HALF_OPEN) {
      // Cap concurrent probes: without this check the first exec()
      // enters HALF_OPEN and every other concurrent call sees the
      // same state before any of them has a chance to succeed/fail,
      // defeating the "limited probe" semantics.
      if (this.halfOpenInFlight >= this.halfOpenRequests) {
        throw new Error(
          `Circuit breaker '${this.name}' HALF_OPEN probe limit reached`,
        );
      }
      this._state = CircuitState.HALF_OPEN;
      this.halfOpenInFlight += 1;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (current === CircuitState.HALF_OPEN) {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
    }
  }

  private onSuccess(): void {
    this.successes += 1;

    if (this._state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenRequests) {
        this.close();
      }
      return;
    }

    // A success in CLOSED resets the failure streak.
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures += 1;
    this.lastFailureAt = new Date();

    if (this._state === CircuitState.HALF_OPEN) {
      this.trip();
      return;
    }

    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this._state = CircuitState.OPEN;
    this.openedAt = Date.now();
    this.halfOpenSuccessCount = 0;
    log.warn("circuit tripped to OPEN", {
      name: this.name,
      failures: this.failures,
    });
  }

  private close(): void {
    this._state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.halfOpenSuccessCount = 0;
    this.halfOpenInFlight = 0;
    this.openedAt = null;
    log.info("circuit closed", { name: this.name });
  }
}

// =============================================================
// Pre-built store instances
// =============================================================

const DEFAULT_OPTIONS: Omit<CircuitBreakerOptions, "name"> = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  halfOpenRequests: 3,
};

export const appleCircuit = new CircuitBreaker({
  name: "apple",
  ...DEFAULT_OPTIONS,
});

export const googleCircuit = new CircuitBreaker({
  name: "google",
  ...DEFAULT_OPTIONS,
});

export const stripeCircuit = new CircuitBreaker({
  name: "stripe",
  ...DEFAULT_OPTIONS,
});

export function getStoreCircuits(): Record<string, CircuitBreakerStats> {
  return {
    apple: appleCircuit.stats(),
    google: googleCircuit.stats(),
    stripe: stripeCircuit.stats(),
  };
}
