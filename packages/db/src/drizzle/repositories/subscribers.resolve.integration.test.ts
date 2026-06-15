// =============================================================
// subscribers repo — rovenueId resolution integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling webhook-events / subscribers.identity
// integration suites.
//
// Covers the three rovenueId-era repo functions added in Task 2:
//   - findSubscriberByRovenueId
//   - resolveSubscriberByRovenueIdOrLegacy (redirect-following + legacy fallback)
//   - setAppUserId

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, subscribers } from "../schema";
import {
  findSubscriberByRovenueId,
  resolveSubscriberByRovenueIdOrLegacy,
  setAppUserId,
} from "./subscribers";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_resolve_${RUN_ID}`;

describe("rovenueId resolution repo functions", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Resolve ${RUN_ID}` });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("findSubscriberByRovenueId returns the active row keyed by rovenueId", async () => {
    const db = getDb();
    const rovenueId = `rov_find_${RUN_ID}`;
    const [inserted] = await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId })
      .returning();

    const found = await findSubscriberByRovenueId(db, {
      projectId: PROJECT_ID,
      rovenueId,
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(inserted!.id);
    expect(found?.rovenueId).toBe(rovenueId);

    const missing = await findSubscriberByRovenueId(db, {
      projectId: PROJECT_ID,
      rovenueId: `rov_nope_${RUN_ID}`,
    });
    expect(missing).toBeNull();
  });

  it("resolve follows mergedInto when the rovenueId row is soft-deleted", async () => {
    const db = getDb();
    const canonicalRovenueId = `rov_canonical_${RUN_ID}`;
    const mergedRovenueId = `rov_merged_${RUN_ID}`;

    const [canonical] = await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId: canonicalRovenueId })
      .returning();

    // Soft-deleted source row redirecting at the canonical row.
    await db.insert(subscribers).values({
      projectId: PROJECT_ID,
      rovenueId: mergedRovenueId,
      deletedAt: new Date(),
      mergedInto: canonical!.id,
    });

    const resolved = await resolveSubscriberByRovenueIdOrLegacy(db, {
      projectId: PROJECT_ID,
      key: mergedRovenueId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(canonical!.id);
    expect(resolved?.rovenueId).toBe(canonicalRovenueId);
  });

  it("resolve falls back to a legacy active appUserId match", async () => {
    const db = getDb();
    const rovenueId = `rov_legacy_${RUN_ID}`;
    const legacyAppUserId = `legacy_app_user_${RUN_ID}`;
    const [row] = await db
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId,
        appUserId: legacyAppUserId,
      })
      .returning();

    // The SDK sent the legacy appUserId, which is NOT a rovenueId match,
    // so resolution must dual-read and find it via the appUserId column.
    const resolved = await resolveSubscriberByRovenueIdOrLegacy(db, {
      projectId: PROJECT_ID,
      key: legacyAppUserId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(row!.id);
  });

  it("resolve returns null when nothing matches", async () => {
    const db = getDb();
    const resolved = await resolveSubscriberByRovenueIdOrLegacy(db, {
      projectId: PROJECT_ID,
      key: `totally_unknown_${RUN_ID}`,
    });
    expect(resolved).toBeNull();
  });

  it("setAppUserId stamps appUserId + identifiedAt", async () => {
    const db = getDb();
    const rovenueId = `rov_setlabel_${RUN_ID}`;
    const [row] = await db
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId })
      .returning();
    expect(row!.appUserId).toBeNull();
    expect(row!.identifiedAt).toBeNull();

    const appUserId = `customer_label_${RUN_ID}`;
    const identifiedAt = new Date();
    await setAppUserId(db, row!.id, appUserId, identifiedAt);

    const after = await findSubscriberByRovenueId(db, {
      projectId: PROJECT_ID,
      rovenueId,
    });
    expect(after?.appUserId).toBe(appUserId);
    expect(after?.identifiedAt).not.toBeNull();
    expect(after?.identifiedAt?.getTime()).toBe(identifiedAt.getTime());
  });
});
