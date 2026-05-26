// =============================================================
// runScheduledActionsSweep — integration tests (TDD step 1 — FAILING)
//
// These tests exercise the not-yet-implemented runScheduledActionsSweep()
// function in ./scheduled-actions. They should fail with
// "Cannot find module './scheduled-actions'" until Task 13 lands.
//
// Infrastructure notes:
//   - No withTestDb / seedProject helpers exist in this codebase.
//     Integration tests use getDb() directly and insert rows inline.
//   - Tests run against the dev Postgres (docker-compose host port 5433)
//     configured in apps/api/tests/setup.ts.
//   - Each test inserts isolated rows keyed by a unique RUN_ID so
//     parallel test runs and re-runs against the dev DB don't collide.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  products,
  purchases,
  subscriberAccess,
  scheduledSubscriptionActions,
} from "@rovenue/db";
import { runScheduledActionsSweep } from "./scheduled-actions";

// ---------------------------------------------------------------------------
// Inline seed helpers — adapted from schedule.integration.test.ts
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_swp_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Sweep Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedSubscriber({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `sub_swp_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    appUserId: `app_user_swp_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `prod_swp_${RUN_ID}${suffix}`;
  await db.insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.test.swp_product_${RUN_ID}${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Sweep Test Product ${RUN_ID}${suffix}`,
    entitlementKeys: [`pro_swp_${RUN_ID}${suffix}`],
  });
  return { id, entitlementKey: `pro_swp_${RUN_ID}${suffix}` };
}

async function seedManualPurchase({
  projectId,
  suffix = "",
  status = "ACTIVE" as "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED",
  expiresDate,
  withAccess = false,
}: {
  projectId: string;
  suffix?: string;
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED";
  expiresDate?: Date;
  withAccess?: boolean;
}) {
  const db = getDb();
  const subscriber = await seedSubscriber({ projectId, suffix });
  const product = await seedProduct({ projectId, suffix });
  const synth = `comp_swp_${RUN_ID}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const futureDate = expiresDate ?? new Date(Date.now() + 30 * 86400_000);

  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId,
      subscriberId: subscriber.id,
      productId: product.id,
      store: "MANUAL",
      storeTransactionId: synth,
      originalTransactionId: synth,
      status,
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: futureDate,
      priceAmount: "0",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning();
  if (!purchase) throw new Error("seedManualPurchase: no row returned");

  if (withAccess) {
    await db.insert(subscriberAccess).values({
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      entitlementKey: product.entitlementKey,
      isActive: true,
      expiresDate: futureDate,
      store: "MANUAL",
    });
  }

  return { purchase, product, subscriber };
}

// ---------------------------------------------------------------------------
// Cleanup — remove all rows inserted by this test run (cascade handles the rest)
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  for (const suffix of ["C1", "C2", "C3"]) {
    await db
      .delete(projects)
      .where(eq(projects.id, `prj_swp_${RUN_ID}${suffix}`));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScheduledActionsSweep", () => {
  it("Case 1: MANUAL + revokeImmediately=true → purchase EXPIRED + access deactivated", async () => {
    const db = getDb();
    const project = await seedProject("C1");
    const { purchase, subscriber } = await seedManualPurchase({
      projectId: project.id,
      suffix: "C1",
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      withAccess: true,
    });

    const [action] = await db
      .insert(scheduledSubscriptionActions)
      .values({
        projectId: project.id,
        purchaseId: purchase.id,
        subscriberId: subscriber.id,
        action: "CANCEL",
        dueAt: new Date(Date.now() - 1_000), // 1 second ago — due
        status: "PENDING",
        payload: { revokeImmediately: true },
        createdBy: "user-1",
      })
      .returning();
    if (!action) throw new Error("action insert failed");

    const result = await runScheduledActionsSweep();

    expect(result.executed).toBe(1);

    const [updatedPurchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(updatedPurchase?.status).toBe("EXPIRED");

    const accessRows = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, purchase.id));
    expect(accessRows.length).toBeGreaterThan(0);
    expect(accessRows.every((a) => a.isActive === false)).toBe(true);

    const [updatedAction] = await db
      .select()
      .from(scheduledSubscriptionActions)
      .where(eq(scheduledSubscriptionActions.id, action.id));
    expect(updatedAction?.status).toBe("EXECUTED");
  });

  it("Case 2: MANUAL + revokeImmediately=false → keep dates, flip autoRenewStatus=false", async () => {
    const db = getDb();
    const project = await seedProject("C2");
    const futureDate = new Date(Date.now() + 30 * 86400_000);
    const { purchase, subscriber } = await seedManualPurchase({
      projectId: project.id,
      suffix: "C2",
      expiresDate: futureDate,
    });

    const [action] = await db
      .insert(scheduledSubscriptionActions)
      .values({
        projectId: project.id,
        purchaseId: purchase.id,
        subscriberId: subscriber.id,
        action: "CANCEL",
        dueAt: new Date(Date.now() - 1_000), // 1 second ago — due
        status: "PENDING",
        payload: { revokeImmediately: false },
        createdBy: "user-1",
      })
      .returning();
    if (!action) throw new Error("action insert failed");

    const result = await runScheduledActionsSweep();

    expect(result.executed).toBe(1);

    const [updatedPurchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(updatedPurchase?.status).toBe("ACTIVE");
    expect(updatedPurchase?.autoRenewStatus).toBe(false);
    // expiresDate should be unchanged (within a few ms tolerance)
    expect(updatedPurchase?.expiresDate?.getTime()).toBeCloseTo(
      futureDate.getTime(),
      -3, // within 1 second
    );

    const [updatedAction] = await db
      .select()
      .from(scheduledSubscriptionActions)
      .where(eq(scheduledSubscriptionActions.id, action.id));
    expect(updatedAction?.status).toBe("EXECUTED");
  });

  it("Case 3: future dueAt → no-op, action stays PENDING", async () => {
    const db = getDb();
    const project = await seedProject("C3");
    const { purchase, subscriber } = await seedManualPurchase({
      projectId: project.id,
      suffix: "C3",
    });

    const [action] = await db
      .insert(scheduledSubscriptionActions)
      .values({
        projectId: project.id,
        purchaseId: purchase.id,
        subscriberId: subscriber.id,
        action: "CANCEL",
        dueAt: new Date(Date.now() + 3_600_000), // 1 hour in the future
        status: "PENDING",
        payload: { revokeImmediately: false },
        createdBy: "user-1",
      })
      .returning();
    if (!action) throw new Error("action insert failed");

    const result = await runScheduledActionsSweep();

    expect(result.executed).toBe(0);

    const [updatedAction] = await db
      .select()
      .from(scheduledSubscriptionActions)
      .where(eq(scheduledSubscriptionActions.id, action.id));
    expect(updatedAction?.status).toBe("PENDING");
  });
});
