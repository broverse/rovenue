// =============================================================
// backfill.test.ts — unit tests for enqueueBackfillForConnection
// =============================================================
//
// M4.2: default 7-day window and custom windowDays.
// M4.3: chunked cursor-pagination when first page is full.
//
// All DB and BullMQ dependencies are injected as vi.fn() stubs.

import { describe, expect, it, vi, type Mock } from "vitest";
import { enqueueBackfillForConnection, outboxRowToEnvelope } from "./backfill";
import type { EnqueueBackfillDeps, OutboxRow } from "./backfill";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string, offsetMs = 0): OutboxRow {
  return {
    id,
    aggregate_type: "REVENUE_EVENT",
    event_type: "revenue.event.recorded",
    payload: { projectId: "proj_test", outboxEventId: id },
    created_at: new Date(Date.now() - offsetMs),
  };
}

function makeDeps(rows: OutboxRow[][]): EnqueueBackfillDeps & {
  queueAddMock: Mock;
  auditMock: Mock;
  executeMock: Mock;
} {
  let callIndex = 0;
  const executeMock = vi.fn(async () => {
    const page = rows[callIndex] ?? [];
    callIndex++;
    return { rows: page };
  });

  const queueAddMock = vi.fn(async () => undefined);
  const auditMock = vi.fn(async () => undefined);

  return {
    db: { execute: executeMock },
    queue: { add: queueAddMock } as unknown as EnqueueBackfillDeps["queue"],
    audit: auditMock,
    queueAddMock,
    auditMock,
    executeMock,
  };
}

// ---------------------------------------------------------------------------
// M4.2 — basic functionality
// ---------------------------------------------------------------------------

