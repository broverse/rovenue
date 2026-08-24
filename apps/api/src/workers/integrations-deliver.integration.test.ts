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

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  buildIntegrationsDeliverJobId,
  deliverJobOptions,
  type IntegrationsDeliverJob,
} from "../queues/integrations";
import {
  ensureIntegrationsDeliverWorker,
  type WorkerHandle,
} from "./integrations-deliver";
import { hashPii, normalizeEmail } from "../services/integrations/hash-pii";
import { generateWebhookSecret } from "../lib/svix-sign";
import type { WebhookSecretEntry } from "../services/integrations/providers/custom-webhook";

// ---------------------------------------------------------------------------
// Env (tests/setup.ts has defaults; this belt-and-braces guard keeps the
// file runnable in isolation via `pnpm --filter @rovenue/api test --`).
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");

const REDIS_URL = process.env.REDIS_URL!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

// Unique per-file queue name — vitest runs these real-infra test files in
// parallel threads; a shared queue name lets one thread's worker steal
// another thread's jobs (see task-1-brief.md).
const TEST_QUEUE_NAME = `rovenue-integrations-deliver-test-${createId()}`;

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

const LOOPBACK_HOST = "127.0.0.1";

interface WebhookTestServer {
  port: number;
  requests: string[];
  close: () => Promise<void>;
}

/** Real local HTTP server on 127.0.0.1 — CUSTOM_WEBHOOK's deliver() bypasses
 *  the process-global undici dispatcher (it builds its own pinned Agent, see
 *  lib/ssrf-guard.ts), so a webhook delivery test needs a real listener
 *  rather than a MockAgent intercept. Mirrors the pattern in
 *  workers/integrations-webhook.e2e.integration.test.ts. */
function startWebhookServer(): Promise<WebhookTestServer> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk));
      req.on("end", () => {
        requests.push(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      });
    });
    server.listen(0, LOOPBACK_HOST, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
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
  workerHandle = await ensureIntegrationsDeliverWorker({ autoStart: true, queueName: TEST_QUEUE_NAME });

  // 4. Queue for adding test jobs
  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<IntegrationsDeliverJob>(TEST_QUEUE_NAME, {
    connection: queueConn,
  });
}, 30_000);

const webhookServersToClose: WebhookTestServer[] = [];

