// =============================================================
// Structured log helpers for integration delivery pipeline
// =============================================================
//
// Provides typed field bags and thin wrappers that emit structured
// log lines via the project-wide Logger instance. All callers get
// consistent field names so log queries and alerts are predictable.

import type { Logger } from "../../lib/logger";

// =============================================================
// Field bag types
// =============================================================

export interface AttemptFields {
  integrationId: string;
  provider: string;
  eventType: string;
  attemptNumber: number;
  jobId?: string;
}

export interface ResultFields extends AttemptFields {
  statusCode?: number;
  durationMs: number;
  success: boolean;
}

export interface DeadLetterFields extends AttemptFields {
  reason: string;
  finalError?: string;
}

// =============================================================
// Helpers
// =============================================================

export function logDeliveryAttempt(
  log: Logger,
  fields: AttemptFields,
): void {
  log.info("integration.delivery.attempt", fields);
}

export function logDeliveryResult(
  log: Logger,
  fields: ResultFields,
): void {
  if (fields.success) {
    log.info("integration.delivery.result", fields);
  } else {
    log.warn("integration.delivery.result", fields);
  }
}

export function logDeliveryDeadLetter(
  log: Logger,
  fields: DeadLetterFields,
): void {
  log.error("integration.delivery.dead_letter", fields);
}
