// =============================================================
// handleGoogleNotification — subscriber resolution (no fabrication)
// =============================================================
//
// An RTDN must resolve to the SAME subscriber the receipt created
// (anchored on the purchaseToken), never mint a parallel row keyed by
// the client's externalAccountId. Otherwise receipt-driven state
// (purchase/access) and webhook-driven state (renewal/refund) split
// across two subscribers (the Apple appAccountToken bug, Google twin).
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, products, projects, purchases, subscribers } from "@rovenue/db";
import {
  GOOGLE_ACKNOWLEDGEMENT_STATE,
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GooglePubSubPushBody,
  type GoogleSubscriptionPurchaseV2,
} from "./google-types";
import type { GoogleVerifyConfig } from "./google-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_gwhres_${RUN_ID}`;
const PRODUCT_ID = `prod_gwhres_${RUN_ID}`;
const PURCHASE_TOKEN = `tok_gwhres_${RUN_ID}`;
const GOOGLE_PRODUCT_ID = `pro_sub_${RUN_ID}`;
const SUBSCRIPTION_ID = `sub_id_${RUN_ID}`;
const DEVICE = `rov_device_${RUN_ID}`;
// A DIFFERENT value than the receipt subscriber's rovenueId — the old code
// would fabricate a subscriber keyed by this.
const EXTERNAL_ACCOUNT_ID = `ext_acct_${RUN_ID}`;

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

vi.mock("./google-verify", () => ({
  verifyGoogleSubscription: vi.fn(async () => fakeSubscriptionPurchase()),
  acknowledgeGoogleSubscription: vi.fn(async () => undefined),
  getSubscriptionBasePlanPricing: vi.fn(async () => ({
    amount: 9.99,
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

function makePushBody(): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    subscriptionNotification: {
      version: "1.0",
      notificationType: GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
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

describe("handleGoogleNotification — subscriber resolution", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `GWHRes ${RUN_ID}` });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pro_${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { google: GOOGLE_PRODUCT_ID },
      displayName: "Pro",
      accessIds: [],
    });
    // Receipt-first: the app-user subscriber already owns the purchase,
    // keyed by the purchaseToken anchor.
    const [s1] = await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: DEVICE, appUserId: DEVICE })
      .returning();
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: s1!.id,
      productId: PRODUCT_ID,
      store: "PLAY_STORE",
      storeTransactionId: PURCHASE_TOKEN,
      originalTransactionId: PURCHASE_TOKEN,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86_400_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("resolves the RTDN to the receipt subscriber via the purchaseToken anchor; never fabricates an externalAccountId row", async () => {
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makePushBody(),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const db = getDb();
    // No parallel subscriber keyed by the client's externalAccountId.
    const fabricated = await db
      .select({ id: subscribers.id })
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, EXTERNAL_ACCOUNT_ID),
        ),
      );
    expect(fabricated).toHaveLength(0);

    // Exactly the one receipt subscriber exists, and still owns the purchase.
    const subs = await db
      .select({ rovenueId: subscribers.rovenueId })
      .from(subscribers)
      .where(eq(subscribers.projectId, PROJECT_ID));
    expect(subs).toHaveLength(1);
    expect(subs[0]?.rovenueId).toBe(DEVICE);

    const [pur] = await db
      .select({ subscriberId: purchases.subscriberId })
      .from(purchases)
      .where(
        and(
          eq(purchases.projectId, PROJECT_ID),
          eq(purchases.storeTransactionId, PURCHASE_TOKEN),
        ),
      );
    const [s1] = await db
      .select({ id: subscribers.id })
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, DEVICE),
        ),
      );
    expect(pur!.subscriberId).toBe(s1!.id);
  });
});
