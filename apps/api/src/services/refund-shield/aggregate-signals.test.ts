import { describe, expect, it, vi } from "vitest";
import { aggregateRefundShieldSignals } from "./aggregate-signals";

// =============================================================
// Mocking strategy
//
// `aggregateRefundShieldSignals` is dependency-injected with a
// Drizzle `db` and a ClickHouse `ch` client. Each test wires up
// minimal stubs that satisfy the call shapes used inside the
// service: `db.execute(sql\`...\`)` returns `{ rows: [...] }`, and
// `ch.query({ ... })` returns an object with `.json()`. We stub
// two separate CH queries (sessions then revenue) and let `vi.fn`
// queue the responses in call order.
// =============================================================

describe("aggregateRefundShieldSignals", () => {
  it("collects tenure + session + lifetime $ for a known subscriber", async () => {
    const dbMock = makeDbMock({
      first_seen_at: new Date("2026-01-01T00:00:00Z"),
      has_active_entitlement: false,
      purchase_started_at: new Date("2026-05-01T00:00:00Z"),
      purchase_ends_at: new Date("2026-06-01T00:00:00Z"),
      was_in_trial: false,
    });
    const chMock = makeChMock([
      { lifetime_session_ms: "3600000" },
      {
        lifetime_dollars_purchased_cents: "7500",
        lifetime_dollars_refunded_cents: "0",
      },
    ]);

    const signals = await aggregateRefundShieldSignals({
      db: dbMock,
      ch: chMock,
      projectId: "proj_1",
      subscriberId: "sub_1",
      originalTransactionId: "tx_1",
      customerConsented: true,
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(signals).toMatchObject({
      customerConsented: true,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lifetimeSessionMs: 3_600_000,
      lifetimeDollarsPurchasedCents: 7500,
      lifetimeDollarsRefundedCents: 0,
      hasActiveEntitlement: false,
      wasInTrial: false,
      purchaseStartedAt: new Date("2026-05-01T00:00:00Z"),
      purchaseEndsAt: new Date("2026-06-01T00:00:00Z"),
    });
  });

  it("returns zero session_ms when subscriber has no telemetry yet", async () => {
    const dbMock = makeDbMock({
      first_seen_at: new Date("2026-05-20T00:00:00Z"),
      has_active_entitlement: false,
      purchase_started_at: new Date("2026-05-25T00:00:00Z"),
      purchase_ends_at: new Date("2026-06-25T00:00:00Z"),
      was_in_trial: true,
    });
    // Empty CH results — service should coalesce to 0.
    const chMock = makeChMock([[], []]);

    const signals = await aggregateRefundShieldSignals({
      db: dbMock,
      ch: chMock,
      projectId: "proj_1",
      subscriberId: "sub_2",
      originalTransactionId: "tx_2",
      customerConsented: true,
      now: new Date("2026-05-28T00:00:00Z"),
    });
    expect(signals.lifetimeSessionMs).toBe(0);
    expect(signals.lifetimeDollarsPurchasedCents).toBe(0);
    expect(signals.lifetimeDollarsRefundedCents).toBe(0);
    expect(signals.wasInTrial).toBe(true);
  });

  it("threads appAccountToken into the returned signals", async () => {
    const dbMock = makeDbMock({
      first_seen_at: new Date("2026-04-01T00:00:00Z"),
      has_active_entitlement: true,
      purchase_started_at: new Date("2026-05-10T00:00:00Z"),
      purchase_ends_at: new Date("2026-06-10T00:00:00Z"),
      was_in_trial: false,
    });
    const chMock = makeChMock([
      { lifetime_session_ms: "0" },
      {
        lifetime_dollars_purchased_cents: "0",
        lifetime_dollars_refunded_cents: "0",
      },
    ]);

    const signals = await aggregateRefundShieldSignals({
      db: dbMock,
      ch: chMock,
      projectId: "proj_1",
      subscriberId: "sub_3",
      originalTransactionId: "tx_3",
      customerConsented: false,
      appAccountToken: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(signals.customerConsented).toBe(false);
    expect(signals.appAccountToken).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(signals.hasActiveEntitlement).toBe(true);
  });
});

interface PgRow {
  first_seen_at: Date;
  has_active_entitlement: boolean;
  purchase_started_at: Date;
  purchase_ends_at: Date;
  was_in_trial: boolean;
}

function makeDbMock(pgRow: PgRow) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [pgRow] }),
  } as never;
}

function makeChMock(payloads: unknown[]) {
  const query = vi.fn();
  for (const payload of payloads) {
    query.mockResolvedValueOnce({
      json: () => Promise.resolve(Array.isArray(payload) ? payload : [payload]),
    });
  }
  return { query } as never;
}
