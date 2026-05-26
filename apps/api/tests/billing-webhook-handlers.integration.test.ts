// =============================================================
// Stripe webhook handlers — end-to-end integration tests
// =============================================================
//
// Exercises the dispatcher + all seven Phase-2 handlers against
// the live docker-compose dev Postgres (host port 5433). The
// dispatcher's `@rovenue/db` singleton (lazy Proxy in
// client.ts) and our test-owned Pool both connect to the same
// database, so writes made by the dispatcher are visible to the
// assertion queries.
//
// We mock `lib/stripe-billing` so `getPlatformStripe()` returns
// a stubbed SDK with the three methods the handlers actually
// call (`paymentMethods.retrieve`, `customers.update`,
// `subscriptions.create`). Everything below the dispatcher is
// real — DB writes, audit chain row, outbox events, the lot.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Env bootstrap — must run BEFORE any @rovenue/db / dispatcher import so the
// lazy `db` singleton picks up the right DATABASE_URL. tests/setup.ts already
// sets this, but we belt-and-braces here so the file is runnable in
// isolation too.
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// Stripe SDK mock — must be declared with vi.mock so it's hoisted above the
// dispatcher's transitive import of "../src/lib/stripe-billing".
// vi.hoisted lets the mocks share state with the test body.
// ---------------------------------------------------------------------------
const stripeStubs = vi.hoisted(() => ({
  pmRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
  subscriptionsCreate: vi.fn(),
}));

vi.mock("../src/lib/stripe-billing", () => ({
  getPlatformStripe: () => ({
    paymentMethods: { retrieve: stripeStubs.pmRetrieve },
    customers: { update: stripeStubs.customersUpdate },
    subscriptions: { create: stripeStubs.subscriptionsCreate },
  }),
  _resetPlatformStripeForTests: () => {},
}));

// Late imports — anything reaching for getPlatformStripe() will get the stub.
import { drizzle as drizzleNs, db as dbSingleton } from "@rovenue/db";
import { dispatchStripeBillingEvent } from "../src/services/billing/webhook-handlers";

// drizzle.schema is the full table namespace — same one client.ts wires up.
const schema = drizzleNs.schema;

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "fixtures", "stripe-webhooks");

function loadFixture(name: string): Stripe.Event {
  const raw = readFileSync(resolve(fixturesDir, name), "utf8");
  return JSON.parse(raw) as Stripe.Event;
}

// ---------------------------------------------------------------------------
// Test-owned DB connection (independent of the singleton — both point at the
// same Postgres, so writes converge).
// ---------------------------------------------------------------------------
let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

// Identifiers assigned in beforeAll — projects.id is cuid2-generated, so we
// can't predict it ahead of time.
let PROJECT_ID: string;
let CUSTOMER_ID: string;
const TEST_PRICE_ID = "price_test_indie_monthly";

// Per-run-unique IDs so reruns don't collide with rows left behind by
// previous runs (the test does not clean up the dev DB between runs).
const INVOICE_ID = `in_test_phase2_${randomUUID().slice(0, 8)}`;
const PM_ID = `pm_test_phase2_${randomUUID().slice(0, 8)}`;
const SUBSCRIPTION_ID = `sub_test_phase2_${randomUUID().slice(0, 8)}`;