describe("enqueueBackfillForConnection — M4.2", () => {
  it("default 7-day window: enqueues 3 rows and calls audit", async () => {
    const rows = [makeRow("evt_1"), makeRow("evt_2"), makeRow("evt_3")];
    const deps = makeDeps([rows, []]);

    const result = await enqueueBackfillForConnection(
      {
        connectionId: "conn_abc",
        projectId: "proj_test",
        providerId: "META_CAPI",
      },
      deps,
    );

    expect(result.eventCount).toBe(3);

    // All 3 rows should have been added to the queue as backfill jobs
    expect(deps.queueAddMock).toHaveBeenCalledTimes(3);
    for (const row of rows) {
      expect(deps.queueAddMock).toHaveBeenCalledWith(
        "deliver",
        expect.objectContaining({
          connectionId: "conn_abc",
          projectId: "proj_test",
          providerId: "META_CAPI",
          isBackfill: true,
        }),
        expect.objectContaining({
          jobId: `conn_abc|${row.id}`,
          priority: 10,
        }),
      );
    }

    // Audit was called with backfill.started and correct metadata
    expect(deps.auditMock).toHaveBeenCalledTimes(1);
    expect(deps.auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration.backfill.started",
        actorId: "system",
        actorType: "system",
        resource: "integration_connection",
        resourceId: "conn_abc",
        metadata: expect.objectContaining({ windowDays: 7, eventCount: 3 }),
      }),
    );

    // SQL should contain '7 days'
    const firstCall = (deps.executeMock.mock.calls as Array<Array<{ sql: string; params: unknown[] }>>)[0]![0]!;
    expect(firstCall.sql).toContain("7 days");
  });

  it("custom windowDays: 3-day window is reflected in SQL", async () => {
    const rows = [makeRow("evt_A"), makeRow("evt_B")];
    const deps = makeDeps([rows, []]);

    const result = await enqueueBackfillForConnection(
      {
        connectionId: "conn_xyz",
        projectId: "proj_test",
        providerId: "META_CAPI",
        windowDays: 3,
      },
      deps,
    );

    expect(result.eventCount).toBe(2);

    const firstCall = (deps.executeMock.mock.calls as Array<Array<{ sql: string; params: unknown[] }>>)[0]![0]!;
    expect(firstCall.sql).toContain("3 days");
    expect(deps.auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ windowDays: 3 }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// M4.3 — chunked cursor-pagination
// ---------------------------------------------------------------------------

describe("enqueueBackfillForConnection — M4.3 chunked", () => {
  it("handles >10 000 rows via cursor pagination: 10 000 + 1 = 10 001 total", async () => {
    // Build a page of 10 000 rows and a final page of 1 row
    const PAGE_SIZE = 10_000;
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeRow(`evt_page1_${i}`, (PAGE_SIZE - i) * 1000),
    );
    const page2 = [makeRow("evt_page2_0", 0)];

    // Third call returns empty — cursor loop should stop
    const deps = makeDeps([page1, page2, []]);

    const result = await enqueueBackfillForConnection(
      {
        connectionId: "conn_bulk",
        projectId: "proj_bulk",
        providerId: "META_CAPI",
      },
      deps,
    );

    expect(result.eventCount).toBe(10_001);
    expect(deps.executeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.queueAddMock).toHaveBeenCalledTimes(10_001);

    // Second call should include a cursor param ($2)
    const secondCall = deps.executeMock.mock.calls[1]?.[0] as
      | { sql: string; params: unknown[] }
      | undefined;
    expect(secondCall).toBeDefined();
    expect(secondCall!.sql).toContain("$2::timestamptz");
  });
});

// ---------------------------------------------------------------------------
// outboxRowToEnvelope — normalization of REAL stored outbox rows
// ---------------------------------------------------------------------------
//
// The payload column is domain-shaped, never a RovenueEventEnvelope, so this
// must go through toFanoutEnvelope rather than casting. A cast produced
// `outboxEventId: undefined`, which then violates integration_deliveries'
// NOT NULL outbox_event_id on both the backfill and the redeliver path.

describe("outboxRowToEnvelope", () => {
  const ROW_ID = "oe_row_1";
  const PROJECT_ID = "proj_norm";

  /** Field names per createRevenueEvent's outbox emit
   *  (packages/db/src/drizzle/repositories/revenue-events.ts). */
  const productionRevenuePayload = {
    revenueEventId: "rev_1",
    projectId: PROJECT_ID,
    subscriberId: "sub_1",
    purchaseId: "pur_1",
    productId: "prod_1",
    type: "RENEWAL",
    store: "APP_STORE",
    amount: "9.9900",
    amountUsd: "9.9900",
    currency: "USD",
    eventDate: "2026-08-20T10:00:00.000Z",
  };

  it("normalizes a production REVENUE_EVENT row into a complete envelope", () => {
    const envelope = outboxRowToEnvelope({
      id: ROW_ID,
      aggregateType: "REVENUE_EVENT",
      eventType: "revenue.event.recorded",
      payload: productionRevenuePayload,
      createdAt: new Date("2026-08-20T10:00:01.000Z"),
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.outboxEventId).toBe(ROW_ID);
    expect(envelope!.projectId).toBe(PROJECT_ID);
    expect(envelope!.revenueEventKind).toBe("RENEWAL");
    expect(envelope!.amount).toBe("9.9900");
    expect(envelope!.currency).toBe("USD");
    expect(envelope!.occurredAt).toBe(productionRevenuePayload.eventDate);
    expect(envelope!.identityContext).toEqual({ externalId: "sub_1" });
  });

  it("normalizes a SUBSCRIPTION bridge row", () => {
    const envelope = outboxRowToEnvelope({
      id: ROW_ID,
      aggregateType: "SUBSCRIPTION",
      eventType: "subscription.expired",
      payload: {
        projectId: PROJECT_ID,
        subscriberId: "sub_2",
        purchaseId: "pur_2",
        timestamp: "2026-08-20T11:00:00.000Z",
      },
      createdAt: "2026-08-20T11:00:01.000Z",
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.outboxEventId).toBe(ROW_ID);
    expect(envelope!.eventKey).toBe("subscription.expired");
    expect(envelope!.occurredAt).toBe("2026-08-20T11:00:00.000Z");
  });

  it("passes a legacy already-complete envelope payload through unchanged", () => {
    const legacy = {
      outboxEventId: "oe_legacy",
      projectId: PROJECT_ID,
      eventType: "revenue.event.recorded",
      revenueEventKind: "INITIAL",
      occurredAt: "2026-08-20T12:00:00.000Z",
      amount: "4.99",
      currency: "USD",
    };

    const envelope = outboxRowToEnvelope({
      id: ROW_ID,
      aggregateType: "REVENUE_EVENT",
      eventType: "revenue.event.recorded",
      payload: legacy,
      createdAt: "2026-08-20T12:00:01.000Z",
    });

    expect(envelope).toEqual(legacy);
  });

  it("returns null for an aggregate type that never fans out to integrations", () => {
    expect(
      outboxRowToEnvelope({
        id: ROW_ID,
        aggregateType: "BILLING",
        eventType: "billing.invoice.paid",
        payload: { projectId: PROJECT_ID },
        createdAt: "2026-08-20T13:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("returns null for an event type the fan-out consumer does not map", () => {
    expect(
      outboxRowToEnvelope({
        id: ROW_ID,
        aggregateType: "SUBSCRIPTION",
        eventType: "DID_RENEW",
        payload: { projectId: PROJECT_ID, subscriberId: "sub_3" },
        createdAt: "2026-08-20T14:00:00.000Z",
      }),
    ).toBeNull();
  });
});
