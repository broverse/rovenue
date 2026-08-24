// =============================================================
// integrations-webhook — end-to-end coverage of the money path (Task 14)
// =============================================================
//
// Boots the real BullMQ worker against live Postgres + Redis (docker-compose
// host ports 5433 / 6380), same real-infra pattern as
// workers/integrations-deliver.integration.test.ts. Unlike that file, the
// CUSTOM_WEBHOOK deliveries in here are NOT intercepted by undici MockAgent
// — customWebhookProvider.deliver() builds its own pinned undici Agent
// (createPinnedHttpClient in lib/ssrf-guard.ts) and passes it explicitly as
// `dispatcher`, so it never goes through the process-global dispatcher this
// file sets for META_CAPI. That means a real `node:http` server on
// 127.0.0.1 receives the actual HTTP request, and the SSRF guard's
// `ALLOW_PRIVATE_TARGETS = env.NODE_ENV !== "production"` (tests/setup.ts
// defaults NODE_ENV to "test") lets it through without any guard hacking.
//
// Scenarios (task-14-brief.md):
//   1. Multi-endpoint fan-out — processFanoutMessage() → 2 CUSTOM_WEBHOOK +
//      1 META_CAPI connections, each gets exactly one delivery; webhook
//      signatures independently re-verified with verifySvixSignature.
//   2. Rotation grace — a connection with 2 active secrets signs with both;
//      verifySvixSignature passes against either key.
//   3. Retriable → dead_letter → notification — a 5xx responder proves the
//      FIRST attempt writes a `failed` row and BullMQ schedules a real
//      custom-backoff retry (job inspected, then removed rather than
//      waiting through WEBHOOK_RETRY_POLICY's real backoff ladder — full
//      8-attempt exhaustion is unit-tested in integrations-deliver.unit.test.ts).
//      A separate connection then exercises the 401 (non-retriable) path
//      straight to dead_letter + audit row + NOTIFICATION outbox row.
//   4. Redeliver — a dead-lettered delivery re-run (server fixed to 200)
//      produces a brand-new succeeded row.
//   5. Paywall event — a rovenue.paywall_events wrapper message through
//      toFanoutEnvelope() delivers with payload passthrough.
//
// Choices made (stated per the brief, both to keep this file's queue
// fully isolated under TEST_QUEUE_NAME — see task-1-brief.md on why a
// shared queue name lets parallel vitest threads steal each other's jobs):
//   - Rotation (#2): the stored credentials cipher is updated directly
//     (mirroring exactly what POST .../rotate-secret produces — newest
//     entry first, old entry kept) rather than calling the dashboard
//     route. The route's own grace-window/pruning logic is already
//     covered by routes/dashboard/integrations.webhook.integration.test.ts;
//     this file is about delivery-time signing/verification, which is
//     identical either way since customWebhookProvider.deliver() always
//     signs with every entry in the stored secrets array.
//   - Redeliver (#4): enqueued directly via buildRedeliverJobId() onto
//     TEST_QUEUE_NAME rather than calling POST .../redeliver — that route
//     hardcodes INTEGRATIONS_DELIVER_QUEUE_NAME (see routes/dashboard/
//     integrations.ts), which this file's worker does NOT listen on by
//     design. Booting a second worker on the shared queue name to exercise
//     the route would reintroduce exactly the job-stealing risk Task 1
//     eliminated.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher } from "undici";
import { drizzle as drizzleNs, getDb } from "@rovenue/db";
import { encrypt } from "@rovenue/shared/crypto";
import { ROVENUE_EVENT_KEYS, WEBHOOK_API_VERSION } from "@rovenue/shared";
import type { RovenueEventKey } from "@rovenue/shared";
import {
  buildIntegrationsDeliverJobId,
  buildRedeliverJobId,
  deliverJobOptions,
  type IntegrationsDeliverJob,
} from "../queues/integrations";
import {
  ensureIntegrationsDeliverWorker,
  type WorkerHandle,
} from "./integrations-deliver";
import { createConnectionCache } from "../services/integrations-fanout/connection-cache";
import {
  processFanoutMessage,
  toFanoutEnvelope,
} from "../services/integrations-fanout/consumer";
import { outboxRowToEnvelope } from "../services/integrations/backfill";
import { verifySvixSignature } from "../lib/svix-signature";
import { generateWebhookSecret } from "../lib/svix-sign";
import type { WebhookSecretEntry } from "../services/integrations/providers/custom-webhook";
import type { RovenueEventEnvelope } from "../services/integrations/types";

