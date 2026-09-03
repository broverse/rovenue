// =============================================================
// runExpiryCheck — SUBSCRIPTION outbox bridge (Task 6, real Postgres)
// =============================================================
//
// expiry-checker.ts previously had no real-Postgres integration test
// (tests/expiry-checker.test.ts is a fully mocked unit test — no real
// DB round trip, so it cannot assert an outbox_events row exists).
// This file follows the inline-seed convention documented in
// scheduled-actions.integration.test.ts: no withTestDb/seedProject
// helpers exist in this codebase, so tests use getDb() directly and
// insert rows keyed by a unique RUN_ID.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  access,
  getDb,
  outboxEvents,
  projects,
  subscribers,
  products,
  purchases,
} from "@rovenue/db";
import {
  BILLING_ISSUE_MAX_AGE_DAYS,
  runBillingIssueAgeing,
  runExpiryCheck,
} from "./expiry-checker";

const RUN_ID = Date.now();

async function seedProject(suffix: string, webhookUrl: string | null = null) {
  const db = getDb();
  const id = `prj_exp_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Expiry Test Project ${RUN_ID}${suffix}`,
    webhookUrl,
  });
  return { id };
}

async function seedSubscriber(projectId: string, suffix: string) {
  const db = getDb();
  const id = `sub_exp_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_user_exp_${RUN_ID}${suffix}`,
    appUserId: `app_user_exp_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct(projectId: string, suffix: string) {
  const db = getDb();
  const id = `prod_exp_${RUN_ID}${suffix}`;
  const accessId = `acsexp${String(RUN_ID).padStart(10, "0").slice(-10)}${suffix.padEnd(2, "x").slice(0, 2)}`
    .padEnd(24, "0")
    .slice(0, 24);
  await db.insert(access).values({
    id: accessId,
    projectId,
    identifier: `pro_exp_${RUN_ID}${suffix}`,
    displayName: `Pro Expiry ${RUN_ID}${suffix}`,
  });
  await db.insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.test.exp_product_${RUN_ID}${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Expiry Test Product ${RUN_ID}${suffix}`,
    accessIds: [accessId],
  });
  return { id, accessId };
}

async function seedOverduePurchase({
  projectId,
  suffix,
  store = "APP_STORE" as "APP_STORE" | "PLAY_STORE",
}: {
  projectId: string;
  suffix: string;
  store?: "APP_STORE" | "PLAY_STORE";
}) {
  const db = getDb();
  const subscriber = await seedSubscriber(projectId, suffix);
  const product = await seedProduct(projectId, suffix);
  const synth = `comp_exp_${RUN_ID}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const pastExpiry = new Date(Date.now() - 10 * 60 * 1000);

  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId,
      subscriberId: subscriber.id,
      productId: product.id,
      store,
      storeTransactionId: synth,
      originalTransactionId: synth,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: pastExpiry,
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: false,
    })
    .returning();
  if (!purchase) throw new Error("seedOverduePurchase: no row returned");

  return { purchase, subscriber };
}

// Generalized seeder used by the BILLING_ISSUE ageing tests below —
// unlike seedOverduePurchase (which seeds INTO an already-created
// project), this creates its own project/subscriber/product per call
// so each seeded purchase is fully isolated, and accepts the fields
// those tests need to control (status, billingIssueDetectedAt,
// expiresDate). Returns just the purchase id, matching how the ageing
// tests use it.
async function seedPurchase({
  suffix,
  status,
  store = "APP_STORE" as "APP_STORE" | "PLAY_STORE",
  expiresDate = new Date(Date.now() - 10 * 60 * 1000),
  billingIssueDetectedAt = null,
}: {
  suffix: string;
  status: "BILLING_ISSUE" | "ACTIVE" | "EXPIRED";
  store?: "APP_STORE" | "PLAY_STORE";
  expiresDate?: Date | null;
  billingIssueDetectedAt?: Date | null;
}): Promise<string> {
  const db = getDb();
  const project = await seedProject(suffix);
  const subscriber = await seedSubscriber(project.id, suffix);
  const product = await seedProduct(project.id, suffix);
  const synth = `comp_exp_${RUN_ID}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;

  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId: project.id,
      subscriberId: subscriber.id,
      productId: product.id,
      store,
      storeTransactionId: synth,
      originalTransactionId: synth,
      status,
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate,
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: false,
      billingIssueDetectedAt,
    })
    .returning();
  if (!purchase) throw new Error("seedPurchase: no row returned");
  return purchase.id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ status: purchases.status })
    .from(purchases)
    .where(eq(purchases.id, id));
  return row?.status;
}

