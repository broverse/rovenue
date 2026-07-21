import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import { billingTierLimits } from "../../packages/db/src/drizzle/schema";

// This test runs against a seeded database.
// Boot Postgres + run `pnpm db:migrate && pnpm db:seed` before running.
// Ladder per the 2026-07-21 pricing consolidation:
// free / indie / studio / enterprise (pro, scale, growth retired).

describe("billing_tier_limits seed", () => {
  it("has exactly 8 rows (4 tiers x 2 cycles)", async () => {
    const rows = await db.select().from(billingTierLimits);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.tier))).toEqual(
      new Set(["free", "indie", "studio", "enterprise"]),
    );
  });

  it("Free tier is $0 both cycles", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "free"));
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.priceUsdCents).toBe(0));
  });

  it("Indie monthly = $49, annual = $490 (2 months free)", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "indie"));
    const monthly = rows.find((r) => r.cycle === "monthly")!;
    const annual = rows.find((r) => r.cycle === "annual")!;
    expect(monthly.priceUsdCents).toBe(4900);
    expect(annual.priceUsdCents).toBe(49_000);
  });

  it("Studio monthly = $399, annual = $3990", async () => {
    const rows = await db
      .select()
      .from(billingTierLimits)
      .where(eq(billingTierLimits.tier, "studio"));
    expect(rows.find((r) => r.cycle === "monthly")!.priceUsdCents).toBe(
      39_900,
    );
    expect(rows.find((r) => r.cycle === "annual")!.priceUsdCents).toBe(
      399_000,
    );
  });

  it("Free MTR bracket = $0 – $5K", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    expect(Number(free.mtrMin)).toBe(0);
    expect(Number(free.mtrMax)).toBe(5000);
  });

  it("Indie MTR bracket = $5K – $50K", async () => {
    const indie = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "indie"))
    )[0]!;
    expect(Number(indie.mtrMin)).toBe(5000);
    expect(Number(indie.mtrMax)).toBe(50_000);
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

  it("Free + Indie have a finite sql_limit; Studio+ are unlimited (NULL)", async () => {
    const free = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "free"))
    )[0]!;
    const studio = (
      await db
        .select()
        .from(billingTierLimits)
        .where(eq(billingTierLimits.tier, "studio"))
    )[0]!;
    expect(free.sqlLimit).toBe(100);
    expect(studio.sqlLimit).toBeNull();
  });
});
