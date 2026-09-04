// =============================================================
// handleAppleNotification — OFFER_REDEEMED (win-back / promo / offer code)
// =============================================================
//
// OFFER_REDEEMED was absent from `dispatch`'s switch entirely, so it fell
// through the default branch: a subscriber could come back from a fully
// lapsed subscription on a win-back offer and Rovenue noticed nothing —
// no state change, no revenue event, no lifecycle event — while
// `offerType` was collapsed into the `isIntroOffer` boolean and otherwise
// discarded, so the win-back cohort was not even queryable after the fact.
//
// This suite pins the four facts that fix requires:
//   1. a redemption against an EXPIRED chain reactivates it and records
//      REACTIVATION, with the offer's type and identifier persisted;
//   2. a redemption against a LIVE chain is a new paid term — INITIAL;
//   3. the lifecycle key reaches the outbox (through the REAL bridge, not
//      a stub), so a win-back campaign can stop targeting the subscriber;
//   4. a redelivery on a transaction we already hold adds no second
//      revenue row — INITIAL and REACTIVATION carry DIFFERENT dedupe
//      kinds, so a handler disagreeing with an earlier one about which
//      this is would double-count the charge rather than dedupe it.
//
// Integration: hits a real Postgres 16 via DATABASE_URL, with a stub
// verifier so no crypto / network runs.

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
  revenueEvents,
  subscribers,
} from "@rovenue/db";
import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  APPLE_OFFER_TYPE,
  type AppleJwsTransactionPayload,
  type AppleNotificationSubtype,
  type AppleNotificationType,
  type AppleOfferType,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";
import { __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook } from "../webhook-processor";

const RUN_ID = Date.now();
const NOW_MS = Date.now();
const TERM_MS = 30 * 86_400_000;
/** Apple reports price in micros (1/1,000,000 of the currency unit). */
const PRICE_MICROS = 9_990_000;

const PROJECT_ID = `prj_apoffer_${RUN_ID}`;
const PRODUCT_ID = `prod_apoffer_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.offer.${RUN_ID}`;
// A second mapped product, so a DOWNGRADE announcement has somewhere to point.
const PRODUCT_B_ID = `prod_apoffer_b_${RUN_ID}`;
const APPLE_PRODUCT_B_ID = `com.app.offer.b.${RUN_ID}`;

// Two independent subscription chains: one that has fully lapsed (the
// win-back case) and one still running (the promotional-offer case).
const LAPSED = {
  subscriberId: `sub_lapsed_${RUN_ID}`,
  originalTransactionId: `otxn_lapsed_${RUN_ID}`,
  oldTransactionId: `txn_lapsed_old_${RUN_ID}`,
  newTransactionId: `txn_winback_${RUN_ID}`,
  offerIdentifier: `winback_20pct_${RUN_ID}`,
};
const LIVE = {
  subscriberId: `sub_live_${RUN_ID}`,
  originalTransactionId: `otxn_live_${RUN_ID}`,
  oldTransactionId: `txn_live_${RUN_ID}`,
  newTransactionId: `txn_promo_${RUN_ID}`,
  offerIdentifier: `promo_x_${RUN_ID}`,
};

// Two more chains, for the two findings the review raised.
const RACE = {
  subscriberId: `sub_race_${RUN_ID}`,
  originalTransactionId: `otxn_race_${RUN_ID}`,
  oldTransactionId: `txn_race_old_${RUN_ID}`,
  newTransactionId: `txn_race_new_${RUN_ID}`,
  offerIdentifier: `winback_race_${RUN_ID}`,
};
const DOWN = {
  subscriberId: `sub_down_${RUN_ID}`,
  originalTransactionId: `otxn_down_${RUN_ID}`,
  oldTransactionId: `txn_down_${RUN_ID}`,
  newTransactionId: `txn_down_${RUN_ID}`,
  offerIdentifier: `offercode_down_${RUN_ID}`,
};

const OFFER_REDEEMED_KEY = "subscription.offer_redeemed";

function makeTransaction(args: {
  transactionId: string;
  originalTransactionId: string;
  offerType: AppleOfferType;
  offerIdentifier: string;
}): AppleJwsTransactionPayload {
  return {
    transactionId: args.transactionId,
    originalTransactionId: args.originalTransactionId,
    productId: APPLE_PRODUCT_ID,
    purchaseDate: NOW_MS,
    originalPurchaseDate: NOW_MS,
    expiresDate: NOW_MS + TERM_MS,
    signedDate: NOW_MS,
    price: PRICE_MICROS,
    currency: "USD",
    environment: APPLE_ENVIRONMENT.SANDBOX,
    offerType: args.offerType,
    offerIdentifier: args.offerIdentifier,
  } as AppleJwsTransactionPayload;
}

