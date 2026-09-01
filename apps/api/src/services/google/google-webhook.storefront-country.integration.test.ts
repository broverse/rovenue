// =============================================================
// handleGoogleNotification — store-supplied country on revenue events
// =============================================================
//
// Task 3 of the 2026-09-01 analytics-integrity-and-proceeds plan.
// Google's SubscriptionPurchaseV2 carries `regionCode`, documented by
// Google as "ISO 3166-1 alpha-2 billing country/region code of the user
// at the time the subscription was granted" — a per-transaction fact
// sourced from the store itself, exactly the Apple `storefront` analog
// (Task 2). Unlike Apple's alpha-3 storefront, Google's regionCode is
// already house-format alpha-2, so `normalizeAlpha2Country` (../country)
// only validates + fails closed — it never converts.
//
// This proves the value threads from the LIVE `subscriptionsv2.get`
// response through the real webhook pipeline into the co-located
// REVENUE_EVENT outbox row's payload, the same way
// apple-webhook.storefront-country.integration.test.ts proves it for
// Apple: by reading the real Postgres outbox row back, never by
// asserting on a mock's call args.
//
// Also documents (test 4) the VERIFIED gap: the VOIDED_PURCHASE RTDN —
// unlike a subscription lifecycle notification — carries no regionCode
// and `processVoidedPurchase` never re-fetches the live subscription for
// one, so a Google-side refund recorded via that path has no
// store-supplied country. That is the correct outcome per the plan's
// "where a store supplies nothing, record nothing" rule, not a defect.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).
// The Android Publisher client is mocked (same technique as the
// existing google-webhook integration suites) so no network runs.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Environment,
  PurchaseStatus,
  Store,
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
  GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE,
  GOOGLE_VOIDED_PURCHASE_REFUND_TYPE,
  type GooglePubSubPushBody,
  type GoogleSubscriptionPurchaseV2,
} from "./google-types";
import type { GoogleVerifyConfig } from "./google-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_gsfcountry_${RUN_ID}`;
const GOOGLE_PRODUCT_ID = `pro_sub_${RUN_ID}`;

// Configurable per-test: the mocked live subscriptionsv2.get response's
// regionCode. Set right before each `handleGoogleNotification` call.
const state = vi.hoisted(() => ({ regionCode: undefined as string | undefined }));

function fakeSubscriptionPurchase(
  purchaseToken: string,
): GoogleSubscriptionPurchaseV2 {
  return {
    regionCode: state.regionCode,
    subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
    acknowledgementState: GOOGLE_ACKNOWLEDGEMENT_STATE.ACKNOWLEDGED,
    startTime: new Date(1_700_000_000_000).toISOString(),
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
  verifyGoogleSubscription: vi.fn(async (_config: unknown, token: string) =>
    fakeSubscriptionPurchase(token),
  ),
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

// Imported AFTER vi.mock so the handler picks up the mocked deps.
const { handleGoogleNotification } = await import("./google-webhook");

function makeSubscriptionPushBody(
  purchaseToken: string,
  messageId: string,
): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    subscriptionNotification: {
      version: "1.0",
      notificationType:
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
      purchaseToken,
      subscriptionId: GOOGLE_PRODUCT_ID,
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

function makeVoidedPushBody(
  purchaseToken: string,
  messageId: string,
): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    voidedPurchaseNotification: {
      purchaseToken,
      orderId: `GPA.${RUN_ID}`,
      productType: GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE.PRODUCT_TYPE_SUBSCRIPTION,
      refundType: GOOGLE_VOIDED_PURCHASE_REFUND_TYPE.REFUND_TYPE_FULL_REFUND,
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

async function readRevenueOutboxPayload(
  purchaseId: string,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateType, "REVENUE_EVENT"));
  const match = rows
    .map((r) => r.payload as Record<string, unknown>)
    .find((p) => p.purchaseId === purchaseId);
  if (!match) throw new Error("no REVENUE_EVENT outbox row for this purchase");
  return match;
}

async function purchaseIdFor(storeTransactionId: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, PROJECT_ID),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    );
  if (!row) throw new Error("purchase not found");
  return row.id;
}

describe("handleGoogleNotification — store-supplied country on revenue events", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `GSFCountry ${RUN_ID}` });
    await db.insert(products).values({
      projectId: PROJECT_ID,
      identifier: `identifier_${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { google: GOOGLE_PRODUCT_ID },
      displayName: `GSFCountry Product ${RUN_ID}`,
      accessIds: [],
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("a live subscription purchase carrying a regionCode produces a revenue event whose payload carries the country", async () => {
    state.regionCode = "US";
    const token = `tok_with_region_${RUN_ID}`;
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makeSubscriptionPushBody(token, `msg_with_region_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(token);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload.country).toBe("US");
  });

  it("an unrecognised regionCode produces a revenue event whose payload carries no country key (fail closed, not the raw code)", async () => {
    state.regionCode = "ZZ";
    const token = `tok_bad_region_${RUN_ID}`;
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makeSubscriptionPushBody(token, `msg_bad_region_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(token);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
    expect(payload.country).not.toBe("ZZ");
  });

  it("a live subscription purchase with no regionCode produces a revenue event whose payload carries no country key", async () => {
    state.regionCode = undefined;
    const token = `tok_no_region_${RUN_ID}`;
    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makeSubscriptionPushBody(token, `msg_no_region_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(token);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
  });

  it("VOIDED_PURCHASE (no live regionCode available on this path) records a refund revenue event with no country key — verified gap, not a defect", async () => {
    const db = getDb();
    const token = `tok_voided_${RUN_ID}`;
    const [subscriber] = await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: `rv_voided_${RUN_ID}` })
      .returning();
    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.projectId, PROJECT_ID));
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: subscriber!.id,
      productId: product!.id,
      store: Store.PLAY_STORE,
      storeTransactionId: token,
      originalTransactionId: token,
      status: PurchaseStatus.ACTIVE,
      purchaseDate: new Date(1_700_000_000_000),
      originalPurchaseDate: new Date(1_700_000_000_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      environment: Environment.PRODUCTION,
    });

    const result = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makeVoidedPushBody(token, `msg_voided_${RUN_ID}`),
      verifyConfig: fakeVerifyConfig,
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(token);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
  });
});
