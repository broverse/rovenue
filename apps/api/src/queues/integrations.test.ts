import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  INTEGRATIONS_DELIVER_BACKOFF_MS,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "./integrations";

describe("integrations queue constants", () => {
  it("queue name is rovenue-integrations-deliver", () => {
    expect(INTEGRATIONS_DELIVER_QUEUE_NAME).toBe("rovenue-integrations-deliver");
  });

  it("backoff schedule has 5 steps", () => {
    expect(INTEGRATIONS_DELIVER_BACKOFF_MS).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 21_600_000,
    ]);
  });

  it("buildIntegrationsDeliverJobId concatenates connectionId:outboxEventId", () => {
    expect(buildIntegrationsDeliverJobId("c1", "o1")).toBe("c1:o1");
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
