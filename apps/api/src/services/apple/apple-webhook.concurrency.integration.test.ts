// =============================================================
// handleAppleNotification — concurrency / single-flight claim
// =============================================================
//
// Proves the atomic `claimWebhookEvent` swap closes the
// double-dispatch race: two concurrent deliveries of the SAME
// notificationUUID must resolve to exactly one "processed" and one
// "duplicate". Pre-fix (non-atomic upsert + status-read) both
// callers saw PROCESSING and both proceeded → ["processed",
// "processed"].
//
// Integration: hits a real Postgres 16 (the docker-compose dev
// stack on host port 5433) for the webhook_events claim. We inject
// a stub verifier and use the no-transaction-info envelope so the
// handler short-circuits before `dispatch` — no products /
// subscribers / FX needed, the claim path alone is exercised.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects } from "@rovenue/db";
import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whrace_${RUN_ID}`;
const NOTIFICATION_UUID = `nfn_race_${RUN_ID}`;

/** A SUBSCRIBED envelope WITHOUT signedTransactionInfo: the handler
 *  logs "notification without transaction info, acknowledging" and
 *  still marks the claimed row PROCESSED — exactly the claim path we
 *  want under concurrency, with no dispatch dependencies. */
function makeFakeNotification(): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.SUBSCRIBED,
    notificationUUID: NOTIFICATION_UUID,
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
    },
  } as AppleResponseBodyV2DecodedPayload;
}

/** A two-party rendezvous barrier: the first caller to `arrive()`
 *  parks until the second arrives, then both proceed together. We
 *  release the barrier from inside `verifyNotification` so BOTH
 *  handler invocations are guaranteed to have decoded the (shared)
 *  notification — and to reach the claim back-to-back — before
 *  either one can run dispatch + mark the row PROCESSED. This makes
 *  the pre-fix double-dispatch race deterministic instead of
 *  timing-dependent: both callers hit the claim while the row is
 *  still PROCESSING. */
function makeBarrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return async function arrive() {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

/** Stub verifier — every call returns the SAME decoded notification
 *  (same UUID), so both concurrent handler invocations race for the
 *  same webhook_events row. Both rendezvous at the barrier before
 *  returning so neither can finish-and-PROCESS ahead of the other's
 *  claim. */
function makeStubVerifier(arrive: () => Promise<void>): AppleNotificationVerifier {
  const notification = makeFakeNotification();
  return {
    verifyNotification: vi.fn(async () => {
      await arrive();
      return notification;
    }),
    verifyTransaction: vi.fn(async () => {
      throw new Error("verifyTransaction not used: no signedTransactionInfo");
    }),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("verifyRenewalInfo not used in this test");
    }),
  };
}

describe("handleAppleNotification — concurrent single-flight claim", () => {
  beforeAll(async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `WH Race ${RUN_ID}` });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("yields exactly one processed and one duplicate for the same notificationUUID", async () => {
    const arrive = makeBarrier(2);
    const opts = {
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(arrive),
    };

    const [a, b] = await Promise.all([
      handleAppleNotification(opts),
      handleAppleNotification(opts),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["duplicate", "processed"]);
  });
});
