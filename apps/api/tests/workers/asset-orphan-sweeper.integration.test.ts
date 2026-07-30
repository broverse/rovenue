// =============================================================
// asset-orphan-sweeper — integration test against real MinIO + Postgres
// (Task 9)
// =============================================================
//
// An S3 write cannot be rolled back, so storage writes deliberately sit
// outside the DB transaction (design spec §5.8). That leaves two ways
// to orphan a bucket object: an upload that puts its object but fails
// to commit its row, and a delete that tombstones its row but fails to
// delete its object. Neither shows up in quota, which counts rows, not
// bytes on disk.
//
// The case that matters most here is NOT "does the sweeper reclaim an
// orphan" — it's "does the sweeper leave an in-flight upload alone".
// An upload that has PUT its object but not yet committed its row is
// indistinguishable from a genuine orphan by any signal except age, so
// `ASSET_ORPHAN_GRACE_HOURS` is what stands between a maintenance job
// and destroying live uploads. `sweepOrphanedAssets` takes `now`
// explicitly (rather than always reading the real clock) specifically
// so this suite can assert both sides of that window without needing
// to backdate a real S3 object's `LastModified`, which isn't possible.
//
// What's real: `lib/asset-store.ts` (real MinIO via startMinio(),
// tests/helpers.ts), `@rovenue/db` (real Postgres, no mocking).
//
// NOT parallel-safe hazard: unlike assets.integration.test.ts and
// quota.integration.test.ts, this file never touches the shared
// `billing_tier_limits` table, so it has none of their cross-file
// hazard. It DOES run an unscoped `DELETE FROM paywall_asset_reservations
// WHERE createdAt < cutoff` — a faithful mirror of production, where the
// sweeper has no reason to know which project an orphan belongs to —
// but every reservation this file inserts has an explicit, deliberately
// recent-or-old `createdAt`, so it cannot collide with a concurrently
// running test's freshly-created (i.e. real-`now()`) reservation rows.

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StartedTestContainer } from "testcontainers";
import { getDb, drizzle, projects } from "@rovenue/db";
import { ASSET_ORPHAN_GRACE_HOURS } from "@rovenue/shared";
import { startMinio } from "../helpers";
import { putObject, listAllKeys } from "../../src/lib/asset-store";
import { sweepOrphanedAssets } from "../../src/workers/asset-orphan-sweeper";

const MS_PER_HOUR = 60 * 60 * 1000;

// A sweep `now` far enough past the real grace window that ANY object
// actually written during this test run reads as older-than-cutoff,
// without needing to backdate a real S3 object.
function wellPastGraceWindow(): Date {
  return new Date(Date.now() + (ASSET_ORPHAN_GRACE_HOURS + 1) * MS_PER_HOUR);
}

const RUN_ID = Date.now();
let projectCounter = 0;
const createdProjectIds: string[] = [];

async function seedProject(): Promise<string> {
  const db = getDb();
  const id = `prj_orphan_sweep_it_${RUN_ID}_${projectCounter++}`;
  await db.insert(projects).values({ id, name: `Orphan Sweep IT ${id}` });
  createdProjectIds.push(id);
  return id;
}

function testKey(projectId: string, suffix: string): string {
  return `${projectId}/${suffix}.webp`;
}

async function seedLiveAsset(projectId: string, storageKey: string): Promise<void> {
  await drizzle.assetRepo.createAsset(getDb(), {
    projectId,
    kind: "image",
    name: "live",
    storageKey,
    contentHash: `hash-${storageKey}`,
    contentType: "image/webp",
    byteSize: 10,
    width: null,
    height: null,
    sourceFormat: null,
    sourceWidth: null,
    sourceHeight: null,
    policyVersion: 1,
  });
}

async function insertReservation(
  projectId: string,
  createdAt: Date,
  bytes = 100,
): Promise<void> {
  await getDb()
    .insert(drizzle.schema.paywallAssetReservations)
    .values({ projectId, bytes, createdAt });
}

async function reservationCreatedAts(projectId: string): Promise<number[]> {
  const rows = await getDb()
    .select()
    .from(drizzle.schema.paywallAssetReservations)
    .where(eq(drizzle.schema.paywallAssetReservations.projectId, projectId));
  return rows.map((r) => r.createdAt.getTime());
}

let minio: StartedTestContainer;

beforeAll(async () => {
  minio = await startMinio();
}, 120_000);

afterAll(async () => {
  const db = getDb();
  for (const id of createdProjectIds) {
    // Cascades to paywall_assets / paywall_asset_reservations (FK ON
    // DELETE CASCADE).
    await db.delete(projects).where(eq(projects.id, id));
  }
  await minio?.stop();
});

describe("sweepOrphanedAssets", () => {
  it("reclaims an object older than the grace window with no live row", async () => {
    const projectId = await seedProject();
    const key = testKey(projectId, "orphan-old");
    await putObject(key, Buffer.from("orphan bytes"), "image/webp");

    const result = await sweepOrphanedAssets(wellPastGraceWindow());

    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    const keys = await listAllKeys();
    expect(keys).not.toContain(key);
  });

  it("leaves an object inside the grace window alone", async () => {
    // This is the case that matters: an upload that has put its object
    // but not yet committed its row looks exactly like an orphan. The
    // grace window is the only thing separating them, so a sweeper that
    // fails this test destroys live uploads.
    const projectId = await seedProject();
    const key = testKey(projectId, "orphan-fresh");
    await putObject(key, Buffer.from("fresh orphan bytes"), "image/webp");

    // Real "now" — the object was just written, so it is nowhere near
    // ASSET_ORPHAN_GRACE_HOURS old.
    const result = await sweepOrphanedAssets(new Date());

    const keys = await listAllKeys();
    expect(keys).toContain(key);
    expect(result.reclaimed).toBe(0);
  });

  it("leaves an object with a live row alone regardless of age", async () => {
    const projectId = await seedProject();
    const key = testKey(projectId, "live");
    await putObject(key, Buffer.from("live bytes"), "image/webp");
    await seedLiveAsset(projectId, key);

    await sweepOrphanedAssets(wellPastGraceWindow());

    const keys = await listAllKeys();
    expect(keys).toContain(key);
  });

  it("clears reservation rows older than the grace window", async () => {
    const projectId = await seedProject();
    const oldCreatedAt = new Date(
      Date.now() - (ASSET_ORPHAN_GRACE_HOURS + 1) * MS_PER_HOUR,
    );
    const freshCreatedAt = new Date();
    await insertReservation(projectId, oldCreatedAt);
    await insertReservation(projectId, freshCreatedAt);

    await sweepOrphanedAssets(new Date());

    const remaining = await reservationCreatedAts(projectId);
    expect(remaining).not.toContain(oldCreatedAt.getTime());
    expect(remaining).toContain(freshCreatedAt.getTime());
  });

  it("reports how many objects it reclaimed", async () => {
    const projectId = await seedProject();
    const keyA = testKey(projectId, "count-a");
    const keyB = testKey(projectId, "count-b");
    await putObject(keyA, Buffer.from("a"), "image/webp");
    await putObject(keyB, Buffer.from("b"), "image/webp");

    const before = await listAllKeys();
    expect(before.filter((k) => k.startsWith(`${projectId}/`))).toHaveLength(2);

    const result = await sweepOrphanedAssets(wellPastGraceWindow());

    expect(result.reclaimed).toBeGreaterThanOrEqual(2);
    const after = await listAllKeys();
    expect(after.filter((k) => k.startsWith(`${projectId}/`))).toHaveLength(0);
  });
});
