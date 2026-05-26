// =============================================================
// billing-tier-limits repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
//
// The Phase-1 backfill migration does NOT seed `billing_tier_limits`;
// the production seed lives in `packages/db/seed.ts`. Tests insert
// their own rows with `onConflictDoNothing()` so the suite stays
// idempotent against a possibly-seeded dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { findByTierAndCycle } from "./billing-tier-limits";

// ---------------------------------------------------------------------------
// Env bootstrap
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// DB connection owned by this test file
// ---------------------------------------------------------------------------

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
  // Ensure deterministic state for the negative-case assertion: the dev
  // `db:seed` script seeds every tier × cycle pairing, including
  // (free, annual). Phase 2 never plans for that pairing, so remove it
  // here before asserting `findByTierAndCycle(db, "free", "annual")`
  // returns null. (Removing then re-seeding the two rows we care about
  // keeps the suite idempotent.)
  await db
    .delete(schema.billingTierLimits)
    .where(
      and(
        eq(schema.billingTierLimits.tier, "free"),
        eq(schema.billingTierLimits.cycle, "annual"),
      ),
    );
  await seedTierLimits();
});

afterAll(async () => {
  // Restore the (free, annual) row that `beforeAll` deleted so the dev DB
  // matches the canonical `seed.ts` state once the suite is done. Guarded
  // by `onConflictDoNothing()` for idempotency against re-runs.
  await db
    .insert(schema.billingTierLimits)
    .values({
      tier: "free",
      cycle: "annual",
      priceUsdCents: 0,
      stripePriceId: null,
      mtrMin: "0",
      mtrMax: "3000",
      eventsLimit: 5_000_000,
      sqlLimit: 100,
      retentionDays: 30,
      auditLogDays: 7,
    })
    .onConflictDoNothing();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedTierLimits() {
  await db
    .insert(schema.billingTierLimits)
    .values([
      {
        tier: "indie",
        cycle: "monthly",
        priceUsdCents: 2900,
        stripePriceId: null,
        mtrMin: "3000",
        mtrMax: "10000",
        eventsLimit: 15_000_000,
        sqlLimit: 500,
        retentionDays: 60,
        auditLogDays: 30,
      },
      {
        tier: "free",
        cycle: "monthly",
        priceUsdCents: 0,
        stripePriceId: null,
        mtrMin: "0",
        mtrMax: "3000",
        eventsLimit: 5_000_000,
        sqlLimit: 100,
        retentionDays: 30,
        auditLogDays: 7,
      },
    ])
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findByTierAndCycle", () => {
  it("returns the indie/monthly row with priceUsdCents=2900", async () => {
    const row = await findByTierAndCycle(db, "indie", "monthly");
    expect(row).not.toBeNull();
    expect(row!.tier).toBe("indie");
    expect(row!.cycle).toBe("monthly");
    expect(row!.priceUsdCents).toBe(2900);
  });

  it("returns null for (free, annual) — no such pairing exists", async () => {
    const row = await findByTierAndCycle(db, "free", "annual");
    expect(row).toBeNull();
  });

  it("returns the free/monthly row with priceUsdCents=0", async () => {
    const row = await findByTierAndCycle(db, "free", "monthly");
    expect(row).not.toBeNull();
    expect(row!.tier).toBe("free");
    expect(row!.cycle).toBe("monthly");
    expect(row!.priceUsdCents).toBe(0);
  });
});