afterAll(async () => {
  const db = getDb();
  for (const suffix of ["E1", "E2", "AF", "AS", "AN"]) {
    const projectId = `prj_exp_${RUN_ID}${suffix}`;
    await db.delete(outboxEvents).where(
      inArray(
        outboxEvents.aggregateId,
        db
          .select({ id: subscribers.id })
          .from(subscribers)
          .where(eq(subscribers.projectId, projectId)),
      ),
    );
    await db.delete(projects).where(eq(projects.id, projectId));
  }
});

describe("runExpiryCheck — SUBSCRIPTION outbox bridge", () => {
  it("Case 1: ACTIVE purchase lapses → outbox row bridged onto SUBSCRIPTION with subscription.expired, even without a webhookUrl", async () => {
    const db = getDb();
    const project = await seedProject("E1", null);
    const { purchase, subscriber } = await seedOverduePurchase({
      projectId: project.id,
      suffix: "E1",
      store: "APP_STORE",
    });

    // The sweep is global (no project scoping) and shares a DB with other
    // integration tests, so other overdue rows may also be swept in the
    // same run — assert our own row transitioned rather than the total count.
    const result = await runExpiryCheck(new Date());
    expect(result.expired).toBeGreaterThanOrEqual(1);

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
    const row = outboxRows[0]!;
    expect(row.aggregateType).toBe("SUBSCRIPTION");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.projectId).toBe(project.id);
    expect(payload.subscriberId).toBe(subscriber.id);
    expect(payload.purchaseId).toBe(purchase.id);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("Case 2: ACTIVE purchase lapses with a webhookUrl configured → outbox row still bridged", async () => {
    const db = getDb();
    const project = await seedProject("E2", "https://hook.example.com/e2");
    const { subscriber } = await seedOverduePurchase({
      projectId: project.id,
      suffix: "E2",
      store: "PLAY_STORE",
    });

    // The sweep is global (no project scoping) and shares a DB with other
    // integration tests, so other overdue rows may also be swept in the
    // same run — assert our own row transitioned rather than the total count.
    const result = await runExpiryCheck(new Date());
    expect(result.expired).toBeGreaterThanOrEqual(1);

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
  });
});

describe("runBillingIssueAgeing — bounded exit from BILLING_ISSUE", () => {
  it("retires a BILLING_ISSUE purchase only after the max-age window", async () => {
    const now = new Date("2026-09-03T00:00:00Z");
    const fresh = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const stale = new Date(
      now.getTime() - (BILLING_ISSUE_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
    );

    const freshId = await seedPurchase({
      suffix: "AF",
      status: "BILLING_ISSUE",
      billingIssueDetectedAt: fresh,
    });
    const staleId = await seedPurchase({
      suffix: "AS",
      status: "BILLING_ISSUE",
      billingIssueDetectedAt: stale,
    });

    // The pass is global (no project scoping) and shares a DB with other
    // integration tests, so other aged rows may also be retired in the
    // same run — assert our own rows individually rather than the total
    // count (see the same convention in Case 1/2 above).
    const result = await runBillingIssueAgeing(now);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    await expect(statusOf(freshId)).resolves.toBe("BILLING_ISSUE");
    await expect(statusOf(staleId)).resolves.toBe("EXPIRED");
  });

  it("does not let the ordinary expiry sweep touch BILLING_ISSUE rows", async () => {
    const id = await seedPurchase({
      suffix: "AN",
      status: "BILLING_ISSUE",
      billingIssueDetectedAt: new Date("2026-08-01T00:00:00Z"),
      expiresDate: new Date("2026-08-01T00:00:00Z"),
    });
    await runExpiryCheck(new Date("2026-09-03T00:00:00Z"));
    await expect(statusOf(id)).resolves.toBe("BILLING_ISSUE");
  });
});
