import { describe, expect, it } from "vitest";
import type {
  IntegrationProvider,
  RovenueEventEnvelope,
  ConnectionConfig,
  DeliveryResult,
  MapEventResult,
  HttpClient,
} from "./types";

describe("integrations types", () => {
  it("compiles a sample MapEventResult skip union", () => {
    const skip: MapEventResult = { skip: true, reason: "filtered_by_event_scope" };
    expect("skip" in skip).toBe(true);
  });
  it("compiles a sample DeliveryResult", () => {
    const ok: DeliveryResult = { ok: true, httpStatus: 200, responseBody: "{}", retriable: false };
    expect(ok.ok).toBe(true);
  });
  it("envelope carries optional identityContext", () => {
    const env: RovenueEventEnvelope = {
      outboxEventId: "o1",
      projectId: "p1",
      eventType: "revenue.event.recorded",
      occurredAt: new Date().toISOString(),
      identityContext: { email: "e@x.com" },
    };
    expect(env.identityContext?.email).toBe("e@x.com");
  });
});
