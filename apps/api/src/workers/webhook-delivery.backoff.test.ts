// =============================================================
// webhook-delivery backoff / dead-letter — unit test (P0-3c)
//
// Verifies the off-by-one fix: a row that has already failed 4 times
// (attempts=4) and fails again is scheduled with the 5th (12h) backoff
// entry — not dead-lettered — and dead-letter only happens AFTER all
// MAX_ATTEMPTS (5) attempts (attempts=5 → newAttempts=6 → DEAD).
//
// We mock @rovenue/db so deliverWebhooks() runs without a real DB; the
// claim returns a single row at a chosen `attempts` and a fetch stub
// always fails, so every tick takes the failure branch.
// =============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { claimPendingWebhooks, updateOutgoingWebhook, reclaimStaleDeliveries } =
  vi.hoisted(() => ({
    claimPendingWebhooks: vi.fn(),
    updateOutgoingWebhook: vi.fn(),
    reclaimStaleDeliveries: vi.fn().mockResolvedValue(0),
  }));

vi.mock("@rovenue/db", () => ({
  OutgoingWebhookStatus: {
    PENDING: "PENDING",
    DELIVERING: "DELIVERING",
    SENT: "SENT",
    FAILED: "FAILED",
    DEAD: "DEAD",
    DISMISSED: "DISMISSED",
  },
  drizzle: {
    db: {},
    outgoingWebhookRepo: {
      claimPendingWebhooks,
      updateOutgoingWebhook,
      reclaimStaleDeliveries,
    },
  },
}));

// notifications emit is fire-and-forget on the 3rd failure; stub it out.
vi.mock("../services/notifications/emit", () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  deliverWebhooks,
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
} from "./webhook-delivery";

function row(attempts: number) {
  return {
    id: `wh_${attempts}`,
    url: "https://example.test/hook",
    payload: { ok: true },
    attempts,
    projectId: "prj_1",
    projectWebhookSecret: null,
  };
}

const failingFetch = vi.fn().mockResolvedValue({
  ok: false,
  status: 500,
  text: () => Promise.resolve("boom"),
}) as unknown as typeof globalThis.fetch;

beforeEach(() => {
  claimPendingWebhooks.mockReset();
  updateOutgoingWebhook.mockReset();
  reclaimStaleDeliveries.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("webhook-delivery backoff / dead-letter (off-by-one)", () => {
  it("attempts=4 fails again → FAILED scheduled with the 5th (12h) backoff", async () => {
    claimPendingWebhooks.mockResolvedValue([row(4)]);
    const before = Date.now();

    const result = await deliverWebhooks(failingFetch);

    expect(result.failed).toBe(1);
    expect(result.dead).toBe(0);

    const patch = updateOutgoingWebhook.mock.calls.at(-1)?.[2];
    expect(patch.status).toBe("FAILED");
    expect(patch.attempts).toBe(5);
    expect(patch.nextRetryAt).toBeInstanceOf(Date);

    // nextRetryAt ≈ now + 12h (the last backoff entry).
    const expected12h = BACKOFF_SCHEDULE_MS[MAX_ATTEMPTS - 1];
    expect(expected12h).toBe(12 * 60 * 60_000);
    const delta = (patch.nextRetryAt as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(expected12h - 5_000);
    expect(delta).toBeLessThanOrEqual(expected12h + 5_000);
  });

  it("attempts=5 fails again → DEAD (dead-letter only after all 5 attempts)", async () => {
    claimPendingWebhooks.mockResolvedValue([row(5)]);

    const result = await deliverWebhooks(failingFetch);

    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);

    const patch = updateOutgoingWebhook.mock.calls.at(-1)?.[2];
    expect(patch.status).toBe("DEAD");
    expect(patch.attempts).toBe(6);
    expect(patch.deadAt).toBeInstanceOf(Date);
    expect(patch.nextRetryAt).toBeNull();
  });

  it("attempts=0 fails → FAILED scheduled with the 1st (1m) backoff", async () => {
    claimPendingWebhooks.mockResolvedValue([row(0)]);
    const before = Date.now();

    await deliverWebhooks(failingFetch);

    const patch = updateOutgoingWebhook.mock.calls.at(-1)?.[2];
    expect(patch.status).toBe("FAILED");
    expect(patch.attempts).toBe(1);
    const delta = (patch.nextRetryAt as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(BACKOFF_SCHEDULE_MS[0] - 5_000);
    expect(delta).toBeLessThanOrEqual(BACKOFF_SCHEDULE_MS[0] + 5_000);
  });
});
