// =============================================================
// integrations-deliver — e2e identityContext test (M7.6)
// =============================================================
//
// Verifies the full PII-hashing pipeline:
//   1. Write an outbox row with identityContext.email = "  USER@Example.com "
//      (mixed case + leading/trailing whitespace) — this simulates what the
//      POST /v1/events route does under the hood.
//   2. Enqueue a BullMQ deliver job pointing at that outbox row.
//   3. The worker picks it up, calls Meta CAPI.
//   4. The intercepted POST body carries user_data.em[0] === hashPii("user@example.com")
//      (lowercased + trimmed) and client_ip_address === "1.2.3.4".
//   5. The integration_deliveries row ends up as "succeeded".
//
// HTTP calls are intercepted by undici MockAgent — no real network traffic.
// Requires live Postgres (5433) + Redis (6380) matching docker-compose.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher } from "undici";
import { drizzle as drizzleNs } from "@rovenue/db";
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
import { hashPii } from "../services/integrations/hash-pii";

// ---------------------------------------------------------------------------
// Env defaults (runnable in isolation)
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

const metaPool = mockAgent.get("https://graph.facebook.com");

// ---------------------------------------------------------------------------
// Database + schema
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

// Seeded IDs
let PROJECT_ID: string;
let CONNECTION_ID: string;
const PIXEL_ID = "e2e_pii_pixel_001";
const ACCESS_TOKEN = "e2e_pii_access_token";

// BullMQ
let queue: Queue<IntegrationsDeliverJob>;
let queueConn: Redis;
let workerHandle: WorkerHandle;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Poll integration_deliveries until the row leaves pending or we time out. */
async function pollDelivery(
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
    .values({ name: `e2e-pii-hash-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed integration_connection (META_CAPI)
  CONNECTION_ID = createId();
  const credentialsCipher = encrypt(
    JSON.stringify({ pixel_id: PIXEL_ID, access_token: ACCESS_TOKEN }),
    ENCRYPTION_KEY,
  );
  await testDb.insert(schema.integrationConnections).values({
    id: CONNECTION_ID,
    projectId: PROJECT_ID,
    providerId: "META_CAPI",
    displayName: "E2E PII Hash Test — Meta CAPI",
    credentialsCipher,
    credentialsHint: `pixel ${PIXEL_ID.slice(0, 4)}...`,
    enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL", "subscription.trial.started"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });

  // 3. Boot worker
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

describe("integrations-deliver worker — identityContext PII hashing (e2e)", () => {
  it(
    "hashes email (lowercase + trim) and forwards ip verbatim to Meta CAPI",
    async () => {
      // -----------------------------------------------------------------------
      // 1. Write the outbox row directly (simulates POST /v1/events).
      //    The raw identityContext contains mixed case + whitespace in email.
      // -----------------------------------------------------------------------
      const outboxEventId = createId();

      await testDb.insert(schema.outboxEvents).values({
        id: outboxEventId,
        aggregateType: "REVENUE_EVENT",
        aggregateId: PROJECT_ID,
        eventType: "revenue.event.recorded",
        payload: {
          eventType: "revenue.event.recorded",
          occurredAt: new Date().toISOString(),
          subscriberId: `sub_${createId()}`,
          amount: "9.99",
          currency: "USD",
          identityContext: {
            email: "  USER@Example.com ",
            ip: "1.2.3.4",
          },
        } as Record<string, unknown>,
      });

      // -----------------------------------------------------------------------
      // 2. Set up MockAgent intercept that captures the POST body.
      // -----------------------------------------------------------------------
      let capturedBody: Record<string, unknown> | undefined;

      metaPool
        .intercept({
          path: (p: string) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
          method: "POST",
        })
        .reply((opts) => {
          try {
            capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          } catch {
            capturedBody = {};
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ events_received: 1 }),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        });

      // -----------------------------------------------------------------------
      // 3. Enqueue the BullMQ deliver job (normally pushed by fanout worker
      //    after Kafka; we push directly since Kafka isn't running in tests).
      // -----------------------------------------------------------------------
      const jobId = buildIntegrationsDeliverJobId(CONNECTION_ID, outboxEventId);
      const job: IntegrationsDeliverJob = {
        connectionId: CONNECTION_ID,
        projectId: PROJECT_ID,
        providerId: "META_CAPI",
        envelope: {
          outboxEventId,
          projectId: PROJECT_ID,
          eventType: "revenue.event.recorded",
          revenueEventKind: "INITIAL",
          occurredAt: new Date().toISOString(),
          amount: "9.99",
          currency: "USD",
          subscriberId: `sub_${createId()}`,
          identityContext: {
            email: "  USER@Example.com ",
            ip: "1.2.3.4",
          },
        },
      };

      await queue.add("deliver", job, { jobId, attempts: 5 });

      // -----------------------------------------------------------------------
      // 4. Wait for the delivery row to reach a terminal state.
      // -----------------------------------------------------------------------
      const row = await pollDelivery(outboxEventId);
      expect(row, "delivery row should exist").toBeDefined();
      expect(row!.status).toBe("succeeded");

      // -----------------------------------------------------------------------
      // 5. Assert the body sent to Meta CAPI hashed the email correctly.
      //    hashPii("user@example.com") is the expected value because the worker
      //    must lowercase + trim before SHA-256.
      // -----------------------------------------------------------------------
      expect(capturedBody, "Meta CAPI POST body should have been captured").toBeDefined();

      const data = capturedBody!.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data) && data.length > 0).toBe(true);

      const userData = data[0]!.user_data as Record<string, unknown>;
      expect(userData).toBeDefined();

      // email → SHA-256(lowercase + trim)
      expect(userData.em).toEqual([hashPii("user@example.com")]);

      // ip forwarded verbatim (not hashed)
      expect(userData.client_ip_address).toBe("1.2.3.4");
    },
    30_000,
  );
});
