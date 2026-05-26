import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  ApnsPushTransport,
  FcmPushTransport,
  createPushTransports,
} from "./index";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    APNS_KEY_ID: undefined,
    APNS_TEAM_ID: undefined,
    APNS_KEY_P8: undefined,
    APNS_BUNDLE_ID: undefined,
    APNS_ENVIRONMENT: "production",
    FCM_SERVICE_ACCOUNT_JSON: undefined,
    ...overrides,
  } as unknown as Env;
}

describe("createPushTransports", () => {
  it("returns empty when no creds are configured", () => {
    const out = createPushTransports(baseEnv());
    expect(out.ios).toBeUndefined();
    expect(out.android).toBeUndefined();
  });

  it("builds the APNs transport when all four APNS_* vars are set", () => {
    const out = createPushTransports(
      baseEnv({
        APNS_KEY_ID: "ABCDE",
        APNS_TEAM_ID: "TEAM",
        APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        APNS_BUNDLE_ID: "io.rovenue.app",
        APNS_ENVIRONMENT: "sandbox",
      }),
    );
    expect(out.ios).toBeInstanceOf(ApnsPushTransport);
    expect(out.ios?.platform).toBe("ios");
    expect(out.android).toBeUndefined();
  });

  it("skips APNs when any of the four vars is missing", () => {
    const out = createPushTransports(
      baseEnv({
        APNS_KEY_ID: "ABCDE",
        APNS_TEAM_ID: "TEAM",
        // APNS_KEY_P8 missing
        APNS_BUNDLE_ID: "io.rovenue.app",
      }),
    );
    expect(out.ios).toBeUndefined();
  });

  it("builds FCM when FCM_SERVICE_ACCOUNT_JSON is set", () => {
    const out = createPushTransports(
      baseEnv({
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
          project_id: "rovenue",
          client_email: "x@y",
          private_key: "k",
        }),
      }),
    );
    expect(out.android).toBeInstanceOf(FcmPushTransport);
    expect(out.android?.platform).toBe("android");
  });

  it("builds both when both sets of creds are present", () => {
    const out = createPushTransports(
      baseEnv({
        APNS_KEY_ID: "x",
        APNS_TEAM_ID: "y",
        APNS_KEY_P8: "z",
        APNS_BUNDLE_ID: "io.rovenue.app",
        FCM_SERVICE_ACCOUNT_JSON: "{}",
      }),
    );
    expect(out.ios).toBeDefined();
    expect(out.android).toBeDefined();
  });
});
