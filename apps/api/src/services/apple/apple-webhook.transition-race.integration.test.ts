// =============================================================
// handleAppleNotification — concurrent terminal-resurrection race
// =============================================================
//
// FINDING 1: two DISTINCT notifications for the SAME (store,
// storeTransactionId) — a REFUND and a late DID_RENEW — can arrive as
// separate webhook events (distinct notificationUUIDs), so
// claimWebhookEvent's single-flight does NOT serialize them. Before
// the fix the guard's `FOR UPDATE` read released at statement end and
// the upsert ran as a separate autocommit statement, so under the
// interleaving REFUND-reads-ACTIVE, RENEW-reads-ACTIVE, RENEW-writes,
// REFUND-writes the row could end up RESURRECTED.
//
// This test fires both notifications concurrently (many iterations to
// exercise both orderings) and asserts the terminal REFUNDED status
// ALWAYS wins — no resurrection — and that any rejected RENEW
// transition was audited. The property holds via (a) the guard read +
// write now sharing one transaction so the row lock is held, and (b)
// the SQL-level CASE guard in upsertPurchase as defense in depth.
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433). Seeds project / subscriber / product / ACTIVE purchase and
// injects a stub verifier so no crypto / network runs.

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
const NOW_MS = Date.now();
const PROJECT_ID = `prj_trace_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_trace_${RUN_ID}`;
const PRODUCT_ID = `prod_trace_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.race.${RUN_ID}`;

// Each iteration uses its own (store, storeTransactionId) so the
// orderings are independent and the seeded ACTIVE start state is
// fresh — the race we care about is between the two events that touch
// the SAME transaction within one iteration.
const ITERATIONS = 12;

function txnId(i: number): string {
  return `txn_trace_${RUN_ID}_${i}`;
}
function otxnId(i: number): string {
  return `otxn_trace_${RUN_ID}_${i}`;
}

function makeTransaction(i: number): AppleJwsTransactionPayload {
  return {
    transactionId: txnId(i),
    originalTransactionId: otxnId(i),
    productId: APPLE_PRODUCT_ID,
    purchaseDate: NOW_MS,
    originalPurchaseDate: NOW_MS,
    expiresDate: NOW_MS + 30 * 86_400_000,
    signedDate: NOW_MS,
    price: 9_990_000,
    currency: "USD",
    environment: APPLE_ENVIRONMENT.SANDBOX,
  } as AppleJwsTransactionPayload;
}

function makeNotification(
  i: number,
  notificationType: AppleResponseBodyV2DecodedPayload["notificationType"],
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType,
    // Distinct UUID per (iteration, type) so claimWebhookEvent treats
    // these as two SEPARATE events — the whole point of the test.
    notificationUUID: `nfn_trace_${RUN_ID}_${i}_${notificationType}`,
    version: "2.0",
    signedDate: NOW_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-transaction-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  i: number,
  notificationType: AppleResponseBodyV2DecodedPayload["notificationType"],
): AppleNotificationVerifier {
  const notification = makeNotification(i, notificationType);
  const transaction = makeTransaction(i);
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => transaction),
    verifyRenewalInfo: vi.fn(async () => ({
      originalTransactionId: otxnId(i),
      productId: APPLE_PRODUCT_ID,
      autoRenewStatus: 1 as const,
      signedDate: NOW_MS,
      environment: APPLE_ENVIRONMENT.SANDBOX,
    })),
  };
}

describe("handleAppleNotification — concurrent REFUND vs DID_RENEW race", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `TRace ${RUN_ID}` });
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
      displayName: `TRace Product ${RUN_ID}`,
      accessIds: [],
    });
    // Seed one ACTIVE purchase per iteration — the legal pre-refund
    // state from which BOTH a REFUND (legal) and a DID_RENEW (legal)
    // could individually proceed.
    for (let i = 0; i < ITERATIONS; i++) {
      await db.insert(purchases).values({
        projectId: PROJECT_ID,
        subscriberId: SUBSCRIBER_ID,
        productId: PRODUCT_ID,
        store: "APP_STORE",
        storeTransactionId: txnId(i),
        originalTransactionId: otxnId(i),
        status: "ACTIVE",
        isTrial: false,
        isIntroOffer: false,
        isSandbox: true,
        environment: "SANDBOX",
        purchaseDate: new Date(),
        originalPurchaseDate: new Date(),
        expiresDate: new Date(Date.now() + 30 * 86400_000),
        priceAmount: "9.99",
        priceCurrency: "USD",
        autoRenewStatus: true,
      });
    }
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("never resurrects a REFUNDED row when a REFUND and a DID_RENEW race", async () => {
    const db = getDb();

    // Fire both events for each iteration concurrently. Alternate which
    // event is dispatched first per iteration so both interleavings are
    // exercised; the concurrency makes the actual DB-level ordering
    // non-deterministic regardless.
    await Promise.all(
      Array.from({ length: ITERATIONS }, (_, i) => {
        const refund = handleAppleNotification({
          projectId: PROJECT_ID,
          signedPayload: "signed-envelope-stub",
          verifier: makeStubVerifier(i, APPLE_NOTIFICATION_TYPE.REFUND),
        });
        const renew = handleAppleNotification({
          projectId: PROJECT_ID,
          signedPayload: "signed-envelope-stub",
          verifier: makeStubVerifier(i, APPLE_NOTIFICATION_TYPE.DID_RENEW),
        });
        return i % 2 === 0 ? [refund, renew] : [renew, refund];
      }).flat(),
    );

    // Every transaction must end REFUNDED — the terminal state wins,
    // no matter which event committed last.
    for (let i = 0; i < ITERATIONS; i++) {
      const [row] = await db
        .select({ status: purchases.status })
        .from(purchases)
        .where(
          and(
            eq(purchases.store, "APP_STORE"),
            eq(purchases.storeTransactionId, txnId(i)),
          ),
        );
      expect(row?.status, `txn ${i} must be REFUNDED, not resurrected`).toBe(
        "REFUNDED",
      );
    }

    // When DID_RENEW lost the race (read REFUNDED first / was rejected
    // by the state machine) it must have left a tamper-evident audit
    // row. With ACTIVE -> REFUNDED legal and ACTIVE -> ACTIVE legal,
    // the rejection only fires when RENEW observed the terminal row, so
    // we assert at least one rejection was recorded across the batch
    // (the resurrection-prevention property is the hard assertion
    // above; this confirms rejections are audited when they occur).
    const rejections = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, PROJECT_ID),
          eq(auditLogs.action, "subscription.transition_rejected"),
        ),
      );
    expect(rejections.length).toBeGreaterThanOrEqual(1);
  });
});
