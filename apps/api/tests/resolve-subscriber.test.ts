// =============================================================
// resolveSubscriber — integration tests
//
// Hits a real migrated Postgres (docker-compose dev stack on host
// port 5433 or a .env.test override). Each test run uses a unique
// RUN_ID suffix so concurrent runs don't collide, and afterAll
// cleans up the project row (cascade removes subscribers).
// =============================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, subscribers } from "@rovenue/db";
import { HTTPException } from "hono/http-exception";
import { resolveSubscriber } from "../src/lib/resolve-subscriber";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_resolve_lib_${RUN_ID}`;

describe("resolveSubscriber (rovenueId-first)", () => {
  beforeAll(async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Resolve Lib Test ${RUN_ID}` });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  beforeEach(async () => {
    // Clean slate per test so inserts don't collide.
    await getDb()
      .delete(subscribers)
      .where(eq(subscribers.projectId, PROJECT_ID));
  });

  it("resolves by rovenueId", async () => {
    const [row] = await getDb()
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: "rov_lib_1", appUserId: null })
      .returning();
    const got = await resolveSubscriber(PROJECT_ID, "rov_lib_1");
    expect(got.id).toBe(row!.id);
  });

  it("resolves by legacy appUserId (dual-read window)", async () => {
    const [row] = await getDb()
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: "rov_lib_2", appUserId: "legacy_user_2" })
      .returning();
    const got = await resolveSubscriber(PROJECT_ID, "legacy_user_2");
    expect(got.id).toBe(row!.id);
  });

  it("follows mergedInto redirect", async () => {
    // Insert canonical target first.
    const [target] = await getDb()
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: "rov_target", appUserId: null })
      .returning();
    // Insert source that is soft-deleted and points at target.
    await getDb()
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: "rov_source",
        appUserId: null,
        deletedAt: new Date(),
        mergedInto: target!.id,
      });
    const got = await resolveSubscriber(PROJECT_ID, "rov_source");
    expect(got.id).toBe(target!.id);
  });

  it("throws 404 when nothing resolves", async () => {
    await expect(
      resolveSubscriber(PROJECT_ID, "nope_does_not_exist"),
    ).rejects.toBeInstanceOf(HTTPException);
  });
});
