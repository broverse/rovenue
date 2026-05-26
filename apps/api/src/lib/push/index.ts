// =============================================================
// Push transport factory
// =============================================================
//
// Builds the per-platform transports the send-push worker
// consumes (Phase 10). Each transport is optional — if the
// platform's creds are unset the corresponding key is absent
// from the returned record and the worker skips that platform
// (the notifier worker writes a delivery row with
// status='failed', reason='no_transport').

import type { Env } from "../env";
import { ApnsPushTransport } from "./apns";
import { FcmPushTransport } from "./fcm";
import type { PushTransport } from "./transport";

export interface PushTransports {
  ios?: PushTransport;
  android?: PushTransport;
}

export function createPushTransports(env: Env): PushTransports {
  const out: PushTransports = {};

  if (
    env.APNS_KEY_ID &&
    env.APNS_TEAM_ID &&
    env.APNS_KEY_P8 &&
    env.APNS_BUNDLE_ID
  ) {
    out.ios = new ApnsPushTransport({
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      keyP8: env.APNS_KEY_P8,
      bundleId: env.APNS_BUNDLE_ID,
      environment: env.APNS_ENVIRONMENT,
    });
  }

  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    out.android = new FcmPushTransport({
      serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    });
  }

  return out;
}

export type { PushTransport, PushMessage, PushSendOutcome } from "./transport";
export { ApnsPushTransport } from "./apns";
export { FcmPushTransport } from "./fcm";
