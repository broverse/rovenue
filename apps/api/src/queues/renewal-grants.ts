import type { JobsOptions } from "bullmq";

// =============================================================
// renewal-grants queue
// =============================================================

export const RENEWAL_GRANT_QUEUE_NAME = "rovenue-renewal-grants";

/** Revenue-event types that grant currency on the RENEWAL trigger.
 *  INITIAL is deliberately absent: it is the PURCHASE trigger's event,
 *  and matching both would double-grant a BOTH row on day one. */
export const RENEWAL_GRANT_EVENT_TYPES: readonly string[] = [
  "RENEWAL",
  "TRIAL_CONVERSION",
  "REACTIVATION",
];

export const RENEWAL_GRANT_ATTEMPTS = 5;
export const RENEWAL_GRANT_BACKOFF_MS = 5_000;

export interface RenewalGrantJob {
  revenueEventId: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  /** revenueEventType enum value as it appeared on the outbox payload. */
  type: string;
}

/**
 * Deterministic job id so an obvious Kafka redelivery collapses before it
 * reaches the worker.
 *
 * This is an OPTIMISATION, never the correctness guarantee: BullMQ retains
 * completed job ids only for the `removeOnComplete` window, so a redelivery
 * arriving after eviction re-runs. That is safe because addCredits dedupes
 * on (referenceType, referenceId, currencyId) — which is the real guarantee.
 * Do not remove that dedup on the strength of this job id.
 */
export function buildRenewalGrantJobId(outboxEventId: string): string {
  // BullMQ v5 rejects custom job ids containing ':' unless they have
  // exactly 3 colon-delimited segments, so no colons here.
  return `renewal-grant-${outboxEventId}`;
}

export function renewalGrantJobOptions(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: RENEWAL_GRANT_ATTEMPTS,
    backoff: { type: "exponential", delay: RENEWAL_GRANT_BACKOFF_MS },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  };
}
