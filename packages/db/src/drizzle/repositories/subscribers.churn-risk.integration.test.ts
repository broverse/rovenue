// =============================================================
// listSubscribers — churn-risk score integration test
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Validates the two new EXISTS signal subqueries (grace period /
// auto-renew-off) feed `churnRiskScore` correctly end-to-end. The
// pure scoring logic itself is unit-tested in churn-risk.test.ts.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { access, products, projects, purchases, subscriberAccess, subscribers } from "../schema";
import { listSubscribers } from "./subscribers";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_churn_${RUN_ID}`;
const PRODUCT_ID = `prod_churn_${RUN_ID}`;
const ACCESS = "premium";
const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const PAST = new Date(Date.now() - 30 * 86_400_000);

type Case = {
  key: string;
  status: "ACTIVE" | "EXPIRED" | "GRACE_PERIOD";
  autoRenew: boolean | null;
  grace: Date | null;
  expires: Date | null;
  activeAccess: boolean;
  expected: number;
};

// All subscribers are recently-active (default lastSeenAt = now), so the
// inactivity component is 0 and `expected` reflects subscription health only.
const CASES: Case[] = [
  { key: "healthy", status: "ACTIVE", autoRenew: true, grace: null, expires: FUTURE, activeAccess: true, expected: 0 },
  { key: "churned", status: "EXPIRED", autoRenew: false, grace: null, expires: PAST, activeAccess: false, expected: 55 },
  { key: "grace", status: "GRACE_PERIOD", autoRenew: true, grace: FUTURE, expires: FUTURE, activeAccess: true, expected: 45 },
  { key: "cancel", status: "ACTIVE", autoRenew: false, grace: null, expires: FUTURE, activeAccess: true, expected: 35 },
];

describe("listSubscribers — churn-risk score", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Churn ${RUN_ID}` });
    await db.insert(access).values({
      id: ACCESS,
      projectId: PROJECT_ID,
      identifier: "premium",
      displayName: "Premium",
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: "premium_monthly",
      type: "SUBSCRIPTION",
      storeIds: {},
      displayName: "Premium",
      accessIds: [ACCESS],
    });

    for (const c of CASES) {
      const [sub] = await db
        .insert(subscribers)
        .values({ projectId: PROJECT_ID, rovenueId: `r-${c.key}-${RUN_ID}`, appUserId: c.key })
        .returning();
      const [pur] = await db
        .insert(purchases)
        .values({
          projectId: PROJECT_ID,
          subscriberId: sub!.id,
          productId: PRODUCT_ID,
          store: "STRIPE",
          storeTransactionId: `tx-${c.key}-${RUN_ID}`,
          originalTransactionId: `tx-${c.key}-${RUN_ID}`,
          status: c.status,
          purchaseDate: PAST,
          originalPurchaseDate: PAST,
          expiresDate: c.expires,
          priceAmount: "9.99",
          priceCurrency: "USD",
          environment: "PRODUCTION",
          autoRenewStatus: c.autoRenew,
          gracePeriodExpires: c.grace,
        })
        .returning();
      if (c.activeAccess) {
        await db.insert(subscriberAccess).values({
          subscriberId: sub!.id,
          purchaseId: pur!.id,
          accessId: ACCESS,
          store: "STRIPE",
          isActive: true,
        });
      }
    }

    // A never-purchased free user — must score 0.
    await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: `r-free-${RUN_ID}`, appUserId: "free" });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(purchases).where(eq(purchases.projectId, PROJECT_ID));
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(products).where(eq(products.projectId, PROJECT_ID));
    await db.delete(access).where(eq(access.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("scores each subscription-health signal correctly from real rows", async () => {
    const db = getDb();
    const rows = await listSubscribers(db, { projectId: PROJECT_ID, limit: 50 });
    const byKey = new Map(rows.map((r) => [r.appUserId, r]));

    for (const c of CASES) {
      expect(byKey.get(c.key)?.churnRisk, `churnRisk for "${c.key}"`).toBe(c.expected);
    }
    expect(byKey.get("free")?.churnRisk, "free user").toBe(0);

    // Correlation guard: these fields are produced by correlated subqueries
    // that previously mis-bound the outer subscriber id. Lock them in.
    expect(byKey.get("healthy")?.activeAccessIds, "healthy active access").toContain(ACCESS);
    expect(byKey.get("churned")?.purchaseCount, "churned purchase count").toBe(1);
    expect(Number(byKey.get("cancel")?.ltvUsd), "cancel ltv").toBeCloseTo(9.99, 2);
    expect(byKey.get("free")?.purchaseCount, "free purchase count").toBe(0);
  });
});
