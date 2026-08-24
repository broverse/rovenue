import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  DEFAULT_RETRY_POLICY,
  WEBHOOK_RETRY_POLICY,
  retryPolicyFor,
  deliverJobOptions,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "./integrations";

describe("integrations queue constants", () => {
  it("queue name is rovenue-integrations-deliver", () => {
    expect(INTEGRATIONS_DELIVER_QUEUE_NAME).toBe("rovenue-integrations-deliver");
  });

  it("buildIntegrationsDeliverJobId concatenates connectionId|outboxEventId (pipe separator, BullMQ v5 safe)", () => {
    expect(buildIntegrationsDeliverJobId("c1", "o1")).toBe("c1|o1");
  });

  it("IntegrationsDeliverJob type compiles", () => {
    const job: IntegrationsDeliverJob = {
      connectionId: "c1",
      projectId: "p1",
      providerId: "META_CAPI",
      envelope: {
        outboxEventId: "o1",
        projectId: "p1",
        eventType: "revenue.event.recorded",
        occurredAt: new Date().toISOString(),
      },
    };
    expect(job.connectionId).toBe("c1");
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("is 5 attempts with the 30s→6h schedule", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      attempts: 5,
      backoffMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000],
    });
  });
});

describe("WEBHOOK_RETRY_POLICY", () => {
  it("is 8 attempts", () => {
    expect(WEBHOOK_RETRY_POLICY.attempts).toBe(8);
  });

  it("has a backoff schedule summing to at least 24h wall-clock (Svix/RevenueCat parity)", () => {
    const totalMs = WEBHOOK_RETRY_POLICY.backoffMs.reduce((sum, ms) => sum + ms, 0);
    expect(totalMs).toBeGreaterThanOrEqual(24 * 3_600_000);
  });
});

describe("retryPolicyFor", () => {
  it("returns WEBHOOK_RETRY_POLICY for CUSTOM_WEBHOOK", () => {
    expect(retryPolicyFor("CUSTOM_WEBHOOK").attempts).toBe(8);
    expect(retryPolicyFor("CUSTOM_WEBHOOK")).toEqual(WEBHOOK_RETRY_POLICY);
  });

  it("returns DEFAULT_RETRY_POLICY for META_CAPI (no override)", () => {
    expect(retryPolicyFor("META_CAPI")).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("returns DEFAULT_RETRY_POLICY for TIKTOK_EVENTS (no override)", () => {
    expect(retryPolicyFor("TIKTOK_EVENTS")).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("falls back to DEFAULT_RETRY_POLICY for an unknown provider id without throwing", () => {
    expect(() => retryPolicyFor("SOME_UNKNOWN_PROVIDER")).not.toThrow();
    expect(retryPolicyFor("SOME_UNKNOWN_PROVIDER")).toEqual(DEFAULT_RETRY_POLICY);
  });
});

describe("deliverJobOptions", () => {
  it("pins backoff.type to 'custom' so BullMQ consults the worker's backoffStrategy", () => {
    // This is the regression test for the dead-backoff bug: jobs enqueued
    // without backoff:{type:"custom"} never reach settings.backoffStrategy,
    // so BullMQ retries them with no delay at all.
    const opts = deliverJobOptions("META_CAPI", "conn1|outbox1");
    expect(opts.backoff).toEqual({ type: "custom" });
  });

  it("sets attempts from the provider's retry policy", () => {
    expect(deliverJobOptions("META_CAPI", "j1").attempts).toBe(5);
    expect(deliverJobOptions("CUSTOM_WEBHOOK", "j2").attempts).toBe(8);
  });

  it("carries the jobId through and sets removeOnComplete/removeOnFail", () => {
    const opts = deliverJobOptions("META_CAPI", "conn1|outbox1");
    expect(opts.jobId).toBe("conn1|outbox1");
    expect(opts.removeOnComplete).toEqual({ age: 86_400, count: 10_000 });
    expect(opts.removeOnFail).toEqual({ age: 7 * 86_400 });
  });
});
