import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../schema";

// =============================================================
// billing_subscriptions repository (Phase 1)
// =============================================================
// One row per project. The partial unique index
// `billing_subscriptions_project_active_uq` permits multiple rows only
// when older ones are state='deleted'; Phase 1 never deletes, so a
// duplicate insert is always a bug.

export async function createFreeBillingSubscription(
  db: Db,
  projectId: string,
): Promise<BillingSubscription> {
  const rows = await db
    .insert(billingSubscriptions)
    .values({
      projectId,
      state: "free",
      tier: "free",
      cycle: "monthly",
    })
    .returning();
  return rows[0]!;
}

export async function findBillingSubscriptionByProject(
  db: Db,
  projectId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
