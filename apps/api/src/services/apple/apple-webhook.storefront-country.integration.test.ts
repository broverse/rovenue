// =============================================================
// handleAppleNotification — store-supplied country on revenue events
// =============================================================
//
// Task 2 of the 2026-09-01 analytics-integrity-and-proceeds plan: revenue
// country must come from the STORE's own per-transaction value (Apple's
// `storefront` on the decoded JWS transaction), never from the
// subscriber's last-known SDK-reported country. This proves the value
// actually threads from the transaction through the real webhook
// pipeline into the co-located REVENUE_EVENT outbox row's payload — the
// exact JSON string `mv_revenue_to_raw` extracts `country` from — by
// reading the real Postgres row back, not by asserting on
// `createRevenueEvent`'s return value or a hand-inserted row.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).
// We seed project / subscriber / product inline and inject a stub
// verifier so no crypto / network runs (same technique as
// apple-webhook.transition-guard.integration.test.ts).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
  subscribers,
} from "@rovenue/db";
import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

const RUN_ID = Date.now();
const NOW_MS = Date.now();
const PROJECT_ID = `prj_sfcountry_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.pro.${RUN_ID}`;

function makeTransaction(
  overrides: Partial<AppleJwsTransactionPayload>,
): AppleJwsTransactionPayload {
  return {
    transactionId: `txn_${RUN_ID}`,
    originalTransactionId: `otxn_${RUN_ID}`,
    productId: APPLE_PRODUCT_ID,
    purchaseDate: NOW_MS,
    originalPurchaseDate: NOW_MS,
    expiresDate: NOW_MS + 30 * 86_400_000,
    signedDate: NOW_MS,
    price: 9_990_000,
    currency: "USD",
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "",
    storefrontId: "",
    ...overrides,
  } as AppleJwsTransactionPayload;
}

function makeNotification(
  notificationUUID: string,
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.SUBSCRIBED,
    notificationUUID,
    version: "2.0",
    signedDate: NOW_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-transaction-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  transaction: AppleJwsTransactionPayload,
  notificationUUID: string,
): AppleNotificationVerifier {
  const notification = makeNotification(notificationUUID);
  return {
    verifyNotification: async () => notification,
    verifyTransaction: async () => transaction,
    verifyRenewalInfo: async () => ({
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      autoRenewStatus: 1 as const,
      signedDate: NOW_MS,
      environment: APPLE_ENVIRONMENT.SANDBOX,
    }),
  };
}

async function seedProject() {
  const db = getDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: `SFCountry ${RUN_ID}` });
  await db.insert(products).values({
    projectId: PROJECT_ID,
    identifier: APPLE_PRODUCT_ID,
    type: "SUBSCRIPTION",
    storeIds: { apple: APPLE_PRODUCT_ID },
    displayName: `SFCountry Product ${RUN_ID}`,
    accessIds: [],
  });
}

async function readRevenueOutboxPayload(
  originalTransactionId: string,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const [purchase] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, PROJECT_ID),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    );
  if (!purchase) throw new Error("purchase not found");

  // Filter on the payload's own `purchaseId` (the exact JSON string
  // mv_revenue_to_raw parses) rather than joining through aggregateId,
  // since the outbox row's aggregateId is the revenue event's id, not
  // the purchase's.
  const rows = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateType, "REVENUE_EVENT"));
  const match = rows
    .map((r) => r.payload as Record<string, unknown>)
    .find((p) => p.purchaseId === purchase.id);
  if (!match) throw new Error("no REVENUE_EVENT outbox row for this purchase");
  return match;
}

describe("handleAppleNotification — store-supplied country on revenue events", () => {
  beforeAll(async () => {
    await seedProject();
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("a transaction carrying a storefront produces a revenue event whose stored payload carries the country", async () => {
    const otxn = `otxn_with_sf_${RUN_ID}`;
    const transaction = makeTransaction({
      transactionId: `txn_with_sf_${RUN_ID}`,
      originalTransactionId: otxn,
      storefront: "USA",
      storefrontId: "143441",
    });

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(transaction, `nfn_with_sf_${RUN_ID}`),
    });
    expect(result.status).toBe("processed");

    const payload = await readRevenueOutboxPayload(otxn);
    expect(payload.country).toBe("USA");
  });

  it("a transaction with no storefront produces a revenue event whose payload carries no country key", async () => {
    const otxn = `otxn_no_sf_${RUN_ID}`;
    const transaction = makeTransaction({
      transactionId: `txn_no_sf_${RUN_ID}`,
      originalTransactionId: otxn,
      storefront: "",
      storefrontId: "",
    });

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(transaction, `nfn_no_sf_${RUN_ID}`),
    });
    expect(result.status).toBe("processed");

    const payload = await readRevenueOutboxPayload(otxn);
    // Absence is represented by the KEY being absent, not by an empty
    // string masquerading as a value — mirrors how `metadata` is only
    // folded in when a presentedContext exists. ClickHouse's
    // `JSONExtractString` on a missing key resolves to the column's own
    // `DEFAULT ''`, so there is exactly one representation of "no
    // store-supplied country" all the way down.
    expect(payload).not.toHaveProperty("country");
  });
});
