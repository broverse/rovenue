// =============================================================
// Push transport interface
// =============================================================
//
// Each platform (APNs, FCM) implements PushTransport. The
// send-push BullMQ worker (Phase 10) consumes one job per
// device and routes by `device.platform` to the matching
// transport. On a permanent failure the worker revokes the
// push_devices row; transient failures are retried by BullMQ.

import type { PushPlatform } from "@rovenue/shared/notifications";

export interface PushMessage {
  deviceToken: string;
  title: string;
  body: string;
  /** Structured payload delivered alongside the alert. */
  data: Record<string, string>;
  badge?: number;
  /** APNs thread-id / Android tag — groups related notifications. */
  threadId?: string;
  /** FCM collapse key / APNs collapse-id — at-most-one in flight. */
  collapseKey?: string;
}

export interface PushSendOk {
  ok: true;
  providerMessageId: string;
}

export interface PushSendFailure {
  ok: false;
  error: string;
  /** When true, the worker should revoke the push_devices row. */
  permanent: boolean;
  raw?: unknown;
}

export type PushSendOutcome = PushSendOk | PushSendFailure;

export interface PushTransport {
  readonly platform: PushPlatform;
  send(message: PushMessage): Promise<PushSendOutcome>;
}
