import type { JobsOptions } from "bullmq";
import type { ProviderId, RetryPolicy, RovenueEventEnvelope } from "../services/integrations/types";
import { getProvider, providerIds } from "../services/integrations/registry";
import { DEFAULT_RETRY_POLICY, WEBHOOK_RETRY_POLICY } from "../services/integrations/retry-policies";

export const INTEGRATIONS_DELIVER_QUEUE_NAME = "rovenue-integrations-deliver";

// Re-exported so callers can import both the policy constants and the
// lookup/options helpers from this one module. See retry-policies.ts for
// why the constants themselves live in a separate file (circular-import
// avoidance: this module depends on registry.ts, which depends on the
// CUSTOM_WEBHOOK provider, which needs WEBHOOK_RETRY_POLICY).
export { DEFAULT_RETRY_POLICY, WEBHOOK_RETRY_POLICY };

/**
 * Resolves the retry policy for a provider id. Never throws — an unknown
 * provider id (or a mistyped one reaching this from job data) falls back to
 * DEFAULT_RETRY_POLICY rather than propagating `getProvider`'s throw, since
 * this is called from hot paths (backoffStrategy, enqueue) that must not
 * crash the worker/queue over a bad id.
 */
export function retryPolicyFor(providerId: string): RetryPolicy {
  if (!providerIds().includes(providerId as ProviderId)) {
    return DEFAULT_RETRY_POLICY;
  }
  return getProvider(providerId as ProviderId).retryPolicy ?? DEFAULT_RETRY_POLICY;
}

/**
 * BullMQ job options for every integrations-deliver enqueue site. Pins
 * `backoff: { type: "custom" }` — BullMQ only consults the worker's
 * `settings.backoffStrategy` when a job declares a *custom* backoff type;
 * without it, retries fire immediately regardless of what the worker
 * configures. (Pre-existing bug: every enqueue site used to omit this.)
 */
export function deliverJobOptions(providerId: string, jobId: string): JobsOptions {
  const policy = retryPolicyFor(providerId);
  return {
    jobId,
    attempts: policy.attempts,
    backoff: { type: "custom" },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  };
}

export interface IntegrationsDeliverJob {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  envelope: RovenueEventEnvelope;
  isBackfill?: boolean;
}

export function buildIntegrationsDeliverJobId(
  connectionId: string,
  outboxEventId: string,
): string {
  // BullMQ v5 rejects custom jobIds that contain `:` unless they have
  // exactly 3 colon-delimited segments (the repeatable-job wire format).
  // Use `|` as the separator so the id is URL-safe and BullMQ-safe.
  return `${connectionId}|${outboxEventId}`;
}

/**
 * Job id for a manual redeliver (Task 10). Deliberately does NOT reuse
 * `buildIntegrationsDeliverJobId`'s `connectionId|outboxEventId` id — that
 * id is the realtime/backfill dedup key, and BullMQ keeps a completed (or
 * failed) job under it for the `removeOnComplete`/`removeOnFail` retention
 * window (see `deliverJobOptions`). Re-adding the same jobId inside that
 * window would just return the already-finished job instead of running a
 * new delivery attempt. Appending `rd-${nonce}` (nonce = a fresh cuid2)
 * guarantees a brand-new job every time an operator clicks redeliver, same
 * `|` separator for the same BullMQ v5 reason as above.
 */
export function buildRedeliverJobId(
  connectionId: string,
  outboxEventId: string,
  nonce: string,
): string {
  return `${connectionId}|${outboxEventId}|rd-${nonce}`;
}
