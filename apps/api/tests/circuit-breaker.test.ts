import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitState,
  type CircuitBreakerOptions,
} from "../src/lib/circuit-breaker";

function opts(overrides: Partial<CircuitBreakerOptions> = {}): CircuitBreakerOptions {
  return {
    name: "test",
    failureThreshold: 3,
    resetTimeoutMs: 5_000,
    halfOpenRequests: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================
// Initial state
// =============================================================

describe("CircuitBreaker — initial", () => {
  test("starts in CLOSED state", () => {
    const cb = new CircuitBreaker(opts());
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  test("stats start at zero", () => {
    const cb = new CircuitBreaker(opts());
    const stats = cb.stats();
    expect(stats.state).toBe("CLOSED");
    expect(stats.failures).toBe(0);
    expect(stats.successes).toBe(0);
    expect(stats.lastFailureAt).toBeNull();
  });
});

// =============================================================
// CLOSED → OPEN transition
// =============================================================

describe("CircuitBreaker — CLOSED → OPEN", () => {
  test("exec passes through on success", async () => {
    const cb = new CircuitBreaker(opts());
    const result = await cb.exec(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  test("failures below threshold keep the circuit CLOSED", async () => {
    const cb = new CircuitBreaker(opts({ failureThreshold: 3 }));

    for (let i = 0; i < 2; i++) {
      await expect(
        cb.exec(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
    }

    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.stats().failures).toBe(2);
  });

  test("reaching the failure threshold trips the circuit to OPEN", async () => {
    const cb = new CircuitBreaker(opts({ failureThreshold: 3 }));

    for (let i = 0; i < 3; i++) {
      await expect(
        cb.exec(() => Promise.reject(new Error("fail"))),
      ).rejects.toThrow("fail");
    }

    expect(cb.state).toBe(CircuitState.OPEN);
  });

  test("a success resets the failure counter", async () => {
    const cb = new CircuitBreaker(opts({ failureThreshold: 3 }));

    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await cb.exec(() => Promise.resolve("ok"));
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();

    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.stats().failures).toBe(1);
  });
});

// =============================================================
// OPEN state — fast fail
// =============================================================

describe("CircuitBreaker — OPEN", () => {
  test("rejects immediately without calling fn", async () => {
    const cb = new CircuitBreaker(opts({ failureThreshold: 1 }));
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe(CircuitState.OPEN);

    const fn = vi.fn(() => Promise.resolve("never"));
    await expect(cb.exec(fn)).rejects.toThrow(/circuit.*open/i);
    expect(fn).not.toHaveBeenCalled();
  });

  test("stats report lastFailureAt as a Date", async () => {
    const cb = new CircuitBreaker(opts({ failureThreshold: 1 }));
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();
    const stats = cb.stats();
    expect(stats.lastFailureAt).toBeInstanceOf(Date);
  });
});

// =============================================================
// OPEN → HALF_OPEN after timeout
// =============================================================

describe("CircuitBreaker — OPEN → HALF_OPEN", () => {
  test("circuit transitions to HALF_OPEN after resetTimeoutMs", async () => {
    const cb = new CircuitBreaker(
      opts({ failureThreshold: 1, resetTimeoutMs: 5_000 }),
    );
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(5_000);

    // The state check should indicate HALF_OPEN now. Force a check
    // by calling exec with a succeeding fn.
    await cb.exec(() => Promise.resolve("probe"));
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
  });

  test("only halfOpenRequests probes are allowed before re-closing", async () => {
    const cb = new CircuitBreaker(
      opts({ failureThreshold: 1, resetTimeoutMs: 100, halfOpenRequests: 2 }),
    );
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();

    vi.advanceTimersByTime(100);

    // First two probes → allowed
    await cb.exec(() => Promise.resolve("p1"));
    await cb.exec(() => Promise.resolve("p2"));

    // After two successes, circuit closes
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  test("a failure during HALF_OPEN re-opens the circuit", async () => {
    const cb = new CircuitBreaker(
      opts({ failureThreshold: 1, resetTimeoutMs: 100, halfOpenRequests: 3 }),
    );
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();

    vi.advanceTimersByTime(100);

    await cb.exec(() => Promise.resolve("p1"));
    await expect(cb.exec(() => Promise.reject(new Error("f2")))).rejects.toThrow();

    expect(cb.state).toBe(CircuitState.OPEN);
  });
});

// =============================================================
// HALF_OPEN → CLOSED
// =============================================================

describe("CircuitBreaker — HALF_OPEN → CLOSED", () => {
  test("resets all counters once back to CLOSED", async () => {
    const cb = new CircuitBreaker(
      opts({ failureThreshold: 1, resetTimeoutMs: 100, halfOpenRequests: 1 }),
    );
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();

    vi.advanceTimersByTime(100);
    await cb.exec(() => Promise.resolve("ok"));

    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.stats().failures).toBe(0);
    expect(cb.stats().successes).toBe(0);
  });
});

// =============================================================
// Per-store registry
// =============================================================

describe("CircuitBreaker — named instances", () => {
  test("exec error message includes the circuit name", async () => {
    const cb = new CircuitBreaker(
      opts({ name: "apple", failureThreshold: 1 }),
    );
    await expect(cb.exec(() => Promise.reject(new Error("f")))).rejects.toThrow();

    await expect(cb.exec(() => Promise.resolve("x"))).rejects.toThrow(
      /apple/i,
    );
  });
});
