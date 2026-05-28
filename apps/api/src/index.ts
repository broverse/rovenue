import { serve } from "@hono/node-server";
import { app } from "./app";
import { internalApp } from "./internal-app";
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
  createOutboxCleanupWorker,
  scheduleOutboxCleanup,
} from "./workers/outbox-cleanup";
import {
  createPartitionMaintenanceWorker,
  schedulePartitionMaintenance,
} from "./workers/partition-maintenance";
import {
  runOutboxDispatcher,
  stopOutboxDispatcher,
} from "./workers/outbox-dispatcher";
import {
  ensureRepeatable as ensureScheduledActionsRepeatable,
  getScheduledActionsQueue,
  getScheduledActionsWorker,
} from "./workers/scheduled-actions";
import { createEmailWorker } from "./workers/email";
import {
  createFunnelAbandonerWorker,
  scheduleFunnelAbandoner,
} from "./workers/funnel-abandoner";
import {
  createFunnelTokenExpirerWorker,
  scheduleFunnelTokenExpirer,
} from "./workers/funnel-token-expirer";
import {
  createFunnelDeferredCleanupWorker,
  scheduleFunnelDeferredCleanup,
} from "./workers/funnel-deferred-cleanup";
import {
  createCustomDomainVerifierWorker,
  scheduleCustomDomainVerifier,
} from "./workers/custom-domain-verifier";
import {
  createCustomDomainCertPollerWorker,
  scheduleCustomDomainCertPoller,
} from "./workers/custom-domain-cert-poller";
import {
  createRoviReaperWorker,
  scheduleRoviReaper,
} from "./workers/rovi-reaper";
import {
  createRoviRetentionWorker,
  scheduleRoviRetention,
} from "./workers/rovi-retention";
import {
  createRefundShieldResponderWorker,
  scheduleRefundShieldResponder,
} from "./workers/refund-shield-responder";
import { bootIntegrations } from "./integrations-boot";

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

// outbox_events cleanup — hourly DELETE pass for rows older than
// 24h whose publishedAt is set (Plan 3 §F.2). Replaces the
// timescale retention policy on the outbox topic-source table.
createOutboxCleanupWorker();
scheduleOutboxCleanup().catch((err: unknown) => {
  logger.error("failed to schedule outbox cleanup", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Partition maintenance — daily 03:00 UTC. Calls
// partman.run_maintenance_proc() and pre-creates the next-month
// partition for outgoing_webhooks (NOT pg_partman-managed).
createPartitionMaintenanceWorker();
schedulePartitionMaintenance().catch((err: unknown) => {
  logger.error("failed to schedule partition maintenance", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Scheduled-actions sweep — every 60 seconds via BullMQ repeatable job.
getScheduledActionsWorker();
ensureScheduledActionsRepeatable().catch((err: unknown) => {
  logger.error("failed to schedule scheduled-actions sweep", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Outgoing transactional email (invitations today; reusable for more flows).
createEmailWorker();

// Funnel session abandoner — hourly sweep that flips in_progress
// sessions with lastActivityAt older than 24h to 'abandoned'.
createFunnelAbandonerWorker();
scheduleFunnelAbandoner().catch((err: unknown) => {
  logger.error("failed to schedule funnel abandoner", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Funnel claim-token expirer — daily 03:00 UTC sweep that removes
// claim-token rows whose expires_at has passed.
createFunnelTokenExpirerWorker();
scheduleFunnelTokenExpirer().catch((err: unknown) => {
  logger.error("failed to schedule funnel token expirer", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Funnel deferred-claim cleanup — every 5 minutes, prunes
// fingerprint-deferred rows past their expires_at.
createFunnelDeferredCleanupWorker();
scheduleFunnelDeferredCleanup().catch((err: unknown) => {
  logger.error("failed to schedule funnel deferred cleanup", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Custom-domain verifier — every 5 minutes, re-runs CNAME+TXT checks
// on unverified rows that were last checked > 30 min ago. After 7 days
// without success the row is tagged `verification_window_expired`.
createCustomDomainVerifierWorker();
scheduleCustomDomainVerifier().catch((err: unknown) => {
  logger.error("failed to schedule custom-domain verifier", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Custom-domain cert poller — every minute, TLS-handshakes verified
// rows to learn whether Caddy has finished ACME. Flips cert_status
// pending → issuing → issued / failed. After 30 minutes without issue
// the row is marked failed.
createCustomDomainCertPollerWorker();
scheduleCustomDomainCertPoller().catch((err: unknown) => {
  logger.error("failed to schedule custom-domain cert poller", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Rovi reaper — every 60 seconds, flips copilot_intents rows
// past their expires_at from 'pending' to 'expired'.
createRoviReaperWorker();
scheduleRoviReaper().catch((err: unknown) => {
  logger.error("failed to schedule rovi reaper", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Rovi retention — nightly at 03:00 UTC, hard-deletes copilot_messages
// older than ROVI_MESSAGE_RETENTION_DAYS (GDPR Art. 5(1)(e)).
createRoviRetentionWorker();
scheduleRoviRetention().catch((err: unknown) => {
  logger.error("failed to schedule rovi retention", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Refund Shield responder — 30-second repeatable BullMQ job. Claims
// PENDING refund_shield_responses rows whose scheduledFor has arrived
// and POSTs the per-subscriber ConsumptionRequest to Apple. Multiple
// API replicas can run safely (FOR UPDATE SKIP LOCKED inside the
// claim repo). See workers/refund-shield-responder.ts.
createRefundShieldResponderWorker();
scheduleRefundShieldResponder().catch((err: unknown) => {
  logger.error("failed to schedule refund shield responder", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Integrations fanout + delivery pipeline (Kafka → BullMQ → worker).
// bootIntegrations() no-ops gracefully when KAFKA_BROKERS is unset.
const integrationsHandle = bootIntegrations();

// Shutdown handler — signals the outbox dispatcher loop to exit
// so the Kafka producer disconnects cleanly before the process
// terminates. Other BullMQ workers close via their own lifecycle.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("shutdown requested", { sig });
    stopOutboxDispatcher();
    void getScheduledActionsWorker().close();
    void getScheduledActionsQueue().close();
    void integrationsHandle.then((h) => h.stop());
  });
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("listening", { url: `http://localhost:${info.port}` });
});

// Internal-only port — Caddy on-demand-TLS ask endpoint + health probe.
// Never mapped in docker-compose `ports:` so it stays unreachable from
// the public network. See apps/api/src/internal-app.ts for the rationale.
serve({ fetch: internalApp.fetch, port: env.INTERNAL_PORT }, (info) => {
  logger.info("internal listener", { url: `http://localhost:${info.port}` });
});

// Outbox → Redpanda dispatcher loop. Fire-and-forget; the loop
// handles its own errors and will no-op when KAFKA_BROKERS is unset.
void runOutboxDispatcher();
