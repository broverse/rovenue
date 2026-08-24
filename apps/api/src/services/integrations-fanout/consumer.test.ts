import { describe, expect, it, vi } from "vitest";
import { processFanoutMessage, toFanoutEnvelope } from "./consumer";
import { createConnectionCache } from "./connection-cache";
import type { RovenueEventEnvelope } from "../integrations/types";
import type { IntegrationConnection } from "@rovenue/db";

const conn = (overrides?: Partial<IntegrationConnection>): IntegrationConnection => ({
  id: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  displayName: "Test",
  credentialsCipher: "encrypted",
  credentialsHint: "hint",
  enabledEvents: ["revenue.event.recorded"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: true,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as IntegrationConnection);

const makeEnvelope = (overrides?: Partial<RovenueEventEnvelope>): RovenueEventEnvelope => ({
  outboxEventId: "ob1",
  projectId: "p1",
  eventType: "revenue.event.recorded",
  occurredAt: new Date().toISOString(),
  ...overrides,
});

describe("processFanoutMessage", () => {
  it("enqueues one job per enabled connection", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const cache = {
      get: vi.fn().mockResolvedValue([
        { id: "c1", projectId: "p1", providerId: "META_CAPI", isEnabled: true },
        { id: "c2", projectId: "p1", providerId: "TIKTOK_EVENTS", isEnabled: true },
      ]),
      invalidate: vi.fn(),
      onInvalidate: vi.fn(),
    };

    await processFanoutMessage(makeEnvelope(), { cache, enqueue });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c1" }),
      "c1|ob1",
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c2" }),
      "c2|ob1",
    );
  });

  it("does not enqueue when no connections returned", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const cache = {
      get: vi.fn().mockResolvedValue([]),
      invalidate: vi.fn(),
      onInvalidate: vi.fn(),
    };

    await processFanoutMessage(makeEnvelope(), { cache, enqueue });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("skips connections with isEnabled=false", async () => {
    const enqueued: string[] = [];
    const cache = createConnectionCache({
      ttlMs: 1000,
      loader: async () => [
        conn({ id: "c1", isEnabled: true }),
        conn({ id: "c2", isEnabled: false }),
      ],
    });
    await processFanoutMessage(
      {
        outboxEventId: "ob1",
        projectId: "p1",
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
      },
      {
        cache,
        enqueue: async (job, _jobId) => { enqueued.push(job.connectionId); },
      },
    );
    expect(enqueued).toEqual(["c1"]);
  });
});

describe("toFanoutEnvelope", () => {
  it("[rovenue.revenue] maps a revenue.event.recorded wrapper (regression)", () => {
    const wrapper = {
      eventId: "ob-rev-1",
      eventType: "revenue.event.recorded",
      aggregateId: "p1",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        projectId: "p1",
        subscriberId: "sub1",
        productId: "prod1",
        type: "INITIAL",
        amount: "9.99",
        currency: "USD",
        eventDate: "2026-08-23T23:00:00.000Z",
      },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.revenue");

    expect(envelope).toEqual({
      outboxEventId: "ob-rev-1",
      projectId: "p1",
      eventType: "revenue.event.recorded",
      occurredAt: "2026-08-23T23:00:00.000Z",
      revenueEventKind: "INITIAL",
      amount: "9.99",
      currency: "USD",
      subscriberId: "sub1",
      productId: "prod1",
      identityContext: { externalId: "sub1" },
    });
  });

  it("[rovenue.revenue] falls back to wrapper createdAt when eventDate is missing", () => {
    const wrapper = {
      eventId: "ob-rev-2",
      eventType: "revenue.event.recorded",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1" },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.revenue");

    expect(envelope?.occurredAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("[rovenue.revenue] returns null for a non-revenue eventType", () => {
    const wrapper = {
      eventId: "ob-rev-3",
      eventType: "something.else",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1" },
    };

    expect(toFanoutEnvelope(wrapper, "rovenue.revenue")).toBeNull();
  });

  it("[rovenue.subscription] maps subscription.cancel_requested", () => {
    const wrapper = {
      eventId: "ob-sub-1",
      eventType: "subscription.cancel_requested",
      aggregateId: "p1",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        projectId: "p1",
        purchaseId: "purchase1",
        subscriberId: "sub1",
        store: "APPLE",
        requestedAt: "2026-08-23T12:00:00.000Z",
      },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.subscription");

    expect(envelope).toEqual({
      outboxEventId: "ob-sub-1",
      projectId: "p1",
      eventType: "subscription.cancel_requested",
      eventKey: "subscription.cancel_requested",
      occurredAt: "2026-08-23T12:00:00.000Z",
      subscriberId: "sub1",
      payload: wrapper.payload,
    });
  });

  it("[rovenue.subscription] falls back to wrapper createdAt when requestedAt is missing", () => {
    const wrapper = {
      eventId: "ob-sub-2",
      eventType: "subscription.cancel_requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1", purchaseId: "purchase1", subscriberId: "sub1", store: "APPLE" },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.subscription");

    expect(envelope?.occurredAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("[rovenue.subscription] returns null for an unmapped eventType", () => {
    const wrapper = {
      eventId: "ob-sub-3",
      eventType: "subscription.expired",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1" },
    };

    expect(toFanoutEnvelope(wrapper, "rovenue.subscription")).toBeNull();
  });

  // The real wire shape published by workers/outbox-dispatcher.ts's
  // shapePaywallEventMessage() — a FLAT payload with `projectId` on it
  // (reshaped from the raw POST /v1/events client envelope). See that
  // module for the field-by-field derivation.
  it("[rovenue.paywall_events] maps paywall_view to eventKey paywall.view", () => {
    const wrapper = {
      eventId: "ob-pw-1",
      eventType: "paywall_view",
      aggregateId: "p1",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        projectId: "p1",
        subscriberId: "sub1",
        paywallId: "pw1",
        placementId: "pl1",
        placementRevision: 3,
        variantId: "v1",
        experimentKey: "exp1",
        occurredAt: "2026-08-23T12:00:00.000Z",
        kind: "view",
      },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.paywall_events");

    expect(envelope).toEqual({
      outboxEventId: "ob-pw-1",
      projectId: "p1",
      eventType: "paywall_view",
      eventKey: "paywall.view",
      occurredAt: "2026-08-23T12:00:00.000Z",
      subscriberId: "sub1",
      payload: wrapper.payload,
    });
  });

  it("[rovenue.paywall_events] maps paywall_close to eventKey paywall.close", () => {
    const wrapper = {
      eventId: "ob-pw-2",
      eventType: "paywall_close",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        projectId: "p1",
        subscriberId: "sub1",
        paywallId: "pw1",
        placementId: "pl1",
        placementRevision: 3,
        variantId: null,
        experimentKey: null,
        occurredAt: "2026-08-23T12:05:00.000Z",
        kind: "close",
      },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.paywall_events");

    expect(envelope?.eventKey).toBe("paywall.close");
    expect(envelope?.eventType).toBe("paywall_close");
  });

  it("[rovenue.paywall_events] falls back to wrapper createdAt when payload.occurredAt is missing", () => {
    const wrapper = {
      eventId: "ob-pw-3",
      eventType: "paywall_view",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1", subscriberId: "sub1" },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.paywall_events");

    expect(envelope?.occurredAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("[rovenue.paywall_events] returns null for an unmapped eventType", () => {
    const wrapper = {
      eventId: "ob-pw-4",
      eventType: "paywall_dismiss",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1" },
    };

    expect(toFanoutEnvelope(wrapper, "rovenue.paywall_events")).toBeNull();
  });

  // Field names per packages/db/src/drizzle/repositories/credit-ledger.ts:151
  // (insertCreditLedger's outbox emit site).
  it("[rovenue.credit] maps credit.ledger.appended", () => {
    const wrapper = {
      eventId: "ob-cr-1",
      eventType: "credit.ledger.appended",
      aggregateId: "creditLedgerRowId",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        creditLedgerId: "cl1",
        projectId: "p1",
        subscriberId: "sub1",
        currencyId: "cur1",
        type: "GRANT",
        amount: 100,
        balance: 100,
        referenceType: "PURCHASE",
        referenceId: "purchase1",
        createdAt: "2026-08-23T12:10:00.000Z",
      },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.credit");

    expect(envelope).toEqual({
      outboxEventId: "ob-cr-1",
      projectId: "p1",
      eventType: "credit.ledger.appended",
      eventKey: "credit.ledger.appended",
      occurredAt: "2026-08-23T12:10:00.000Z",
      subscriberId: "sub1",
      payload: wrapper.payload,
    });
  });

  it("[rovenue.credit] falls back to wrapper createdAt when payload.createdAt is missing", () => {
    const wrapper = {
      eventId: "ob-cr-2",
      eventType: "credit.ledger.appended",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1", subscriberId: "sub1" },
    };

    const envelope = toFanoutEnvelope(wrapper, "rovenue.credit");

    expect(envelope?.occurredAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("[rovenue.credit] returns null for an unmapped eventType", () => {
    const wrapper = {
      eventId: "ob-cr-3",
      eventType: "credit.ledger.reversed",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { projectId: "p1" },
    };

    expect(toFanoutEnvelope(wrapper, "rovenue.credit")).toBeNull();
  });

  it("returns null for a malformed message (not an object)", () => {
    expect(toFanoutEnvelope("not-an-object", "rovenue.revenue")).toBeNull();
    expect(toFanoutEnvelope(null, "rovenue.revenue")).toBeNull();
  });

  it("returns null when the wrapper has no string eventId", () => {
    const wrapper = { eventType: "revenue.event.recorded", payload: { projectId: "p1" } };
    expect(toFanoutEnvelope(wrapper, "rovenue.revenue")).toBeNull();
  });

  it("passes through an already-complete envelope regardless of topic", () => {
    const complete: RovenueEventEnvelope = {
      outboxEventId: "already-1",
      projectId: "p1",
      eventType: "revenue.event.recorded",
      occurredAt: "2026-08-24T00:00:00.000Z",
    };

    expect(toFanoutEnvelope(complete, "rovenue.credit")).toEqual(complete);
  });
});
