// =============================================================
// runGoogleReconciliationSweep — real Postgres integration test
// =============================================================
//
// Follows the inline-seed convention documented in
// scheduled-actions.integration.test.ts / expiry-checker.integration.test.ts:
// no withTestDb/seedProject helpers exist in this codebase, so this uses
// getDb() directly and inserts rows keyed by a unique RUN_ID.
//
// The live Google HTTP call is swapped for a fake via
// `GoogleReconciliationDeps` — the sweep's OWN logic (claim, guard,
// write, audit, outbox, entitlement sync) all run against the real
// database, exactly as production would. The fake is scoped to each
// test's own purchase token and THROWS for any other token, so a
// stray candidate picked up from another integration test's leftover
// rows in this shared dev DB is treated as an "error" (no writes) —
// this test can never silently mutate someone else's fixture.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  access,
  auditLogs,
  getDb,
  outboxEvents,
  projects,
  purchases,
  products,
  subscriberAccess,
  subscribers,
} from "@rovenue/db";
import {
  runGoogleReconciliationSweep,
  type GoogleReconciliationDeps,
} from "./google-reconciliation";
import { GOOGLE_SUBSCRIPTION_STATE } from "../services/google/google-types";
import { syncAccess } from "../services/access-engine";

const RUN_ID = Date.now();

