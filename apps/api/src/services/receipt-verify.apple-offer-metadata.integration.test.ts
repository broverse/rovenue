// =============================================================
// verifyReceipt (Apple) — offer metadata on the receipt path
// =============================================================
//
// `purchases.offerType` / `offerIdentifier` exist to make a promotional,
// offer-code or win-back cohort queryable. The Apple WEBHOOK path writes
// them; this path is where a purchase is very often observed FIRST (the
// SDK verifies the receipt the moment StoreKit hands it over, before any
// App Store Server Notification arrives). Left unwired here, a win-back
// purchase would record `offerType = NULL` forever unless a webhook later
// happened to repaint it — the feature half-delivered.
//
// Also pins the update path's present-only write: a later verify that
// omits `offerType` must LEAVE the recorded offer alone. `?? null` there
// would erase exactly the fact these columns exist to keep.
//
// Integration: real Postgres via DATABASE_URL. The JWS verifier is
// mocked, so no crypto or network runs — `resolveAppleVerifier` falls back
// to `JoseAppleNotificationVerifier` for a project with no stored Apple
// credentials, which is what this replaces.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, products, projects, purchases } from "@rovenue/db";
import {
  APPLE_ENVIRONMENT,
  APPLE_OFFER_TYPE,
  type AppleJwsTransactionPayload,
} from "./apple/apple-types";

const RUN_ID = Date.now();
const NOW_MS = Date.now();
const TERM_MS = 30 * 86_400_000;
/** Apple reports price in micros (1/1,000,000 of the currency unit). */
const PRICE_MICROS = 4_990_000;

const PROJECT_ID = `prj_rvoffer_${RUN_ID}`;
const PRODUCT_ID = `prod_rvoffer_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.rvoffer.${RUN_ID}`;
const APP_USER_ID = `app_user_rvoffer_${RUN_ID}`;
const TXN_ID = `txn_rvoffer_${RUN_ID}`;
const OTXN_ID = `otxn_rvoffer_${RUN_ID}`;
const OFFER_IDENTIFIER = `winback_receipt_${RUN_ID}`;

/** Swapped per test; read by the mocked verifier below. */
let nextTransaction: AppleJwsTransactionPayload;

vi.mock("./apple/apple-verify", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./apple/apple-verify")>();
  return {
    ...actual,
    JoseAppleNotificationVerifier: class {
      async verifyTransaction(): Promise<AppleJwsTransactionPayload> {
        return nextTransaction;
      }
    },
  };
});

const { verifyReceipt } = await import("./receipt-verify");

function makeTransaction(
  offer: { offerType?: number; offerIdentifier?: string },
): AppleJwsTransactionPayload {
  return {
    transactionId: TXN_ID,
    originalTransactionId: OTXN_ID,
    bundleId: `com.app.${RUN_ID}`,
    productId: APPLE_PRODUCT_ID,
    purchaseDate: NOW_MS,
    originalPurchaseDate: NOW_MS,
    expiresDate: NOW_MS + TERM_MS,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: NOW_MS,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: PRICE_MICROS,
    ...offer,
  } as AppleJwsTransactionPayload;
}

async function offerColumns() {
  const [row] = await getDb()
    .select({
      offerType: purchases.offerType,
      offerIdentifier: purchases.offerIdentifier,
      isIntroOffer: purchases.isIntroOffer,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, PROJECT_ID),
        eq(purchases.store, "APP_STORE"),
        eq(purchases.storeTransactionId, TXN_ID),
      ),
    );
  return row;
}

async function verify() {
  return verifyReceipt({
    projectId: PROJECT_ID,
    store: "APP_STORE",
    receipt: "stub-signed-transaction-jws",
    productId: APPLE_PRODUCT_ID,
    appUserId: APP_USER_ID,
  });
}

describe("verifyReceipt (Apple) — offer metadata", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `RVOffer ${RUN_ID}` });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: APPLE_PRODUCT_ID,
      type: "SUBSCRIPTION",
      storeIds: { apple: APPLE_PRODUCT_ID },
      displayName: `RVOffer Product ${RUN_ID}`,
      accessIds: [],
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("records offerType and offerIdentifier when the purchase is first seen here", async () => {
    nextTransaction = makeTransaction({
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: OFFER_IDENTIFIER,
    });
    await verify();

    const row = await offerColumns();
    expect(row?.offerType).toBe(APPLE_OFFER_TYPE.WIN_BACK);
    expect(row?.offerIdentifier).toBe(OFFER_IDENTIFIER);
    // The pre-existing boolean still says only "some offer applied" — which
    // is exactly why the two columns had to be added.
    expect(row?.isIntroOffer).toBe(true);
  });

  it("a later verify that omits the offer does not erase what was recorded", async () => {
    nextTransaction = makeTransaction({});
    await verify();

    const row = await offerColumns();
    expect(row?.offerType).toBe(APPLE_OFFER_TYPE.WIN_BACK);
    expect(row?.offerIdentifier).toBe(OFFER_IDENTIFIER);
  });
});
