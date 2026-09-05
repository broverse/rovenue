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
