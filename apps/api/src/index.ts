import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { createWebhookWorker } from "./services/webhook-processor";
import {
  createExpiryWorker,
  scheduleExpiryCheck,
} from "./workers/expiry-checker";
import {
  createFxWorker,
  scheduleFxFetch,
} from "./services/fx";
import {
  createDeliveryWorker,
  scheduleDelivery,
} from "./workers/webhook-delivery";
import {
  createWebhookRetentionWorker,
  scheduleWebhookRetention,
} from "./workers/webhook-retention";
import {
  runOutboxDispatcher,
  stopOutboxDispatcher,
} from "./workers/outbox-dispatcher";

// Start the in-process webhook worker alongside the HTTP server. For
// horizontal scaling, move this to a separate process using the same
// entrypoint and switch the HTTP side off there.
createWebhookWorker();

// Subscription expiry sweeper — 5-minute repeatable BullMQ job.
createExpiryWorker();
scheduleExpiryCheck().catch((err: unknown) => {
  logger.error("failed to schedule expiry checker", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Daily FX rate fetch at 00:05 UTC.
createFxWorker();
scheduleFxFetch().catch((err: unknown) => {
  logger.error("failed to schedule FX rate fetch", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Outgoing webhook delivery — 30-second repeatable poll.
createDeliveryWorker();
scheduleDelivery().catch((err: unknown) => {
  logger.error("failed to schedule webhook delivery", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// webhook_events retention — nightly DELETE pass for rows older
// than 90 days. Replaces a hypertable drop_chunks policy; see
// workers/webhook-retention.ts for the rationale.
createWebhookRetentionWorker();
scheduleWebhookRetention().catch((err: unknown) => {
  logger.error("failed to schedule webhook retention", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Shutdown handler — signals the outbox dispatcher loop to exit
// so the Kafka producer disconnects cleanly before the process
// terminates. Other BullMQ workers close via their own lifecycle.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("shutdown requested", { sig });
    stopOutboxDispatcher();
  });
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("listening", { url: `http://localhost:${info.port}` });
});

// Outbox → Redpanda dispatcher loop. Fire-and-forget; the loop
// handles its own errors and will no-op when KAFKA_BROKERS is unset.
void runOutboxDispatcher();
