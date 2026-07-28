// =============================================================
// fontRepo — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling paywall-versions.integration.test.ts
// suite (barrel import + real inserts, no mocking).
//
// Covers:
//   - bytea bytes round-trip unchanged through upsertFace/findFaceBytes
//   - upserting the same (familyId, weight, style) replaces rather than
//     duplicates the face row
//   - soft-deleting a family removes its faces from every read path
//   - listFamiliesWithFaces never selects the bytes column (metadata
//     only), while still surfacing the denormalised byteSize

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import * as drizzleRepos from "../index";
import { projects } from "../schema";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_fonts_${RUN_ID}`;
const db = getDb();

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: `Fonts ${RUN_ID}` });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("fontRepo", () => {
  it("round-trips face bytes unchanged", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    const bytes = Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0x01, 0x02, 0x03]);
    const face = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes,
    });
    const found = await drizzleRepos.fontRepo.findFaceBytes(db, face.id);
    expect(found?.bytes.equals(bytes)).toBe(true);
  });

  it("replaces the face for a repeated weight and style rather than duplicating", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1]),
    });
    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([2]),
    });
    const families = await drizzleRepos.fontRepo.listFamiliesWithFaces(db, PROJECT_ID);
    const withFaces = families.find((f) => f.id === family.id);
    expect(withFaces?.faces).toHaveLength(1);
  });

  it("deleting a family removes its faces", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    const face = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1]),
    });
    await drizzleRepos.fontRepo.softDeleteFamily(db, family.id);
    const families = await drizzleRepos.fontRepo.listFamiliesWithFaces(db, PROJECT_ID);
    expect(families.find((f) => f.id === family.id)).toBeUndefined();
    expect(await drizzleRepos.fontRepo.findFaceBytes(db, face.id)).toBeNull();
  });

  it("listFamiliesWithFaces does not select the bytes column", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1, 2, 3]),
    });
    const families = await drizzleRepos.fontRepo.listFamiliesWithFaces(db, PROJECT_ID);
    const withFaces = families.find((f) => f.id === family.id);
    expect(withFaces?.faces[0]).not.toHaveProperty("bytes");
    expect(withFaces?.faces[0]?.byteSize).toBe(3);
  });

  // Task 3 review, fix round 1, item 1: countFacesForProject previously
  // had no test of its own anywhere — the dashboard upload route's
  // quota gate mocks it out entirely (by design; see that route's
  // test file), so this is the only place its real SQL is ever run.
  // Pinned against a live Postgres instance because a wrong join or a
  // missing deletedAt filter is exactly the kind of defect a mock
  // would happily agree with.
  it("countFacesForProject reflects inserted faces and excludes soft-deleted families", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Count Family",
    });
    // Baseline rather than an absolute number — PROJECT_ID is shared
    // across this file's tests (each using its own family), so this
    // assertion must not assume it starts the file at zero.
    const before = await drizzleRepos.fontRepo.countFacesForProject(
      db,
      PROJECT_ID,
    );

    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1]),
    });
    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 700,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([2]),
    });
    const afterTwoInserts = await drizzleRepos.fontRepo.countFacesForProject(
      db,
      PROJECT_ID,
    );
    expect(afterTwoInserts).toBe(before + 2);

    // Re-uploading an existing (familyId, weight, style) replaces
    // rather than inserts (the sibling test above already pins this
    // for listFamiliesWithFaces) — the count must not grow. This is
    // exactly the invariant the dashboard route's quota-skip-on-update
    // fix (fix round 1, item 4) depends on.
    await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([9]),
    });
    const afterReplace = await drizzleRepos.fontRepo.countFacesForProject(
      db,
      PROJECT_ID,
    );
    expect(afterReplace).toBe(before + 2);

    // Soft-deleting the family must remove its faces from the count —
    // this is exactly what the upload route's quota gate depends on
    // (design spec §4.1 / Task 1 review finding #2's flip side: a
    // wrong implementation here would silently let a project past its
    // real cap).
    await drizzleRepos.fontRepo.softDeleteFamily(db, family.id);
    const afterDelete = await drizzleRepos.fontRepo.countFacesForProject(
      db,
      PROJECT_ID,
    );
    expect(afterDelete).toBe(before);
  });
});
