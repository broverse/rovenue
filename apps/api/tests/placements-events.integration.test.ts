// =============================================================
// Task 5 (paywall-placements): lazy exposure assignment,
// paywall_view outbox event, and receipt/webhook attribution.
// =============================================================
//
// Boots minimal Hono apps (apiKeyAuth + one route) against the live
// dev Postgres, mirroring routes/v1/events.integration.test.ts. Only
// the Apple JWS crypto (verifyTransaction) is mocked — everything
// else, including @rovenue/db, is real so the assertions exercise
// actual persistence (assignment dedup, outbox aggregateType, the
// new purchases.presentedContext column, revenue-event metadata).
//
// Scenarios (per task-5-brief.md Step 1):
//   1. expose w/ variantId creates an assignment row exactly once
//      across two calls.
//   2. paywall_view envelope lands in the outbox with
//      aggregateType: "PAYWALL_EVENT".
//   3. Apple receipt with presentedContext persists it on the
//      purchase row and on the revenue event's outbox metadata.
//   4. Malformed `rovenue_presented_context` Stripe metadata is
//      ignored without failing webhook processing; valid metadata
//      persists on the purchase and flows into the revenue event
//      recorded on invoice.paid.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type Stripe from "stripe";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../src/middleware/api-key-auth";
import { errorHandler } from "../src/middleware/error";
import { eventsRoute } from "../src/routes/v1/events";
import { experimentsRoute } from "../src/routes/v1/experiments";
import { parsePresentedContextMetadata } from "../src/lib/presented-context";

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";

// =============================================================
// Mocks — Apple JWS crypto + credential lookup only. @rovenue/db
// stays real; no vi.mock("@rovenue/db", ...) in this file.
// =============================================================

let appleTransaction: Record<string, unknown> = {};

vi.mock("../src/services/apple/apple-verify", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/apple/apple-verify")
  >("../src/services/apple/apple-verify");
  return {
    ...actual,
    JoseAppleNotificationVerifier: class {
      async verifyTransaction() {
        return appleTransaction;
      }
    },
  };
});

vi.mock("../src/lib/project-credentials", () => ({
  loadAppleCredentials: vi.fn(async () => null),
  loadGoogleCredentials: vi.fn(async () => null),
}));

vi.mock("../src/lib/circuit-breaker", () => ({
  appleCircuit: { exec: (fn: () => unknown) => fn(), state: "CLOSED" },
  googleCircuit: { exec: (fn: () => unknown) => fn(), state: "CLOSED" },
}));

// Imported AFTER the mocks above so the module graph picks them up.
import { verifyReceipt } from "../src/services/receipt-verify";
import { processStripeEvent } from "../src/services/stripe/stripe-webhook";

// =============================================================
// DB setup
// =============================================================

const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;

async function seedAudience(): Promise<string> {
  const [row] = await testDb
    .insert(schema.audiences)
    .values({ projectId: PROJECT_ID, name: `aud-${createId().slice(0, 8)}` })
    .returning();
  if (!row) throw new Error("seed: audience insert returned no row");
  return row.id;
}

async function seedExperiment(variantId: string): Promise<string> {
  const audienceId = await seedAudience();
  const [row] = await testDb
    .insert(schema.experiments)
    .values({
      projectId: PROJECT_ID,
      name: "Paywall test",
      type: "PAYWALL",
      key: `exp-${createId().slice(0, 8)}`,
      audienceId,
      status: "RUNNING",
      variants: [{ id: variantId, name: "Treatment", weight: 100 }],
    })
    .returning();
  if (!row) throw new Error("seed: experiment insert returned no row");
  return row.id;
}

async function seedProduct(args: {
  identifier: string;
  storeIds: Record<string, string>;
}): Promise<string> {
  const [row] = await testDb
    .insert(schema.products)
    .values({
      projectId: PROJECT_ID,
      identifier: args.identifier,
      type: "SUBSCRIPTION",
      storeIds: args.storeIds,
      displayName: "Pro",
      accessIds: [],
    })
    .returning();
  if (!row) throw new Error("seed: product insert returned no row");
  return row.id;
}

