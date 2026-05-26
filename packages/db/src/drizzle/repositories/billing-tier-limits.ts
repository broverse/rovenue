import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import { billingTierLimits, type BillingTierLimits } from "../schema";

// =============================================================
// billing_tier_limits repository (read-only reference table)
// =============================================================
// Composite primary key is (tier, cycle). Rows are populated by
// `pnpm db:seed` (see packages/db/seed.ts); webhook handlers in
// Phase 2+ read them to map a (tier, cycle) bracket back to its
// `stripe_price_id`. Phase 2 only ever queries ("indie", "monthly").

export async function findByTierAndCycle(
  db: Db,
  tier: BillingTierLimits["tier"],
  cycle: BillingTierLimits["cycle"],
): Promise<BillingTierLimits | null> {
  const rows = await db
    .select()
    .from(billingTierLimits)
    .where(
      and(
        eq(billingTierLimits.tier, tier),
        eq(billingTierLimits.cycle, cycle),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
