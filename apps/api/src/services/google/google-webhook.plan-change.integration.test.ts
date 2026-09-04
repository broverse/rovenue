// =============================================================
// handleGoogleNotification — product_changed on a token replacement
// =============================================================
//
// This is Google's MOST COMMON plan change: an immediate upgrade or
// downgrade (replacement mode WITH_TIME_PRORATION / CHARGE_PRORATED_PRICE)
// issues a NEW purchase token and points at the retired one via
// `linkedPurchaseToken`. Because the new token has no prior row, the
// guarded upsert INSERTS and its before-image is null — so the emit inside
// that transaction cannot see the change. And no Google RTDN type maps to
// `subscription.product_changed` in the flat normalization table for this
// flow. Before this suite, the flow produced no event at all.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
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
const PROJECT_ID = `prj_gpchg_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_gpchg_${RUN_ID}`;
const BASIC_PRODUCT_ID = `prod_basic_${RUN_ID}`;
const PRO_PRODUCT_ID = `prod_pro_${RUN_ID}`;
const GOOGLE_BASIC_ID = `basic_sub_${RUN_ID}`;
const GOOGLE_PRO_ID = `pro_sub_${RUN_ID}`;
const OLD_TOKEN = `tok_old_${RUN_ID}`;
const NEW_TOKEN = `tok_new_${RUN_ID}`;
const SUBSCRIPTION_ID = `sub_id_${RUN_ID}`;
// google-webhook resolves an RTDN for a token it has never seen to a
// synthetic subscriber keyed by that token (the receipt path converges it
// later). Seeding the subscriber under exactly that anchor is the realistic
// already-converged state AND makes resolution deterministic here.
const SYNTHETIC_ROVENUE_ID = `google:${NEW_TOKEN.slice(0, 24)}`;

const PRODUCT_CHANGED = "subscription.product_changed";
const PHASE_EFFECTIVE = "effective";
const TERM_MS = 30 * 86_400_000;

// The replacing purchase: NEW token, Pro line item, pointing back at the
// token it retired.
function fakeSubscriptionPurchase(): GoogleSubscriptionPurchaseV2 {
  return {
    regionCode: "US",
    subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
    acknowledgementState: GOOGLE_ACKNOWLEDGEMENT_STATE.ACKNOWLEDGED,
    startTime: new Date(Date.now()).toISOString(),
    linkedPurchaseToken: OLD_TOKEN,
    lineItems: [
      {
        productId: GOOGLE_PRO_ID,
        expiryTime: new Date(Date.now() + TERM_MS).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: "monthly" },
      },
    ],
  };
}

vi.mock("./google-verify", () => ({
  verifyGoogleSubscription: vi.fn(async () => fakeSubscriptionPurchase()),
  acknowledgeGoogleSubscription: vi.fn(async () => undefined),
  getSubscriptionBasePlanPricing: vi.fn(async () => ({
    amount: 19.99,
    currency: "USD",
  })),
}));
vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

const { handleGoogleNotification } = await import("./google-webhook");

function makePushBody(messageId: string): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType:
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      purchaseToken: NEW_TOKEN,
      subscriptionId: SUBSCRIPTION_ID,
    },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(rtdn)).toString("base64"),
      messageId,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/x/subscriptions/y",
  };
}

const fakeVerifyConfig = {
  credentials: { project_id: "test" },
  packageName: "com.rovenue.test",
} as unknown as GoogleVerifyConfig;

async function productChangedRows() {
  return getDb()
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, SUBSCRIBER_ID),
        eq(outboxEvents.eventType, PRODUCT_CHANGED),
      ),
    );
}

describe("handleGoogleNotification — token-replacement plan change", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `GPChg ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: SYNTHETIC_ROVENUE_ID,
      appUserId: SYNTHETIC_ROVENUE_ID,
    });
    await db.insert(products).values([
      {
        id: BASIC_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: GOOGLE_BASIC_ID,
        type: "SUBSCRIPTION",
        storeIds: { google: GOOGLE_BASIC_ID },
        displayName: `Basic ${RUN_ID}`,
        accessIds: [],
      },
      {
        id: PRO_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: GOOGLE_PRO_ID,
        type: "SUBSCRIPTION",
        storeIds: { google: GOOGLE_PRO_ID },
        displayName: `Pro ${RUN_ID}`,
        accessIds: [],
      },
    ]);
    // The tier being replaced, still paid up — keyed by the OLD token.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: BASIC_PRODUCT_ID,
      store: "PLAY_STORE",
      storeTransactionId: OLD_TOKEN,
      originalTransactionId: OLD_TOKEN,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + TERM_MS),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    });
  });

  afterAll(async () => {
    await getDb()
      .delete(outboxEvents)
      .where(eq(outboxEvents.aggregateId, SUBSCRIBER_ID));
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("emits product_changed for an immediate upgrade that issues a new token", async () => {
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody(`msg_move_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const rows = await productChangedRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    // The old side comes from the row the linked token retired.
    expect(payload.previousProductId).toBe(BASIC_PRODUCT_ID);
    expect(payload.productId).toBe(PRO_PRODUCT_ID);
    // Google states no direction — a prorated charge is not a list price.
    expect(payload.changeType).toBeNull();
    expect(payload.phase).toBe(PHASE_EFFECTIVE);

    // The replaced tier really was retired, so access cannot linger.
    const [oldRow] = await getDb()
      .select({ status: purchases.status })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "PLAY_STORE"),
          eq(purchases.storeTransactionId, OLD_TOKEN),
        ),
      );
    expect(oldRow?.status).toBe("EXPIRED");
  });

  it("does not emit again when the same replacement RTDN is redelivered", async () => {
    // A different messageId, so the RTDN dedup does not short-circuit it —
    // replay safety has to come from the supersede reporting nothing the
    // second time, because EXPIRED is not a terminal status and the row is
    // still found and re-written.
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody(`msg_replay_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");
    expect(await productChangedRows()).toHaveLength(1);
  });
});