// Snapshot of the pre-existing (indie, monthly) tier-limits row so we can
// restore stripePriceId on teardown.
let originalIndieMonthlyPriceId: string | null = null;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  // 1. Seed a fresh project — id is auto-generated cuid2.
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `Phase-2 Webhook Test ${randomUUID().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed billing_subscriptions row in state='free' with a known
  //    stripe_customer_id so the dispatcher's customer→project lookup hits.
  CUSTOMER_ID = `cus_test_phase2_${randomUUID().slice(0, 8)}`;
  await drizzleNs.billingSubscriptionRepo.createFreeBillingSubscription(
    testDb,
    PROJECT_ID,
  );
  await drizzleNs.billingSubscriptionRepo.setStripeCustomerId(
    testDb,
    PROJECT_ID,
    CUSTOMER_ID,
  );

  // 3. Snapshot then UPSERT the (indie, monthly) tier-limits row so it has a
  //    known stripe_price_id. dev seed leaves this null unless env is set.
  const existing = await drizzleNs.billingTierLimitsRepo.findByTierAndCycle(
    testDb,
    "indie",
    "monthly",
  );
  if (!existing) {
    throw new Error(
      "billing_tier_limits is unseeded — run `pnpm db:seed` against the dev DB before this test",
    );
  }
  originalIndieMonthlyPriceId = existing.stripePriceId;
  await testDb
    .update(schema.billingTierLimits)
    .set({ stripePriceId: TEST_PRICE_ID })
    .where(
      and(
        eq(schema.billingTierLimits.tier, "indie"),
        eq(schema.billingTierLimits.cycle, "monthly"),
      ),
    );

  // 4. Default stub return shapes — individual tests can override.
  stripeStubs.pmRetrieve.mockImplementation(async (_id: string) => ({
    id: PM_ID,
    type: "card" as const,
    card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
  }));
  stripeStubs.customersUpdate.mockImplementation(async () => ({}));
  stripeStubs.subscriptionsCreate.mockImplementation(async () => ({
    id: SUBSCRIPTION_ID,
    status: "incomplete",
  }));
});

afterAll(async () => {
  // Restore the tier-limits row so we don't poison the dev DB for the next
  // test run / a manual `pnpm db:seed`.
  try {
    await testDb
      .update(schema.billingTierLimits)
      .set({ stripePriceId: originalIndieMonthlyPriceId })
      .where(
        and(
          eq(schema.billingTierLimits.tier, "indie"),
          eq(schema.billingTierLimits.cycle, "monthly"),
        ),
      );
  } catch {
    // ignore — dev DB cleanliness, not a correctness concern.
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests — order matters: payment_method.detached depends on the PM that
// setup_intent.succeeded inserts, and the invoice tests run on the same
// stripe_invoice_id so the upsert converges.
// ---------------------------------------------------------------------------

describe("Stripe webhook handlers — integration", () => {
  it("setup_intent.succeeded inserts PM and schedules subscriptions.create", async () => {
    const event = loadFixture("setup_intent.succeeded.json");
    event.id = `evt_si_${randomUUID()}`;
    const intent = event.data.object as {
      customer: string;
      payment_method: string;
      metadata: Record<string, string>;
    };
    intent.customer = CUSTOMER_ID;
    intent.payment_method = PM_ID;
    intent.metadata.rovenue_project_id = PROJECT_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const pms =
      await drizzleNs.billingPaymentMethodRepo.listPaymentMethodsForProject(
        dbSingleton,
        PROJECT_ID,
      );
    expect(pms).toHaveLength(1);
    expect(pms[0]!.last4).toBe("4242");
    expect(pms[0]!.brand).toBe("visa");
    expect(pms[0]!.isDefault).toBe(true);
    expect(pms[0]!.stripePaymentMethodId).toBe(PM_ID);

    expect(stripeStubs.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: CUSTOMER_ID }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(PROJECT_ID),
      }),
    );
  });

  it("customer.subscription.created flips state=active + writes audit + outbox", async () => {
    const event = loadFixture("customer.subscription.created.json");
    event.id = `evt_sub_created_${randomUUID()}`;
    const obj = event.data.object as {
      id: string;
      customer: string;
      items: { data: Array<{ price: { id: string } }> };
    };
    obj.id = SUBSCRIPTION_ID;
    obj.customer = CUSTOMER_ID;
    obj.items.data[0]!.price.id = TEST_PRICE_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const sub =
      await drizzleNs.billingSubscriptionRepo.findBillingSubscriptionByProject(
        dbSingleton,
        PROJECT_ID,
      );
    expect(sub?.state).toBe("active");
    expect(sub?.tier).toBe("indie");
    expect(sub?.cycle).toBe("monthly");
    expect(sub?.stripeSubscriptionId).toBe(SUBSCRIPTION_ID);

    const outboxRows = await testDb
      .select({ eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "BILLING"),
          eq(schema.outboxEvents.aggregateId, PROJECT_ID),
        ),
      );
    const types = outboxRows.map((r) => r.eventType);
    expect(types).toContain("billing.subscription.activated");

    const auditCount = await testDb
      .select({ count: sql<string>`count(*)` })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.projectId, PROJECT_ID),
          eq(schema.auditLogs.action, "billing.subscription.activated"),
        ),
      );
    expect(parseInt(auditCount[0]!.count, 10)).toBeGreaterThanOrEqual(1);
  });

  it("invoice.created mirrors into billing_invoices", async () => {
    const event = loadFixture("invoice.created.json");
    event.id = `evt_inv_created_${randomUUID()}`;
    const obj = event.data.object as { id: string; customer: string };
    obj.id = INVOICE_ID;
    obj.customer = CUSTOMER_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const invoices =
      await drizzleNs.billingInvoiceRepo.listInvoicesForProject(
        dbSingleton,
        PROJECT_ID,
      );
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    const inv = invoices.find((i) => i.stripeInvoiceId === INVOICE_ID);
    expect(inv).toBeDefined();
    expect(inv!.status).toBe("draft");
    expect(inv!.amountDue).toBe("29.0000");
  });

  it("invoice.payment_succeeded flips status=paid and emits billing.invoice.paid", async () => {
    const event = loadFixture("invoice.payment_succeeded.json");
    event.id = `evt_inv_paid_${randomUUID()}`;
    const obj = event.data.object as { id: string; customer: string };
    obj.id = INVOICE_ID;
    obj.customer = CUSTOMER_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const inv = await drizzleNs.billingInvoiceRepo.findInvoiceByStripeId(
      dbSingleton,
      INVOICE_ID,
    );
    expect(inv?.status).toBe("paid");
    expect(inv?.amountPaid).toBe("29.0000");

    const outboxRows = await testDb
      .select({ eventType: schema.outboxEvents.eventType })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "BILLING"),
          eq(schema.outboxEvents.aggregateId, PROJECT_ID),
          eq(schema.outboxEvents.eventType, "billing.invoice.paid"),
        ),
      );
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
  });

  it("charge.refunded increments refunded_amount", async () => {
    const event = loadFixture("charge.refunded.json");
    event.id = `evt_charge_refunded_${randomUUID()}`;
    const obj = event.data.object as { customer: string; invoice: string };
    obj.customer = CUSTOMER_ID;
    obj.invoice = INVOICE_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const inv = await drizzleNs.billingInvoiceRepo.findInvoiceByStripeId(
      dbSingleton,
      obj.invoice,
    );
    expect(inv).not.toBeNull();
    expect(parseFloat(inv!.refundedAmount)).toBeGreaterThan(0);
    expect(parseFloat(inv!.refundedAmount)).toBeCloseTo(5, 4);
  });

  it("payment_method.detached removes the PM row", async () => {
    const event = loadFixture("payment_method.detached.json");
    event.id = `evt_pm_detached_${randomUUID()}`;
    const obj = event.data.object as { customer: string; id: string };
    obj.customer = CUSTOMER_ID;
    obj.id = PM_ID;

    const result = await dispatchStripeBillingEvent(event);
    expect(result).toEqual({ status: "ok" });

    const pms =
      await drizzleNs.billingPaymentMethodRepo.listPaymentMethodsForProject(
        dbSingleton,
        PROJECT_ID,
      );
    expect(
      pms.find((p) => p.stripePaymentMethodId === PM_ID),
    ).toBeUndefined();
  });

  it("duplicate event id returns status='duplicate'", async () => {
    const event = loadFixture("invoice.created.json");
    const dupeId = `evt_dupe_${randomUUID()}`;
    event.id = dupeId;
    const obj = event.data.object as { customer: string; id: string };
    obj.customer = CUSTOMER_ID;
    obj.id = `in_dupe_${randomUUID()}`;

    const first = await dispatchStripeBillingEvent(event);
    const second = await dispatchStripeBillingEvent(event);

    expect(first.status).toBe("ok");
    expect(second).toEqual({ status: "duplicate" });
  });
});
