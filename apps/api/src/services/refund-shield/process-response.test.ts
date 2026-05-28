import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Mocking strategy
//
// `processRefundShieldResponse` composes three units we already
// trust under test:
//
//   1. `aggregateRefundShieldSignals` (T12)  → signals
//   2. `mapToConsumptionRequest`     (T7)   → ConsumptionRequest
//   3. `sendConsumptionInfo`         (T8)   → Apple POST
//
// We only re-exercise the *control flow* here: SLA gate, success
// pass-through, 4xx → FAILED, 5xx/network → RETRY with backoff.
// The aggregator and Apple client are stubbed via `vi.mock` so the
// test stays a pure unit suite (no fake DB/CH, no real fetch).
//
// Note: because `vi.mock` replaces the module's `AppleServerApiError`
// export with a local class, the implementation must NOT rely on
// `instanceof AppleServerApiError` to read `status` / `bodyPreview`
// — it has to fall back to reading those fields off the thrown
// error directly. The 5xx test below intentionally throws a plain
// `Error` with `status`/`bodyPreview` attached to verify that.
// =============================================================

const sendConsumptionInfoMock = vi.fn();
vi.mock("../apple/apple-server-api", () => ({
  sendConsumptionInfo: (...args: unknown[]) => sendConsumptionInfoMock(...args),
  AppleServerApiError: class extends Error {
    constructor(
      public status: number,
      public bodyPreview: string,
    ) {
      super(`apple ${status}`);
    }
  },
}));

const aggregateMock = vi.fn();
vi.mock("./aggregate-signals", () => ({
  aggregateRefundShieldSignals: (...args: unknown[]) => aggregateMock(...args),
}));

import { processRefundShieldResponse } from "./process-response";

const FAKE_SIGNALS = {
  customerConsented: true,
  appAccountToken: "550e8400-e29b-41d4-a716-446655440000",
  firstSeenAt: new Date("2026-01-01"),
  now: new Date("2026-05-28"),
  purchaseStartedAt: new Date("2026-05-01"),
  purchaseEndsAt: new Date("2026-06-01"),
  wasInTrial: false,
  hasActiveEntitlement: true,
  lifetimeSessionMs: 3_600_000,
  lifetimeDollarsPurchasedCents: 7500,
  lifetimeDollarsRefundedCents: 0,
};

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row_1",
    projectId: "proj_1",
    subscriberId: "sub_1",
    appleNotificationUuid: "uuid-1",
    appleOriginalTransactionId: "tx_original",
    appleTransactionId: "tx_apple",
    detectedAt: new Date("2026-05-28T00:00:00Z"),
    scheduledFor: new Date("2026-05-28T01:00:00Z"),
    status: "PENDING",
    retryCount: 0,
    ...overrides,
  } as never;
}

const FAKE_CTX = {
  keyId: "ABCDEFGHIJ",
  issuerId: "00000000-0000-0000-0000-000000000000",
  bundleId: "com.example.app",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  environment: "PRODUCTION" as const,
};

function makeInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    row: makeRow(),
    ctx: FAKE_CTX,
    customerConsented: true,
    db: {} as never,
    ch: {} as never,
    now: new Date("2026-05-28T02:00:00Z"),
    ...overrides,
  } as never;
}

describe("processRefundShieldResponse", () => {
  beforeEach(() => {
    sendConsumptionInfoMock.mockReset();
    aggregateMock.mockReset();
  });

  it("sends to Apple and marks SENT on 202", async () => {
    sendConsumptionInfoMock.mockResolvedValue({ status: 202 });
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);

    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("SENT");
    if (out.status === "SENT") {
      expect(out.payload.refundPreference).toBe(2);
      expect(out.httpStatus).toBe(202);
    }
    expect(sendConsumptionInfoMock).toHaveBeenCalledWith(
      FAKE_CTX,
      "tx_apple",
      expect.objectContaining({ refundPreference: 2 }),
    );
  });

  it("returns RETRY when Apple returns 5xx", async () => {
    sendConsumptionInfoMock.mockRejectedValue(
      Object.assign(new Error("apple 503"), { status: 503, bodyPreview: "" }),
    );
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);

    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("RETRY");
    if (out.status === "RETRY") {
      expect(out.retryDelayMs).toBeGreaterThan(0);
    }
  });

  it("returns FAILED when Apple returns 4xx (no retry)", async () => {
    sendConsumptionInfoMock.mockRejectedValue(
      Object.assign(new Error("apple 400"), { status: 400, bodyPreview: "bad" }),
    );
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);

    const out = await processRefundShieldResponse(makeInput());
    expect(out.status).toBe("FAILED");
    if (out.status === "FAILED") {
      expect(out.error).toContain("400");
    }
  });

  it("returns FAILED when 12h SLA has elapsed", async () => {
    aggregateMock.mockResolvedValue(FAKE_SIGNALS);

    const out = await processRefundShieldResponse(
      makeInput({
        row: makeRow({ detectedAt: new Date(Date.now() - 13 * 3600_000) }),
        now: new Date(),
      }),
    );
    expect(out.status).toBe("FAILED");
    if (out.status === "FAILED") {
      expect(out.error).toBe("SLA_EXCEEDED");
    }
    expect(sendConsumptionInfoMock).not.toHaveBeenCalled();
  });
});