interface StubArgs {
  uuidSuffix: string;
  transactionId: string;
  originalTransactionId: string;
  offerType: AppleOfferType;
  offerIdentifier: string;
  notificationType?: AppleNotificationType;
  subtype?: AppleNotificationSubtype;
  /** Apple product the NEXT renewal charges for — drives the pending columns. */
  autoRenewProductId?: string;
}

function makeStubVerifier(args: StubArgs): AppleNotificationVerifier {
  const notification = {
    notificationType: args.notificationType ?? APPLE_NOTIFICATION_TYPE.OFFER_REDEEMED,
    ...(args.subtype ? { subtype: args.subtype } : {}),
    notificationUUID: `nfn_apoffer_${RUN_ID}_${args.uuidSuffix}`,
    version: "2.0",
    signedDate: NOW_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-transaction-jws",
      // Without this the handler never calls verifyRenewalInfo, so
      // `autoRenewProductId` — the subject of a downgrade announcement —
      // never reaches the code.
      ...(args.autoRenewProductId ? { signedRenewalInfo: "stub-renewal-jws" } : {}),
    },
  } as AppleResponseBodyV2DecodedPayload;

  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => makeTransaction(args)),
    verifyRenewalInfo: vi.fn(async () => {
      if (!args.autoRenewProductId) {
        throw new Error("no renewal info on this fixture");
      }
      return {
        originalTransactionId: args.originalTransactionId,
        productId: APPLE_PRODUCT_ID,
        autoRenewProductId: args.autoRenewProductId,
        autoRenewStatus: 1 as const,
        signedDate: NOW_MS,
        environment: APPLE_ENVIRONMENT.SANDBOX,
      };
    }),
  } as unknown as AppleNotificationVerifier;
}

/**
 * Drives the handler with the REAL outbox bridge as `postProcess` — the
 * same function webhook-processor hands every store handler. A stub here
 * would prove only that the handler called something; the lifecycle key
 * has to survive `resolveStorePublicKey` to reach a consumer at all.
 */
async function redeem(args: StubArgs) {
  return handleAppleNotification({
    projectId: PROJECT_ID,
    signedPayload: `signed-envelope-${args.uuidSuffix}`,
    verifier: makeStubVerifier(args),
    postProcess: async (post) => {
      if (!post.subscriberId) return;
      await enqueueOutgoingWebhook({
        projectId: PROJECT_ID,
        subscriberId: post.subscriberId,
        purchaseId: post.purchaseId,
        eventType: post.eventType,
        webhookEventId: post.webhookEventId,
        eventContext: post.eventContext,
      });
    },
  });
}

async function purchaseRow(storeTransactionId: string) {
  const [row] = await getDb()
    .select({
      id: purchases.id,
      status: purchases.status,
      isIntroOffer: purchases.isIntroOffer,
      offerType: purchases.offerType,
      offerIdentifier: purchases.offerIdentifier,
      pendingProductId: purchases.pendingProductId,
      pendingChangeType: purchases.pendingChangeType,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, PROJECT_ID),
        eq(purchases.store, "APP_STORE"),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    );
  return row;
}

async function revenueTypesFor(purchaseId: string) {
  const rows = await getDb()
    .select({ type: revenueEvents.type })
    .from(revenueEvents)
    .where(eq(revenueEvents.purchaseId, purchaseId));
  return rows.map((r) => r.type);
}

async function outboxEventTypesFor(subscriberId: string) {
  const rows = await getDb()
    .select({ eventType: outboxEvents.eventType })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, subscriberId));
  return rows.map((r) => r.eventType);
}

type SeedStatus = "EXPIRED" | "ACTIVE" | "BILLING_ISSUE";

async function seedChain(chain: typeof LAPSED, status: SeedStatus) {
  const db = getDb();
  await db.insert(subscribers).values({
    id: chain.subscriberId,
    projectId: PROJECT_ID,
    rovenueId: `app_user_${chain.subscriberId}`,
    appUserId: `app_user_${chain.subscriberId}`,
  });
  await db.insert(purchases).values({
    projectId: PROJECT_ID,
    subscriberId: chain.subscriberId,
    productId: PRODUCT_ID,
    store: "APP_STORE",
    storeTransactionId: chain.oldTransactionId,
    originalTransactionId: chain.originalTransactionId,
    status,
    isTrial: false,
    isIntroOffer: false,
    isSandbox: true,
    environment: "SANDBOX",
    purchaseDate: new Date(NOW_MS - TERM_MS),
    originalPurchaseDate: new Date(NOW_MS - TERM_MS),
    // A lapsed chain's term is already over; a live one runs on.
    expiresDate: new Date(
      status === "EXPIRED" ? NOW_MS - 86_400_000 : NOW_MS + TERM_MS,
    ),
    priceAmount: "9.99",
    priceCurrency: "USD",
    autoRenewStatus: status === "ACTIVE",
  });
}

