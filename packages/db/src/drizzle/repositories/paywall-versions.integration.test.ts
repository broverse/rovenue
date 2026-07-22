// =============================================================
// paywallVersionRepo integration tests — real Postgres.
// Mirrors paywalls.integration.test.ts's seeding style.
// =============================================================

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getDb } from "../client";
import * as drizzleRepos from "../index";
import { projects, offerings, paywalls, paywallVersions } from "../schema";
import { eq } from "drizzle-orm";

const RUN_ID = Date.now();
const db = getDb();

let projectId: string;
let offeringId: string;
let paywallId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: `pwv-${RUN_ID}` })
    .returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;

  const [paywall] = await db
    .insert(paywalls)
    .values({
      projectId,
      identifier: `pw-${RUN_ID}`,
      name: "Test paywall",
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    })
    .returning();
  paywallId = paywall!.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("paywallVersionRepo", () => {
  it("nextVersionNo starts at 1 and increments", async () => {
    expect(await drizzleRepos.paywallVersionRepo.nextVersionNo(db, paywallId)).toBe(1);

    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId,
      versionNo: 1,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });

    expect(await drizzleRepos.paywallVersionRepo.nextVersionNo(db, paywallId)).toBe(2);
  });

  it("listByPaywall returns newest first", async () => {
    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId,
      versionNo: 2,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });

    const rows = await drizzleRepos.paywallVersionRepo.listByPaywall(db, paywallId);
    expect(rows.map((r) => r.versionNo)).toEqual([2, 1]);
  });

  it("findByVersionNo scopes to the paywall", async () => {
    const v1 = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 1);
    expect(v1?.versionNo).toBe(1);
    expect(await drizzleRepos.paywallVersionRepo.findByVersionNo(db, "nope", 1)).toBeNull();
  });

  it("findByIds batches", async () => {
    const rows = await drizzleRepos.paywallVersionRepo.listByPaywall(db, paywallId);
    const found = await drizzleRepos.paywallVersionRepo.findByIds(
      db,
      rows.map((r) => r.id),
    );
    expect(found).toHaveLength(2);
    expect(await drizzleRepos.paywallVersionRepo.findByIds(db, [])).toEqual([]);
  });

  it("setLabel updates only the targeted version", async () => {
    const updated = await drizzleRepos.paywallVersionRepo.setLabel(db, paywallId, 1, "Launch");
    expect(updated?.label).toBe("Launch");
    const other = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 2);
    expect(other?.label).toBeNull();
  });

  it("setPublishedVersion points the paywall at a version", async () => {
    const v2 = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 2);
    const row = await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      projectId,
      paywallId,
      v2!.id,
    );
    expect(row?.publishedVersionId).toBe(v2!.id);
    expect(row?.status).toBe("published");
  });

  it("deleting the paywall cascades its versions", async () => {
    const [tmp] = await db
      .insert(paywalls)
      .values({
        projectId,
        identifier: `pw-tmp-${RUN_ID}`,
        name: "Temp",
        offeringId,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      })
      .returning();
    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: tmp!.id,
      versionNo: 1,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });
    await db.delete(paywalls).where(eq(paywalls.id, tmp!.id));
    const left = await db
      .select()
      .from(paywallVersions)
      .where(eq(paywallVersions.paywallId, tmp!.id));
    expect(left).toHaveLength(0);
  });
});
