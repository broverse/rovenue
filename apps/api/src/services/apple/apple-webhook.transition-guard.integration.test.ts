// =============================================================
// handleAppleNotification — state-machine transition guard
// =============================================================
//
// Proves a terminal REFUNDED purchase is NOT resurrected to ACTIVE
// by a late DID_RENEW: the status write is withheld and a
// `subscription.transition_rejected` audit row is written. Without
// the guard the row flips back to ACTIVE (resurrecting refunded
// revenue + access).
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433). We seed project / subscriber / product / REFUNDED purchase
// inline and inject a stub verifier so no crypto / network runs.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
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
const PROJECT_ID = `prj_tguard_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_tguard_${RUN_ID}`;
const PRODUCT_ID = `prod_tguard_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.pro.${RUN_ID}`;
const TXN_ID = `txn_tguard_${RUN_ID}`;
const OTXN_ID = `otxn_tguard_${RUN_ID}`;
const NOTIFICATION_UUID = `nfn_tguard_${RUN_ID}`;

function makeTransaction(): AppleJwsTransactionPayload {
  return {
    transactionId: TXN_ID,
    originalTransactionId: OTXN_ID,
    productId: APPLE_PRODUCT_ID,
    purchaseDate: 1_700_000_000_000,
    originalPurchaseDate: 1_700_000_000_000,
    expiresDate: 1_900_000_000_000,
    price: 9_990_000,
    currency: "USD",
    environment: APPLE_ENVIRONMENT.SANDBOX,
  } as AppleJwsTransactionPayload;
}

function makeRenewNotification(): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_RENEW,
    notificationUUID: NOTIFICATION_UUID,
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-transaction-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(): AppleNotificationVerifier {
  const notification = makeRenewNotification();
  const transaction = makeTransaction();
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => transaction),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("verifyRenewalInfo not used in this test");
    }),
  };
}

describe("handleAppleNotification — terminal transition guard", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `TGuard ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_${RUN_ID}`,
      appUserId: `app_user_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: APPLE_PRODUCT_ID,
      type: "SUBSCRIPTION",
      storeIds: { apple: APPLE_PRODUCT_ID },
      displayName: `TGuard Product ${RUN_ID}`,
      accessIds: [],
    });
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: TXN_ID,
      originalTransactionId: OTXN_ID,
      status: "REFUNDED",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: true,
      environment: "SANDBOX",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: false,
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("keeps a REFUNDED purchase REFUNDED on a late DID_RENEW and audits the rejection", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(),
    });

    expect(result.status).toBe("processed");

    const db = getDb();
    const [row] = await db
      .select({ status: purchases.status })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "APP_STORE"),
          eq(purchases.storeTransactionId, TXN_ID),
        ),
      );
    expect(row?.status).toBe("REFUNDED");

    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, PROJECT_ID),
          eq(auditLogs.action, "subscription.transition_rejected"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
