import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import { billingTierLimits } from "../../packages/db/src/drizzle/schema";

// This test runs against a seeded database.
// Boot Postgres + run `pnpm db:migrate && pnpm db:seed` before running.

describe("billing_tier_limits seed", () => {
  it("has exactly 12 rows (6 tiers x 2 cycles)", async () => {
    const rows = await db.select().from(billingTierLimits);
    expect(rows).toHaveLength(12);
  });

  it("Free tier is $0 both cycles", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "free"));
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.priceUsdCents).toBe(0));
  });

  it("Indie monthly = $29, annual = $290 (2 months free)", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "indie"));
    const monthly = rows.find((r) => r.cycle === "monthly")!;
    const annual = rows.find((r) => r.cycle === "annual")!;
    expect(monthly.priceUsdCents).toBe(2900);
    expect(annual.priceUsdCents).toBe(29_000);
  });

  it("Scale monthly = $399, annual = $3990", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "scale"));
    expect(rows.find((r) => r.cycle === "monthly")!.priceUsdCents).toBe(
      39_900,
    );
    expect(rows.find((r) => r.cycle === "annual")!.priceUsdCents).toBe(
      399_000,
    );
  });

  it("Free MTR bracket = $0 – $3K", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    expect(Number(free.mtrMin)).toBe(0);
    expect(Number(free.mtrMax)).toBe(3000);
  });

  it("Enterprise has no upper MTR bound and no stripe_price_id", async () => {
    const ent = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "enterprise"))
    )[0]!;
    expect(ent.mtrMax).toBeNull();
    expect(ent.stripePriceId).toBeNull();
  });

  it("Free + Indie have a finite sql_limit; Scale+ are unlimited (NULL)", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    const scale = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "scale"))
    )[0]!;
    expect(free.sqlLimit).toBe(100);
    expect(scale.sqlLimit).toBeNull();
  });
});
