// =============================================================
// scheduleAction service — integration tests (TDD step 1 — FAILING)
//
// These tests exercise the not-yet-implemented scheduleAction(),
// listScheduledForProject(), and cancelScheduledAction() services
// in ./schedule.ts. They should fail with "Cannot find module
// './schedule'" until Task 10 lands.
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
  scheduledSubscriptionActions,
} from "@rovenue/db";
import {
  scheduleAction,
  listScheduledForProject,
  cancelScheduledAction,
} from "./schedule";

// ---------------------------------------------------------------------------
// Inline seed helpers — same shape as in grant.integration.test.ts
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_sched_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Schedule Test Project ${RUN_ID}${suffix}`,
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
  const id = `sub_sched_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    appUserId: `app_user_sched_${RUN_ID}${suffix}`,
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
  const id = `prod_sched_${RUN_ID}${suffix}`;
  await db.insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.test.sched_product_${RUN_ID}${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Schedule Test Product ${RUN_ID}${suffix}`,
    accessIds: [],
  });
  return { id };
}

async function seedManualPurchase({
  projectId,
  suffix = "",
  status = "ACTIVE" as "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED",
  expiresDate,
}: {
  projectId: string;
  suffix?: string;
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED";
  expiresDate?: Date;
}) {
  const subscriber = await seedSubscriber({ projectId, suffix });
  const product = await seedProduct({ projectId, suffix });
  const synth = `comp_${RUN_ID}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const [purchase] = await getDb()
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
      expiresDate: expiresDate ?? new Date(Date.now() + 30 * 86400_000),
      priceAmount: "0",
      priceCurrency: "USD",
      autoRenewStatus: false,
    })
    .returning();
  if (!purchase) throw new Error("seedManualPurchase: no row returned");
  return purchase;
}

// ---------------------------------------------------------------------------
// Cleanup — remove all rows inserted by this test run
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  for (const suffix of ["S1", "S2", "S3", "S4", "S5"]) {
    await db
      .delete(projects)
      .where(eq(projects.id, `prj_sched_${RUN_ID}${suffix}`));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduleAction", () => {
  it("inserts a PENDING row", async () => {
    const project = await seedProject("S1");
    const purchase = await seedManualPurchase({
      projectId: project.id,
      suffix: "S1",
    });
    const row = await scheduleAction({
      projectId: project.id,
      actorUserId: "user-1",
      purchaseId: purchase.id,
      input: {
        action: "CANCEL",
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        revokeImmediately: false,
      },
    });
    expect(row.status).toBe("PENDING");
  });

  it("rejects dueAt within 60s skew window", async () => {
    const project = await seedProject("S2");
    const purchase = await seedManualPurchase({
      projectId: project.id,
      suffix: "S2",
    });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "user-1",
        purchaseId: purchase.id,
        input: {
          action: "CANCEL",
          dueAt: new Date(Date.now() + 30_000).toISOString(),
          revokeImmediately: false,
        },
      }),
    ).rejects.toThrow(/future/i);
  });

  it("rejects duplicate PENDING for same purchase", async () => {
    const project = await seedProject("S3");
    const purchase = await seedManualPurchase({
      projectId: project.id,
      suffix: "S3",
    });
    const dueAt = new Date(Date.now() + 3600_000).toISOString();
    await scheduleAction({
      projectId: project.id,
      actorUserId: "user-1",
      purchaseId: purchase.id,
      input: { action: "CANCEL", dueAt, revokeImmediately: false },
    });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "user-1",
        purchaseId: purchase.id,
        input: { action: "CANCEL", dueAt, revokeImmediately: false },
      }),
    ).rejects.toThrow(/already|pending|exists/i);
  });

  it("rejects scheduling on a terminal-status purchase", async () => {
    const project = await seedProject("S4");
    const purchase = await seedManualPurchase({
      projectId: project.id,
      suffix: "S4",
      status: "EXPIRED",
    });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "user-1",
        purchaseId: purchase.id,
        input: {
          action: "CANCEL",
          dueAt: new Date(Date.now() + 3600_000).toISOString(),
          revokeImmediately: false,
        },
      }),
    ).rejects.toThrow(/terminal|expired|status/i);
  });

  it("cancelScheduledAction marks PENDING → CANCELED", async () => {
    const project = await seedProject("S5");
    const purchase = await seedManualPurchase({
      projectId: project.id,
      suffix: "S5",
    });
    const row = await scheduleAction({
      projectId: project.id,
      actorUserId: "user-1",
      purchaseId: purchase.id,
      input: {
        action: "CANCEL",
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        revokeImmediately: false,
      },
    });
    const cancelled = await cancelScheduledAction({
      projectId: project.id,
      actorUserId: "user-1",
      id: row.id,
    });
    expect(cancelled.status).toBe("CANCELED");
  });
});
