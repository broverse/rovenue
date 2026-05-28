// =============================================================
// Refund Shield observability metrics (Task T19)
// =============================================================
//
// Light-weight stubs that mirror the shape of the spec §8 counters
// + histogram. Calls are no-ops today — the full prom-client
// registry isn't wired into this codebase yet (see the matching
// notes in lib/metrics-notifications.ts and lib/clickhouse.ts).
// All call sites are instrumented exhaustively so a future swap
// to `new Counter(...)` / `new Histogram(...)` is a one-file
// change without touching the webhook handlers, worker, or
// outcome handlers.
//
// Metric names match the spec verbatim so a future Grafana
// dashboard import doesn't need a translation layer.
//
// Label cardinality:
//   - project_id: bounded by tenant count (small N per deployment)
//   - reason (failed only): closed set defined by FailureReason
//   No unbounded labels (subscriber_id, transaction_id) ever
//   appear — see plan §"Metric label cardinality".

import { logger } from "./logger";

const log = logger.child("refund-shield.metrics");

// ---- in-memory counter storage (test introspection) ---------
//
// The test suites in apps/api/src/workers and src/services/apple
// assert metric emission via vi.spyOn against the inc* helpers.
// We also keep a tiny in-memory snapshot so an integration test
// (T20) can read the registry directly without standing up
// prom-client.

interface CounterSnapshot {
  // keyed by `${projectId}` or `${projectId}::${reason}`
  values: Map<string, number>;
}

function makeCounter(): CounterSnapshot {
  return { values: new Map() };
}

function bumpCounter(c: CounterSnapshot, key: string): void {
  c.values.set(key, (c.values.get(key) ?? 0) + 1);
}

const _received = makeCounter();
const _sent = makeCounter();
const _failed = makeCounter();
const _outcomeApproved = makeCounter();
const _outcomeDeclined = makeCounter();
const _outcomeReversed = makeCounter();
const _slaRemainingSamples: Array<{
  projectId: string;
  seconds: number;
}> = [];

export type RefundShieldFailureReason =
  | "apple_4xx"
  | "apple_5xx"
  | "sla_exceeded"
  | "disabled"
  | "not_found"
  | "max_retries"
  | "apple_ctx_missing"
  | "project_not_found"
  | "internal_error";

/**
 * `refund_shield_received_total{project_id}`
 *
 * Incremented in `applyConsumptionRequest` after the
 * refund_shield_responses row is persisted (regardless of status —
 * PENDING / SKIPPED_DISABLED / SKIPPED_NOT_FOUND all count).
 */
export function incRefundShieldReceived(projectId: string): void {
  bumpCounter(_received, projectId);
  log.debug("received", { projectId });
}

/**
 * `refund_shield_sent_total{project_id}`
 *
 * Incremented in the responder worker's SENT branch, after
 * markResponseSent persists the row.
 */
export function incRefundShieldSent(projectId: string): void {
  bumpCounter(_sent, projectId);
  log.debug("sent", { projectId });
}

/**
 * `refund_shield_failed_total{project_id, reason}`
 *
 * Incremented in the responder worker's FAILED branch and any
 * pre-flight terminal failure (project missing, apple creds
 * missing, max retries exhausted). The `reason` label maps
 * worker error strings into a closed set so Grafana panels can
 * facet without unbounded cardinality.
 */
export function incRefundShieldFailed(
  projectId: string,
  reason: RefundShieldFailureReason,
): void {
  bumpCounter(_failed, `${projectId}::${reason}`);
  log.debug("failed", { projectId, reason });
}

/**
 * `refund_shield_outcome_approved_total{project_id}`
 *
 * Apple eventually approved the refund (REFUND notification).
 */
export function incRefundShieldOutcomeApproved(projectId: string): void {
  bumpCounter(_outcomeApproved, projectId);
  log.debug("outcome_approved", { projectId });
}

/**
 * `refund_shield_outcome_declined_total{project_id}`
 *
 * Apple declined the refund (REFUND_DECLINED notification — a win
 * for the developer, attributable to the signal payload).
 */
export function incRefundShieldOutcomeDeclined(projectId: string): void {
  bumpCounter(_outcomeDeclined, projectId);
  log.debug("outcome_declined", { projectId });
}

/**
 * `refund_shield_outcome_reversed_total{project_id}`
 *
 * Apple reversed a prior refund (REFUND_REVERSED notification).
 */
export function incRefundShieldOutcomeReversed(projectId: string): void {
  bumpCounter(_outcomeReversed, projectId);
  log.debug("outcome_reversed", { projectId });
}

/**
 * `refund_shield_sla_remaining_seconds{project_id}` histogram.
 *
 * Observed at SEND time: how many seconds were still left in
 * Apple's 12h SLA when we dispatched the response? Low values
 * mean we're cutting it close — alert thresholds can be defined
 * downstream.
 */
export function observeRefundShieldSlaRemainingSeconds(
  projectId: string,
  seconds: number,
): void {
  _slaRemainingSamples.push({ projectId, seconds });
  if (seconds < 3600) {
    log.warn("sla_close", { projectId, seconds });
  } else {
    log.debug("sla_remaining", { projectId, seconds });
  }
}

// =============================================================
// Test introspection (not part of the public metric surface).
// Lets tests assert metric emission without standing up
// prom-client. Tests should prefer vi.spyOn against the inc*
// helpers; this is the fallback for integration tests that wire
// the whole worker.
// =============================================================

export const __testing = {
  snapshot(): {
    received: Record<string, number>;
    sent: Record<string, number>;
    failed: Record<string, number>;
    outcomeApproved: Record<string, number>;
    outcomeDeclined: Record<string, number>;
    outcomeReversed: Record<string, number>;
    slaRemainingSamples: ReadonlyArray<{ projectId: string; seconds: number }>;
  } {
    return {
      received: Object.fromEntries(_received.values),
      sent: Object.fromEntries(_sent.values),
      failed: Object.fromEntries(_failed.values),
      outcomeApproved: Object.fromEntries(_outcomeApproved.values),
      outcomeDeclined: Object.fromEntries(_outcomeDeclined.values),
      outcomeReversed: Object.fromEntries(_outcomeReversed.values),
      slaRemainingSamples: [..._slaRemainingSamples],
    };
  },
  reset(): void {
    _received.values.clear();
    _sent.values.clear();
    _failed.values.clear();
    _outcomeApproved.values.clear();
    _outcomeDeclined.values.clear();
    _outcomeReversed.values.clear();
    _slaRemainingSamples.length = 0;
  },
};
