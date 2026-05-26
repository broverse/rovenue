// =============================================================
// APNs HTTP/2 transport — stub
// =============================================================
//
// Real implementation lands in Task 8.2. This stub satisfies the
// transport factory so callers don't crash before APNs creds are
// configured.

import type { PushTransport, PushMessage, PushSendOutcome } from "./transport";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  keyP8: string;
  bundleId: string;
  environment: "production" | "sandbox";
}

export class ApnsPushTransport implements PushTransport {
  readonly platform = "ios" as const;

  constructor(private readonly config: ApnsConfig) {}

  send(_message: PushMessage): Promise<PushSendOutcome> {
    return Promise.resolve({
      ok: false,
      error: "apns_not_implemented",
      permanent: false,
    });
  }
}
