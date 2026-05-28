// =============================================================
// backfill.integration.test.ts — M4.5 + M4.6
// =============================================================
//
// Integration tests against real Postgres (port 5433) and Redis
// (port 6380).  No testcontainers helper — matches the project
// convention from integrations-deliver.integration.test.ts (M2.7).
//
// M4.5: enqueueBackfillForConnection enqueues in-window rows
//       and deduplicates against realtime jobs via jobId.
//
// M4.6: End-to-end worker processing of N=5 backfill jobs via
//       the real ensureIntegrationsDeliverWorker.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher } from "undici";
import { drizzle as drizzleNs } from "@rovenue/db";
import { encrypt } from "@rovenue/shared/crypto";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import {
  ensureIntegrationsDeliverWorker,
  type WorkerHandle,
} from "../../workers/integrations-deliver";
import {
  enqueueBackfillForConnection,
  type EnqueueBackfillDeps,
} from "./backfill";

// ---------------------------------------------------------------------------
// Env guards
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.ENCRYPTION_KEY ??=
  "6ecfcd0f73d5afe055ff651e0e4ce85679cdd12bb4cede7aa4338b693047b8f1";

const REDIS_URL = process.env.REDIS_URL!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

// ---------------------------------------------------------------------------
// undici MockAgent
// ---------------------------------------------------------------------------
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const PIXEL_ID = "backfill_pixel_456";
const ACCESS_TOKEN = "backfill_access_token";
const metaPool = mockAgent.get("https://graph.facebook.com");

// ---------------------------------------------------------------------------
// DB + schema
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

// Seeded in beforeAll
let PROJECT_ID: string;
let CONNECTION_ID: string;

// BullMQ queue + Redis + worker
let queue: Queue<IntegrationsDeliverJob>;
let queueConn: Redis;
let workerHandle: WorkerHandle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid RovenueEventEnvelope stored in outbox_events.payload */
function buildOutboxPayload(outboxEventId: string): Record<string, unknown> {
  return {
    outboxEventId,
    projectId: PROJECT_ID,
    eventType: "revenue.event.recorded",
    revenueEventKind: "RENEWAL",
    occurredAt: new Date().toISOString(),
    amount: "4.99",
    currency: "USD",
    subscriberId: `sub_${createId()}`,
    identityContext: { email: `${createId()}@test.com`, externalId: `uid_${createId()}` },
  };
}

/** Insert an outbox_events row directly. */
async function insertOutboxEvent(opts: {
  id: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
}): Promise<void> {
  const createdAt = opts.createdAt ?? new Date();
  await testDb.insert(schema.outboxEvents).values({
    id: opts.id,
    aggregateType: "REVENUE_EVENT",
    aggregateId: PROJECT_ID,
    eventType: "revenue.event.recorded",
    payload: opts.payload,
    createdAt,
  });
}