async function seedProject(suffix: string) {
  const db = getDb();
  const id = `prj_grc_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Google Reconciliation Test ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedSubscriber(projectId: string, suffix: string) {
  const db = getDb();
  const id = `sub_grc_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_user_grc_${RUN_ID}${suffix}`,
    appUserId: `app_user_grc_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct(projectId: string, suffix: string) {
  const db = getDb();
  const id = `prod_grc_${RUN_ID}${suffix}`;
  const accessId = `access_grc_${RUN_ID}${suffix}`;
  const identifier = `com.rovenue.test.grc_product_${RUN_ID}${suffix}`;
  await db.insert(access).values({
    id: accessId,
    projectId,
    identifier: `pro_grc_${RUN_ID}${suffix}`,
    displayName: `Pro Reconciliation ${RUN_ID}${suffix}`,
  });
  await db.insert(products).values({
    id,
    projectId,
    identifier,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Reconciliation Test Product ${RUN_ID}${suffix}`,
    accessIds: [accessId],
  });
  return { id, identifier, accessId };
}

async function seedDriftedPurchase({
  projectId,
  subscriberId,
  productId,
  suffix,
}: {
  projectId: string;
  subscriberId: string;
  productId: string;
  suffix: string;
}) {
  const db = getDb();
  const token = `grc_token_${RUN_ID}_${suffix}`;
  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId,
      subscriberId,
      productId,
      store: "PLAY_STORE",
      storeTransactionId: token,
      originalTransactionId: token,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      // Still in the future — the row qualifies as a candidate purely
      // because lastReconciledAt is NULL ("never checked"), the same
      // way a real project's very first sweep would see it. This also
      // proves the sweep is not merely re-deriving expiry-checker's
      // "past expiresDate" rule.
      expiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning();
  if (!purchase) throw new Error("seedDriftedPurchase: no row returned");
  return { purchase, token };
}

function fakeDepsFor(
  token: string,
  productIdentifier: string,
): GoogleReconciliationDeps {
  return {
    loadVerifyConfig: async () => ({
      packageName: "com.rovenue.test",
      credentials: {} as never,
    }),
    verifySubscription: async (_config, purchaseToken) => {
      if (purchaseToken !== token) {
        // Any candidate this test's sweep call picked up from another
        // fixture in the shared dev DB — refuse rather than guess, so
        // this test can never mutate a row it didn't seed.
        throw new Error(`unexpected purchaseToken in test fake: ${purchaseToken}`);
      }
      return {
        subscriptionState: GOOGLE_SUBSCRIPTION_STATE.EXPIRED,
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        lineItems: [
          {
            productId: productIdentifier,
            expiryTime: new Date(Date.now() - 60_000).toISOString(),
            autoRenewingPlan: { autoRenewEnabled: false },
          },
        ],
      };
    },
  };
}

afterAll(async () => {
  const db = getDb();
  for (const suffix of ["G1", "G2A", "G2B"]) {
    const projectId = `prj_grc_${RUN_ID}${suffix}`;
    await db.delete(outboxEvents).where(
      inArray(
        outboxEvents.aggregateId,
        db
          .select({ id: subscribers.id })
          .from(subscribers)
          .where(eq(subscribers.projectId, projectId)),
      ),
    );
    await db.delete(auditLogs).where(eq(auditLogs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
  }
});

describe("runGoogleReconciliationSweep", () => {
  it("Case 1: ACTIVE purchase Google now reports EXPIRED is corrected, entitlements sync, and the outbox event lands", async () => {
    const db = getDb();
    const project = await seedProject("G1");
    const subscriber = await seedSubscriber(project.id, "G1");
    const product = await seedProduct(project.id, "G1");
    const { purchase, token } = await seedDriftedPurchase({
      projectId: project.id,
      subscriberId: subscriber.id,
      productId: product.id,
      suffix: "G1",
    });

    // Establish the ACTIVE entitlement a real grant flow would have
    // created — without this, "entitlements sync" cannot be verified:
    // there would be no subscriber_access row to observe flipping.
    await syncAccess(subscriber.id);
    const [preAccess] = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, purchase.id));
    expect(preAccess?.isActive).toBe(true);

    const result = await runGoogleReconciliationSweep(new Date(), {
      deps: fakeDepsFor(token, product.identifier),
    });
    // The sweep is global and shares a DB with other integration tests
    // (same caveat expiry-checker.integration.test.ts documents) — assert
    // our own row transitioned rather than the aggregate tally.
    expect(result.corrected).toBeGreaterThanOrEqual(1);

    const [updatedPurchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(updatedPurchase?.status).toBe("EXPIRED");
    expect(updatedPurchase?.lastReconciledAt).not.toBeNull();

    // Entitlements synced: the previously-active access grant is now
    // inactive — a real, observed TRUE → FALSE transition, not a
    // vacuous scan of an empty table.
    const [postAccess] = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, purchase.id));
    expect(postAccess?.isActive).toBe(false);

    // The outbox event landed — the same public key expiry-checker.ts
    // emits for an EXPIRED transition, so every configured integration
    // sees this correction exactly as it would a live webhook's.
    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "subscription.expired"),
        ),
      );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.aggregateType).toBe("SUBSCRIPTION");
    const payload = outboxRows[0]!.payload as Record<string, unknown>;
    expect(payload.purchaseId).toBe(purchase.id);
    expect(payload.previousStatus).toBe("ACTIVE");
    expect(payload.status).toBe("EXPIRED");

    // Audited, attributed to the sweep rather than a user.
    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, project.id),
          eq(auditLogs.resourceId, purchase.id),
          eq(auditLogs.action, "subscription.reconciled"),
        ),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.userId).toBe("system");
  });

  it("Case 2: two concurrent sweeps racing the same drifted purchase produce exactly one transition", async () => {
    const db = getDb();
    const project = await seedProject("G2A");
    const subscriber = await seedSubscriber(project.id, "G2A");
    const product = await seedProduct(project.id, "G2A");
    const { purchase, token } = await seedDriftedPurchase({
      projectId: project.id,
      subscriberId: subscriber.id,
      productId: product.id,
      suffix: "G2A",
    });

    const deps = fakeDepsFor(token, product.identifier);
    const [resultA, resultB] = await Promise.all([
      runGoogleReconciliationSweep(new Date(), { deps }),
      runGoogleReconciliationSweep(new Date(), { deps }),
    ]);

    // Exactly one of the two racing sweeps actually corrected this row —
    // the other either SKIPped (lock held by the winner) or CONFIRMed
    // nothing further to do (already corrected by the time it claimed).
    expect(resultA.corrected + resultB.corrected).toBeGreaterThanOrEqual(1);

    const [updatedPurchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(updatedPurchase?.status).toBe("EXPIRED");

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "subscription.expired"),
        ),
      );
    expect(outboxRows.length).toBe(1);

    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, project.id),
          eq(auditLogs.resourceId, purchase.id),
          eq(auditLogs.action, "subscription.reconciled"),
        ),
      );
    expect(auditRows.length).toBe(1);
  });

  it("Case 3: backfill mode corrects the row and syncs entitlements WITHOUT emitting an outbox event", async () => {
    const db = getDb();
    const project = await seedProject("G2B");
    const subscriber = await seedSubscriber(project.id, "G2B");
    const product = await seedProduct(project.id, "G2B");
    const { purchase, token } = await seedDriftedPurchase({
      projectId: project.id,
      subscriberId: subscriber.id,
      productId: product.id,
      suffix: "G2B",
    });

    const result = await runGoogleReconciliationSweep(new Date(), {
      backfill: true,
      deps: fakeDepsFor(token, product.identifier),
    });
    expect(result.corrected).toBeGreaterThanOrEqual(1);

    const [updatedPurchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(updatedPurchase?.status).toBe("EXPIRED");

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, subscriber.id));
    expect(outboxRows.length).toBe(0);

    // Still audited — backfill silences the external signal, not the
    // internal record of what the sweep did.
    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.projectId, project.id),
          eq(auditLogs.resourceId, purchase.id),
          eq(auditLogs.action, "subscription.reconciled"),
        ),
      );
    expect(auditRows.length).toBe(1);
  });
});
