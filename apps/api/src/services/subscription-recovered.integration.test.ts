// =============================================================
// subscription.recovered — Apple + Stripe BILLING_ISSUE -> granting
// =============================================================
//
// packages/shared/src/store-event-normalization.ts used to record that
// Stripe (and, by the same logic, Apple) get no `recovered` row: inferring
// one from a renewal event following a payment failure would fire on
// unrelated renewals too, since the event-type table has no way to know
// where the row actually was beforehand.
//
// Two earlier tasks in this plan removed that obstacle: a BILLING_ISSUE
// status now exists for a payment failure the store has stopped covering,
// and `guardStatusWrite` returns a `previous` before-image of the row
// under the same FOR UPDATE lock as the write. `emitSubscriptionRecovered`
// (subscription-plan-change.ts) uses that before-image directly instead of
// guessing from event type: it fires only when the row actually SAT in
// BILLING_ISSUE immediately before this write.
//
// This suite pins both directions for both stores:
//   1. a subscription leaving BILLING_ISSUE emits `subscription.recovered`;
//   2. an ordinary renewal on a subscription that was already ACTIVE does
//      NOT emit it — the exact false positive the original exclusion was
//      written to avoid. Without this second case, a suite that only
//      checks (1) would pass just as well for the wrong implementation
//      (one that fires on every renewal regardless of prior state).
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).
// Apple gets a stub verifier so no crypto / network runs; Stripe's
// customer.subscription.updated path reads only event.data.object, so a
// dummy client satisfies the signature.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
  subscribers,
} from "@rovenue/db";
import { handleAppleNotification } from "./apple/apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple/apple-types";
import type { AppleNotificationVerifier } from "./apple/apple-verify";
import { processStripeEvent } from "./stripe/stripe-webhook";

const RUN_ID = Date.now();
const NOW_MS = Date.now();
const TERM_MS = 30 * 86_400_000;
const TERM_SECONDS = TERM_MS / 1000;

const RECOVERED = "subscription.recovered";

async function recoveredRows(subscriberId: string) {
  return getDb()
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, subscriberId),
        eq(outboxEvents.eventType, RECOVERED),
      ),
    );
}

// =============================================================
// Apple
// =============================================================

