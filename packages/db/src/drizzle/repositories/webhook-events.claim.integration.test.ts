// =============================================================
// webhook-events repo — claimWebhookEvent lease integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../client";
import { webhookEvents, projects } from "../schema";
import * as webhookEventRepo from "./webhook-events";

const RUN_ID = Date.now();
const P = `prj_whclaim_${RUN_ID}`;
const EVID = `evt_${RUN_ID}`;

describe("claimWebhookEvent lease", () => {
  afterAll(async () => {
    const db = getDb();
    await db.delete(webhookEvents).where(sql`"projectId" = ${P}`);
    await db.delete(projects).where(sql`id = ${P}`);
  });

  it("claims a new event, blocks a fresh concurrent claim, reclaims a stale one", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "whclaim" });
    const input = { projectId: P, source: "APPLE" as const, eventType: "TEST", storeEventId: EVID, payload: {} };

    const first = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(first.outcome).toBe("claimed");

    const second = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(second.outcome).toBe("in_progress"); // fresh PROCESSING — not a duplicate

    // Backdate claimedAt past the lease, then a reclaim must succeed.
    await db.update(webhookEvents)
      .set({ claimedAt: new Date(Date.now() - 10 * 60_000) })
      .where(sql`"storeEventId" = ${EVID}`);
    const third = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(third.outcome).toBe("claimed");
  });

  it("returns duplicate once PROCESSED", async () => {
    const db = getDb();
    await db.update(webhookEvents).set({ status: "PROCESSED" }).where(sql`"storeEventId" = ${EVID}`);
    const r = await webhookEventRepo.claimWebhookEvent(db, { projectId: P, source: "APPLE", eventType: "TEST", storeEventId: EVID, payload: {} });
    expect(r.outcome).toBe("duplicate");
  });
});