// ---------------------------------------------------------------------------
// Env (tests/setup.ts has defaults; belt-and-braces guard for standalone runs).
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");

const REDIS_URL = process.env.REDIS_URL!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

// Unique per-file queue name — see workers/integrations-deliver.integration.test.ts.
const TEST_QUEUE_NAME = `rovenue-integrations-deliver-test-${createId()}`;

// ---------------------------------------------------------------------------
// undici MockAgent — intercepts only META_CAPI (createUndiciHttpClient uses
// the global dispatcher). CUSTOM_WEBHOOK bypasses this entirely (see header).
// ---------------------------------------------------------------------------
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
const metaPool = mockAgent.get("https://graph.facebook.com");
const META_PIXEL_ID = "test_pixel_e2e";
const META_ACCESS_TOKEN = "test_access_token_e2e";

// ---------------------------------------------------------------------------
// Named constants — no magic literals at call sites.
// ---------------------------------------------------------------------------
const LOOPBACK_HOST = "127.0.0.1";
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const ALL_EVENT_KEYS: RovenueEventKey[] = [...ROVENUE_EVENT_KEYS];

// ---------------------------------------------------------------------------
// Database + schema
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;
type IntegrationDeliveryRow = (typeof schema.integrationDeliveries)["$inferSelect"];
type AuditLogRow = (typeof schema.auditLogs)["$inferSelect"];
type OutboxEventRow = (typeof schema.outboxEvents)["$inferSelect"];

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;

let queue: Queue<IntegrationsDeliverJob>;
let queueConn: Redis;
let workerHandle: WorkerHandle;

interface TestServer {
  port: number;
  requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}
const serversToClose: TestServer[] = [];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function asHeaderString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function svixHeadersFrom(headers: Record<string, string | string[] | undefined>): {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
} {
  return {
    id: asHeaderString(headers["svix-id"]),
    timestamp: asHeaderString(headers["svix-timestamp"]),
    signature: asHeaderString(headers["svix-signature"]),
  };
}

/** Real local HTTP server on 127.0.0.1 with an ephemeral port. Status is
 *  mutable via setStatus() so scenario 4 can flip a dead-lettering
 *  responder to 200 for the redeliver attempt without a second server. */
function startWebhookServer(initialStatus: number): Promise<TestServer> {
  return new Promise((resolve) => {
    let status = initialStatus;
    const requests: TestServer["requests"] = [];
    const server: Server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk));
        req.on("end", () => {
          requests.push({ headers: req.headers, body: raw });
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ received: true }));
        });
      },
    );
    server.listen(0, LOOPBACK_HOST, () => {
      const port = (server.address() as AddressInfo).port;
      const handle: TestServer = {
        port,
        requests,
        setStatus: (s) => {
          status = s;
        },
        close: () => new Promise((r) => server.close(() => r())),
      };
      resolve(handle);
    });
  });
}

function secretEntry(): WebhookSecretEntry {
  return { id: createId(), key: generateWebhookSecret(), createdAt: new Date().toISOString() };
}

function webhookCreds(port: number, secrets: WebhookSecretEntry[]): Record<string, string> {
  return { url: `http://${LOOPBACK_HOST}:${port}/hook`, secrets: JSON.stringify(secrets) };
}

