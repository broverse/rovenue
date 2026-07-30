// =============================================================
// pg-errors — integration test (residual finding 2)
// =============================================================
//
// pg-errors.test.ts (the unit suite, kept as-is — it still documents
// the shape) proves `isUniqueViolationOf` reads the fields it reads on
// a HAND-BUILT error shaped the way the code expects. That's
// self-confirming: it proves the function matches its own idea of a
// Postgres error, not that a real one actually carries those fields
// the way Drizzle 0.45.2 wraps them. This file closes that gap by
// feeding the classifier a genuine error thrown by a real Postgres 16
// instance through the real `assetRepo.createAsset` call — the same
// repository call `commitAssetRow` in routes/dashboard/assets.ts
// wraps in its own catch block — for both:
//
//   - a real unique-violation of `paywall_assets_project_hash_key`
//     (must classify true — this is what routes a concurrent duplicate
//     upload to the idempotent 200 instead of a 500)
//   - a real, DIFFERENT constraint violation — a foreign-key violation
//     on `projectId`, easy to provoke by referencing a project that
//     doesn't exist — which must classify false, so the positive case
//     above isn't just "returns true for anything that looks like a
//     Postgres error"
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (apps/api/tests/setup.ts defaults it to the docker-compose dev
// stack on host port 5433). Pattern mirrors
// services/assets/quota.integration.test.ts: direct Drizzle inserts
// against the real schema, no mocking of the DB layer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { isUniqueViolationOf } from "../../src/lib/pg-errors";

// Mirrors the same-named constant in routes/dashboard/assets.ts.
// Duplicated rather than imported (that constant isn't exported, and
// the route file has no other reason to export internals) — the
// duplication is deliberate here anyway: this test is checking that
// the LITERAL migration index name the route hardcodes is what
// Postgres actually reports, not re-deriving it from the route's own
// source, which would make the assertion trivially circular.
const PAYWALL_ASSETS_PROJECT_HASH_KEY = "paywall_assets_project_hash_key";

const db = getDb();
const RUN_ID = Date.now();
const PROJECT_ID = `prj_pgerr_${RUN_ID}`;

function assetInput(overrides: { projectId?: string; contentHash?: string } = {}) {
  const id = createId();
  return {
    projectId: overrides.projectId ?? PROJECT_ID,
    kind: "image" as const,
    name: "hero.png",
    storageKey: `${PROJECT_ID}/${id}.webp`,
    contentHash: overrides.contentHash ?? createId().padEnd(64, "z"),
    contentType: "image/webp",
    byteSize: 1234,
    width: 800,
    height: 600,
    sourceFormat: "png" as const,
    sourceWidth: 1600,
    sourceHeight: 1200,
    policyVersion: 1,
  };
}

/** Runs `fn`, expects it to REJECT, and hands back the real thrown
 *  error — rather than `.rejects.toThrow()`, which only proves
 *  SOMETHING was thrown and discards the object this file exists to
 *  inspect. */
async function captureRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: `pg-errors ${RUN_ID}` });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("isUniqueViolationOf against REAL Postgres errors (residual finding 2)", () => {
  it("classifies a genuine paywall_assets_project_hash_key violation as true", async () => {
    const hash = createId().padEnd(64, "y");
    await drizzle.assetRepo.createAsset(db, assetInput({ contentHash: hash }));

    const realErr = await captureRejection(() =>
      drizzle.assetRepo.createAsset(db, assetInput({ contentHash: hash })),
    );

    expect(isUniqueViolationOf(realErr, PAYWALL_ASSETS_PROJECT_HASH_KEY)).toBe(true);
  });

  it("classifies a genuine, DIFFERENT constraint violation (FK on projectId) as false", async () => {
    const realErr = await captureRejection(() =>
      drizzle.assetRepo.createAsset(db, assetInput({ projectId: `prj_missing_${RUN_ID}` })),
    );

    expect(isUniqueViolationOf(realErr, PAYWALL_ASSETS_PROJECT_HASH_KEY)).toBe(false);
    // Still worth confirming this really is a violation of SOME
    // constraint (the FK), not e.g. a connection error that would
    // trivially fail to match too and prove nothing. The detail sits on
    // `.cause` — the outer DrizzleQueryError's own message is just
    // "Failed query: insert into ..." (see lib/pg-errors.ts's module
    // comment on why the classifier has to walk the chain at all).
    const cause = (realErr as { cause?: { message?: string } }).cause;
    expect(String(cause?.message)).toMatch(/violates foreign key constraint/i);
  });
});
