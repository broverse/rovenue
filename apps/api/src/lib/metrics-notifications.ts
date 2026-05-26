// =============================================================
// Notification pipeline metrics
// =============================================================
//
// Light-weight stubs that mirror the shape of the spec §8.5
// counters/histograms. Calls are no-ops today (the full
// prom-client registry isn't wired into this codebase yet — see
// the matching note in lib/clickhouse.ts) but the call sites in
// processNotification / send-email-worker / send-push-worker
// instrument every meaningful transition. Wiring to a real
// registry is a one-file swap.
//
// Metric names match the spec verbatim so a future Grafana
// dashboard import doesn't need a translation layer.

import { logger } from "./logger";

const log = logger.child("notifier.metrics");

export type DispatchStatus = "queued" | "delivered" | "suppressed" | "failed";

/**
 * notifier_dispatched_total{event_key, channel, status}
 *
 * Incremented once per delivery-row transition in
 * processNotification (insert) and per send-worker callback
 * (sent/failed/suppressed).
 */
export function incDispatched(
  eventKey: string,
  channel: "email" | "push" | "inapp",
  status: DispatchStatus,
): void {
  // Sample-rate debug log so the call sites have something to
  // grep for in dev without flooding prod logs.
  log.debug("dispatched", { eventKey, channel, status });
}

/**
 * notifier_send_duration_seconds{channel, transport, outcome}
 *
 * Observed from the send-email / send-push workers around the
 * transport.send() call. Outcome is "ok" / "transient" / "permanent".
 */
export function observeSendDuration(
  channel: "email" | "push",
  transport: string,
  outcome: "ok" | "transient" | "permanent",
  durationMs: number,
): void {
  if (durationMs > 5_000) {
    // 5s+ is unusual for a healthy transport — surface it loudly
    // even without prom-client.
    log.warn("slow_send", {
      channel,
      transport,
      outcome,
      durationMs,
    });
  }
}

/**
 * notifier_dlq_total{topic}
 *
 * Incremented by the notifier worker when it routes a message to
 * the rovenue.notifications.dlq topic.
 */
export function incDlq(topic: string): void {
  log.warn("dlq", { topic });
}

/**
 * notifier_push_devices_revoked_total{platform, reason}
 *
 * Incremented in the send-push worker when a permanent token
 * failure causes a push_devices revocation.
 */
export function incPushDevicesRevoked(
  platform: "ios" | "android",
  reason: string,
): void {
  log.info("push_device_revoked", { platform, reason });
}
