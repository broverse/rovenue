// =============================================================
// Prometheus metrics registry
// =============================================================
//
// A dedicated (non-global) prom-client Registry so importing this
// module twice in tests never collides with the default registry.
// Exposed as text via GET /metrics on the INTERNAL listener only.

import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
} from "prom-client";

export const registry = new Registry();

// Node/process/event-loop/GC gauges.
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the API",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Incremented each time the webhook replay guard catches a Redis error
// and fails open (availability over dedup). Alert if this climbs — it
// means the replay dedup window is ineffective while Redis is degraded.
export const webhookReplayGuardFailOpenTotal = new Counter({
  name: "rovenue_webhook_replay_guard_failopen_total",
  help: "Number of times the webhook replay guard failed open due to a Redis error",
  labelNames: ["source"] as const,
  registers: [registry],
});

// Incremented by the webhook reaper each sweep with the count of stale
// PROCESSING rows it reclaimed (crashed/lost BullMQ jobs). Non-zero
// values indicate API pods are dying mid-processing.
export const webhookEventsReclaimedTotal = new Counter({
  name: "rovenue_webhook_events_reclaimed_total",
  help: "Number of stale PROCESSING webhook_events rows reclaimed by the reaper",
  registers: [registry],
});

// =============================================================
// Entitlement drift reconciler (workers/access-reconciliation.ts)
// =============================================================

// Incremented per drift class each time the reconciler finds a
// subscriber whose `subscriber_access` rows disagree with what
// `computeDesiredAccess` says they should be. A steady low rate is
// expected on a busy install (a sweep can race a live webhook); a step
// change means an ingestion path stopped calling syncAccess.
export const accessDriftDetectedTotal = new Counter({
  name: "rovenue_access_drift_detected_total",
  help: "Subscribers found with subscriber_access drift, by drift class",
  labelNames: ["class"] as const,
  registers: [registry],
});

// Incremented once per subscriber the reconciler actually rewrote.
export const accessDriftHealedTotal = new Counter({
  name: "rovenue_access_drift_healed_total",
  help: "Subscribers whose subscriber_access rows the reconciler rewrote",
  registers: [registry],
});

// Incremented once per sweep that refused to heal because the batch's
// drift ratio exceeded MAX_DRIFT_HEAL_RATIO. ALERT ON ANY NON-ZERO
// VALUE: it means either a genuine mass-corruption incident or a bug in
// `computeDesiredAccess` itself — in both cases the entitlement data is
// untrustworthy and no automated repair should be allowed to proceed.
export const accessDriftCircuitBreakerTotal = new Counter({
  name: "rovenue_access_drift_circuit_breaker_total",
  help: "Sweeps that refused to auto-heal because the batch drift ratio was above threshold",
  registers: [registry],
});

// =============================================================
// Renewal-grant worker (workers/renewal-grant.ts)
// =============================================================

// Incremented once per renewal that actually granted currency.
export const renewalGrantsAppliedTotal = new Counter({
  name: "rovenue_renewal_grants_applied_total",
  help: "Renewal events that granted product currency",
  registers: [registry],
});

