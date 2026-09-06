// =============================================================
// POST /v1/events on an ERASED subscriber — integration tests
// =============================================================
//
// Closes the missing-coverage gap from the Task 1 review: the guard
// added around line 165 of events.ts (resolveOrCreateSubscriber's
// `deadEnded` flag) had no test at all. Reverting it left the suite
// green, which is exactly the failure mode a self-confirming test
// suite has -- nothing here proved the guard did anything.
//
// paywall_* events are the only ones that resolve a subscriber at all
// (see events.ts's `body.eventType.startsWith("paywall_")` branch), so
// that is the only event type that can exercise this guard.
//
// The event still flows to the outbox either way -- dropping it would
// distort the project's own paywall-funnel aggregates -- but for an
// erased subject it must carry the RAW wire subscriberId, never the
// resolved (project-owned) `subscriber.id`. Raw and resolved ids live
// in different id spaces (rovenueId vs. cuid2 database id), so leaving
// the raw value in place makes the row structurally unable to join
// back to the subscriber elsewhere, i.e. "unattributed" rather than
// re-linking analytics to someone who asked to be forgotten.
//
// Erasure runs through the REAL `anonymizeSubscriber` service, not a
// hand-crafted soft delete -- matching me-dead-ended.integration.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq, desc } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { anonymizeSubscriber } from "../../services/gdpr/anonymize-subscriber";
import { eventsRoute } from "./events";

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
// anonymizeSubscriber derives its anonymous id by HMAC with the master
// key, so the service refuses to run without one.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;
let ACTOR_USER_ID: string;
let ERASED_SUBSCRIBER_DB_ID: string;
let LIVE_SUBSCRIBER_DB_ID: string;

const RUN = createId().slice(0, 8);
const ERASED_ROVENUE_ID = `evt-erased-${RUN}`;
const LIVE_ROVENUE_ID = `evt-live-${RUN}`;

function buildApp() {
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/events", eventsRoute)
    .onError(errorHandler);
}

function postPaywallView(subscriberId: string, placementId: string) {
  return buildApp().request("/v1/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PUBLIC_KEY}`,
    },
    body: JSON.stringify({
      eventType: "paywall_view",
      occurredAt: new Date().toISOString(),
      subscriberId,
      paywallContext: {
        paywallId: `pw_${RUN}`,
        placementId,
        placementRevision: 1,
      },
    }),
  });
}

interface PaywallOutboxPayload {
  subscriberId?: string;
  paywallContext?: { placementId?: string };
}

async function latestOutboxRowFor(placementId: string) {
  const rows = await testDb
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateId, PROJECT_ID))
    .orderBy(desc(schema.outboxEvents.createdAt))
    .limit(20);
  return rows.find((r) => {
    const payload = r.payload as PaywallOutboxPayload;
    return payload.paywallContext?.placementId === placementId;
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `events-dead-ended-${RUN}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });

  // anonymizeSubscriber writes an audit row, whose projectId is a real
  // FK and whose actor is a real user id.
  const [user] = await testDb
    .insert(schema.user)
    .values({
      id: createId(),
      name: "dsar actor",
      email: `dsar-events-${RUN}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("seed: user insert returned no row");
  ACTOR_USER_ID = user.id;

  const [erased] = await testDb
    .insert(schema.subscribers)
    .values({ projectId: PROJECT_ID, rovenueId: ERASED_ROVENUE_ID })
    .returning();
  if (!erased) throw new Error("seed: erased subscriber insert returned no row");
  ERASED_SUBSCRIBER_DB_ID = erased.id;

  const [live] = await testDb
    .insert(schema.subscribers)
    .values({ projectId: PROJECT_ID, rovenueId: LIVE_ROVENUE_ID })
    .returning();
  if (!live) throw new Error("seed: live subscriber insert returned no row");
  LIVE_SUBSCRIBER_DB_ID = live.id;

  await anonymizeSubscriber({
    subscriberId: erased.id,
    projectId: PROJECT_ID,
    actorUserId: ACTOR_USER_ID,
    reason: "gdpr_request",
  });
}, 30_000);

afterAll(async () => {
  await testDb
    .delete(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateId, PROJECT_ID));
  await testDb
    .delete(schema.auditLogs)
    .where(eq(schema.auditLogs.projectId, PROJECT_ID));
  await testDb
    .delete(schema.subscribers)
    .where(eq(schema.subscribers.projectId, PROJECT_ID));
  await testDb.delete(schema.projects).where(eq(schema.projects.id, PROJECT_ID));
  await testDb.delete(schema.user).where(eq(schema.user.id, ACTOR_USER_ID));
  await pool.end();
});

describe("POST /v1/events (paywall_view) on an erased subscriber", () => {
  it("still accepts the event but never re-links it to the resolved subscriber id", async () => {
    const placementId = `pl_erased_${RUN}`;
    const res = await postPaywallView(ERASED_ROVENUE_ID, placementId);
    expect(res.status).toBe(202);

    const row = await latestOutboxRowFor(placementId);
    expect(row).toBeDefined();
    const payload = row!.payload as Record<string, unknown>;
    // The raw wire id, NOT the resolved database id -- resolving it would
    // re-link paywall-funnel analytics to a subscriber who asked to be
    // forgotten, un-erasing them through a second (read-only-looking) path.
    expect(payload.subscriberId).toBe(ERASED_ROVENUE_ID);
    expect(payload.subscriberId).not.toBe(ERASED_SUBSCRIBER_DB_ID);
  });

  it("resolves to the project-owned subscriber id for a live subscriber", async () => {
    // The mirror. Without it the test above passes against a route that
    // never resolves ANY subscriber, guarded or not.
    const placementId = `pl_live_${RUN}`;
    const res = await postPaywallView(LIVE_ROVENUE_ID, placementId);
    expect(res.status).toBe(202);

    const row = await latestOutboxRowFor(placementId);
    expect(row).toBeDefined();
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.subscriberId).toBe(LIVE_SUBSCRIBER_DB_ID);
    expect(payload.subscriberId).not.toBe(LIVE_ROVENUE_ID);
  });
});