function buildEventsApp() {
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/events", eventsRoute)
    .onError(errorHandler);
}

function buildExperimentsApp() {
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/experiments", experimentsRoute)
    .onError(errorHandler);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `task5-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "task5-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });
}, 15_000);

afterAll(async () => {
  await pool.end();
});

// =============================================================
// 1. Lazy exposure assignment
// =============================================================

describe("POST /v1/experiments/:id/expose — lazy assignment", () => {
  it("persists an experiment_assignments row exactly once across two calls", async () => {
    const variantId = "var_treatment";
    const experimentId = await seedExperiment(variantId);
    const app = buildExperimentsApp();
    const subscriberId = `sub_${createId().slice(0, 8)}`;

    for (let i = 0; i < 2; i++) {
      const res = await app.request(`/v1/experiments/${experimentId}/expose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PUBLIC_KEY}`,
        },
        body: JSON.stringify({ variantId, subscriberId }),
      });
      expect(res.status).toBe(200);
    }

    const rows = await testDb
      .select()
      .from(schema.experimentAssignments)
      .where(eq(schema.experimentAssignments.experimentId, experimentId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.variantId).toBe(variantId);
  });

  it("accepts an optional placementId without rejecting the request", async () => {
    const variantId = "var_a";
    const experimentId = await seedExperiment(variantId);
    const app = buildExperimentsApp();

    const res = await app.request(`/v1/experiments/${experimentId}/expose`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify({
        variantId,
        subscriberId: `sub_${createId().slice(0, 8)}`,
        placementId: "plc_onboarding",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: boolean } };
    expect(body.data.accepted).toBe(true);
  });
});

// =============================================================
// 2. paywall_view → PAYWALL_EVENT outbox row
// =============================================================

describe("POST /v1/events — paywall_view", () => {
  it("lands in the outbox with aggregateType PAYWALL_EVENT and the paywallContext intact", async () => {
    const app = buildEventsApp();
    const subscriberId = `sub_${createId().slice(0, 8)}`;
    const body = {
      eventType: "paywall_view",
      occurredAt: new Date().toISOString(),
      subscriberId,
      paywallContext: {
        paywallId: "pw_default",
        placementId: "plc_onboarding",
        placementRevision: 1,
        variantId: "var_treatment",
        experimentKey: "exp_key_1",
      },
    };

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);

    const rows = await testDb
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateId, PROJECT_ID),
          eq(schema.outboxEvents.eventType, "paywall_view"),
        ),
      )
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(5);

    const row = rows.find(
      (r) =>
        (r.payload as Record<string, unknown>).subscriberId === subscriberId,
    );
    expect(row).toBeDefined();
    expect(row!.aggregateType).toBe("PAYWALL_EVENT");

    const payload = row!.payload as Record<string, unknown>;
    expect(payload.paywallContext).toEqual(body.paywallContext);
  });

  it("rejects a paywallContext missing a required field → 400 (strict Zod)", async () => {
    const app = buildEventsApp();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify({
        eventType: "paywall_view",
        occurredAt: new Date().toISOString(),
        paywallContext: { paywallId: "pw_default" }, // missing placementId/placementRevision
      }),
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================
// 3. Apple receipt presentedContext → purchase row + revenue metadata
// =============================================================

describe("verifyReceipt (Apple) — presentedContext attribution", () => {
  it("persists presentedContext on the purchase row and on the revenue event's outbox metadata", async () => {
    const productIdentifier = `com.app.pro.${createId().slice(0, 8)}`;
    await seedProduct({ identifier: productIdentifier, storeIds: {} });

    const transactionId = `txn_${createId().slice(0, 8)}`;
    appleTransaction = {
      transactionId,
      originalTransactionId: transactionId,
      productId: productIdentifier,
      purchaseDate: Date.now(),
      originalPurchaseDate: Date.now(),
      expiresDate: Date.now() + 30 * 24 * 3600 * 1000,
      price: 9_990_000,
      currency: "USD",
      environment: "Production",
    };

    const presentedContext = {
      placementId: "plc_onboarding",
      paywallId: "pw_default",
      variantId: "var_treatment",
      experimentKey: "exp_key_1",
    };

    const { purchase } = await verifyReceipt({
      projectId: PROJECT_ID,
      store: "APP_STORE",
      receipt: "signed-jws",
      productId: productIdentifier,
      appUserId: `apple_user_${createId().slice(0, 8)}`,
      presentedContext,
    });

    expect(purchase.presentedContext).toEqual(presentedContext);

    // Re-select to prove it round-tripped through Postgres, not just the
    // in-memory `.returning()` row.
    const [reselected] = await testDb
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchase.id));
    expect(reselected!.presentedContext).toEqual(presentedContext);

    const outboxRows = await testDb
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
          eq(schema.outboxEvents.eventType, "revenue.event.recorded"),
        ),
      )
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(20);

    const row = outboxRows.find(
      (r) => (r.payload as Record<string, unknown>).purchaseId === purchase.id,
    );
    expect(row).toBeDefined();
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.metadata).toEqual({ presentedContext });
  });

  it("omitting presentedContext leaves the purchase row's attribution null", async () => {
    const productIdentifier = `com.app.free.${createId().slice(0, 8)}`;
    await seedProduct({ identifier: productIdentifier, storeIds: {} });

    const transactionId = `txn_${createId().slice(0, 8)}`;
    appleTransaction = {
      transactionId,
      originalTransactionId: transactionId,
      productId: productIdentifier,
      purchaseDate: Date.now(),
      originalPurchaseDate: Date.now(),
      expiresDate: Date.now() + 30 * 24 * 3600 * 1000,
      price: 4_990_000,
      currency: "USD",
      environment: "Production",
    };

    const { purchase } = await verifyReceipt({
      projectId: PROJECT_ID,
      store: "APP_STORE",
      receipt: "signed-jws",
      productId: productIdentifier,
      appUserId: `apple_user_${createId().slice(0, 8)}`,
    });

    expect(purchase.presentedContext).toBeNull();
  });
});

// =============================================================
// 4. Stripe rovenue_presented_context — malformed vs. valid
// =============================================================

function buildSubscriptionEvent(args: {
  eventId: string;
  subscriptionId: string;
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
}): Stripe.Event {
  return {
    id: args.eventId,
    type: "customer.subscription.created",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    object: "event",
    data: {
      object: {
        id: args.subscriptionId,
        object: "subscription",
        customer: args.customerId,
        status: "active",
        metadata: args.metadata ?? {},
        items: {
          object: "list",
          data: [
            {
              id: `si_${args.subscriptionId}`,
              price: { id: args.priceId, unit_amount: 999, currency: "usd" },
            },
          ],
        },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        start_date: Math.floor(Date.now() / 1000),
        cancel_at_period_end: false,
      },
    },
  } as unknown as Stripe.Event;
}

function buildInvoicePaidEvent(args: {
  eventId: string;
  invoiceId: string;
  subscriptionId: string;
}): Stripe.Event {
  return {
    id: args.eventId,
    type: "invoice.paid",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    object: "event",
    data: {
      object: {
        id: args.invoiceId,
        object: "invoice",
        subscription: args.subscriptionId,
        amount_paid: 999,
        currency: "usd",
        billing_reason: "subscription_create",
        created: Math.floor(Date.now() / 1000),
      },
    },
  } as unknown as Stripe.Event;
}

describe("parsePresentedContextMetadata — defensive parse", () => {
  it("returns null for malformed JSON", () => {
    expect(parsePresentedContextMetadata("{not valid json")).toBeNull();
  });

  it("returns null for well-formed JSON missing required fields", () => {
    expect(
      parsePresentedContextMetadata(JSON.stringify({ paywallId: "pw_1" })),
    ).toBeNull();
  });

  it("returns null for absent metadata", () => {
    expect(parsePresentedContextMetadata(undefined)).toBeNull();
    expect(parsePresentedContextMetadata(null)).toBeNull();
  });

  it("parses a well-formed presentedContext", () => {
    const ctx = { placementId: "plc_1", paywallId: "pw_1" };
    expect(parsePresentedContextMetadata(JSON.stringify(ctx))).toEqual(ctx);
  });
});

describe("processStripeEvent — rovenue_presented_context attribution", () => {
  it("malformed metadata is ignored — webhook still processes, purchase.presentedContext stays null", async () => {
    const priceId = `price_${createId().slice(0, 8)}`;
    await seedProduct({ identifier: `stripe-prod-${createId().slice(0, 8)}`, storeIds: { stripe: priceId } });
    const subscriptionId = `sub_${createId().slice(0, 8)}`;

    const event = buildSubscriptionEvent({
      eventId: `evt_${createId().slice(0, 8)}`,
      subscriptionId,
      customerId: `cus_${createId().slice(0, 8)}`,
      priceId,
      metadata: { rovenue_presented_context: "{not valid json" },
    });

    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event,
      stripe: {} as Stripe,
      accountId: "acct_test",
    });

    expect(result.status).toBe("processed");

    const [purchase] = await testDb
      .select()
      .from(schema.purchases)
      .where(
        and(
          eq(schema.purchases.store, "STRIPE"),
          eq(schema.purchases.storeTransactionId, subscriptionId),
        ),
      );
    expect(purchase).toBeDefined();
    expect(purchase!.presentedContext).toBeNull();
  });

  it("valid metadata persists on the purchase and flows into the invoice.paid revenue event's metadata", async () => {
    const priceId = `price_${createId().slice(0, 8)}`;
    await seedProduct({ identifier: `stripe-prod-${createId().slice(0, 8)}`, storeIds: { stripe: priceId } });
    const subscriptionId = `sub_${createId().slice(0, 8)}`;
    const presentedContext = {
      placementId: "plc_onboarding",
      paywallId: "pw_default",
    };

    const subEvent = buildSubscriptionEvent({
      eventId: `evt_${createId().slice(0, 8)}`,
      subscriptionId,
      customerId: `cus_${createId().slice(0, 8)}`,
      priceId,
      metadata: { rovenue_presented_context: JSON.stringify(presentedContext) },
    });
    await processStripeEvent({
      projectId: PROJECT_ID,
      event: subEvent,
      stripe: {} as Stripe,
      accountId: "acct_test",
    });

    const [purchase] = await testDb
      .select()
      .from(schema.purchases)
      .where(
        and(
          eq(schema.purchases.store, "STRIPE"),
          eq(schema.purchases.storeTransactionId, subscriptionId),
        ),
      );
    expect(purchase!.presentedContext).toEqual(presentedContext);

    const invoiceEvent = buildInvoicePaidEvent({
      eventId: `evt_${createId().slice(0, 8)}`,
      invoiceId: `in_${createId().slice(0, 8)}`,
      subscriptionId,
    });
    await processStripeEvent({
      projectId: PROJECT_ID,
      event: invoiceEvent,
      stripe: {} as Stripe,
      accountId: "acct_test",
    });

    const outboxRows = await testDb
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
          eq(schema.outboxEvents.eventType, "revenue.event.recorded"),
        ),
      )
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(20);

    const row = outboxRows.find(
      (r) => (r.payload as Record<string, unknown>).purchaseId === purchase!.id,
    );
    expect(row).toBeDefined();
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.metadata).toEqual({ presentedContext });
  });
});
