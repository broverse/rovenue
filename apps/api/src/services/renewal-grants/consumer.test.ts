import { describe, expect, test } from "vitest";
import { toRenewalGrantJob } from "./consumer";

// Shape confirmed against outbox-dispatcher.ts's Kafka envelope
// (workers/outbox-dispatcher.ts's generic non-paywall branch, ~line 326):
// `{ eventId: row.id, eventType, aggregateId, createdAt, payload }`. The
// wire field is `eventId` (the outbox row id) — NOT `outboxEventId`, which
// is only the internal RovenueEventEnvelope's field name used by the
// integrations-fanout consumer once it has already parsed this same wrapper.
function message(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "obx_1",
    eventType: "revenue.event.recorded",
    payload: {
      revenueEventId: "rev_1",
      projectId: "prj_1",
      subscriberId: "sub_1",
      purchaseId: "pur_1",
      productId: "prd_1",
      type: "RENEWAL",
      store: "APP_STORE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: "2026-09-04T00:00:00.000Z",
      ...overrides,
    },
  };
}

describe("toRenewalGrantJob", () => {
  test("maps a renewal envelope onto a job", () => {
    const result = toRenewalGrantJob(message());

    expect(result).toEqual({
      outboxEventId: "obx_1",
      job: {
        revenueEventId: "rev_1",
        projectId: "prj_1",
        subscriberId: "sub_1",
        productId: "prd_1",
        type: "RENEWAL",
      },
    });
  });

  test("returns null for a non-granting event type", () => {
    // Filtered at the consumer so the queue never carries work the
    // worker would only discard.
    expect(toRenewalGrantJob(message({ type: "REFUND" }))).toBeNull();
  });

  test("returns null when a required field is missing", () => {
    expect(toRenewalGrantJob(message({ productId: undefined }))).toBeNull();
    expect(toRenewalGrantJob(message({ subscriberId: null }))).toBeNull();
  });

  test("returns null for a shape it does not recognise", () => {
    expect(toRenewalGrantJob(null)).toBeNull();
    expect(toRenewalGrantJob({})).toBeNull();
    expect(toRenewalGrantJob({ payload: "not an object" })).toBeNull();
  });
});
