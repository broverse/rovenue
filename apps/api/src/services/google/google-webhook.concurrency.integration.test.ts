// =============================================================
// handleGoogleNotification — concurrency / single-flight claim
// =============================================================
//
// Proves the atomic `claimWebhookEvent` swap closes the
// double-dispatch race the old non-atomic `upsertWebhookEvent` +
// `status === PROCESSED` guard left open. Two concurrent deliveries
// of the SAME purchaseToken (= storeEventId) must result in exactly
// ONE successful "processed" and the other either returning "duplicate"
// (if the first fully completed first) or throwing with
// "claim in progress; retry" (if both raced and the second hit the
// PROCESSING lease — the new F1 fix that forces BullMQ to retry
// instead of silently acking). In all cases exactly ONE revenue_events
// row must be written.
//
// Pre-fix both callers upserted the row PROCESSING (a no-op on
// conflict) and then read `status === PROCESSED` — which is false for
// both while the row is still PROCESSING — so both proceeded into
// dispatch and each emitted a revenue_events row (double-count).
//
// Integration: hits a real Postgres 16 (the dev stack on host port
// 5433) for the claim + the actual revenue/access/purchase writes.
// The Google Android Publisher API client and FX/refund side effects
// are mocked so the test exercises the DB-backed claim race, not the
// network.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  projects,
  products,
  revenueEvents,
  webhookEvents,
  subscribers,
} from "@rovenue/db";
import {
  GOOGLE_ACKNOWLEDGEMENT_STATE,
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GooglePubSubPushBody,
  type GoogleSubscriptionPurchaseV2,
} from "./google-types";
import type { GoogleVerifyConfig } from "./google-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_gwhrace_${RUN_ID}`;
const PRODUCT_ID = `prod_gwhrace_${RUN_ID}`;
const PURCHASE_TOKEN = `tok_gwhrace_${RUN_ID}`;
const GOOGLE_PRODUCT_ID = `pro_sub_${RUN_ID}`;
const SUBSCRIPTION_ID = `sub_id_${RUN_ID}`;
const EXTERNAL_ACCOUNT_ID = `ext_acct_${RUN_ID}`;

// A short artificial delay inside the (post-claim) verify call widens
// the window in which the second concurrent invocation hits the
// atomic claim while the first still holds the row PROCESSING. With
// the fix the claim is a single atomic SQL statement, so even without
// this delay exactly one caller wins; the delay just makes the race
// reliably overlap rather than serialize. We do NOT use a 2-party
// barrier here: post-fix only ONE invocation ever reaches verify (the
// other short-circuits on the null claim), so a 2-party barrier would
// deadlock — which is itself proof the single-flight guard works.
function fakeSubscriptionPurchase(): GoogleSubscriptionPurchaseV2 {
  return {
    regionCode: "US",
    subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
    acknowledgementState: GOOGLE_ACKNOWLEDGEMENT_STATE.ACKNOWLEDGED,
    startTime: new Date(1_700_000_000_000).toISOString(),
    externalAccountIdentifiers: { externalAccountId: EXTERNAL_ACCOUNT_ID },
    lineItems: [
      {
        productId: GOOGLE_PRODUCT_ID,
        expiryTime: new Date(1_705_000_000_000).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: "monthly" },
      },
    ],
  };
}

// Mock the Google Android Publisher client surface. Both concurrent
// invocations get the SAME purchase object; verify rendezvouses at
// the barrier so neither can finish-and-PROCESS ahead of the other's
// claim.
vi.mock("./google-verify", () => ({
  verifyGoogleSubscription: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return fakeSubscriptionPurchase();
  }),
  acknowledgeGoogleSubscription: vi.fn(async () => undefined),
  getSubscriptionBasePlanPricing: vi.fn(async () => ({
    amount: 9.99,
    currency: "USD",
  })),
}));

// Keep FX + refund side effects off the network/Redis.
vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

// Imported AFTER vi.mock so the handler picks up the mocked deps.
const { handleGoogleNotification } = await import("./google-webhook");

function makePushBody(): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    subscriptionNotification: {
      version: "1.0",
      notificationType:
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      purchaseToken: PURCHASE_TOKEN,
      subscriptionId: SUBSCRIPTION_ID,
    },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(rtdn)).toString("base64"),
      messageId: `msg_${RUN_ID}`,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/x/subscriptions/y",
  };
}

const fakeVerifyConfig = {
  credentials: { project_id: "test" },
  packageName: "com.rovenue.test",
} as unknown as GoogleVerifyConfig;

describe("handleGoogleNotification — concurrent single-flight claim", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `G WH Race ${RUN_ID}` });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pro_${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { google: GOOGLE_PRODUCT_ID },
      displayName: "Pro",
      // Empty accessIds: this test targets the single-flight claim and
      // the revenue_events double-write, not entitlement granting.
      // Seeding `access` rows would only add FK fixtures unrelated to
      // the race under test.
      accessIds: [],
    });
  });

  afterAll(async () => {
    const db = getDb();
    // revenue_events / purchases / subscriber_access / webhook_events
    // all FK-cascade off the project row.
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("yields exactly one processed and prevents double-dispatch; second caller either returns duplicate or throws in-progress", async () => {
    const opts = {
      projectId: PROJECT_ID,
      pushBody: makePushBody(),
      verifyConfig: fakeVerifyConfig,
    };

    const results = await Promise.allSettled([
      handleGoogleNotification(opts),
      handleGoogleNotification(opts),
    ]);

    // Exactly one must succeed with "processed".
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof handleGoogleNotification>>> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r) => r.status === "rejected");

    // One of two outcomes:
    // A) Both fulfilled — one "processed" + one "duplicate" (first completed before second claimed)
    // B) One fulfilled ("processed") + one rejected (threw "claim in progress; retry")
    // In both cases, dispatch ran exactly once.
    if (rejected.length === 0) {
      // Case A: both returned normally
      const statuses = fulfilled.map((r) => r.value.status).sort();
      expect(statuses).toEqual(["duplicate", "processed"]);
    } else {
      // Case B: loser threw the in-progress error (the new F1 behaviour)
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.value.status).toBe("processed");
      expect(rejected).toHaveLength(1);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/claim in progress/);
    }

    const db = getDb();

    const revRows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, PROJECT_ID));
    expect(revRows).toHaveLength(1);

    const whRows = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.projectId, PROJECT_ID),
          eq(webhookEvents.storeEventId, PURCHASE_TOKEN),
        ),
      );
    expect(whRows).toHaveLength(1);
    expect(whRows[0]?.status).toBe("PROCESSED");

    const subRows = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.projectId, PROJECT_ID));
    expect(subRows).toHaveLength(1);
  });
});
