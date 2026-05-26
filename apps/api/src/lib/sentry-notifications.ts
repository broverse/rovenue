// =============================================================
// Sentry instrumentation for the notification pipeline
// =============================================================
//
// Stub matching the surface of @sentry/node's captureException
// — `@sentry/node` isn't installed in this codebase yet (same
// state as the prom-client registry in metrics-notifications.ts).
// When it lands, swap the body of `captureNotifierError` for
// `Sentry.captureException(err, scope => scope.setTags(tags)
// .setExtras(extras))` without touching any call site.
//
// PII redaction: ONLY pass user/project IDs and structural
// labels. NEVER pass `to` email addresses, push tokens, raw
// rendered HTML, or message bodies. The `extras` shape below
// is the allowlist; callers don't get a freeform escape hatch.

import { logger } from "./logger";

const log = logger.child("notifier.sentry");

export interface NotifierErrorContext {
  /** "notifier" | "send-email" | "send-push" | "digest" */
  component:
    | "notifier"
    | "send-email"
    | "send-push"
    | "digest"
    | "webhook-failing-emit";
  /** Catalog event key when known. */
  eventKey?: string;
  /** "email" | "push" | "inapp" */
  channel?: "email" | "push" | "inapp";
  /** UUID of the affected user — safe to log. */
  userId?: string;
  /** UUID of the affected project — safe to log. */
  projectId?: string;
  /** UUID of the affected notification_deliveries row. */
  deliveryId?: string;
  /** Free-form structural label (no PII). */
  reason?: string;
}

/**
 * Surface a permanent / unrecoverable failure. Send-worker
 * transient retries don't call this — only the path where the
 * outcome is final (attempts exhausted, UnrecoverableError, DLQ).
 */
export function captureNotifierError(
  err: unknown,
  ctx: NotifierErrorContext,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // The stub path: a structured error log that an external
  // log shipper (Loki / Vector / etc.) can already alert on.
  // When @sentry/node lands the captureException replaces this
  // body and the log call becomes a debug-level breadcrumb.
  log.error("captured_exception", {
    err: message,
    ...ctx,
    stackFirstLine: stack?.split("\n")[1]?.trim(),
  });
}
