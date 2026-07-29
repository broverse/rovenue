// =============================================================
// paywallPreviewSessionRepo — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling paywalls.integration.test.ts suite.
//
// Covers:
//   - revokePreviewSession returns null on a second (already-revoked) call,
//     rather than overwriting revokedAt again — see the doc comment on
//     revokePreviewSession in paywall-preview-sessions.ts for why that
//     matters (double-DELETE must not look like two successful revokes).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { offerings, paywalls, projects } from "../schema";
import * as previewSessionRepo from "./paywall-preview-sessions";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_preview_sessions_${RUN_ID}`;
let paywallId: string;

describe("paywallPreviewSessionRepo", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Preview Sessions ${RUN_ID}` });
    const [offering] = await db
      .insert(offerings)
      .values({ projectId: PROJECT_ID, identifier: "default", packages: [] })
      .returning();
    const [paywall] = await db
      .insert(paywalls)
      .values({
        projectId: PROJECT_ID,
        identifier: "onboarding",
        name: "Onboarding Paywall",
        offeringId: offering!.id,
      })
      .returning();
    paywallId = paywall!.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(paywalls).where(eq(paywalls.projectId, PROJECT_ID));
    await db.delete(offerings).where(eq(offerings.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("returns null when revoking an already-revoked session, instead of re-revoking it", async () => {
    const db = getDb();
    const session = await previewSessionRepo.createPreviewSession(db, {
      projectId: PROJECT_ID,
      paywallId,
      tokenHash: `hash_${RUN_ID}`,
      createdBy: "user_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const firstRevoke = await previewSessionRepo.revokePreviewSession(
      db,
      PROJECT_ID,
      session.id,
    );
    expect(firstRevoke?.id).toBe(session.id);
    expect(firstRevoke?.revokedAt).not.toBeNull();

    const secondRevoke = await previewSessionRepo.revokePreviewSession(
      db,
      PROJECT_ID,
      session.id,
    );
    expect(secondRevoke).toBeNull();
  });
});
