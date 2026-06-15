// =============================================================
// claimPendingWebhooks — concurrency integration test (Task P0-3a)
//
// Verifies the atomic status-flip claim: two replicas polling the
// same cadence must NOT both claim the same row. The CTE flips due
// rows to DELIVERING under `FOR UPDATE … SKIP LOCKED` in one
// statement, so a claimed row is invisible to a second caller's
// `status IN ('PENDING','FAILED')` predicate before any HTTP runs.
//
// Infrastructure notes (see scheduled-actions.integration.test.ts):
//   - No withTestDb helper exists; we use getDb() and insert inline.
//   - Runs against dev Postgres (docker-compose host port 5433)
//     configured in apps/api/tests/setup.ts. SKIP LOCKED needs real
//     Postgres MVCC, so this can't run on the SQLite engine.
//   - Rows are keyed by a unique RUN_ID so parallel runs / re-runs
//     against the shared dev DB don't collide.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  outgoingWebhooks,
  projects,
  subscribers,
  drizzle,
} from "@rovenue/db";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whclaim_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_whclaim_${RUN_ID}`;

async function seed(): Promise<string[]> {
  const db = getDb();
  await db.insert(projects).values({
    id: PROJECT_ID,
    name: `Webhook Claim Test ${RUN_ID}`,
    webhookSecret: `whsec_${RUN_ID}`,
  });
  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `app_user_whclaim_${RUN_ID}`,
    appUserId: `app_user_whclaim_${RUN_ID}`,
  });

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `ogw_whclaim_${RUN_ID}_${i}`;
    ids.push(id);
    await db.insert(outgoingWebhooks).values({
      id,
      projectId: PROJECT_ID,
      eventType: "test.event",
      subscriberId: SUBSCRIBER_ID,
      purchaseId: null,
      payload: { i },
      url: "https://example.test/hook",
      status: "PENDING",
      attempts: 0,
    });
  }
  return ids;
}

afterAll(async () => {
  const db = getDb();
  // FK cascade from projects deletes subscribers + outgoing_webhooks.
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("claimPendingWebhooks — concurrent claim is disjoint", () => {
  it("two concurrent claims partition the 3 PENDING rows with no overlap, all DELIVERING", async () => {
    const db = getDb();
    const seededIds = await seed();
    const now = new Date();

    // Two concurrent claim calls racing for the same batch. With a
    // pre-flip-claim bug both could grab all 3 rows; the atomic
    // status flip makes the second caller's predicate miss claimed rows.
    const [claimA, claimB] = await Promise.all([
      drizzle.outgoingWebhookRepo.claimPendingWebhooks(db, now, 50),
      drizzle.outgoingWebhookRepo.claimPendingWebhooks(db, now, 50),
    ]);

    const idsA = new Set(claimA.map((r) => r.id));
    const idsB = new Set(claimB.map((r) => r.id));

    // Disjoint: no row claimed by both callers.
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }

    // Together they claimed exactly our 3 seeded rows (no more, no less).
    const claimedOurs = [...claimA, ...claimB]
      .map((r) => r.id)
      .filter((id) => seededIds.includes(id));
    expect(new Set(claimedOurs).size).toBe(3);

    // The joined project webhook secret rode along the claim.
    for (const row of [...claimA, ...claimB].filter((r) =>
      seededIds.includes(r.id),
    )) {
      expect(row.projectWebhookSecret).toBe(`whsec_${RUN_ID}`);
    }

    // Every seeded row is now DELIVERING with a claimedAt stamp.
    const rows = await db
      .select()
      .from(outgoingWebhooks)
      .where(eq(outgoingWebhooks.projectId, PROJECT_ID));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("DELIVERING");
      expect(row.claimedAt).not.toBeNull();
    }
  });
});
