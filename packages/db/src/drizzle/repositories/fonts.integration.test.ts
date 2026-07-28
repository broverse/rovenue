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
});