describe("handleAppleNotification — subscription.recovered", () => {
  const PROJECT_ID = `prj_recov_ap_${RUN_ID}`;
  const SUBSCRIBER_ID = `sub_recov_ap_${RUN_ID}`;
  const PRODUCT_ID = `prod_recov_ap_${RUN_ID}`;
  const APPLE_PRODUCT_ID = `com.app.recov.${RUN_ID}`;
  const RECOVERING_TXN_ID = `txn_recov_billing_${RUN_ID}`;
  const RECOVERING_OTXN_ID = `otxn_recov_billing_${RUN_ID}`;
  const RENEWING_TXN_ID = `txn_recov_active_${RUN_ID}`;
  const RENEWING_OTXN_ID = `otxn_recov_active_${RUN_ID}`;

  function makeTransaction(
    transactionId: string,
    originalTransactionId: string,
  ): AppleJwsTransactionPayload {
    return {
      transactionId,
      originalTransactionId,
      productId: APPLE_PRODUCT_ID,
      purchaseDate: NOW_MS,
      originalPurchaseDate: NOW_MS,
      expiresDate: NOW_MS + TERM_MS,
      signedDate: NOW_MS,
      price: 9_990_000,
      currency: "USD",
      environment: APPLE_ENVIRONMENT.SANDBOX,
    } as AppleJwsTransactionPayload;
  }

  function makeStubVerifier(args: {
    uuidSuffix: string;
    transactionId: string;
    originalTransactionId: string;
  }): AppleNotificationVerifier {
    const notification = {
      notificationType: APPLE_NOTIFICATION_TYPE.DID_RENEW,
      notificationUUID: `nfn_recov_ap_${RUN_ID}_${args.uuidSuffix}`,
      version: "2.0",
      signedDate: NOW_MS,
      data: {
        environment: APPLE_ENVIRONMENT.SANDBOX,
        signedTransactionInfo: "stub-transaction-jws",
      },
    } as AppleResponseBodyV2DecodedPayload;

    return {
      verifyNotification: vi.fn(async () => notification),
      verifyTransaction: vi.fn(async () =>
        makeTransaction(args.transactionId, args.originalTransactionId),
      ),
      verifyRenewalInfo: vi.fn(async () => ({
        originalTransactionId: args.originalTransactionId,
        productId: APPLE_PRODUCT_ID,
        autoRenewStatus: 1 as const,
        signedDate: NOW_MS,
        environment: APPLE_ENVIRONMENT.SANDBOX,
      })),
    };
  }

  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Recov AP ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_recov_ap_${RUN_ID}`,
      appUserId: `app_user_recov_ap_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: APPLE_PRODUCT_ID,
      type: "SUBSCRIPTION",
      storeIds: { apple: APPLE_PRODUCT_ID },
      displayName: `Recov AP Product ${RUN_ID}`,
      accessIds: [],
    });
    // Row 1: currently in BILLING_ISSUE. The DID_RENEW below is the store
    // finally collecting payment — a genuine recovery.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: RECOVERING_TXN_ID,
      originalTransactionId: RECOVERING_OTXN_ID,
      status: "BILLING_ISSUE",
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
    // Row 2: already ACTIVE. The DID_RENEW below is an ordinary renewal —
    // the false positive the original exclusion was written to avoid.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: RENEWING_TXN_ID,
      originalTransactionId: RENEWING_OTXN_ID,
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

  it("emits subscription.recovered when Apple's DID_RENEW leaves BILLING_ISSUE", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        uuidSuffix: "recover",
        transactionId: RECOVERING_TXN_ID,
        originalTransactionId: RECOVERING_OTXN_ID,
      }),
    });
    expect(result.status).toBe("processed");

    const rows = await recoveredRows(SUBSCRIBER_ID);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.previousStatus).toBe("BILLING_ISSUE");
    expect(payload.status).toBe("ACTIVE");
    expect(payload.subscriberId).toBe(SUBSCRIBER_ID);

    const [row] = await getDb()
      .select({ status: purchases.status })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "APP_STORE"),
          eq(purchases.storeTransactionId, RECOVERING_TXN_ID),
        ),
      );
    expect(row?.status).toBe("ACTIVE");
  });

  it("does not emit subscription.recovered on an ordinary renewal of an already-ACTIVE row", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier({
        uuidSuffix: "renew",
        transactionId: RENEWING_TXN_ID,
        originalTransactionId: RENEWING_OTXN_ID,
      }),
    });
    expect(result.status).toBe("processed");

    // Only the BILLING_ISSUE row's recovery from the previous test — none
    // from this ordinary ACTIVE -> ACTIVE renewal.
    expect(await recoveredRows(SUBSCRIBER_ID)).toHaveLength(1);
  });
});

// =============================================================
// Stripe
// =============================================================

