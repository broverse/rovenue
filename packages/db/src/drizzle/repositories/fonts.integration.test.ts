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
import { fontFaces, projects } from "../schema";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_fonts_${RUN_ID}`;
// Task 3 review, fix round 2: a second project, used only to prove
// findLiveFamilyForProject actually excludes a family it doesn't own —
// a family row needs a real projects.id to satisfy the FK, so "another
// project" can't be faked with an arbitrary string.
const OTHER_PROJECT_ID = `prj_fonts_other_${RUN_ID}`;
const db = getDb();

beforeAll(async () => {
  await db.insert(projects).values({ id: PROJECT_ID, name: `Fonts ${RUN_ID}` });
  await db
    .insert(projects)
    .values({ id: OTHER_PROJECT_ID, name: `Fonts Other ${RUN_ID}` });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
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

  // Final-review Important 3: softDeleteFamily used to set `deletedAt`
  // on the family only, leaving the `bytea` face rows resident forever
  // (invisible to every read path, uncounted by the quota, unreachable
  // by any cleanup job). This queries `fontFaces` directly — bypassing
  // every repo read, which all filter on the family's `deletedAt` and
  // would report "gone" whether the row was hard-deleted or merely
  // hidden — so it proves physical removal, not filtering.
  it("hard-deletes the face rows themselves, not just filters them out", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Bytes To Reclaim",
    });
    const faceA = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1, 2, 3]),
    });
    const faceB = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 700,
      style: "italic",
      format: "otf",
      bytes: Buffer.from([4, 5, 6]),
    });

    const beforeRows = await db
      .select({ id: fontFaces.id })
      .from(fontFaces)
      .where(eq(fontFaces.familyId, family.id));
    expect(beforeRows.map((r) => r.id).sort()).toEqual(
      [faceA.id, faceB.id].sort(),
    );

    await drizzleRepos.fontRepo.softDeleteFamily(db, family.id);

    const afterRows = await db
      .select({ id: fontFaces.id })
      .from(fontFaces)
      .where(eq(fontFaces.familyId, family.id));
    expect(afterRows).toHaveLength(0);
  });

  it("listFamiliesWithFaces does not select the bytes column, and exposes contentHash", async () => {
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
    expect(typeof withFaces?.faces[0]?.contentHash).toBe("string");
    expect(withFaces?.faces[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Task 7: the URL-versioning fix rests entirely on `contentHash` being
  // recomputed on every write, including the ON CONFLICT DO UPDATE path —
  // a re-upload that changed the bytes but left a stale hash behind is
  // exactly the bug this task exists to prevent. This is the update path,
  // not the insert path.
  it("a re-upload with different bytes changes the stored contentHash", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    const first = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([1, 2, 3]),
    });
    const firstFound = await drizzleRepos.fontRepo.findFaceBytes(db, first.id);

    const second = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([9, 9, 9, 9]),
    });
    const secondFound = await drizzleRepos.fontRepo.findFaceBytes(db, second.id);

    // Still the same row (Task 1's replace-in-place semantics), but the
    // hash must have moved with the bytes.
    expect(second.id).toBe(first.id);
    expect(secondFound?.contentHash).not.toBe(firstFound?.contentHash);
  });

  it("hashes bytes deterministically: identical bytes hash the same, different bytes hash differently", async () => {
    const family = await drizzleRepos.fontRepo.createFamily(db, {
      projectId: PROJECT_ID,
      name: "Brand Sans",
    });
    const faceA = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([5, 6, 7]),
    });
    const faceB = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 400,
      style: "italic",
      format: "otf",
      bytes: Buffer.from([5, 6, 7]),
    });
    const faceC = await drizzleRepos.fontRepo.upsertFace(db, {
      familyId: family.id,
      weight: 700,
      style: "normal",
      format: "otf",
      bytes: Buffer.from([8, 8, 8]),
    });

    const foundA = await drizzleRepos.fontRepo.findFaceBytes(db, faceA.id);
    const foundB = await drizzleRepos.fontRepo.findFaceBytes(db, faceB.id);
    const foundC = await drizzleRepos.fontRepo.findFaceBytes(db, faceC.id);

    expect(foundA?.contentHash).toBe(foundB?.contentHash);
    expect(foundA?.contentHash).not.toBe(foundC?.contentHash);
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

  // Task 3 review, fix round 2, item 1: the dashboard upload route's
  // familyId ownership/liveness check used to be an inline query in
  // the route file, pinned by nothing but a mock that ignored its
  // WHERE clause entirely. It now lives here as
  // findLiveFamilyForProject, and every predicate in it gets its own
  // case against a real database.
  describe("findLiveFamilyForProject", () => {
    it("finds a family the project owns and that is not deleted", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: PROJECT_ID,
        name: "Live Family",
      });
      const found = await drizzleRepos.fontRepo.findLiveFamilyForProject(db, {
        projectId: PROJECT_ID,
        familyId: family.id,
      });
      expect(found?.id).toBe(family.id);
    });

    it("does not find a family belonging to another project", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: OTHER_PROJECT_ID,
        name: "Foreign Family",
      });
      const found = await drizzleRepos.fontRepo.findLiveFamilyForProject(db, {
        projectId: PROJECT_ID,
        familyId: family.id,
      });
      expect(found).toBeNull();
    });

    it("does not find a soft-deleted family, even one this project owns", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: PROJECT_ID,
        name: "Deleted Family",
      });
      await drizzleRepos.fontRepo.softDeleteFamily(db, family.id);
      const found = await drizzleRepos.fontRepo.findLiveFamilyForProject(db, {
        projectId: PROJECT_ID,
        familyId: family.id,
      });
      expect(found).toBeNull();
    });
  });

  // Final-review Important 2: this query used to be inline in the
  // dashboard upload route, pinned by a mock whose `from`/`where`/
  // `limit` all discarded their arguments — dropping either the
  // `weight` or `style` predicate from the real WHERE clause would
  // have silently let a project sail past FONT_FACES_MAX_PER_PROJECT,
  // and the route's own tests would still pass green. Each predicate
  // gets its own case here, against a real database, mutation-checked
  // (see final-fix-report.md).
  describe("findFaceByKey", () => {
    it("finds the face at the matching (familyId, weight, style)", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: PROJECT_ID,
        name: "Key Match Family",
      });
      const face = await drizzleRepos.fontRepo.upsertFace(db, {
        familyId: family.id,
        weight: 400,
        style: "normal",
        format: "otf",
        bytes: Buffer.from([1]),
      });
      const found = await drizzleRepos.fontRepo.findFaceByKey(db, {
        familyId: family.id,
        weight: 400,
        style: "normal",
      });
      expect(found?.id).toBe(face.id);
    });

    it("does not find a face with a different weight", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: PROJECT_ID,
        name: "Key Weight Family",
      });
      await drizzleRepos.fontRepo.upsertFace(db, {
        familyId: family.id,
        weight: 400,
        style: "normal",
        format: "otf",
        bytes: Buffer.from([1]),
      });
      const found = await drizzleRepos.fontRepo.findFaceByKey(db, {
        familyId: family.id,
        weight: 700,
        style: "normal",
      });
      expect(found).toBeNull();
    });

    it("does not find a face with a different style", async () => {
      const family = await drizzleRepos.fontRepo.createFamily(db, {
        projectId: PROJECT_ID,
        name: "Key Style Family",
      });
      await drizzleRepos.fontRepo.upsertFace(db, {
        familyId: family.id,
        weight: 400,
        style: "normal",
        format: "otf",
        bytes: Buffer.from([1]),
      });
      const found = await drizzleRepos.fontRepo.findFaceByKey(db, {
        familyId: family.id,
        weight: 400,
        style: "italic",
      });
      expect(found).toBeNull();
    });
  });
});
