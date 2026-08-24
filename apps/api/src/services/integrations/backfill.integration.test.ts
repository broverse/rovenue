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

import { randomBytes } from "node:crypto";
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
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");

const REDIS_URL = process.env.REDIS_URL!;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

// Unique per-file queue name — vitest runs these real-infra test files in
// parallel threads; a shared queue name lets one thread's worker steal
// another thread's jobs (see task-1-brief.md).
const TEST_QUEUE_NAME = `rovenue-integrations-deliver-test-${createId()}`;

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
let WEBHOOK_CONNECTION_ID: string;
// Final-review I3: a provider whose topics are revenue + subscription only
// (no rovenue.credit), on its OWN project so the aggregate-type filter can be
// asserted against a known-empty starting set.
let TOPIC_FILTER_PROJECT_ID: string;
let AMPLITUDE_CONNECTION_ID: string;
let TOPIC_FILTER_WEBHOOK_CONNECTION_ID: string;

// BullMQ queue + Redis + worker
let queue: Queue<IntegrationsDeliverJob>;
let queueConn: Redis;
let workerHandle: WorkerHandle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A legacy/directly-published payload that already IS a complete
 *  RovenueEventEnvelope. Kept to cover `outboxRowToEnvelope`'s passthrough
 *  branch — the production shape is `buildProductionRevenuePayload` below. */
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

/**
 * The payload a REVENUE_EVENT outbox row actually carries in production —
 * field names copied verbatim from createRevenueEvent's outbox emit in
 * packages/db/src/drizzle/repositories/revenue-events.ts (mirrored by
 * publishRevenueEvent in apps/api/src/services/event-bus.ts).
 *
 * It is deliberately NOT a RovenueEventEnvelope: there is no
 * `outboxEventId`, no `occurredAt`, no `revenueEventKind`, and the amount
 * fields are CH-shaped. Backfilling it only works if outboxRowToEnvelope
 * NORMALIZES the row (dispatcher wrapper → toFanoutEnvelope) instead of
 * casting the payload.
 */
function buildProductionRevenuePayload(revenueEventId: string): Record<string, unknown> {
  return {
    revenueEventId,
    projectId: PROJECT_ID,
    subscriberId: `sub_${createId()}`,
    purchaseId: `pur_${createId()}`,
    productId: `prod_${createId()}`,
    type: "RENEWAL",
    store: "APP_STORE",
    amount: "4.9900",
    amountUsd: "4.9900",
    currency: "USD",
    eventDate: new Date().toISOString(),
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

/** Insert an outbox_events row of an arbitrary aggregate/event type — used by
 *  Task 11's widened-aggregate coverage (SUBSCRIPTION / CREDIT_LEDGER /
 *  unmappable rows), unlike insertOutboxEvent above which is pinned to
 *  REVENUE_EVENT. */
async function insertOutboxEventOfType(opts: {
  id: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt?: Date;
}): Promise<void> {
  const createdAt = opts.createdAt ?? new Date();
  await testDb.insert(schema.outboxEvents).values({
    id: opts.id,
    aggregateType: opts.aggregateType as (typeof schema.outboxEvents.$inferInsert)["aggregateType"],
    aggregateId: PROJECT_ID,
    eventType: opts.eventType,
    payload: opts.payload,
    createdAt,
  });
}

/** A SUBSCRIPTION outbox row exactly as the webhook-processor/expiry-checker
 *  bridge writes it — see apps/api/src/workers/expiry-checker.ts:191 and
 *  services/webhook-processor.ts:372 — flat payload with top-level
 *  projectId. */
function buildSubscriptionBridgePayload(subscriberId: string): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    subscriberId,
    purchaseId: `pur_${createId()}`,
    timestamp: new Date().toISOString(),
  };
}

/** A CREDIT_LEDGER outbox row exactly as insertCreditLedger writes it — see
 *  packages/db/src/drizzle/repositories/credit-ledger.ts:151 — flat payload
 *  with top-level projectId. */
