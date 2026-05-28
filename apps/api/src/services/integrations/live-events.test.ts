import { describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENTS_CHANNEL_PREFIX,
  publishIntegrationDeliveryLiveEvent,
  type DeliveryLiveEvent,
  type LivePublisher,
} from "./live-events";

const baseEvent: DeliveryLiveEvent = {
  type: "integration.delivery",
  projectId: "p1",
  integrationId: "int-1",
  provider: "meta",
  eventType: "Purchase",
  success: true,
  statusCode: 200,
  durationMs: 55,
  attemptNumber: 1,
  jobId: "job-abc",
  timestamp: new Date().toISOString(),
};

describe("live events publisher", () => {
  it("publishes to the per-project channel with serialised JSON", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const publisher: LivePublisher = { publish };
    await publishIntegrationDeliveryLiveEvent(publisher, baseEvent);
    expect(publish).toHaveBeenCalledOnce();
    const [channel, message] = publish.mock.calls[0];
    expect(channel).toBe(`${LIVE_EVENTS_CHANNEL_PREFIX}.p1`);
    const parsed = JSON.parse(message);
    expect(parsed.type).toBe("integration.delivery");
    expect(parsed.success).toBe(true);
  });

  it("swallows publish errors (best-effort)", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis down"));
    const publisher: LivePublisher = { publish };
    await expect(
      publishIntegrationDeliveryLiveEvent(publisher, baseEvent),
    ).resolves.toBeUndefined();
  });
});
