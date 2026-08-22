// =============================================================
// Storage quota — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (apps/api/tests/setup.ts defaults it to the docker-compose dev
// stack on host port 5433). Pattern mirrors
// packages/db/src/drizzle/repositories/fonts.integration.test.ts:
// barrel import + real inserts, no mocking of the DB layer.
//
// There is no shared `makeTestDb`/`seedProject`/`setTierLimit` helper
// module in this repo (the brief that seeded this file's test bodies
// assumed one); the local helpers below do the same job with direct
// Drizzle inserts against the real schema, following the pattern
// fonts.integration.test.ts uses.
//
// The concurrency case at the bottom is the reason this file exists:
// it is the only test in the suite that can tell an atomic
// check-and-reserve apart from a read-then-write race, and it can only
// do that against a real Postgres instance — a mocked transaction
// cannot substantiate an atomicity claim.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  ASSET_STORAGE_TIER_LIMIT_BYTES,
  ASSET_STORAGE_UNLIMITED_LIMIT_BYTES,
} from "@rovenue/shared";
import { getDb, projects, billingSubscriptions, billingTierLimits } from "@rovenue/db";
import {
  reserveStorage,
  releaseReservation,
  getStorageUsage,
  UNLIMITED_RESERVATION,
} from "../../../src/services/assets/quota";

const db = getDb();
const RUN_ID = Date.now();

type Tier = "free" | "indie" | "studio" | "enterprise";

let projectCounter = 0;
const createdProjectIds: string[] = [];

/** Inserts a real project row (satisfying every FK the quota queries
 *  join through), and — unless `withSubscription: false` — a
 *  `billing_subscriptions` row on the given tier. */
async function seedProject(
  opts: { tier?: Tier; withSubscription?: boolean } = {},
): Promise<string> {
  const projectId = `prj_quota_${RUN_ID}_${projectCounter++}`;
  await db.insert(projects).values({ id: projectId, name: `Quota ${projectId}` });
  createdProjectIds.push(projectId);
  if (opts.withSubscription !== false) {
    await db.insert(billingSubscriptions).values({
      projectId,
      state: "active",
      tier: opts.tier ?? "free",
      cycle: "monthly",
    });
  }
  return projectId;
}

/** Upserts the (tier, "monthly") row in the reference `billing_tier_limits`
 *  table so tests control the cap directly, regardless of whether the
 *  environment has been through `pnpm db:seed`. */
async function setTierLimit(tier: Tier, limitBytes: number | null): Promise<void> {
  await db
    .insert(billingTierLimits)
    .values({
      tier,
      cycle: "monthly",
      priceUsdCents: 0,
      mtrMin: "0",
      retentionDays: 30,
      auditLogDays: 7,
      assetStorageBytesLimit: limitBytes,
    })
    .onConflictDoUpdate({
      target: [billingTierLimits.tier, billingTierLimits.cycle],
      set: { assetStorageBytesLimit: limitBytes },
    });
}

beforeAll(async () => {
  // HOST_MODE defaults to "cloud" in apps/api/tests/setup.ts, so the
  // quota service's self-host bypass does not short-circuit these cases.
  expect(process.env.HOST_MODE).toBe("cloud");
});