afterAll(async () => {
  await workerHandle.stop();
  await queue.close();
  await queueConn.quit();
  mockAgent.deactivate();
  await Promise.all(webhookServersToClose.map((s) => s.close()));
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

    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));

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

    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));

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
    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));
    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId)).catch(() => undefined);

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

    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));

    const row = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("dead_letter");
    expect(row!.httpStatus).toBe(401);
  }, 30_000);

  it("dead_letter: 401 response also writes a dead-letter project notification to the outbox", async () => {
    const outboxEventId = `e2e-dead-notify-${createId()}`;
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
      .reply(401, JSON.stringify({ error: { message: "Invalid token" } }), {
        headers: { "content-type": "application/json" },
      });

    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));

    const deliveryRow = await pollDelivery(CONNECTION_ID, outboxEventId);
    expect(deliveryRow).toBeDefined();
    expect(deliveryRow!.status).toBe("dead_letter");

    // Poll for the NOTIFICATION outbox row emitted alongside the audit write.
    const start = Date.now();
    let hit: (typeof schema.outboxEvents)["$inferSelect"] | undefined;
    while (Date.now() - start < 10_000) {
      const rows = await testDb
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.eventType, "integration.delivery.dead_letter"))
        .orderBy(desc(schema.outboxEvents.createdAt))
        .limit(10);
      hit = rows.find(
        (r) =>
          r.aggregateType === "NOTIFICATION" &&
          (r.payload as { context?: { connectionId?: string } } | null)?.context
            ?.connectionId === CONNECTION_ID,
      );
      if (hit) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(hit).toBeDefined();
    expect(hit!.aggregateType).toBe("NOTIFICATION");
    expect(hit!.aggregateId).toBe(PROJECT_ID);
    expect(hit!.payload).toMatchObject({
      eventKey: "integration.delivery.dead_letter",
      context: {
        projectId: PROJECT_ID,
        connectionId: CONNECTION_ID,
        providerId: "META_CAPI",
        displayName: "Test Meta CAPI",
      },
    });
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

    await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));

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

  // -----------------------------------------------------------------------
  // Task 2 — delivery-time subscriber identity enrichment
  // -----------------------------------------------------------------------
  it(
    "enriches Meta CAPI with the subscriber's $email attribute while CUSTOM_WEBHOOK never sees it",
    async () => {
      // 1. Seed a subscriber with $email (nested AttributeEntry shape, as
      //    written by applyMutations) but NO identityContext.email on the
      //    envelope itself — the worker must backfill it at delivery time.
      const rawEmail = "hidden-subscriber@example.com";
      const nowIso = new Date().toISOString();
      const [subscriber] = await testDb
        .insert(schema.subscribers)
        .values({
          projectId: PROJECT_ID,
          rovenueId: `rov_${createId()}`,
          appUserId: `app_${createId()}`,
          attributes: {
            $email: { value: rawEmail, updatedAt: nowIso, source: "sdk" },
            $appsflyerId: { value: "af-123", updatedAt: nowIso, source: "sdk" },
          },
        })
        .returning();
      if (!subscriber) throw new Error("seed: subscriber insert returned no row");

      // 2. Seed a CUSTOM_WEBHOOK connection pointed at a real local server —
      //    its deliver() bypasses the undici MockAgent (see ssrf-guard.ts).
      const webhookServer = await startWebhookServer();
      webhookServersToClose.push(webhookServer);
      const webhookSecret: WebhookSecretEntry = {
        id: createId(),
        key: generateWebhookSecret(),
        createdAt: nowIso,
      };
      const WEBHOOK_CONNECTION_ID = createId();
      await testDb.insert(schema.integrationConnections).values({
        id: WEBHOOK_CONNECTION_ID,
        projectId: PROJECT_ID,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "Test Custom Webhook — Task 2 enrichment",
        credentialsCipher: encrypt(
          JSON.stringify({
            url: `http://${LOOPBACK_HOST}:${webhookServer.port}/hook`,
            secrets: JSON.stringify([webhookSecret]),
          }),
          ENCRYPTION_KEY,
        ),
        credentialsHint: "task2-test",
        enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL"],
        eventMapping: {},
        actionSource: "app",
        isEnabled: true,
      });

      const outboxEventId = `e2e-enrich-${createId()}`;
      const envelope: IntegrationsDeliverJob["envelope"] = {
        outboxEventId,
        projectId: PROJECT_ID,
        eventType: "revenue.event.recorded",
        revenueEventKind: "INITIAL",
        occurredAt: new Date().toISOString(),
        amount: "9.99",
        currency: "USD",
        subscriberId: subscriber.id,
        // Deliberately no identityContext at all — the only path to an
        // email reaching Meta is delivery-time enrichment off the
        // subscriber's $email attribute.
      };

      // 3. Capture the Meta CAPI request body.
      let capturedMetaBody: { data?: Array<{ user_data?: { em?: string[] } }> } | undefined;
      metaPool
        .intercept({
          path: (p) => p.startsWith(`/v18.0/${PIXEL_ID}/events`),
          method: "POST",
        })
        .reply((opts) => {
          try {
            capturedMetaBody = JSON.parse(opts.body as string);
          } catch {
            capturedMetaBody = undefined;
          }
          return {
            statusCode: 200,
            data: JSON.stringify({ events_received: 1 }),
            responseOptions: { headers: { "content-type": "application/json" } },
          };
        });

      // 4a. Deliver to META_CAPI (existing suite connection).
      const metaOutboxEventId = `${outboxEventId}-meta`;
      const metaJobId = buildIntegrationsDeliverJobId(CONNECTION_ID, metaOutboxEventId);
      await queue.add(
        "deliver",
        {
          connectionId: CONNECTION_ID,
          projectId: PROJECT_ID,
          providerId: "META_CAPI",
          envelope: { ...envelope, outboxEventId: metaOutboxEventId },
        },
        deliverJobOptions("META_CAPI", metaJobId),
      );

      const metaRow = await pollDelivery(CONNECTION_ID, metaOutboxEventId);
      expect(metaRow).toBeDefined();
      expect(metaRow!.status).toBe("succeeded");
      expect(capturedMetaBody?.data?.[0]?.user_data?.em?.[0]).toBe(
        hashPii(normalizeEmail(rawEmail)),
      );

      // 4b. Deliver the SAME subscriber's event to CUSTOM_WEBHOOK — its
      //     body must contain neither the raw email nor subscriberAttributes.
      const webhookOutboxEventId = `${outboxEventId}-webhook`;
      const webhookJobId = buildIntegrationsDeliverJobId(
        WEBHOOK_CONNECTION_ID,
        webhookOutboxEventId,
      );
      await queue.add(
        "deliver",
        {
          connectionId: WEBHOOK_CONNECTION_ID,
          projectId: PROJECT_ID,
          providerId: "CUSTOM_WEBHOOK",
          envelope: { ...envelope, outboxEventId: webhookOutboxEventId },
        },
        deliverJobOptions("CUSTOM_WEBHOOK", webhookJobId),
      );

      const webhookRow = await pollDelivery(WEBHOOK_CONNECTION_ID, webhookOutboxEventId);
      expect(webhookRow).toBeDefined();
      expect(webhookRow!.status).toBe("succeeded");

      // Poll the local server for the received request body (delivery may
      // finish writing its DB row a beat before the request handler runs).
      const start = Date.now();
      while (webhookServer.requests.length === 0 && Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(webhookServer.requests.length).toBeGreaterThan(0);
      const webhookBody = webhookServer.requests[webhookServer.requests.length - 1]!;
      expect(webhookBody).not.toContain(rawEmail);
      expect(webhookBody).not.toContain("subscriberAttributes");
      expect(webhookBody).not.toContain("$email");
    },
    30_000,
  );
});
