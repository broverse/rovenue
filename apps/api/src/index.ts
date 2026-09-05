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
  createGoogleReconciliationWorker,
  scheduleGoogleReconciliation,
} from "./workers/google-reconciliation";
import {
  createAccessReconciliationWorker,
  scheduleAccessReconciliation,
} from "./workers/access-reconciliation";
import {
  createFxWorker,
  scheduleFxFetch,
} from "./services/fx";
import {
  createDeliveryWorker,
  scheduleDelivery,
} from "./workers/webhook-delivery";
import {
  createWebhookReaperWorker,
  scheduleWebhookReaper,
} from "./workers/webhook-reaper";
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
  createUsageCapSweeperWorker,
  scheduleUsageCapSweep,
} from "./workers/usage-cap-sweeper";
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
  createRefundShieldResponderWorker,
  scheduleRefundShieldResponder,
} from "./workers/refund-shield-responder";
import { createImportRunnerWorker } from "./workers/import-runner";
import { ensureImportRetention } from "./workers/import-retention";
import {
  createExperimentSchedulerWorker,
  scheduleExperimentScheduler,
} from "./workers/experiment-scheduler";
import { ensureLeaderboardScheduler } from "./workers/leaderboard-scheduler";
import { ensureRetentionSweep } from "./workers/retention-sweep";
import { bootIntegrations } from "./integrations-boot";
import { bootRenewalGrants } from "./renewal-grants-boot";
import { checkConnectWebhookEvents } from "./services/stripe/connect-endpoint-check";
import { applySharpHardening } from "./services/assets/sharp-hardening";

// Lock the libvips loader allowlist down before any image bytes reach
// sharp — see services/assets/sharp-hardening.ts for the rationale.
applySharpHardening();

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

// Google reconciliation sweep — 15-minute repeatable BullMQ job that
// re-verifies drifted Google purchases against the Play Developer API
// (see workers/google-reconciliation.ts for the first-run backfill
// decision). Always schedules with the default `backfill: false`.
createGoogleReconciliationWorker();
scheduleGoogleReconciliation().catch((err: unknown) => {
  logger.error("failed to schedule google reconciliation sweep", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Entitlement drift reconciler — 30-minute repeatable BullMQ job that
// re-derives every subscriber's desired access with the same function
// syncAccess writes from, and heals what drifted behind a circuit
// breaker that refuses to auto-repair an implausibly large batch (see
// workers/access-reconciliation.ts).
createAccessReconciliationWorker();
scheduleAccessReconciliation().catch((err: unknown) => {
  logger.error("failed to schedule access reconciliation sweep", {
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

// webhook_events stale-claim reaper — per-minute sweep that resets
// orphaned PROCESSING rows (claimedAt past the 5-min lease) to FAILED
// so they become re-claimable and visible to alerting (W2.4).
createWebhookReaperWorker();
scheduleWebhookReaper().catch((err: unknown) => {
  logger.error("failed to schedule webhook reaper", {
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

// Usage-cap sweep — daily; flips projects.usage_locked_at per the
// two-consecutive-periods rule (cloud mode only; no-op when self-hosted).
createUsageCapSweeperWorker();
scheduleUsageCapSweep().catch((err: unknown) => {
  logger.error("failed to schedule usage-cap sweep", {
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

// Data-import runner (Task 8) — consumes rovenue-imports jobs enqueued
// by the dashboard's import flow. Per-project serialisation is enforced
// inside runImportJob itself (a Postgres advisory lock), not by worker
// concurrency, so this is safe to run on every API replica.
createImportRunnerWorker();

// Data-import file retention — nightly sweep that deletes a terminal
// job's uploaded file (and report) once its registry-resolved window
// (ROADMAP §9.2, table "import_jobs") has passed. Kept as its own
// worker rather than folded into the generic retention sweep below: it
// also deletes object-storage files and tracks that with
// `filesDeletedAt`, which the generic sweep deliberately does not
// model. See workers/import-retention.ts.
ensureImportRetention();

// Experiment scheduler (Task 9) — 5-minute repeatable BullMQ job. Starts
// DRAFT experiments whose scheduledStartAt is due (chaining successors on
// startAfterExperimentId), stops RUNNING experiments past scheduledEndAt,
// and — only when autoWinnerOnStop is set — ships a winner via the same
// stop-with-winner transition the manual /stop route uses. Multiple API
// replicas can run safely: every transition is claimed with a conditional
// UPDATE ... RETURNING. See workers/experiment-scheduler.ts.
createExperimentSchedulerWorker();
scheduleExperimentScheduler().catch((err: unknown) => {
  logger.error("failed to schedule experiment scheduler", {
    err: err instanceof Error ? err.message : String(err),
  });
});

// Leaderboard season scheduler (ROADMAP §12 item 3) — 5-minute repeatable
// BullMQ job. Opens a first season for enabled leaderboards that have
// none, and closes ACTIVE seasons past endsAt + the ClickHouse settle
// delay: ClickHouse is queried before anything is claimed, so an outage
// leaves the season untouched instead of closed-but-empty. See
// workers/leaderboard-scheduler.ts.
ensureLeaderboardScheduler();

// Retention sweep (ROADMAP §9.2) — nightly at 03:00 UTC. Registry-driven
// replacement for the three bespoke retention workers that used to live
// here (rovi-retention for copilot_messages, webhook-retention for
// webhook_events, both retired — their tables are registry rows now).
// Walks every project x every policy in RETENTION_POLICIES
// (@rovenue/shared/retention), resolving each project's own window from
// its billing tier and any override, and reclaims whatever has aged out
// via DELETE_ROWS, DROP_PARTITION or CHECKPOINT_TRUNCATE depending on
// the table. import_jobs stays on its own worker (see
// ensureImportRetention above) even though it also carries a registry
// entry — its strategy is EXTERNAL_WORKER, which this sweep never
// dispatches. See workers/retention-sweep.ts.
ensureRetentionSweep();

// Integrations fanout + delivery pipeline (Kafka → BullMQ → worker).
// bootIntegrations() no-ops gracefully when KAFKA_BROKERS is unset.
const integrationsHandle = bootIntegrations();

// Renewal-credit-grant consumer (Kafka rovenue.revenue → BullMQ → worker).
// A second, independent consumer group beside rovenue-integrations-fanout.
// bootRenewalGrants() no-ops gracefully when KAFKA_BROKERS is unset.
const renewalGrantsHandle = bootRenewalGrants();

// Advisory: the funnel's one-time backstop depends on the platform's
// Connect endpoint having `payment_intent.succeeded` selected, and
// nothing else in the process would ever notice its absence. No-ops when
// Connect is unconfigured; never blocks or fails startup.
void checkConnectWebhookEvents().catch((err: unknown) => {
  logger.error("connect webhook endpoint check failed", {
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
    void getScheduledActionsWorker().close();
    void getScheduledActionsQueue().close();
    void integrationsHandle.then((h) => h.stop());
    void renewalGrantsHandle.then((h) => h.stop());
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
// Gated by OUTBOX_DISPATCHER_ENABLED so a horizontally-scaled API can
// run the dispatcher on a single instance only.
if (env.OUTBOX_DISPATCHER_ENABLED) {
  void runOutboxDispatcher();
} else {
  logger.info("outbox dispatcher disabled (OUTBOX_DISPATCHER_ENABLED=false)");
}
