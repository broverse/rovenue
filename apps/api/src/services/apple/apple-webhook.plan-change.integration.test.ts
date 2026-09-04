// =============================================================
// handleAppleNotification — pending plan change + product_changed
// =============================================================
//
// Apple is the ONLY store that states the direction of a plan change, and
// before this suite existed its whole arm was inert. Three things stacked
// up: DID_CHANGE_RENEWAL_PREF early-returned for every subtype except
// UPGRADE (so the announcing notifications never wrote the pending
// columns), UPGRADE mints a NEW transactionId (so the guard's before-image
// is null and the in-transaction emit is skipped), and by the following
// DID_RENEW `autoRenewProductId` already equals the transaction's product
// (so nothing looks pending any more).
//
// This pins all three paths:
//   1. DOWNGRADE records the pending change and takes NO effect;
//   2. the no-subtype revert clears it again;
//   3. UPGRADE emits `subscription.product_changed` with the direction
//      Apple stated and the retired row's product as the previous side.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433),
// with a stub verifier so no crypto / network runs.

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
import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleNotificationSubtype,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";

const RUN_ID = Date.now();
const NOW_MS = Date.now();
const TERM_MS = 30 * 86_400_000;

const PROJECT_ID = `prj_apchg_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_apchg_${RUN_ID}`;
const BASIC_PRODUCT_ID = `prod_basic_${RUN_ID}`;
const PRO_PRODUCT_ID = `prod_pro_${RUN_ID}`;
const APPLE_BASIC_ID = `com.app.basic.${RUN_ID}`;
const APPLE_PRO_ID = `com.app.pro.${RUN_ID}`;
const BASIC_TXN_ID = `txn_basic_${RUN_ID}`;
const UPGRADE_TXN_ID = `txn_upgrade_${RUN_ID}`;
const OTXN_ID = `otxn_apchg_${RUN_ID}`;

const PRODUCT_CHANGED = "subscription.product_changed";
const PHASE_EFFECTIVE = "effective";

function makeTransaction(
  transactionId: string,
  appleProductId: string,
): AppleJwsTransactionPayload {
  return {
    transactionId,
    originalTransactionId: OTXN_ID,
    productId: appleProductId,
    purchaseDate: NOW_MS,
    originalPurchaseDate: NOW_MS,
    expiresDate: NOW_MS + TERM_MS,
    signedDate: NOW_MS,
    price: 9_990_000,
    currency: "USD",
    environment: APPLE_ENVIRONMENT.SANDBOX,
  } as AppleJwsTransactionPayload;
}

/**
 * @param autoRenewProductId what Apple says will renew NEXT — the whole
 * point of a renewal-pref notification.
 */
function makeStubVerifier(args: {
  uuidSuffix: string;
  subtype?: AppleNotificationSubtype;
  transactionId: string;
  appleProductId: string;
  autoRenewProductId: string;
}): AppleNotificationVerifier {
  const notification = {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_PREF,
    ...(args.subtype ? { subtype: args.subtype } : {}),
    notificationUUID: `nfn_apchg_${RUN_ID}_${args.uuidSuffix}`,
    version: "2.0",
    signedDate: NOW_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-transaction-jws",
      // Without this the handler never calls verifyRenewalInfo, so
      // `ctx.renewalInfo` is undefined and autoRenewProductId — the whole
      // subject of a renewal-pref notification — never reaches the code.
      signedRenewalInfo: "stub-renewal-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;

  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () =>
      makeTransaction(args.transactionId, args.appleProductId),
    ),
    verifyRenewalInfo: vi.fn(async () => ({
      originalTransactionId: OTXN_ID,
      productId: args.appleProductId,
      autoRenewProductId: args.autoRenewProductId,
      autoRenewStatus: 1 as const,
      signedDate: NOW_MS,
      environment: APPLE_ENVIRONMENT.SANDBOX,
    })),
  } as unknown as AppleNotificationVerifier;
}

async function basicRow() {
  const [row] = await getDb()
    .select({
      status: purchases.status,
      productId: purchases.productId,
      pendingProductId: purchases.pendingProductId,
      pendingChangeType: purchases.pendingChangeType,
      pendingChangeEffectiveAt: purchases.pendingChangeEffectiveAt,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.store, "APP_STORE"),
        eq(purchases.storeTransactionId, BASIC_TXN_ID),
      ),
    );
  return row;
}

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