function buildCreditLedgerPayload(subscriberId: string): Record<string, unknown> {
  return {
    creditLedgerId: `cl_${createId()}`,
    projectId: PROJECT_ID,
    subscriberId,
    currencyId: `cur_${createId()}`,
    type: "GRANT",
    amount: "10",
    balance: "10",
    referenceType: null,
    referenceId: null,
    createdAt: new Date().toISOString(),
  };
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

  // Seed a second, CUSTOM_WEBHOOK connection — Task 11 widens backfill to
  // SUBSCRIPTION/CREDIT_LEDGER, both carried by customWebhookProvider's
  // topics (rovenue.subscription, rovenue.credit), unlike META_CAPI above.
  WEBHOOK_CONNECTION_ID = createId();
  const webhookCredentialsCipher = encrypt(
    JSON.stringify({ url: "https://example.test/hook", secrets: "[]" }),
    ENCRYPTION_KEY,
  );
  await testDb.insert(schema.integrationConnections).values({
    id: WEBHOOK_CONNECTION_ID,
    projectId: PROJECT_ID,
    providerId: "CUSTOM_WEBHOOK",
    displayName: "Backfill Test Custom Webhook",
    credentialsCipher: webhookCredentialsCipher,
    credentialsHint: "example.test",
    isEnabled: true,
  });

  // Final-review I3 fixture: its own project (so the backfill window starts
  // empty) carrying one AMPLITUDE connection — amplitudeProvider.topics is
  // ["rovenue.revenue", "rovenue.subscription"], i.e. NOT rovenue.credit.
  const [topicFilterProject] = await testDb
    .insert(schema.projects)
    .values({ name: `backfill-topics-${createId().slice(0, 8)}` })
    .returning();
  if (!topicFilterProject) throw new Error("seed: topic-filter project insert returned no row");
  TOPIC_FILTER_PROJECT_ID = topicFilterProject.id;

  AMPLITUDE_CONNECTION_ID = createId();
  await testDb.insert(schema.integrationConnections).values({
    id: AMPLITUDE_CONNECTION_ID,
    projectId: TOPIC_FILTER_PROJECT_ID,
    providerId: "AMPLITUDE",
    displayName: "Backfill Test Amplitude",
    credentialsCipher: encrypt(JSON.stringify({ api_key: "amp_test_key" }), ENCRYPTION_KEY),
    credentialsHint: "amp_...key",
    enabledEvents: ["subscription.expired"],
    eventMapping: {},
    actionSource: "app",
    isEnabled: true,
  });

  // …and a CUSTOM_WEBHOOK connection on the SAME project — customWebhook-
  // Provider does subscribe to rovenue.credit, so it is the control arm.
  TOPIC_FILTER_WEBHOOK_CONNECTION_ID = createId();
  await testDb.insert(schema.integrationConnections).values({
    id: TOPIC_FILTER_WEBHOOK_CONNECTION_ID,
    projectId: TOPIC_FILTER_PROJECT_ID,
    providerId: "CUSTOM_WEBHOOK",
    displayName: "Backfill Topic Filter Custom Webhook",
    credentialsCipher: encrypt(
      JSON.stringify({ url: "https://example.test/hook", secrets: "[]" }),
      ENCRYPTION_KEY,
    ),
    credentialsHint: "example.test",
    isEnabled: true,
  });

  // Boot worker
  workerHandle = await ensureIntegrationsDeliverWorker({ autoStart: true, queueName: TEST_QUEUE_NAME });

  // Queue client
  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<IntegrationsDeliverJob>(TEST_QUEUE_NAME, {
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
        envelope: buildOutboxPayload(eventId) as unknown as IntegrationsDeliverJob["envelope"],
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
  it("worker processes 5 RENEWAL backfill jobs seeded with PRODUCTION outbox payloads and writes succeeded rows", async () => {
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

    // Insert outbox events carrying the REAL production payload shape
    // (CH-shaped revenue row, no envelope fields) — see
    // buildProductionRevenuePayload.
    for (const id of eventIds) {
      await insertOutboxEvent({
        id,
        payload: buildProductionRevenuePayload(`rev_${createId()}`),
      });
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

// ---------------------------------------------------------------------------
// Task 11 — backfill widened to all fanout-backed aggregates
// ---------------------------------------------------------------------------
//
// SUBSCRIPTION and CREDIT_LEDGER rows carry top-level projectId at rest (the
// bridge / insertCreditLedger emit sites), so they belong in the backfill
// IN-list alongside REVENUE_EVENT. An unmappable row (recognized aggregate
// type, but an eventType outboxRowToEnvelope/toFanoutEnvelope doesn't know
// how to normalize — e.g. a raw store-native notification type instead of
// one of the bridged `subscription.*` keys) must still be skipped, exactly
// as the live fan-out consumer would drop it.

describe("backfill integration — Task 11: widened aggregate types", () => {
  it("backfills SUBSCRIPTION and CREDIT_LEDGER rows via a CUSTOM_WEBHOOK connection, and skips an unmappable row", async () => {
    const subscriptionEventId = `evt-sub-${createId()}`;
    const creditEventId = `evt-credit-${createId()}`;
    const unmappableEventId = `evt-unmap-${createId()}`;
    const subscriberId = `sub_${createId()}`;

    // A real bridge-shaped SUBSCRIPTION row — recognized eventType, flat
    // payload with top-level projectId (see buildSubscriptionBridgePayload).
    await insertOutboxEventOfType({
      id: subscriptionEventId,
      aggregateType: "SUBSCRIPTION",
      eventType: "subscription.expired",
      payload: buildSubscriptionBridgePayload(subscriberId),
    });

    // A real CREDIT_LEDGER row (see buildCreditLedgerPayload).
    await insertOutboxEventOfType({
      id: creditEventId,
      aggregateType: "CREDIT_LEDGER",
      eventType: "credit.ledger.appended",
      payload: buildCreditLedgerPayload(subscriberId),
    });

    // An unmappable row: SUBSCRIPTION aggregate, but a raw store-native
    // notification type (not one of SUBSCRIPTION_EVENT_TYPES in
    // integrations-fanout/consumer.ts) — payload still carries projectId
    // (so it passes the SQL filter) but toSubscriptionEnvelope returns null
    // for it, exactly like the live consumer would drop it.
    await insertOutboxEventOfType({
      id: unmappableEventId,
      aggregateType: "SUBSCRIPTION",
      eventType: "DID_RENEW", // raw Apple ASN2 notificationType, not bridged
      payload: { projectId: PROJECT_ID, subscriberId, raw: true },
    });

    const deps = makeBackfillDeps();
    const result = await enqueueBackfillForConnection(
      {
        connectionId: WEBHOOK_CONNECTION_ID,
        projectId: PROJECT_ID,
        providerId: "CUSTOM_WEBHOOK",
      },
      deps,
    );

    // At least the 2 mappable rows from this test should have been enqueued
    // (the project may also carry unrelated in-window REVENUE_EVENT rows
    // from earlier tests in this file — this run reuses PROJECT_ID).
    expect(result.eventCount).toBeGreaterThanOrEqual(2);

    const subscriptionJobId = buildIntegrationsDeliverJobId(
      WEBHOOK_CONNECTION_ID,
      subscriptionEventId,
    );
    const creditJobId = buildIntegrationsDeliverJobId(WEBHOOK_CONNECTION_ID, creditEventId);
    const unmappableJobId = buildIntegrationsDeliverJobId(
      WEBHOOK_CONNECTION_ID,
      unmappableEventId,
    );

    const subscriptionJob = await queue.getJob(subscriptionJobId);
    expect(subscriptionJob).toBeDefined();
    expect(subscriptionJob!.data.isBackfill).toBe(true);

    const creditJob = await queue.getJob(creditJobId);
    expect(creditJob).toBeDefined();
    expect(creditJob!.data.isBackfill).toBe(true);

    const unmappableJob = await queue.getJob(unmappableJobId);
    expect(unmappableJob).toBeUndefined();
  }, 30_000);

  it("does not backfill a PAYWALL_EVENT row (its outbox payload has no top-level projectId)", async () => {
    // Mirrors the exact shape routes/v1/events.ts writes to the outbox for
    // paywall_* events — the client envelope, with projectId only in
    // aggregateId (added at Kafka-publish time by
    // shapePaywallEventMessage), never inside payload itself.
    const paywallEventId = `evt-paywall-${createId()}`;
    await insertOutboxEventOfType({
      id: paywallEventId,
      aggregateType: "PAYWALL_EVENT",
      eventType: "paywall_view",
      payload: {
        eventId: createId(),
        subscriberId: `sub_${createId()}`,
        occurredAt: new Date().toISOString(),
        paywallContext: {
          paywallId: `pw_${createId()}`,
          placementId: `pl_${createId()}`,
          placementRevision: 1,
        },
      },
    });

    const deps = makeBackfillDeps();
    await enqueueBackfillForConnection(
      {
        connectionId: WEBHOOK_CONNECTION_ID,
        projectId: PROJECT_ID,
        providerId: "CUSTOM_WEBHOOK",
      },
      deps,
    );

    const jobId = buildIntegrationsDeliverJobId(WEBHOOK_CONNECTION_ID, paywallEventId);
    const job = await queue.getJob(jobId);
    expect(job).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Final-review I3 — backfill honors the provider's topic subscription
// ---------------------------------------------------------------------------
//
// The LIVE fan-out only routes a connection the topics its provider declares.
// Backfill used to fetch REVENUE_EVENT + SUBSCRIPTION + CREDIT_LEDGER for
// every provider, so enabling any of the five Wave-1 providers that don't
// subscribe to `rovenue.credit` replayed every credit_ledger row in the
// window into delivery jobs the worker instantly skipped as `no_mapping` —
// Delivery Log pollution and an inflated audit `eventCount`.

describe("backfill integration — I3: aggregate types intersected with provider topics", () => {
  it("an AMPLITUDE connection skips CREDIT_LEDGER rows while a CUSTOM_WEBHOOK connection on the same project still backfills them", async () => {
    const subscriptionEventId = `evt-tf-sub-${createId()}`;
    const creditEventId = `evt-tf-credit-${createId()}`;
    const subscriberId = `sub_${createId()}`;

    const insertForTopicProject = async (opts: {
      id: string;
      aggregateType: string;
      eventType: string;
      payload: Record<string, unknown>;
    }) => {
      await testDb.insert(schema.outboxEvents).values({
        id: opts.id,
        aggregateType: opts.aggregateType as (typeof schema.outboxEvents.$inferInsert)["aggregateType"],
        aggregateId: TOPIC_FILTER_PROJECT_ID,
        eventType: opts.eventType,
        payload: opts.payload,
        createdAt: new Date(),
      });
    };

    await insertForTopicProject({
      id: subscriptionEventId,
      aggregateType: "SUBSCRIPTION",
      eventType: "subscription.expired",
      payload: {
        projectId: TOPIC_FILTER_PROJECT_ID,
        subscriberId,
        purchaseId: `pur_${createId()}`,
        timestamp: new Date().toISOString(),
      },
    });

    await insertForTopicProject({
      id: creditEventId,
      aggregateType: "CREDIT_LEDGER",
      eventType: "credit.ledger.appended",
      payload: {
        creditLedgerId: `cl_${createId()}`,
        projectId: TOPIC_FILTER_PROJECT_ID,
        subscriberId,
        currencyId: `cur_${createId()}`,
        type: "GRANT",
        amount: "10",
        balance: "10",
        referenceType: null,
        referenceId: null,
        createdAt: new Date().toISOString(),
      },
    });

    const deps = makeBackfillDeps();

    // AMPLITUDE — rovenue.revenue + rovenue.subscription only.
    const amplitudeResult = await enqueueBackfillForConnection(
      {
        connectionId: AMPLITUDE_CONNECTION_ID,
        projectId: TOPIC_FILTER_PROJECT_ID,
        providerId: "AMPLITUDE",
      },
      deps,
    );
    // The project was seeded fresh for this test, so the count is exact:
    // the subscription row and nothing else.
    expect(amplitudeResult.eventCount).toBe(1);
    expect(
      await queue.getJob(
        buildIntegrationsDeliverJobId(AMPLITUDE_CONNECTION_ID, subscriptionEventId),
      ),
    ).toBeDefined();
    expect(
      await queue.getJob(
        buildIntegrationsDeliverJobId(AMPLITUDE_CONNECTION_ID, creditEventId),
      ),
    ).toBeUndefined();

    // CUSTOM_WEBHOOK — subscribes to rovenue.credit too, so both rows go.
    const webhookResult = await enqueueBackfillForConnection(
      {
        connectionId: TOPIC_FILTER_WEBHOOK_CONNECTION_ID,
        projectId: TOPIC_FILTER_PROJECT_ID,
        providerId: "CUSTOM_WEBHOOK",
      },
      deps,
    );
    expect(webhookResult.eventCount).toBe(2);
    expect(
      await queue.getJob(
        buildIntegrationsDeliverJobId(
          TOPIC_FILTER_WEBHOOK_CONNECTION_ID,
          creditEventId,
        ),
      ),
    ).toBeDefined();
  }, 30_000);
});