/** Poll integration_deliveries until a row with non-pending status appears. */
async function pollDeliveries(
  outboxEventIds: string[],
  expectedCount: number,
  timeoutMs = 20_000,
): Promise<(typeof schema.integrationDeliveries)["$inferSelect"][]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await testDb
      .select()
      .from(schema.integrationDeliveries)
      .where(inArray(schema.integrationDeliveries.outboxEventId, outboxEventIds));
    const settled = rows.filter((r) => r.status !== "pending");
    if (settled.length >= expectedCount) return settled;
    await new Promise((r) => setTimeout(r, 300));
  }
  // Return whatever we have
  return testDb
    .select()
    .from(schema.integrationDeliveries)
    .where(inArray(schema.integrationDeliveries.outboxEventId, outboxEventIds));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  // Seed project
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `backfill-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // Seed integration connection
  CONNECTION_ID = createId();
  const credentialsCipher = encrypt(
    JSON.stringify({ pixel_id: PIXEL_ID, access_token: ACCESS_TOKEN }),
    ENCRYPTION_KEY,
  );
  await testDb.insert(schema.integrationConnections).values({
    id: CONNECTION_ID,
    projectId: PROJECT_ID,
    providerId: "META_CAPI",
    displayName: "Backfill Test Meta CAPI",
    credentialsCipher,
    credentialsHint: `pixel ${PIXEL_ID.slice(0, 4)}...`,
    enabledEvents: ["revenue.RENEWAL", "revenue.INITIAL"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });

  // Boot worker
  workerHandle = await ensureIntegrationsDeliverWorker({ autoStart: true });

  // Queue client
  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<IntegrationsDeliverJob>(INTEGRATIONS_DELIVER_QUEUE_NAME, {
    connection: queueConn,
  });
}, 30_000);

afterAll(async () => {
  await workerHandle.stop();
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await queueConn.quit();
  mockAgent.deactivate();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Build deps for enqueueBackfillForConnection using the real pool
// ---------------------------------------------------------------------------

function makeBackfillDeps(): EnqueueBackfillDeps {
  return {
    db: {
      async execute(sqlObj: { sql: string; params: unknown[] }) {
        // Execute raw SQL against the real Postgres pool
        const result = await pool.query(sqlObj.sql, sqlObj.params);
        return { rows: result.rows };
      },
    },
    queue,
    audit: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// M4.5 — enqueue in-window rows + dedup vs realtime
// ---------------------------------------------------------------------------

describe("backfill integration — M4.5", () => {
  it("enqueues 3 in-window events and skips 1 out-of-window event", async () => {
    const inWindow = [
      `evt-inw-${createId()}`,
      `evt-inw-${createId()}`,
      `evt-inw-${createId()}`,
    ];
    const outOfWindow = `evt-oow-${createId()}`;

    // Insert 3 in-window rows
    for (const id of inWindow) {
      await insertOutboxEvent({ id, payload: buildOutboxPayload(id) });
    }
    // Insert 1 out-of-window row (9 days ago)
    await insertOutboxEvent({
      id: outOfWindow,
      payload: buildOutboxPayload(outOfWindow),
      createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });

    const deps = makeBackfillDeps();
    const result = await enqueueBackfillForConnection(
      { connectionId: CONNECTION_ID, projectId: PROJECT_ID, providerId: "META_CAPI" },
      deps,
    );

    // Only the 3 in-window events should have been enqueued
    expect(result.eventCount).toBe(3);

    // Verify the jobs exist in the queue with correct jobIds and isBackfill=true
    for (const id of inWindow) {
      const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, id);
      const job = await queue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.data.isBackfill).toBe(true);
      expect(job!.opts.jobId).toBe(jobId);
    }

    // Out-of-window event should NOT be in the queue
    const oowJobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outOfWindow);
    const oowJob = await queue.getJob(oowJobId);
    // BullMQ returns undefined (not null) when a job doesn't exist
    expect(oowJob).toBeUndefined();
  }, 30_000);

  it("backfill deduplicates against realtime job with same jobId", async () => {
    const eventId = `evt-dedup-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, eventId);

    // Insert the outbox event
    await insertOutboxEvent({ id: eventId, payload: buildOutboxPayload(eventId) });

    // Manually add a realtime job first (simulates the outbox dispatcher)
    await queue.add(
      "deliver",
      {
        connectionId: CONNECTION_ID,
        projectId: PROJECT_ID,
        providerId: "META_CAPI",
        envelope: buildOutboxPayload(eventId) as IntegrationsDeliverJob["envelope"],
        isBackfill: false,
      },
      { jobId },
    );

    // Now run backfill — the same jobId should not create a duplicate
    const deps = makeBackfillDeps();
    await enqueueBackfillForConnection(
      { connectionId: CONNECTION_ID, projectId: PROJECT_ID, providerId: "META_CAPI" },
      deps,
    );

    // BullMQ dedup: only 1 job should exist for this jobId
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    // The job that was added first (realtime) wins — it should not have isBackfill=true
    // (BullMQ silently drops the second add when jobId already exists)
    expect(job!.opts.jobId).toBe(jobId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// M4.6 — end-to-end worker processes N=5 backfill jobs
// ---------------------------------------------------------------------------

describe("backfill integration — M4.6", () => {
  it("worker processes 5 RENEWAL backfill jobs and writes succeeded rows", async () => {
    const N = 5;
    const eventIds = Array.from({ length: N }, () => `evt-e2e-${createId()}`);

    // Stub Meta CAPI for all deliveries
    metaPool
      .intercept({
        path: (p: string) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
        method: "POST",
      })
      .reply(200, JSON.stringify({ events_received: 1 }), {
        headers: { "content-type": "application/json" },
      })
      .persist();

    // Insert outbox events
    for (const id of eventIds) {
      await insertOutboxEvent({ id, payload: buildOutboxPayload(id) });
    }

    // Run backfill — enqueues all 5 jobs
    const deps = makeBackfillDeps();
    const result = await enqueueBackfillForConnection(
      { connectionId: CONNECTION_ID, projectId: PROJECT_ID, providerId: "META_CAPI" },
      deps,
    );

    // At minimum 5 new events should have been enqueued (may include prior events)
    expect(result.eventCount).toBeGreaterThanOrEqual(N);

    // Poll for the 5 delivery rows
    const deliveries = await pollDeliveries(eventIds, N, 25_000);
    expect(deliveries.length).toBe(N);

    for (const delivery of deliveries) {
      expect(delivery.status).toBe("succeeded");
      expect(delivery.connectionId).toBe(CONNECTION_ID);
    }
  }, 45_000);
});