describe("handleAppleNotification — plan change", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `APChg ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_${RUN_ID}`,
      appUserId: `app_user_${RUN_ID}`,
    });
    await db.insert(products).values([
      {
        id: BASIC_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: APPLE_BASIC_ID,
        type: "SUBSCRIPTION",
        storeIds: { apple: APPLE_BASIC_ID },
        displayName: `Basic ${RUN_ID}`,
        accessIds: [],
      },
      {
        id: PRO_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: APPLE_PRO_ID,
        type: "SUBSCRIPTION",
        storeIds: { apple: APPLE_PRO_ID },
        displayName: `Pro ${RUN_ID}`,
        accessIds: [],
      },
    ]);
    // In force: Basic, paid up for another term.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: BASIC_PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: BASIC_TXN_ID,
      originalTransactionId: OTXN_ID,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: true,
      environment: "SANDBOX",
      purchaseDate: new Date(NOW_MS),
      originalPurchaseDate: new Date(NOW_MS),
      expiresDate: new Date(NOW_MS + TERM_MS),
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

  it("records a DOWNGRADE as pending without touching status or product", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        uuidSuffix: "downgrade",
        subtype: APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE,
        transactionId: BASIC_TXN_ID,
        appleProductId: APPLE_BASIC_ID,
        // Apple says the NEXT renewal charges for Pro.
        autoRenewProductId: APPLE_PRO_ID,
      }),
    });
    expect(result.status).toBe("processed");

    const row = await basicRow();
    expect(row?.pendingProductId).toBe(PRO_PRODUCT_ID);
    expect(row?.pendingChangeType).toBe("DOWNGRADE");
    expect(row?.pendingChangeEffectiveAt).toEqual(new Date(NOW_MS + TERM_MS));
    // A scheduled change takes NO effect: the paid-up term keeps its
    // product and its status.
    expect(row?.status).toBe("ACTIVE");
    expect(row?.productId).toBe(BASIC_PRODUCT_ID);
    // Announcing is not changing.
    expect(await productChangedRows()).toHaveLength(0);
  });

  it("clears the pending change when the subscriber reverts it", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        uuidSuffix: "revert",
        // The revert carries no subtype, and autoRenewProductId is back to
        // the product already in force.
        transactionId: BASIC_TXN_ID,
        appleProductId: APPLE_BASIC_ID,
        autoRenewProductId: APPLE_BASIC_ID,
      }),
    });
    expect(result.status).toBe("processed");

    const row = await basicRow();
    expect(row?.pendingProductId).toBeNull();
    expect(row?.pendingChangeType).toBeNull();
    expect(row?.pendingChangeEffectiveAt).toBeNull();
    expect(row?.status).toBe("ACTIVE");
  });

  it("emits product_changed with Apple's stated direction on an UPGRADE", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        uuidSuffix: "upgrade",
        subtype: APPLE_NOTIFICATION_SUBTYPE.UPGRADE,
        // Apple charges immediately and mints a NEW transaction id — which
        // is exactly why the guard's before-image cannot see this change.
        transactionId: UPGRADE_TXN_ID,
        appleProductId: APPLE_PRO_ID,
        autoRenewProductId: APPLE_PRO_ID,
      }),
    });
    expect(result.status).toBe("processed");

    const rows = await productChangedRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    // The previous side comes from the row the upgrade retired.
    expect(payload.previousProductId).toBe(BASIC_PRODUCT_ID);
    expect(payload.productId).toBe(PRO_PRODUCT_ID);
    // Apple is the only store that states this.
    expect(payload.changeType).toBe("UPGRADE");
    // Distinguishes an effected change from the bridge's announcement.
    expect(payload.phase).toBe(PHASE_EFFECTIVE);

    // The superseded tier really was retired.
    expect((await basicRow())?.status).toBe("EXPIRED");
  });

  it("does not emit twice when Apple redelivers the same upgrade", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        // A DIFFERENT notification uuid, so the webhook_events dedup does
        // not short-circuit it — the replay safety has to come from the
        // supersede returning nothing the second time.
        uuidSuffix: "upgrade_replay",
        subtype: APPLE_NOTIFICATION_SUBTYPE.UPGRADE,
        transactionId: UPGRADE_TXN_ID,
        appleProductId: APPLE_PRO_ID,
        autoRenewProductId: APPLE_PRO_ID,
      }),
    });
    expect(result.status).toBe("processed");
    expect(await productChangedRows()).toHaveLength(1);
  });
});