async function insertConnection(opts: {
  id: string;
  providerId: "CUSTOM_WEBHOOK" | "META_CAPI";
  displayName: string;
  credentials: Record<string, string>;
  enabledEvents?: RovenueEventKey[];
}): Promise<string> {
  const credentialsCipher = encrypt(JSON.stringify(opts.credentials), ENCRYPTION_KEY);
  await testDb.insert(schema.integrationConnections).values({
    id: opts.id,
    projectId: PROJECT_ID,
    providerId: opts.providerId,
    displayName: opts.displayName,
    credentialsCipher,
    credentialsHint: "e2e-test",
    enabledEvents: opts.enabledEvents ?? ALL_EVENT_KEYS,
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });
  return opts.id;
}

function revenueEnvelope(
  outboxEventId: string,
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId,
    projectId: PROJECT_ID,
    eventType: "revenue.event.recorded",
    revenueEventKind: "RENEWAL",
    occurredAt: new Date().toISOString(),
    amount: "9.99",
    currency: "USD",
    subscriberId: `sub_${createId()}`,
    identityContext: { email: "e2e-webhook@example.com", externalId: "ext-e2e" },
    ...overrides,
  };
}

/**
 * The payload a REVENUE_EVENT outbox row carries in production — field names
 * copied verbatim from createRevenueEvent's outbox emit in
 * packages/db/src/drizzle/repositories/revenue-events.ts. Deliberately NOT a
 * RovenueEventEnvelope (no outboxEventId / occurredAt / revenueEventKind).
 */
function productionRevenuePayload(): Record<string, unknown> {
  return {
    revenueEventId: `rev_${createId()}`,
    projectId: PROJECT_ID,
    subscriberId: `sub_${createId()}`,
    purchaseId: `pur_${createId()}`,
    productId: `prod_${createId()}`,
    type: "RENEWAL",
    store: "APP_STORE",
    amount: "9.9900",
    amountUsd: "9.9900",
    currency: "USD",
    eventDate: new Date().toISOString(),
  };
}

/** Enqueues a single-connection deliver job directly onto TEST_QUEUE_NAME —
 *  used by scenarios that don't go through processFanoutMessage/the cache. */
async function deliverDirect(
  connectionId: string,
  providerId: IntegrationsDeliverJob["providerId"],
  envelope: RovenueEventEnvelope,
): Promise<void> {
  const jobId = buildIntegrationsDeliverJobId(connectionId, envelope.outboxEventId);
  await queue.add(
    "deliver",
    { connectionId, projectId: PROJECT_ID, providerId, envelope },
    deliverJobOptions(providerId, jobId),
  );
}

/** Polls integration_deliveries for a row with the given (connectionId,
 *  outboxEventId, status) triple. Filters by status explicitly (rather than
 *  "latest row / not pending") so a scenario with multiple attempts on the
 *  same key (e.g. redeliver) can't race-match the earlier terminal row. */