describe("handleAppleNotification — OFFER_REDEEMED", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `APOffer ${RUN_ID}` });
    await db.insert(products).values([
      {
        id: PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: APPLE_PRODUCT_ID,
        type: "SUBSCRIPTION",
        storeIds: { apple: APPLE_PRODUCT_ID },
        displayName: `Offer product ${RUN_ID}`,
        accessIds: [],
      },
      {
        id: PRODUCT_B_ID,
        projectId: PROJECT_ID,
        identifier: APPLE_PRODUCT_B_ID,
        type: "SUBSCRIPTION",
        storeIds: { apple: APPLE_PRODUCT_B_ID },
        displayName: `Offer product B ${RUN_ID}`,
        accessIds: [],
      },
    ]);
    await seedChain(LAPSED, "EXPIRED");
    await seedChain(LIVE, "ACTIVE");
    // BILLING_ISSUE, not EXPIRED: the state a lapsing chain sits in while
    // the expiry-checker has not caught up. It is what makes the two
    // handlers disagree, and what makes a re-grant on an announcement
    // possible.
    await seedChain(RACE, "BILLING_ISSUE");
    await seedChain(DOWN, "BILLING_ISSUE");
  });

  afterAll(async () => {
    const db = getDb();
    for (const chain of [LAPSED, LIVE, RACE, DOWN]) {
      await db
        .delete(outboxEvents)
        .where(eq(outboxEvents.aggregateId, chain.subscriberId));
    }
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("reactivates an expired subscription on a win-back redemption", async () => {
    const result = await redeem({
      uuidSuffix: "winback",
      transactionId: LAPSED.newTransactionId,
      originalTransactionId: LAPSED.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: LAPSED.offerIdentifier,
    });
    expect(result.status).toBe("processed");

    const purchase = await purchaseRow(LAPSED.newTransactionId);
    expect(purchase?.status).toBe("ACTIVE");
    // The whole point of the two new columns: a win-back is now
    // distinguishable from an introductory price, which `isIntroOffer`
    // alone never was.
    expect(purchase?.offerType).toBe(APPLE_OFFER_TYPE.WIN_BACK);
    expect(purchase?.offerIdentifier).toBe(LAPSED.offerIdentifier);

    expect(await revenueTypesFor(purchase!.id)).toContain("REACTIVATION");
    // The redemption attaches to the SAME subscriber the lapsed chain
    // belonged to — a resurrection that minted a second subscriber would
    // be a silent orphan.
    expect(await outboxEventTypesFor(LAPSED.subscriberId)).toContain(
      OFFER_REDEEMED_KEY,
    );
  });

  it("records INITIAL, not REACTIVATION, when the chain was not expired", async () => {
    const result = await redeem({
      uuidSuffix: "promo",
      transactionId: LIVE.newTransactionId,
      originalTransactionId: LIVE.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.PROMOTIONAL,
      offerIdentifier: LIVE.offerIdentifier,
    });
    expect(result.status).toBe("processed");

    const purchase = await purchaseRow(LIVE.newTransactionId);
    expect(purchase?.status).toBe("ACTIVE");
    expect(purchase?.offerType).toBe(APPLE_OFFER_TYPE.PROMOTIONAL);

    const types = await revenueTypesFor(purchase!.id);
    expect(types).toContain("INITIAL");
    expect(types).not.toContain("REACTIVATION");
  });

  it("records one charge when OFFER_REDEEMED lands FIRST and SUBSCRIBED/RESUBSCRIBE follows", async () => {
    // The reverse ordering of the case above, and the one a per-row gate
    // does NOT catch. `applyOfferRedeemed` classifies on CHAIN STATUS and
    // `applySubscribed` on SUBTYPE, so a chain sitting in BILLING_ISSUE
    // (the expiry-checker has not caught up) yields INITIAL from the
    // redemption and REACTIVATION from the resubscribe — two dedupe kinds,
    // two rows, one charge counted twice.
    const redeemed = await redeem({
      uuidSuffix: "race-offer",
      transactionId: RACE.newTransactionId,
      originalTransactionId: RACE.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: RACE.offerIdentifier,
    });
    expect(redeemed.status).toBe("processed");

    const purchase = await purchaseRow(RACE.newTransactionId);
    // Not EXPIRED, so this one labels the charge INITIAL.
    expect(await revenueTypesFor(purchase!.id)).toEqual(["INITIAL"]);

    // Apple's own SUBSCRIBED for the very same transaction, which would
    // label it REACTIVATION.
    const resubscribed = await redeem({
      uuidSuffix: "race-subscribed",
      transactionId: RACE.newTransactionId,
      originalTransactionId: RACE.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: RACE.offerIdentifier,
      notificationType: APPLE_NOTIFICATION_TYPE.SUBSCRIBED,
      subtype: APPLE_NOTIFICATION_SUBTYPE.RESUBSCRIBE,
    });
    expect(resubscribed.status).toBe("processed");

    const types = await revenueTypesFor(purchase!.id);
    expect(types).toEqual(["INITIAL"]);
    expect(types).not.toContain("REACTIVATION");
  });

  it("a DOWNGRADE redemption announces the change without granting anything", async () => {
    // A downgrade offer takes effect at the NEXT renewal and carries the
    // transaction already in force. Writing ACTIVE for it is not the no-op
    // it looks like when the row is BILLING_ISSUE: the guard would apply
    // the transition and access would be re-granted on an announcement,
    // with no money behind it.
    const before = await purchaseRow(DOWN.oldTransactionId);
    expect(before?.status).toBe("BILLING_ISSUE");

    const result = await redeem({
      uuidSuffix: "downgrade",
      transactionId: DOWN.oldTransactionId,
      originalTransactionId: DOWN.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.SUBSCRIPTION_OFFER_CODE,
      offerIdentifier: DOWN.offerIdentifier,
      subtype: APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE,
      autoRenewProductId: APPLE_PRODUCT_B_ID,
    });
    expect(result.status).toBe("processed");

    const after = await purchaseRow(DOWN.oldTransactionId);
    expect(after?.status).toBe("BILLING_ISSUE");
    // The announcement IS recorded — taking no effect is not the same as
    // ignoring the notification.
    expect(after?.pendingProductId).toBe(PRODUCT_B_ID);
    expect(after?.pendingChangeType).toBe("DOWNGRADE");
    expect(await revenueTypesFor(after!.id)).toEqual([]);
    // And the lifecycle key still reaches consumers.
    expect(await outboxEventTypesFor(DOWN.subscriberId)).toContain(
      OFFER_REDEEMED_KEY,
    );
  });

  it("adds no second revenue row when the same transaction is redeemed again", async () => {
    // A NEW notificationUUID, so the inbound webhook_events dedupe does
    // not absorb this — the suppression under test is the handler's own
    // "we already hold this transaction, its money is already recorded".
    const result = await redeem({
      uuidSuffix: "winback-redelivery",
      transactionId: LAPSED.newTransactionId,
      originalTransactionId: LAPSED.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: LAPSED.offerIdentifier,
    });
    expect(result.status).toBe("processed");

    const purchase = await purchaseRow(LAPSED.newTransactionId);
    const types = await revenueTypesFor(purchase!.id);
    expect(types).toEqual(["REACTIVATION"]);
    // In particular NOT an added INITIAL: by now the chain's newest row is
    // the ACTIVE one this redemption itself created, so a handler reading
    // the chain a second time would classify it INITIAL — and INITIAL and
    // REACTIVATION dedupe under different keys, so both rows would stand.
    expect(types).not.toContain("INITIAL");
  });

  it("a later REFUND_REVERSED still records its compensating REACTIVATION", async () => {
    // The reason the first charge is filed under the CANONICAL "purchase"
    // kind rather than under its own label. `applyRefundReversed` emits a
    // compensating REACTIVATION for a transaction whose first charge is
    // already recorded, and it claims `apple:<txn>:reactivation`. If a
    // win-back's first charge had claimed that key — which it did while
    // the label picked the key — the reversal would collide with the
    // purchase it exists to reverse and be silently dropped.
    const purchase = await purchaseRow(LAPSED.newTransactionId);
    const before = await revenueTypesFor(purchase!.id);
    expect(before).toEqual(["REACTIVATION"]);

    const result = await redeem({
      uuidSuffix: "refund-reversed",
      transactionId: LAPSED.newTransactionId,
      originalTransactionId: LAPSED.originalTransactionId,
      offerType: APPLE_OFFER_TYPE.WIN_BACK,
      offerIdentifier: LAPSED.offerIdentifier,
      notificationType: APPLE_NOTIFICATION_TYPE.REFUND_REVERSED,
    });
    expect(result.status).toBe("processed");

    // Two REACTIVATION rows now: the win-back charge, and the reversal's
    // compensation. Distinct economic events, distinct dedupe keys.
    const after = await revenueTypesFor(purchase!.id);
    expect(after).toHaveLength(2);
    expect(after.every((t) => t === "REACTIVATION")).toBe(true);
  });
});
