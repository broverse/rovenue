// =============================================================
// handleGoogleNotification — VOIDED_PURCHASE inbound refund
// =============================================================
//
// When a user obtains a refund directly from Google Play, the RTDN
// `voidedPurchaseNotification` must, like the Stripe/Apple inbound
// handlers: (1) flip the purchase to REFUNDED + stamp refundDate,
// (2) revoke access, (3) write a positive-magnitude REFUND
// revenue_events row so analytics net it via `gross - refunds`, and
// (4) fire the refund-detected emit. The VOIDED_PURCHASE payload
// carries no amount, so the refund amount is derived from the stored
// purchase price.
//
// Integration: hits a real Postgres 16 (the dev stack on host port
// 5433) for the purchase/revenue writes. The Android Publisher client,
// FX, and refund emit are mocked — the voided-purchase path never calls
// verify, so this exercises the DB-backed status/revenue writes.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  getDb,
  products,
  projects,
  purchases,
  revenueEvents,
  subscribers,
} from "@rovenue/db";
import {
  GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE,
  GOOGLE_VOIDED_PURCHASE_REFUND_TYPE,
  type GooglePubSubPushBody,
} from "./google-types";
import type { GoogleVerifyConfig } from "./google-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_gwhvoid_${RUN_ID}`;
const PRODUCT_ID = `prod_gwhvoid_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_gwhvoid_${RUN_ID}`;
const PURCHASE_ID = `pur_gwhvoid_${RUN_ID}`;
const PURCHASE_TOKEN = `tok_gwhvoid_${RUN_ID}`;
const ORDER_ID = `GPA.${RUN_ID}`;

// verifyGoogleSubscription is never reached on the voided-purchase path;
// the module is mocked only to keep imports off the network.
vi.mock("./google-verify", () => ({
  verifyGoogleSubscription: vi.fn(),
  acknowledgeGoogleSubscription: vi.fn(async () => undefined),
  getSubscriptionBasePlanPricing: vi.fn(async () => null),
}));
// FX passthrough so the USD amount equals the source amount.
vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
// Spyable refund-detected emit (asserted below).
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

// Imported AFTER vi.mock so the handler picks up the mocked deps.
import { maybeEmitRefundDetected } from "../notifications/refund-emit";
const { handleGoogleNotification } = await import("./google-webhook");

function makeVoidedPushBody(): GooglePubSubPushBody {
  const rtdn = {
    version: "1.0",
    packageName: "com.rovenue.test",
    eventTimeMillis: String(1_700_000_000_000),
    voidedPurchaseNotification: {
      purchaseToken: PURCHASE_TOKEN,
      orderId: ORDER_ID,
      productType: GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE.PRODUCT_TYPE_SUBSCRIPTION,
      refundType: GOOGLE_VOIDED_PURCHASE_REFUND_TYPE.REFUND_TYPE_FULL_REFUND,
    },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(rtdn)).toString("base64"),
      messageId: `msg_void_${RUN_ID}`,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/x/subscriptions/y",
  };
}

const fakeVerifyConfig = {
  credentials: { project_id: "test" },
  packageName: "com.rovenue.test",
} as unknown as GoogleVerifyConfig;

describe("handleGoogleNotification — VOIDED_PURCHASE inbound refund", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `G WH Void ${RUN_ID}` });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pro_${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { google: `pro_sub_${RUN_ID}` },
      displayName: "Pro",
      accessIds: [],
    });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `rv_${RUN_ID}`,
    });
    await db.insert(purchases).values({
      id: PURCHASE_ID,
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: Store.PLAY_STORE,
      storeTransactionId: PURCHASE_TOKEN,
      originalTransactionId: PURCHASE_TOKEN,
      status: PurchaseStatus.ACTIVE,
      purchaseDate: new Date(1_700_000_000_000),
      originalPurchaseDate: new Date(1_700_000_000_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      environment: Environment.PRODUCTION,
    });
  });

  afterAll(async () => {
    const db = getDb();
    // products / subscribers / purchases / revenue_events all FK-cascade
    // off the project row.
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("marks the purchase REFUNDED, writes a positive REFUND revenue_event, and fires refund-detected", async () => {
    const res = await handleGoogleNotification({
      projectId: PROJECT_ID,
      pushBody: makeVoidedPushBody(),
      verifyConfig: fakeVerifyConfig,
    });

    expect(res.status).toBe("processed");

    const db = getDb();

    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, PURCHASE_ID));
    expect(purchase?.status).toBe(PurchaseStatus.REFUNDED);
    expect(purchase?.refundDate).not.toBeNull();

    const revRows = await db
      .select()
      .from(revenueEvents)
      .where(
        and(
          eq(revenueEvents.projectId, PROJECT_ID),
          eq(revenueEvents.type, RevenueEventType.REFUND),
        ),
      );
    expect(revRows).toHaveLength(1);
    expect(revRows[0]?.purchaseId).toBe(PURCHASE_ID);
    expect(Number(revRows[0]?.amount)).toBeCloseTo(9.99);
    // Positive magnitude per the analytics convention (gross - refunds).
    expect(Number(revRows[0]?.amountUsd)).toBeCloseTo(9.99);

    const emit = vi.mocked(maybeEmitRefundDetected);
    expect(emit).toHaveBeenCalledTimes(1);
    const emitArg = emit.mock.calls[0]?.[1] as {
      purchaseId: string;
      amountUsdCents: number;
    };
    expect(emitArg.purchaseId).toBe(PURCHASE_ID);
    expect(emitArg.amountUsdCents).toBe(999);
  });
});
