// =============================================================
// webhook-events repo — claimWebhookEvent integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Env fallback mirrors the sibling revenue-events integration suite.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects } from "../schema";
import * as webhookEventRepo from "./webhook-events";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whclaim_${RUN_ID}`;

describe("claimWebhookEvent", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `WH Claim ${RUN_ID}` });

    const input = {
      projectId: PROJECT_ID,
      source: "APPLE" as const,
      eventType: "DID_RENEW",
      storeEventId: `uuid_${RUN_ID}`,
      payload: { foo: "bar" },
    };

    const [a, b] = await Promise.all([
      webhookEventRepo.claimWebhookEvent(db, input),
      webhookEventRepo.claimWebhookEvent(db, input),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    const losers = [a, b].filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.status).toBe("PROCESSING");
  });

  it("returns null for an already-PROCESSED event", async () => {
    const db = getDb();
    const input = {
      projectId: PROJECT_ID,
      source: "APPLE" as const,
      eventType: "DID_RENEW",
      storeEventId: `uuid_done_${RUN_ID}`,
      payload: {},
    };
    const first = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(first).not.toBeNull();
    await webhookEventRepo.updateWebhookEvent(db, first!.id, {
      status: "PROCESSED",
      processedAt: new Date(),
    });
    const second = await webhookEventRepo.claimWebhookEvent(db, input);
    expect(second).toBeNull();
  });
});
