// =============================================================
// Live Events publisher for integration delivery results
// =============================================================
//
// Publishes real-time delivery outcomes to a Redis Pub/Sub channel
// so the dashboard can stream results via SSE. Publishing is
// best-effort — any error is swallowed so a Redis hiccup never
// blocks the BullMQ worker's job-completion path.

// =============================================================
// Constants
// =============================================================

export const LIVE_EVENTS_CHANNEL_PREFIX = "rovenue.live-events";

// =============================================================
// Types
// =============================================================

/** Minimal Redis interface required by this module (subset of ioredis). */
export interface LivePublisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface DeliveryLiveEvent {
  type: "integration.delivery";
  projectId: string;
  integrationId: string;
  provider: string;
  eventType: string;
  success: boolean;
  statusCode?: number;
  durationMs: number;
  attemptNumber: number;
  jobId?: string;
  timestamp: string;
}

// =============================================================
// Publisher
// =============================================================

/**
 * Publishes a delivery live-event to the per-project Redis channel.
 * Errors are silently swallowed (best-effort).
 */
export async function publishIntegrationDeliveryLiveEvent(
  publisher: LivePublisher,
  event: DeliveryLiveEvent,
): Promise<void> {
  try {
    const channel = `${LIVE_EVENTS_CHANNEL_PREFIX}.${event.projectId}`;
    await publisher.publish(channel, JSON.stringify(event));
  } catch {
    // best-effort — swallow
  }
}