async function pollDeliveryRowWithStatus(
  connectionId: string,
  outboxEventId: string,
  status: IntegrationDeliveryRow["status"],
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<IntegrationDeliveryRow | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await testDb
      .select()
      .from(schema.integrationDeliveries)
      .where(
        and(
          eq(schema.integrationDeliveries.connectionId, connectionId),
          eq(schema.integrationDeliveries.outboxEventId, outboxEventId),
        ),
      )
      .orderBy(desc(schema.integrationDeliveries.createdAt));
    const hit = rows.find((r) => r.status === status);
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

/** Polls for >= expectedCount delivery rows across ALL connections for one
 *  outboxEventId, all past "pending" — scenario 1's fan-out assertion. */
async function pollDeliveryRowsForOutboxEvent(
  outboxEventId: string,
  expectedCount: number,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<IntegrationDeliveryRow[]> {
  const start = Date.now();
  let rows: IntegrationDeliveryRow[] = [];
  while (Date.now() - start < timeoutMs) {
    rows = await testDb
      .select()
      .from(schema.integrationDeliveries)
      .where(eq(schema.integrationDeliveries.outboxEventId, outboxEventId));
    if (rows.length >= expectedCount && rows.every((r) => r.status !== "pending")) return rows;
    await sleep(POLL_INTERVAL_MS);
  }
  return rows;
}

async function pollAuditDeadLetter(
  connectionId: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<AuditLogRow | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await testDb
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.projectId, PROJECT_ID))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(50);
    const hit = rows.find(
      (r) => r.action === "integration.delivery.dead_letter" && r.resourceId === connectionId,
    );
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

async function pollDeadLetterNotification(
  connectionId: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<OutboxEventRow | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await testDb
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, "integration.delivery.dead_letter"))
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(50);
    const hit = rows.find(
      (r) =>
        r.aggregateType === "NOTIFICATION" &&
        (r.payload as { context?: { connectionId?: string } } | null)?.context?.connectionId ===
          connectionId,
    );
    if (hit) return hit;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `integrations-webhook-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  workerHandle = await ensureIntegrationsDeliverWorker({
    autoStart: true,
    queueName: TEST_QUEUE_NAME,
  });

  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<IntegrationsDeliverJob>(TEST_QUEUE_NAME, { connection: queueConn });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(serversToClose.map((s) => s.close()));
  await workerHandle.stop();
  await queue.close();
  await queueConn.quit();
  mockAgent.deactivate();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integrations-webhook v2 — end-to-end (money path)", () => {
  it(
    "scenario 1: multi-endpoint fan-out — 2 CUSTOM_WEBHOOK + 1 META_CAPI, each exactly one delivery, real signatures verify",
    async () => {
      const srvA = await startWebhookServer(HTTP_OK);
      const srvB = await startWebhookServer(HTTP_OK);
      serversToClose.push(srvA, srvB);

      const secretA = secretEntry();
      const secretB = secretEntry();
      const connA = createId();
      const connB = createId();
      const connMeta = createId();

      await insertConnection({
        id: connA,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "fanout-webhook-a",
        credentials: webhookCreds(srvA.port, [secretA]),
      });
      await insertConnection({
        id: connB,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "fanout-webhook-b",
        credentials: webhookCreds(srvB.port, [secretB]),
      });
      await insertConnection({
        id: connMeta,
        providerId: "META_CAPI",
        displayName: "fanout-meta",
        credentials: { pixel_id: META_PIXEL_ID, access_token: META_ACCESS_TOKEN },
      });

      metaPool
        .intercept({
          path: (p: string) => p.startsWith(`/v18.0/${META_PIXEL_ID}/events`),
          method: "POST",
        })
        .reply(200, JSON.stringify({ events_received: 1 }), {
          headers: { "content-type": "application/json" },
        });

      const db = getDb();
      const cache = createConnectionCache({
        ttlMs: 60_000,
        loader: (projectId) =>
          drizzleNs.integrationConnectionRepo.listActiveConnectionsForProject(db, projectId),
      });
      const enqueue = async (job: IntegrationsDeliverJob, jobId: string): Promise<void> => {
        await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));
      };

      const outboxEventId = createId();
      const envelope = revenueEnvelope(outboxEventId);

      await processFanoutMessage(envelope, { cache, enqueue });

      const rows = await pollDeliveryRowsForOutboxEvent(outboxEventId, 3);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === "succeeded")).toBe(true);
      expect(rows.filter((r) => r.providerId === "CUSTOM_WEBHOOK")).toHaveLength(2);
      expect(rows.filter((r) => r.providerId === "META_CAPI")).toHaveLength(1);

      for (const [server, secret] of [
        [srvA, secretA],
        [srvB, secretB],
      ] as const) {
        expect(server.requests).toHaveLength(1);
        const req = server.requests[0]!;
        expect(() =>
          verifySvixSignature(svixHeadersFrom(req.headers), req.body, secret.key),
        ).not.toThrow();

        const body = JSON.parse(req.body) as {
          type: string;
          apiVersion: string;
          data: { amount?: string };
        };
        expect(body.type).toBe("revenue.RENEWAL");
        expect(body.apiVersion).toBe(WEBHOOK_API_VERSION);
        expect(body.data.amount).toBe("9.99");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scenario 2: rotation grace — signature carries 2 v1 parts, verifies against BOTH old and new secret",
    async () => {
      const server = await startWebhookServer(HTTP_OK);
      serversToClose.push(server);

      const oldSecret = secretEntry();
      const connId = createId();
      await insertConnection({
        id: connId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "rotation-grace",
        credentials: webhookCreds(server.port, [oldSecret]),
      });

      const outboxEventId1 = createId();
      await deliverDirect(connId, "CUSTOM_WEBHOOK", revenueEnvelope(outboxEventId1));
      const row1 = await pollDeliveryRowWithStatus(connId, outboxEventId1, "succeeded");
      expect(row1).toBeDefined();
      expect(server.requests).toHaveLength(1);
      const sig1 = asHeaderString(server.requests[0]!.headers["svix-signature"]) ?? "";
      expect(sig1.split(" ")).toHaveLength(1);

      // Mirror POST .../rotate-secret's exact output shape: newest entry
      // first, old entry kept for the grace window. Applied directly to
      // the stored cipher — see the "Choices made" note at the top of the
      // file for why.
      const newSecret = secretEntry();
      const rotatedCipher = encrypt(
        JSON.stringify(webhookCreds(server.port, [newSecret, oldSecret])),
        ENCRYPTION_KEY,
      );
      await testDb
        .update(schema.integrationConnections)
        .set({ credentialsCipher: rotatedCipher, updatedAt: new Date() })
        .where(eq(schema.integrationConnections.id, connId));

      const outboxEventId2 = createId();
      await deliverDirect(connId, "CUSTOM_WEBHOOK", revenueEnvelope(outboxEventId2));
      const row2 = await pollDeliveryRowWithStatus(connId, outboxEventId2, "succeeded");
      expect(row2).toBeDefined();
      expect(server.requests).toHaveLength(2);

      const req2 = server.requests[1]!;
      const sig2 = asHeaderString(req2.headers["svix-signature"]) ?? "";
      expect(sig2.split(" ").filter((p) => p.startsWith("v1,"))).toHaveLength(2);

      const headers2 = svixHeadersFrom(req2.headers);
      expect(() => verifySvixSignature(headers2, req2.body, oldSecret.key)).not.toThrow();
      expect(() => verifySvixSignature(headers2, req2.body, newSecret.key)).not.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scenario 3: retriable 5xx writes a failed row + custom-backoff retry, then 401 dead-letters with audit + notification",
    async () => {
      // --- Part A: retriable failure (first attempt only) -----------------
      const server500 = await startWebhookServer(HTTP_SERVER_ERROR);
      serversToClose.push(server500);
      const connFail = createId();
      await insertConnection({
        id: connFail,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "retriable-failure",
        credentials: webhookCreds(server500.port, [secretEntry()]),
      });

      const outboxEventIdA = createId();
      const jobIdA = buildIntegrationsDeliverJobId(connFail, outboxEventIdA);
      const jobA = await queue.add(
        "deliver",
        {
          connectionId: connFail,
          projectId: PROJECT_ID,
          providerId: "CUSTOM_WEBHOOK",
          envelope: revenueEnvelope(outboxEventIdA),
        },
        deliverJobOptions("CUSTOM_WEBHOOK", jobIdA),
      );

      const rowA = await pollDeliveryRowWithStatus(connFail, outboxEventIdA, "failed");
      expect(rowA).toBeDefined();
      expect(rowA!.httpStatus).toBe(HTTP_SERVER_ERROR);

      expect(jobA.opts.backoff).toMatchObject({ type: "custom" });
      const stateAfterFirstFailure = await jobA.getState();
      expect(["delayed", "waiting", "active", "waiting-children"]).toContain(
        stateAfterFirstFailure,
      );

      // Stop here instead of waiting through WEBHOOK_RETRY_POLICY's real
      // 30s→2m→…→12h backoff ladder — full 8-attempt exhaustion is covered
      // by integrations-deliver.unit.test.ts's injected maxAttempts.
      await jobA.remove().catch(() => undefined);
      await server500.close();

      // --- Part B: non-retriable 401 → dead_letter + audit + notification -
      const server401 = await startWebhookServer(HTTP_UNAUTHORIZED);
      serversToClose.push(server401);
      const connDead = createId();
      await insertConnection({
        id: connDead,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "dead-letter",
        credentials: webhookCreds(server401.port, [secretEntry()]),
      });

      const outboxEventIdB = createId();
      await deliverDirect(connDead, "CUSTOM_WEBHOOK", revenueEnvelope(outboxEventIdB));

      const rowB = await pollDeliveryRowWithStatus(connDead, outboxEventIdB, "dead_letter");
      expect(rowB).toBeDefined();
      expect(rowB!.httpStatus).toBe(HTTP_UNAUTHORIZED);

      const auditRow = await pollAuditDeadLetter(connDead);
      expect(auditRow).toBeDefined();
      expect(auditRow!.resourceId).toBe(connDead);

      const notificationRow = await pollDeadLetterNotification(connDead);
      expect(notificationRow).toBeDefined();
      expect(notificationRow!.aggregateType).toBe("NOTIFICATION");
      expect(notificationRow!.aggregateId).toBe(PROJECT_ID);
      expect(notificationRow!.payload).toMatchObject({
        eventKey: "integration.delivery.dead_letter",
        context: {
          projectId: PROJECT_ID,
          connectionId: connDead,
          providerId: "CUSTOM_WEBHOOK",
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scenario 4: redeliver — a dead-lettered delivery, re-run after the server is fixed, produces a new succeeded row",
    async () => {
      const server = await startWebhookServer(HTTP_UNAUTHORIZED);
      serversToClose.push(server);
      const connId = createId();
      await insertConnection({
        id: connId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "redeliver",
        credentials: webhookCreds(server.port, [secretEntry()]),
      });

      const outboxEventId = createId();

      // Intact originating outbox row — the real POST .../redeliver route
      // rebuilds its envelope from exactly this row (outboxRowToEnvelope).
      // The payload is the PRODUCTION revenue shape (see
      // productionRevenuePayload), not a pre-built envelope, so this
      // scenario exercises the same normalization the route depends on.
      await testDb.insert(schema.outboxEvents).values({
        id: outboxEventId,
        aggregateType: "REVENUE_EVENT",
        aggregateId: PROJECT_ID,
        eventType: "revenue.event.recorded",
        payload: productionRevenuePayload(),
      });

      // Rebuild exactly the way the redeliver route does: read the row
      // back and normalize it. A bare `payload as RovenueEventEnvelope`
      // cast yields `outboxEventId: undefined` here.
      const [storedRow] = await testDb
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.id, outboxEventId));
      const envelope = outboxRowToEnvelope({
        id: storedRow!.id,
        aggregateType: storedRow!.aggregateType,
        eventType: storedRow!.eventType,
        payload: storedRow!.payload,
        createdAt: storedRow!.createdAt,
      });
      expect(envelope).not.toBeNull();
      expect(envelope!.outboxEventId).toBe(outboxEventId);
      expect(envelope!.revenueEventKind).toBe("RENEWAL");

      await deliverDirect(connId, "CUSTOM_WEBHOOK", envelope!);
      const deadRow = await pollDeliveryRowWithStatus(connId, outboxEventId, "dead_letter");
      expect(deadRow).toBeDefined();

      server.setStatus(HTTP_OK);

      const redeliverJobId = buildRedeliverJobId(connId, outboxEventId, createId());
      await queue.add(
        "deliver",
        {
          connectionId: connId,
          projectId: PROJECT_ID,
          providerId: "CUSTOM_WEBHOOK",
          envelope: envelope!,
        },
        deliverJobOptions("CUSTOM_WEBHOOK", redeliverJobId),
      );

      const succeededRow = await pollDeliveryRowWithStatus(connId, outboxEventId, "succeeded");
      expect(succeededRow).toBeDefined();
      expect(succeededRow!.id).not.toBe(deadRow!.id);
      expect(server.requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scenario 5: paywall event end-to-end — toFanoutEnvelope wraps rovenue.paywall_events, webhook body carries type paywall.view + payload passthrough",
    async () => {
      const server = await startWebhookServer(HTTP_OK);
      serversToClose.push(server);
      const secret = secretEntry();
      const connId = createId();
      await insertConnection({
        id: connId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "paywall-event",
        credentials: webhookCreds(server.port, [secret]),
      });

      const outboxEventId = createId();
      const wrapper = {
        eventId: outboxEventId,
        eventType: "paywall_view",
        createdAt: new Date().toISOString(),
        payload: {
          projectId: PROJECT_ID,
          subscriberId: `sub_${createId()}`,
          occurredAt: new Date().toISOString(),
          placementId: "test_placement_e2e",
          paywallId: "test_paywall_e2e",
        },
      };

      const envelope = toFanoutEnvelope(wrapper, "rovenue.paywall_events");
      expect(envelope).not.toBeNull();
      expect(envelope!.eventKey).toBe("paywall.view");

      await deliverDirect(connId, "CUSTOM_WEBHOOK", envelope!);

      const row = await pollDeliveryRowWithStatus(connId, outboxEventId, "succeeded");
      expect(row).toBeDefined();
      expect(server.requests).toHaveLength(1);

      const req = server.requests[0]!;
      expect(() =>
        verifySvixSignature(svixHeadersFrom(req.headers), req.body, secret.key),
      ).not.toThrow();

      const body = JSON.parse(req.body) as { type: string; data: Record<string, unknown> };
      expect(body.type).toBe("paywall.view");
      expect(body.data).toEqual(wrapper.payload);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "scenario 6: Wave-1 store-lifecycle normalization — toFanoutEnvelope wraps rovenue.subscription with eventType subscription.billing_issue, webhook body carries type subscription.billing_issue",
    async () => {
      // Fanout half of the spec's acceptance 4 (spec acceptance's bridge
      // half — resolving the store-native DID_FAIL_TO_RENEW /
      // SUBSCRIPTION_ON_HOLD / invoice.payment_failed onto this same
      // public key via STORE_EVENT_TO_PUBLIC_KEY — is covered by
      // webhook-processor.integration.test.ts's Case 6, against real
      // Postgres). This scenario exercises what happens once that
      // already-normalized outbox row reaches the fan-out consumer.
      const server = await startWebhookServer(HTTP_OK);
      serversToClose.push(server);
      const secret = secretEntry();
      const connId = createId();
      await insertConnection({
        id: connId,
        providerId: "CUSTOM_WEBHOOK",
        displayName: "subscription-billing-issue",
        credentials: webhookCreds(server.port, [secret]),
      });

      const outboxEventId = createId();
      const wrapper = {
        eventId: outboxEventId,
        eventType: "subscription.billing_issue",
        aggregateId: `sub_${createId()}`,
        createdAt: new Date().toISOString(),
        payload: {
          projectId: PROJECT_ID,
          subscriberId: `sub_${createId()}`,
          purchaseId: `purchase_${createId()}`,
          webhookEventId: `whe_${createId()}`,
          timestamp: new Date().toISOString(),
        },
      };

      const envelope = toFanoutEnvelope(wrapper, "rovenue.subscription");
      expect(envelope).not.toBeNull();
      expect(envelope!.eventKey).toBe("subscription.billing_issue");
      expect(envelope!.eventType).toBe("subscription.billing_issue");

      await deliverDirect(connId, "CUSTOM_WEBHOOK", envelope!);

      const row = await pollDeliveryRowWithStatus(connId, outboxEventId, "succeeded");
      expect(row).toBeDefined();
      expect(server.requests).toHaveLength(1);

      const req = server.requests[0]!;
      expect(() =>
        verifySvixSignature(svixHeadersFrom(req.headers), req.body, secret.key),
      ).not.toThrow();

      const body = JSON.parse(req.body) as { type: string; data: Record<string, unknown> };
      expect(body.type).toBe("subscription.billing_issue");
      expect(body.data).toEqual(wrapper.payload);
    },
    TEST_TIMEOUT_MS,
  );
});
