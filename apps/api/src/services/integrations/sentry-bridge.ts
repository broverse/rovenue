// =============================================================
// Sentry breadcrumb bridge for dead-letter integration events
// =============================================================
//
// Thin wrapper around captureNotifierError that adapts the
// integration dead-letter context to the existing notifier error
// surface. No @sentry/node dependency — delegates to the project's
// existing sentry-notifications shim which will swap in the real
// Sentry.captureException when the package lands.

import type { captureNotifierError } from "../../lib/sentry-notifications";

// =============================================================
// Types
// =============================================================

export interface SentryDeps {
  captureNotifierError: typeof captureNotifierError;
}

export interface DeadLetterContext {
  integrationId: string;
  provider: string;
  eventType: string;
  projectId: string;
  attemptNumber: number;
  reason: string;
  jobId?: string;
}

// =============================================================
// Bridge
// =============================================================

/**
 * Reports a dead-lettered integration delivery to Sentry (or the
 * structured-log shim that precedes it). Call sites treat this as
 * best-effort — errors thrown by captureNotifierError are swallowed
 * so a Sentry outage never blocks the worker shutdown path.
 */
export function reportDeadLetterToSentry(
  deps: SentryDeps,
  err: unknown,
  ctx: DeadLetterContext,
): void {
  try {
    deps.captureNotifierError(err, {
      component: "webhook-failing-emit",
      reason: ctx.reason,
      projectId: ctx.projectId,
      eventKey: ctx.eventType,
    });
  } catch {
    // best-effort — swallow
  }
}