describe("processStripeEvent — subscription.recovered", () => {
  const PROJECT_ID = `prj_recov_st_${RUN_ID}`;
  const APP_USER_ID = `app_user_recov_st_${RUN_ID}`;
  const PRODUCT_ID = `prod_recov_st_${RUN_ID}`;
  const PRICE_ID = `price_recov_st_${RUN_ID}`;
  const RECOVERING_SUB_ID = `sub_stripe_recov_billing_${RUN_ID}`;
  const RENEWING_SUB_ID = `sub_stripe_recov_active_${RUN_ID}`;
  let subscriberId = "";

  function updatedEvent(eventId: string, stripeSubId: string): Stripe.Event {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      id: eventId,
      type: "customer.subscription.updated",
      created: nowSeconds,
      data: {
        object: {
          id: stripeSubId,
          customer: `cus_recov_${RUN_ID}`,
          status: "active",
          start_date: nowSeconds - TERM_SECONDS,
          current_period_end: nowSeconds + TERM_SECONDS,
          cancel_at_period_end: false,
          metadata: { app_user_id: APP_USER_ID },
          items: {
            data: [
              {
                price: { id: PRICE_ID, unit_amount: 4999, currency: "usd" },
              } as never,
            ],
          },
        } as unknown as Stripe.Subscription,
      },
    } as Stripe.Event;
  }

  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Recov ST ${RUN_ID}` });
    const [subscriber] = await db
      .insert(subscribers)
      .values({
        id: `sub_recov_st_${RUN_ID}`,
        projectId: PROJECT_ID,
        rovenueId: APP_USER_ID,
        appUserId: APP_USER_ID,
      })
      .returning({ id: subscribers.id });
    subscriberId = subscriber!.id;

    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: PRICE_ID,
      type: "SUBSCRIPTION",
      storeIds: { stripe: PRICE_ID },
      displayName: `Recov ST Product ${RUN_ID}`,
      accessIds: [],
    });

    // Row 1: currently in BILLING_ISSUE — the update below is Stripe
    // finally collecting payment, a genuine recovery.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId,
      productId: PRODUCT_ID,
      store: "STRIPE",
      storeTransactionId: RECOVERING_SUB_ID,
      originalTransactionId: RECOVERING_SUB_ID,
      status: "BILLING_ISSUE",
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
    // Row 2: already ACTIVE — the update below is an ordinary renewal, the
    // false positive the original exclusion was written to avoid.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId,
      productId: PRODUCT_ID,
      store: "STRIPE",
      storeTransactionId: RENEWING_SUB_ID,
      originalTransactionId: RENEWING_SUB_ID,
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
    await getDb().delete(outboxEvents).where(eq(outboxEvents.aggregateId, subscriberId));
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("emits subscription.recovered when Stripe leaves BILLING_ISSUE", async () => {
    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: updatedEvent(`evt_recov_billing_${RUN_ID}`, RECOVERING_SUB_ID),
      account: {} as never,
    });
    expect(result.status).toBe("processed");

    const rows = await recoveredRows(subscriberId);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.previousStatus).toBe("BILLING_ISSUE");
    expect(payload.status).toBe("ACTIVE");
    expect(payload.subscriberId).toBe(subscriberId);
  });

  it("does not emit recovered on an ordinary renewal of an already-ACTIVE subscription", async () => {
    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: updatedEvent(`evt_recov_active_${RUN_ID}`, RENEWING_SUB_ID),
      account: {} as never,
    });
    expect(result.status).toBe("processed");

    // Only the BILLING_ISSUE row's recovery from the previous test — none
    // from this ordinary ACTIVE -> ACTIVE renewal.
    expect(await recoveredRows(subscriberId)).toHaveLength(1);
  });
});

// =============================================================
// Apple — the recovery that lands on a DIFFERENT transactionId
// =============================================================
//
// The suite above pins the case where the BILLING_ISSUE row and the
// recovering delivery share a transactionId. That is Stripe's shape (one
// stable subscription id), and it is the shape a hand-written fixture
// naturally takes — but it is NOT Apple's. Apple mints a new
// transactionId per billing period, and `applyFailedRenewal` stamps
// BILLING_ISSUE onto the row of the transaction that FAILED. The renewal
// that recovers it therefore arrives on a key with no row at all: the
// guard's before-image is null and, before this fix, `recovered` returned
// early every single time. Half the feature was inert for Apple.
//
// Two things must hold, and both are asserted here:
//   1. the recovering delivery emits `subscription.recovered` exactly once;
//   2. it leaves no stale BILLING_ISSUE row behind — otherwise
//      `runBillingIssueAgeing` retires it 60 days later and emits
//      `subscription.expired` plus a zero-amount CANCELLATION for a
//      subscriber who is actively paying.

describe("handleAppleNotification — recovery across an Apple renewal chain", () => {
  const PROJECT_ID = `prj_recov_ch_${RUN_ID}`;
  const SUBSCRIBER_ID = `sub_recov_ch_${RUN_ID}`;
  const PRODUCT_ID = `prod_recov_ch_${RUN_ID}`;
  const APPLE_PRODUCT_ID = `com.app.recovch.${RUN_ID}`;
  // One chain, two billing periods: the period that failed to renew, and
  // the period whose successful charge recovers it.
  const CHAIN_OTXN_ID = `otxn_recov_ch_${RUN_ID}`;
  const FAILED_TXN_ID = `txn_recov_ch_failed_${RUN_ID}`;
  const RECOVERING_TXN_ID = `txn_recov_ch_renewed_${RUN_ID}`;

  function makeStubVerifier(uuidSuffix: string): AppleNotificationVerifier {
    const notification = {
      notificationType: APPLE_NOTIFICATION_TYPE.DID_RENEW,
      notificationUUID: `nfn_recov_ch_${RUN_ID}_${uuidSuffix}`,
      version: "2.0",
      signedDate: NOW_MS,
      data: {
        environment: APPLE_ENVIRONMENT.SANDBOX,
        signedTransactionInfo: "stub-transaction-jws",
      },
    } as AppleResponseBodyV2DecodedPayload;

    return {
      verifyNotification: vi.fn(async () => notification),
      verifyTransaction: vi.fn(
        async () =>
          ({
            transactionId: RECOVERING_TXN_ID,
            originalTransactionId: CHAIN_OTXN_ID,
            productId: APPLE_PRODUCT_ID,
            purchaseDate: NOW_MS,
            originalPurchaseDate: NOW_MS,
            expiresDate: NOW_MS + TERM_MS,
            signedDate: NOW_MS,
            price: 9_990_000,
            currency: "USD",
            environment: APPLE_ENVIRONMENT.SANDBOX,
          }) as AppleJwsTransactionPayload,
      ),
      verifyRenewalInfo: vi.fn(async () => ({
        originalTransactionId: CHAIN_OTXN_ID,
        productId: APPLE_PRODUCT_ID,
        autoRenewStatus: 1 as const,
        signedDate: NOW_MS,
        environment: APPLE_ENVIRONMENT.SANDBOX,
      })),
    };
  }

  async function statusOfTransaction(
    storeTransactionId: string,
  ): Promise<string | undefined> {
    const [row] = await getDb()
      .select({ status: purchases.status })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "APP_STORE"),
          eq(purchases.storeTransactionId, storeTransactionId),
        ),
      );
    return row?.status;
  }

  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Recov CH ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_recov_ch_${RUN_ID}`,
      appUserId: `app_user_recov_ch_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: APPLE_PRODUCT_ID,
      type: "SUBSCRIPTION",
      storeIds: { apple: APPLE_PRODUCT_ID },
      displayName: `Recov CH Product ${RUN_ID}`,
      accessIds: [],
    });
    // The failed period. Its expiresDate is in the PAST — that is what a
    // billing failure means — which is also why nothing else in the system
    // ever retires it: BILLING_ISSUE is not sweepable.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: FAILED_TXN_ID,
      originalTransactionId: CHAIN_OTXN_ID,
      status: "BILLING_ISSUE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: true,
      environment: "SANDBOX",
      purchaseDate: new Date(NOW_MS - TERM_MS),
      originalPurchaseDate: new Date(NOW_MS - TERM_MS),
      expiresDate: new Date(NOW_MS - 1),
      billingIssueDetectedAt: new Date(NOW_MS - 1),
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

  it("emits recovered once for a renewal on a NEW transactionId, and leaves no BILLING_ISSUE row to age out", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier("renewed"),
    });
    expect(result.status).toBe("processed");

    const rows = await recoveredRows(SUBSCRIBER_ID);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.previousStatus).toBe("BILLING_ISSUE");
    expect(payload.status).toBe("ACTIVE");

    await expect(statusOfTransaction(RECOVERING_TXN_ID)).resolves.toBe(
      "ACTIVE",
    );
    // The whole second half of the bug: without the chain retirement this
    // is still "BILLING_ISSUE", and 60 days later the ageing pass fires a
    // false expiry for a paying subscriber.
    await expect(statusOfTransaction(FAILED_TXN_ID)).resolves.not.toBe(
      "BILLING_ISSUE",
    );
  });

  it("a redelivery of the same renewal emits nothing further", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier("redelivery"),
    });
    expect(result.status).toBe("processed");

    expect(await recoveredRows(SUBSCRIBER_ID)).toHaveLength(1);
  });
});