afterAll(async () => {
  // Cascades to billing_subscriptions / paywall_assets /
  // paywall_asset_reservations via ON DELETE CASCADE.
  for (const id of createdProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("storage quota", () => {
  it("reports usage and the tier limit", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", 1000);
    const usage = await getStorageUsage(db, projectId);
    expect(usage.usedBytes).toBe(0);
    expect(usage.limitBytes).toBe(1000);
  });

  it("allows a reservation that fits and returns its id", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", 1000);
    expect(await reserveStorage(db, projectId, 600)).toEqual(expect.any(String));
  });

  it("refuses a reservation that would exceed the cap", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", 1000);
    expect(await reserveStorage(db, projectId, 600)).toEqual(expect.any(String));
    expect(await reserveStorage(db, projectId, 600)).toBeNull();
  });

  it("frees the reserved bytes again once the reservation is released", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", 1000);
    const first = await reserveStorage(db, projectId, 900);
    expect(await reserveStorage(db, projectId, 900)).toBeNull();
    await releaseReservation(db, first!);
    // Without the release this stays null forever (until the sweeper),
    // because the reservation keeps counting against the cap.
    expect(await reserveStorage(db, projectId, 900)).toEqual(expect.any(String));
  });

  it("treats a NULL tier limit as unlimited", async () => {
    const projectId = await seedProject({ tier: "enterprise" });
    await setTierLimit("enterprise", null);
    expect(await reserveStorage(db, projectId, 10 ** 12)).toBe(UNLIMITED_RESERVATION);
  });

  it("falls back to the free cap for a project with no subscription row", async () => {
    const projectId = await seedProject({ withSubscription: false });
    await setTierLimit("free", 1000);
    // Must NOT be unlimited: failing open here would hand every
    // brand-new project unmetered storage.
    expect(await reserveStorage(db, projectId, 2000)).toBeNull();
  });

  // ----- NULL means "unseeded", not "free" -----
  //
  // `asset_storage_bytes_limit` spells both "unlimited" and "nobody ever
  // put a number here" as NULL, and reading the second as the first
  // fails open on a paid limit. Migrations did exactly that: 0099 filled
  // the column with an UPDATE, 0100 then seeded the ladder with an
  // INSERT that never listed it — so a database built from migrations
  // alone had NULL on every tier and no quota at all.

  it("does not treat an unseeded free-tier cap as unlimited", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", null);

    const usage = await getStorageUsage(db, projectId);
    expect(usage.limitBytes).toBe(ASSET_STORAGE_TIER_LIMIT_BYTES.free);
    // One byte over the fallback cap, not an astronomical number:
    // `paywall_asset_reservations.bytes` is an integer column, so a
    // 10^12 probe would fail on the type rather than on the quota.
    expect(
      await reserveStorage(db, projectId, ASSET_STORAGE_TIER_LIMIT_BYTES.free + 1),
    ).toBeNull();
  });

  it("falls back to the tier's OWN cap, not the free one", async () => {
    const projectId = await seedProject({ tier: "indie" });
    await setTierLimit("indie", null);

    // An indie project with an unseeded row must not be squeezed into
    // the free band it is paying to leave.
    const usage = await getStorageUsage(db, projectId);
    expect(usage.limitBytes).toBe(ASSET_STORAGE_TIER_LIMIT_BYTES.indie);
  });

  it("honours a negative cap as an explicit, deliberate unlimited", async () => {
    // Narrowing NULL to "unseeded" costs the column its way of saying
    // "this capped tier is unlimited here" — a thing a cloud operator
    // may legitimately want for one customer. The sentinel gives it
    // back, unambiguously.
    const projectId = await seedProject({ tier: "indie" });
    await setTierLimit("indie", ASSET_STORAGE_UNLIMITED_LIMIT_BYTES);

    expect((await getStorageUsage(db, projectId)).limitBytes).toBeNull();
    expect(await reserveStorage(db, projectId, 10 ** 9)).toBe(UNLIMITED_RESERVATION);
  });

  it("does not treat an unseeded free-tier cap as unlimited for an unsubscribed project", async () => {
    const projectId = await seedProject({ withSubscription: false });
    await setTierLimit("free", null);

    expect((await getStorageUsage(db, projectId)).limitBytes).toBe(
      ASSET_STORAGE_TIER_LIMIT_BYTES.free,
    );
  });

  // This is the whole point of the task. A read-then-write check lets
  // both of these through; only an atomic conditional INSERT under a
  // per-project advisory lock does not. It must run against real
  // Postgres — a mocked transaction cannot substantiate an atomicity
  // claim. (See task-5-report.md for the paired run with the advisory
  // lock removed, proving this case actually exercises the race.)
  it("does not exceed the cap under concurrent reservations", async () => {
    const projectId = await seedProject({ tier: "free" });
    await setTierLimit("free", 1000);

    const CONCURRENCY = 20;
    const EACH = 100;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => reserveStorage(db, projectId, EACH)),
    );

    const granted = results.filter(Boolean).length;
    expect(granted).toBe(10); // 10 * 100 = 1000, exactly the cap
  });
});