// Incremented on every failed grant attempt, before BullMQ retries it.
// A steady low rate is transient infrastructure; a sustained rate means
// renewals are reaching their attempt ceiling and credits are not landing.
export const renewalGrantsFailedTotal = new Counter({
  name: "rovenue_renewal_grants_failed_total",
  help: "Renewal grant attempts that threw, by error name",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// =============================================================
// Leaderboard season scheduler (workers/leaderboard-scheduler.ts)
// =============================================================

// Incremented once per season opened — either a leaderboard's first
// season, or the next season opened as part of closing the previous one.
export const leaderboardSeasonsOpenedTotal = new Counter({
  name: "rovenue_leaderboard_seasons_opened_total",
  help: "Leaderboard seasons opened by the scheduler",
  registers: [registry],
});

// Incremented once per season closed and snapshotted into
// leaderboard_standings.
export const leaderboardSeasonsClosedTotal = new Counter({
  name: "rovenue_leaderboard_seasons_closed_total",
  help: "Leaderboard seasons closed and snapshotted",
  registers: [registry],
});

// A lost claim is normal with multiple replicas. A sustained "clickhouse"
// rate means seasons are drifting past their boundary unclosed, which is
// otherwise invisible until someone notices stale standings.
export const leaderboardSeasonCloseSkippedTotal = new Counter({
  name: "rovenue_leaderboard_season_close_skipped_total",
  help: "Season closes abandoned, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// =============================================================
// Retention sweep (workers/retention-sweep.ts, ROADMAP §9.2 Task 3)
// =============================================================

// Incremented by the count of rows actually deleted by a DELETE_ROWS
// policy, per table. Tasks 4/5 (DROP_PARTITION, CHECKPOINT_TRUNCATE)
// increment this too once implemented, so it reads as "space reclaimed
// by the sweep" regardless of strategy.
export const retentionRowsReclaimedTotal = new Counter({
  name: "rovenue_retention_rows_reclaimed_total",
  help: "Rows reclaimed by the retention sweep, by table",
  labelNames: ["table"] as const,
  registers: [registry],
});

// Incremented once per (project, policy) unit the sweep did not act
// on, by reason: "no-window" (neither a billing tier nor an override —
// expected and safe on a self-hosted install), "tier-limits-not-found"
// (the project HAS a tier/cycle but billing_tier_limits has no matching
// row — a reference-ladder integrity gap, not an ordinary no-tier
// project; the direction is still safe, retaining rather than deleting,
// but a paying project's tier clamp silently not applying is worth its
// own signal), "strategy-not-implemented" (DROP_PARTITION/
// CHECKPOINT_TRUNCATE, until Tasks 4/5 ship), or "error" (the unit's
// own lookup or delete threw). A sustained "error" rate means the sweep
// is silently failing to reclaim space somewhere; a sustained
// "strategy-not-implemented" rate outside audit_logs/credit_ledger/
// revenue_events means a policy was added without its strategy ever
// landing; ANY "tier-limits-not-found" means the billing ladder is
// missing a (tier, cycle) row a real project needs.
export const retentionSweepSkippedTotal = new Counter({
  name: "rovenue_retention_sweep_skipped_total",
  help: "Retention sweep units skipped, by reason and table",
  labelNames: ["reason", "table"] as const,
  registers: [registry],
});

// Incremented once per (project, policy) DELETE_ROWS unit whose batched
// delete stopped because it hit `RETENTION_MAX_BATCHES` rather than
// because it ran out of rows to delete. Unlike a skip, work DID happen
// (whatever `retentionRowsReclaimedTotal` recorded for the same call) —
// this is "there is more to do than one night's cap allows," which is
// otherwise invisible: the loop just stops with no counter and no log,
// and a table that needs more than the cap every night stalls forever
// with nobody the wiser.
export const retentionSweepBatchCapReachedTotal = new Counter({
  name: "rovenue_retention_sweep_batch_cap_reached_total",
  help: "Retention sweep DELETE_ROWS units that hit RETENTION_MAX_BATCHES with rows still remaining, by table",
  labelNames: ["table"] as const,
  registers: [registry],
});

// =============================================================
// DSAR export worker (workers/dsar-export.ts, ROADMAP §9.1 Task 4)
// =============================================================

// Incremented once per `dsar_requests` row the worker actually completed
// (artifact written, confirmed, and the row marked COMPLETED).
export const dsarExportCompletedTotal = new Counter({
  name: "rovenue_dsar_export_completed_total",
  help: "DSAR export jobs completed",
  registers: [registry],
});

// Incremented once per job the worker did NOT complete, by reason:
// "race" (claimDsarRequest returned null — another replica already has
// this row, not an error), "storage-unconfigured" (fail-closed: the
// customer must never be told an export is ready that was never
// written), or "error" (exportSubscriber or the storage write threw).
// A sustained "storage-unconfigured" rate means a deployment is
// missing its object-storage env vars while customers are actively
// filing DSAR requests against it.
export const dsarExportSkippedTotal = new Counter({
  name: "rovenue_dsar_export_skipped_total",
  help: "DSAR export jobs that did not complete, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// =============================================================
// DSAR erasure worker (workers/dsar-erasure.ts, ROADMAP §9.1 Task 5)
// =============================================================

// Incremented once per `dsar_requests` ERASURE row the worker actually
// completed: Postgres anonymised AND every ClickHouse mutation
// confirmed `is_done` (not merely submitted).
export const dsarErasureCompletedTotal = new Counter({
  name: "rovenue_dsar_erasure_completed_total",
  help: "DSAR erasure jobs completed",
  registers: [registry],
});

// Incremented once per job the worker did NOT complete, by reason:
// "race" (claimDsarRequest returned null — another replica already has
// this row, not an error), "clickhouse-unconfigured" (fail-closed: a
// request must never be marked COMPLETED while ClickHouse rows remain
// untouched because there was nowhere to send the DELETE), or "error"
// (anonymizeSubscriber threw, a ClickHouse mutation failed, or the
// bounded wait for `system.mutations.is_done` timed out). A sustained
// "clickhouse-unconfigured" rate means a deployment is missing its
// ClickHouse env vars while customers are actively filing erasure
// requests against it.
export const dsarErasureSkippedTotal = new Counter({
  name: "rovenue_dsar_erasure_skipped_total",
  help: "DSAR erasure jobs that did not complete, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});
