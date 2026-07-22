import { describe, expect, it } from "vitest";
import type { OutboxEvent } from "@rovenue/db";
import {
  paywallEventId,
  shapePaywallEventMessage,
} from "../src/workers/outbox-dispatcher";

// =============================================================
// PAYWALL_EVENT payload shaping — unit tests (no DB/Kafka/CH)
// =============================================================
//
// Covers the pure functions the dispatcher uses to turn the raw
// client envelope POST /v1/events stores as the outbox payload
// (routes/v1/events.ts) into the flat shape CH migration 0017's
// mv_paywall_events_to_raw expects. The end-to-end round trip
// through real Kafka + ClickHouse is covered by
// ch-kafka-engine.integration.test.ts.

function buildRow(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "evt_row_1",
    aggregateType: "PAYWALL_EVENT",
    aggregateId: "prj_1",
    eventType: "paywall_view",
    payload: {
      eventId: "client_evt_1",
      eventType: "paywall_view",
      occurredAt: "2026-07-20T10:00:00.000Z",
      subscriberId: "sub_1",
      paywallContext: {
        paywallId: "pw_default",
        placementId: "plc_onboarding",
        placementRevision: 3,
        variantId: "var_treatment",
        experimentKey: "exp_key_1",
      },
    },
    createdAt: new Date("2026-07-20T10:00:01.000Z"),
    publishedAt: null,
    ...overrides,
  } as OutboxEvent;
}

describe("paywallEventId", () => {
  it("is deterministic for the same inputs", () => {
    const a = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1");
    const b = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the client eventId changes (distinct client retries stay collapsible per logical view)", () => {
    const a = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1");
    const b = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_2");
    expect(a).not.toBe(b);
  });

  it("changes when any identity field changes", () => {
    const base = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1");
    expect(paywallEventId("prj_2", "sub_1", "pw_1", "plc_1", "evt_1")).not.toBe(base);
    expect(paywallEventId("prj_1", "sub_2", "pw_1", "plc_1", "evt_1")).not.toBe(base);
    expect(paywallEventId("prj_1", "sub_1", "pw_2", "plc_1", "evt_1")).not.toBe(base);
    expect(paywallEventId("prj_1", "sub_1", "pw_1", "plc_2", "evt_1")).not.toBe(base);
  });
});

describe("shapePaywallEventMessage", () => {
  it("flattens the envelope into the raw-table-shaped payload, keyed by subscriberId", () => {
    const row = buildRow();
    const { key, value } = shapePaywallEventMessage(row);
    expect(key).toBe("sub_1");

    const parsed = JSON.parse(value) as {
      eventId: string;
      eventType: string;
      aggregateId: string;
      createdAt: string;
      payload: Record<string, unknown>;
    };

    const expectedEventId = paywallEventId(
      "prj_1",
      "sub_1",
      "pw_default",
      "plc_onboarding",
      "client_evt_1",
      "view",
    );
    expect(parsed.eventId).toBe(expectedEventId);
    expect(parsed.eventType).toBe("paywall_view");
    expect(parsed.aggregateId).toBe("prj_1");
    expect(parsed.payload).toEqual({
      projectId: "prj_1",
      subscriberId: "sub_1",
      paywallId: "pw_default",
      placementId: "plc_onboarding",
      placementRevision: 3,
      variantId: "var_treatment",
      experimentKey: "exp_key_1",
      occurredAt: "2026-07-20T10:00:00.000Z",
      kind: "view",
    });
  });

  it("is stable across two shapings of the same outbox row (dispatcher crash-replay)", () => {
    const row = buildRow();
    const first = shapePaywallEventMessage(row);
    const second = shapePaywallEventMessage(row);
    expect(JSON.parse(first.value).eventId).toBe(JSON.parse(second.value).eventId);
  });

  it("produces the SAME eventId for two distinct outbox rows sharing a client eventId (SDK-level retry)", () => {
    const first = shapePaywallEventMessage(buildRow({ id: "evt_row_1" }));
    const second = shapePaywallEventMessage(buildRow({ id: "evt_row_2" }));
    expect(JSON.parse(first.value).eventId).toBe(JSON.parse(second.value).eventId);
  });

  it("falls back to the outbox row id when the SDK omitted a client eventId", () => {
    const row = buildRow({
      payload: {
        occurredAt: "2026-07-20T10:00:00.000Z",
        subscriberId: "sub_1",
        paywallContext: {
          paywallId: "pw_default",
          placementId: "plc_onboarding",
          placementRevision: 1,
        },
      },
    });
    const { value } = shapePaywallEventMessage(row);
    const expected = paywallEventId(
      "prj_1",
      "sub_1",
      "pw_default",
      "plc_onboarding",
      row.id,
      "view",
    );
    expect(JSON.parse(value).eventId).toBe(expected);
  });

  it("tolerates a missing subscriberId (falls back to empty string, keys by projectId)", () => {
    const row = buildRow({
      payload: {
        eventId: "client_evt_1",
        occurredAt: "2026-07-20T10:00:00.000Z",
        paywallContext: {
          paywallId: "pw_default",
          placementId: "plc_onboarding",
          placementRevision: 1,
        },
      },
    });
    const { key, value } = shapePaywallEventMessage(row);
    expect(key).toBe("prj_1");
    const parsed = JSON.parse(value) as { payload: Record<string, unknown> };
    expect(parsed.payload.subscriberId).toBe("");
  });

  // ===========================================================
  // kind (0020) — eventType suffix, forward-tolerant
  // ===========================================================

  it("sets payload.kind to 'view' for a paywall_view row", () => {
    const row = buildRow({ eventType: "paywall_view" });
    const { value } = shapePaywallEventMessage(row);
    const parsed = JSON.parse(value) as { payload: Record<string, unknown> };
    expect(parsed.payload.kind).toBe("view");
  });

  it("sets payload.kind to 'close' for a paywall_close row", () => {
    const row = buildRow({ eventType: "paywall_close" });
    const { value } = shapePaywallEventMessage(row);
    const parsed = JSON.parse(value) as { payload: Record<string, unknown> };
    expect(parsed.payload.kind).toBe("close");
  });

  it("passes an unrecognized paywall_* suffix through as-is (forward-tolerant)", () => {
    const row = buildRow({ eventType: "paywall_impression" });
    const { value } = shapePaywallEventMessage(row);
    const parsed = JSON.parse(value) as { payload: Record<string, unknown> };
    expect(parsed.payload.kind).toBe("impression");
  });

  it("produces a DIFFERENT eventId for paywall_view vs paywall_close sharing the same clientEventId (kind joins the hash input)", () => {
    const viewRow = buildRow({ eventType: "paywall_view" });
    const closeRow = buildRow({ eventType: "paywall_close" });
    const viewEventId = JSON.parse(shapePaywallEventMessage(viewRow).value).eventId;
    const closeEventId = JSON.parse(shapePaywallEventMessage(closeRow).value).eventId;
    expect(viewEventId).not.toBe(closeEventId);
  });
});

describe("paywallEventId kind divergence", () => {
  it("changes when kind changes, all other inputs held equal", () => {
    const view = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1", "view");
    const close = paywallEventId("prj_1", "sub_1", "pw_1", "plc_1", "evt_1", "close");
    expect(view).not.toBe(close);
  });
});
