// =============================================================
// verifyReceipt (Google) — store-supplied country on revenue events
// =============================================================
//
// Task 3 of the 2026-09-01 analytics-integrity-and-proceeds plan.
// Proves the SAME country wiring the Google RTDN webhook gets
// (google-webhook.storefront-country.integration.test.ts) also lands
// through the receipt-verify path — both subscription and one-time
// product purchases carry a Google `regionCode`
// (`GoogleSubscriptionPurchaseV2.regionCode` /
// `ProductPurchase.regionCode`, both documented by Google as "ISO
// 3166-1 alpha-2 billing country/region code ... at the time the
// subscription/product was granted") — by reading the real Postgres
// outbox row back, the same technique as every other suite in this
// plan.
//
// Unlike Apple's `receipt-verify.ts` path, Google verification is a
// plain HTTP call (no JWS/crypto), so it is directly mockable and this
// suite exercises the real function end to end rather than accepting
// the crypto-path gap Task 2 documented for Apple.
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433) for the real product/subscriber/purchase/outbox writes. Only
// the Android Publisher client and the credentials loader are mocked —
// no network call runs.

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
} from "@rovenue/db";
import {
  GOOGLE_PRODUCT_PURCHASE_STATE,
  GOOGLE_SUBSCRIPTION_STATE,
} from "./google/google-types";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_grcountry_${RUN_ID}`;
const SUB_PRODUCT_ID = `prod_grc_sub_${RUN_ID}`;
const ONETIME_PRODUCT_ID = `prod_grc_1t_${RUN_ID}`;
const GOOGLE_SUB_PRODUCT_ID = `pro_sub_${RUN_ID}`;
const GOOGLE_ONETIME_PRODUCT_ID = `pro_1t_${RUN_ID}`;

// Configurable per-test regionCode for both the subscription and
// one-time mocked Android Publisher responses.
const state = vi.hoisted(() => ({
  subscriptionRegionCode: undefined as string | undefined,
  productRegionCode: undefined as string | null | undefined,
}));

vi.mock("../lib/project-credentials", () => ({
  loadGoogleCredentials: vi.fn(async () => ({
    packageName: "com.rovenue.test",
    serviceAccount: {
      client_email: "svc@rovenue-test.iam.gserviceaccount.com",
      private_key: "fake-key",
    },
  })),
}));

vi.mock("./google/google-verify", () => ({
  verifyGoogleSubscription: vi.fn(async () => ({
    regionCode: state.subscriptionRegionCode,
    subscriptionState: GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
    startTime: new Date(1_700_000_000_000).toISOString(),
    lineItems: [
      {
        productId: GOOGLE_SUB_PRODUCT_ID,
        expiryTime: new Date(1_705_000_000_000).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: "monthly" },
      },
    ],
  })),
  // orderId keyed on the purchaseToken (3rd arg): each one-time test uses
  // a distinct receipt/token, so the revenue dedupeKey (built from
  // orderId) doesn't collide across tests and silently return the FIRST
  // test's row instead of creating a fresh one.
  verifyGoogleProductPurchase: vi.fn(
    async (_config: unknown, _productId: string, purchaseToken: string) => ({
      regionCode: state.productRegionCode,
      purchaseState: GOOGLE_PRODUCT_PURCHASE_STATE.PURCHASED,
      orderId: `GPA.onetime.${purchaseToken}`,
      // Current time, not a fixed historical one: revenue_events is
      // date-partitioned and an old fixed timestamp can miss the seeded
      // partition range in a real Postgres run.
      purchaseTimeMillis: String(Date.now()),
    }),
  ),
  getSubscriptionBasePlanPricing: vi.fn(async () => ({
    amount: 9.99,
    currency: "USD",
  })),
  getOneTimeProductPricing: vi.fn(async () => ({
    amount: 4.99,
    currency: "USD",
  })),
}));

vi.mock("./fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));

// Imported AFTER vi.mock so the module picks up the mocked deps.
const { verifyReceipt } = await import("./receipt-verify");

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

describe("verifyReceipt (Google) — store-supplied country on revenue events", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `GRCountry ${RUN_ID}` });
    await db.insert(products).values([
      {
        id: SUB_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: `identifier_sub_${RUN_ID}`,
        type: "SUBSCRIPTION",
        storeIds: { google: GOOGLE_SUB_PRODUCT_ID },
        displayName: `GRCountry Sub Product ${RUN_ID}`,
        accessIds: [],
      },
      {
        id: ONETIME_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: `identifier_1t_${RUN_ID}`,
        type: "CONSUMABLE",
        storeIds: { google: GOOGLE_ONETIME_PRODUCT_ID },
        displayName: `GRCountry 1t Product ${RUN_ID}`,
        accessIds: [],
      },
    ]);
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("a subscription receipt carrying a regionCode produces a revenue event whose payload carries the country", async () => {
    state.subscriptionRegionCode = "US";
    const receipt = `tok_sub_with_region_${RUN_ID}`;
    await verifyReceipt({
      projectId: PROJECT_ID,
      store: "PLAY_STORE",
      receipt,
      productId: `identifier_sub_${RUN_ID}`,
      appUserId: `device_${receipt}`,
    });

    const purchaseId = await purchaseIdFor(receipt);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload.country).toBe("US");
  });

  it("a subscription receipt with an unrecognised regionCode produces a revenue event whose payload carries no country key", async () => {
    state.subscriptionRegionCode = "ZZ";
    const receipt = `tok_sub_bad_region_${RUN_ID}`;
    await verifyReceipt({
      projectId: PROJECT_ID,
      store: "PLAY_STORE",
      receipt,
      productId: `identifier_sub_${RUN_ID}`,
      appUserId: `device_${receipt}`,
    });

    const purchaseId = await purchaseIdFor(receipt);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
    expect(payload.country).not.toBe("ZZ");
  });

  it("a one-time product receipt carrying a regionCode produces a revenue event whose payload carries the country", async () => {
    state.productRegionCode = "GB";
    const receipt = `tok_1t_with_region_${RUN_ID}`;
    await verifyReceipt({
      projectId: PROJECT_ID,
      store: "PLAY_STORE",
      receipt,
      productId: `identifier_1t_${RUN_ID}`,
      appUserId: `device_${receipt}`,
    });

    const purchaseId = await purchaseIdFor(receipt);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload.country).toBe("GB");
  });

  it("a one-time product receipt with no regionCode produces a revenue event whose payload carries no country key", async () => {
    state.productRegionCode = undefined;
    const receipt = `tok_1t_no_region_${RUN_ID}`;
    await verifyReceipt({
      projectId: PROJECT_ID,
      store: "PLAY_STORE",
      receipt,
      productId: `identifier_1t_${RUN_ID}`,
      appUserId: `device_${receipt}`,
    });

    const purchaseId = await purchaseIdFor(receipt);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
  });
});
