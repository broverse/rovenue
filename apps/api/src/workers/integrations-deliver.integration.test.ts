// =============================================================
// integrations-deliver — end-to-end integration test (M2.7)
// =============================================================
//
// Boots the real BullMQ worker against live Postgres + Redis
// (docker-compose host ports 5433 / 6380).  HTTP calls to
// Meta CAPI are intercepted by undici MockAgent so no network
// traffic leaves the machine.
//
// Scenarios:
//   1. success     — worker delivers, row status = 'succeeded'
//   2. skip        — no user data → skip row, outcome = 'skipped'
//   3. replay      — same jobId twice → only one delivery row
//   4. dead_letter — 401 response, non-retriable → 'dead_letter'
//
// The test bypasses Kafka entirely; it adds jobs directly into
// the BullMQ queue and lets the worker pick them up.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq, desc } from "drizzle-orm";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher } from "undici";
import { drizzle as drizzleNs, getDb } from "@rovenue/db";
import { encrypt } from "@rovenue/shared/crypto";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildIntegrationsDeliverJobId,
  type IntegrationsDeliverJob,
} from "../queues/integrations";
import {
  ensureIntegrationsDeliverWorker,
  type WorkerHandle,
} from "./integrations-deliver";

// ---------------------------------------------------------------------------
// Env (tests/setup.ts has defaults; this belt-and-braces guard keeps the
// file runnable in isolation via `pnpm --filter @rovenue/api test --`).
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.ENCRYPTION_KEY ??=
  "6ecfcd0f73d5afe055ff651e0e4ce85679cdd12bb4cede7aa4338b693047b8f1";

const REDIS_URL = process.env.REDIS_URL!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

// ---------------------------------------------------------------------------
// undici MockAgent — intercepts all outbound HTTP from createUndiciHttpClient
// ---------------------------------------------------------------------------
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);

const metaPool = mockAgent.get("https://graph.facebook.com");

// ---------------------------------------------------------------------------
// Database + schema
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

// IDs seeded in beforeAll
let PROJECT_ID: string;
let CONNECTION_ID: string;
const PIXEL_ID = "test_pixel_123";
const ACCESS_TOKEN = "test_access_token";

// BullMQ queue + worker
let queue: Queue<IntegrationsDeliverJob>;
let queueConn: Redis;
let workerHandle: WorkerHandle;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildEnvelope(
  outboxEventId: string,
  withUserData = true,
): IntegrationsDeliverJob["envelope"] {
  return {
    outboxEventId,
    projectId: PROJECT_ID,
    eventType: "revenue.event.recorded",
    revenueEventKind: "INITIAL",
    occurredAt: new Date().toISOString(),
    amount: "9.99",
    currency: "USD",
    subscriberId: `sub_${createId()}`,
    identityContext: withUserData
      ? { email: "test@example.com", externalId: "uid_abc123" }
      : undefined,
  };
}

