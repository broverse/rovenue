// =============================================================
// FCM v1 HTTP API transport — stub
// =============================================================
//
// Real implementation lands in Task 8.3. This stub satisfies the
// transport factory so callers don't crash before FCM creds are
// configured.

import type { PushTransport, PushMessage, PushSendOutcome } from "./transport";

export interface FcmConfig {
  /** Verbatim service-account JSON (parsed lazily). */
  serviceAccountJson: string;
}

export class FcmPushTransport implements PushTransport {
  readonly platform = "android" as const;

  constructor(private readonly config: FcmConfig) {}

  send(_message: PushMessage): Promise<PushSendOutcome> {
    return Promise.resolve({
      ok: false,
      error: "fcm_not_implemented",
      permanent: false,
    });
  }
}