/** Poll the integration_deliveries table until a matching row appears or timeout. */
async function pollDelivery(
  connectionId: string,
  outboxEventId: string,
  timeoutMs = 15_000,
): Promise<(typeof schema.integrationDeliveries)["$inferSelect"] | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await testDb
      .select()
      .from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.outboxEventId, outboxEventId))
      .limit(1);
    if (row && row.status !== "pending") return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Return even a pending row if we timed out — caller will assert
  const [row] = await testDb
    .select()
    .from(schema.integrationDeliveries)
    .where(eq(schema.integrationDeliveries.outboxEventId, outboxEventId))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  // 1. Seed project
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `integration-deliver-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed integration_connection with encrypted credentials
  CONNECTION_ID = createId();
  const credentialsCipher = encrypt(
    JSON.stringify({ pixel_id: PIXEL_ID, access_token: ACCESS_TOKEN }),
    ENCRYPTION_KEY,
  );
  await testDb.insert(schema.integrationConnections).values({
    id: CONNECTION_ID,
    projectId: PROJECT_ID,
    providerId: "META_CAPI",
    displayName: "Test Meta CAPI",
    credentialsCipher,
    credentialsHint: `pixel ${PIXEL_ID.slice(0, 4)}...`,
    enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL", "subscription.trial.started"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });

  // 3. Boot worker (uses its own internal Redis connection)
  workerHandle = await ensureIntegrationsDeliverWorker({ autoStart: true });

  // 4. Queue for adding test jobs
  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<IntegrationsDeliverJob>(INTEGRATIONS_DELIVER_QUEUE_NAME, {
    connection: queueConn,
  });
}, 30_000);

afterAll(async () => {
  await workerHandle.stop();
  await queue.close();
  await queueConn.quit();
  mockAgent.deactivate();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integrations-deliver worker (e2e)", () => {
  it("success: delivers event and writes succeeded row", async () => {
    const outboxEventId = `e2e-success-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
    const job: IntegrationsDeliverJob = {
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      providerId: "META_CAPI",
      envelope: buildEnvelope(outboxEventId, true),
    };

    // Stub Meta CAPI → 200
    metaPool
      .intercept({
        path: (p) =>
          p.startsWith(`/v18.0/${PIXEL_ID}/events`),
        method: "POST",
      })
      .reply(200, JSON.stringify({ events_received: 1 }), {
        headers: { "content-type": "application/json" },
      });

    await queue.add("deliver", job, { jobId, attempts: 5 });

    const row = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("succeeded");
    expect(row!.httpStatus).toBe(200);
    expect(row!.connectionId).toBe(CONNECTION_ID);
  }, 30_000);

  it("skip: no user data → writes skipped row", async () => {
    const outboxEventId = `e2e-skip-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
    const job: IntegrationsDeliverJob = {
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      providerId: "META_CAPI",
      envelope: buildEnvelope(outboxEventId, false /* no user data */),
    };

    await queue.add("deliver", job, { jobId, attempts: 5 });

    const row = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("skipped");
    expect(row!.skipReason).toBe("no_user_data");
  }, 30_000);

  it("replay/dedupe: second job with same jobId produces only one delivery row", async () => {
    const outboxEventId = `e2e-replay-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
    const job: IntegrationsDeliverJob = {
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      providerId: "META_CAPI",
      envelope: buildEnvelope(outboxEventId, true),
    };

    // Stub Meta CAPI — only one delivery should happen due to BullMQ jobId dedup
    metaPool
      .intercept({
        path: (p) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
        method: "POST",
      })
      .reply(200, JSON.stringify({ events_received: 1 }), {
        headers: { "content-type": "application/json" },
      })
      .times(1);

    // Add twice with same jobId — BullMQ dedupes at the queue level
    await queue.add("deliver", job, { jobId, attempts: 5 });
    await queue.add("deliver", job, { jobId, attempts: 5 }).catch(() => undefined);

    const row = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("succeeded");

    // Only one delivery row should exist for this outboxEventId
    const rows = await testDb
      .select()
      .from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.outboxEventId, outboxEventId));
    expect(rows.length).toBe(1);
  }, 30_000);

  it("dead_letter: 401 response marks row as dead_letter", async () => {
    const outboxEventId = `e2e-dead-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
    const job: IntegrationsDeliverJob = {
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      providerId: "META_CAPI",
      envelope: buildEnvelope(outboxEventId, true),
    };

    // Stub Meta CAPI → 401 (non-retriable)
    metaPool
      .intercept({
        path: (p) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
        method: "POST",
      })
      .reply(401, JSON.stringify({ error: { message: "Invalid token" } }), {
        headers: { "content-type": "application/json" },
      });

    await queue.add("deliver", job, { jobId, attempts: 5 });

    const row = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("dead_letter");
    expect(row!.httpStatus).toBe(401);
  }, 30_000);

  it("dead_letter case writes an audit_logs row", async () => {
    const outboxEventId = `e2e-audit-dead-${createId()}`;
    const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
    const job: IntegrationsDeliverJob = {
      connectionId: CONNECTION_ID,
      projectId: PROJECT_ID,
      providerId: "META_CAPI",
      envelope: buildEnvelope(outboxEventId, true),
    };

    // Stub Meta CAPI → 401 (non-retriable) so the job dead-letters
    metaPool
      .intercept({
        path: (p) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
        method: "POST",
      })
      .reply(401, JSON.stringify({ error: { message: "Unauthorized" } }), {
        headers: { "content-type": "application/json" },
      });

    await queue.add("deliver", job, { jobId, attempts: 5 });

    // Wait for the delivery row to be written first
    const deliveryRow = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(deliveryRow).toBeDefined();
    expect(deliveryRow!.status).toBe("dead_letter");

    // Poll for the audit_logs row (audit() is async after updateDeliveryStatus)
    const start = Date.now();
    let hit: (typeof schema.auditLogs)["$inferSelect"] | undefined;
    while (Date.now() - start < 10_000) {
      const audits = await testDb
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.projectId, PROJECT_ID))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(10);
      hit = audits.find((a) => a.action === "integration.delivery.dead_letter" && a.resourceId === CONNECTION_ID);
      if (hit) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(hit).toBeDefined();
    expect(hit?.resourceId).toBe(CONNECTION_ID);
  }, 30_000);
});
