// =============================================================
// processStripeEvent — store-supplied country on revenue events
// =============================================================
//
// Task 3 of the 2026-09-01 analytics-integrity-and-proceeds plan.
//
// VERIFIED (see task-3-report.md for the full citation trail):
// `Charge.billing_details.address.country` is documented by Stripe's
// own API reference (https://docs.stripe.com/api/charges/object) as
// "Billing information associated with the payment method AT THE TIME
// OF THE TRANSACTION" — the one Stripe field whose own documentation
// makes it a per-transaction fact, the same bar Apple's `storefront`
// and Google's `regionCode` clear. It is already the house alpha-2
// format (`Address.country`: "2-letter country code").
//
// `applyChargeRefunded` already holds a real `Stripe.Charge` object
// (`ctx.event.data.object`) with no extra API call, so the REFUND path
// is wired here. `applyInvoicePaid` (the INITIAL/RENEWAL/
// TRIAL_CONVERSION path) only holds a `Stripe.Invoice`, whose only
// country-shaped field is `customer_address` — documented as equal to
// `customer.address`, i.e. the customer's ACCOUNT address, which the
// plan explicitly forbids using (not a per-transaction fact, and
// possibly captured at signup). Wiring that path would need an extra
// Stripe API call to fetch the associated Charge, which this task does
// not introduce — documented as a verified gap, not a defect.
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433) for the real purchase/revenue/outbox writes. Only the Stripe
// account-scoped client (`ctx.account.invoices.retrieve`) is stubbed —
// no network call runs.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  Environment,
  PurchaseStatus,
  Store,
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
  subscribers,
} from "@rovenue/db";
import type { AccountScopedStripe } from "../../lib/stripe-account-scoped";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_stcountry_${RUN_ID}`;
const PRODUCT_ID = `prod_stcountry_${RUN_ID}`;

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));

// Imported AFTER vi.mock so the handler picks up the mocked deps.
const { processStripeEvent } = await import("./stripe-webhook");

function fakeAccount(invoiceSubscriptionId: string): AccountScopedStripe {
  return {
    invoices: {
      retrieve: vi.fn(async () => ({
        subscription: invoiceSubscriptionId,
      })),
    },
  } as unknown as AccountScopedStripe;
}

function makeChargeRefundedEvent(args: {
  eventId: string;
  invoiceId: string;
  country: string | null;
}): Stripe.Event {
  return {
    id: args.eventId,
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `ch_${args.eventId}`,
        invoice: args.invoiceId,
        amount: 999,
        amount_captured: 999,
        amount_refunded: 999,
        currency: "usd",
        refunds: { data: [{ amount: 999 }] },
        billing_details: {
          address: { country: args.country },
        },
      },
    },
  } as unknown as Stripe.Event;
}

async function seedPurchase(subscriptionId: string) {
  const db = getDb();
  const [subscriber] = await db
    .insert(subscribers)
    .values({ projectId: PROJECT_ID, rovenueId: `rv_${subscriptionId}` })
    .returning();
  await db.insert(purchases).values({
    projectId: PROJECT_ID,
    subscriberId: subscriber!.id,
    productId: PRODUCT_ID,
    store: Store.STRIPE,
    storeTransactionId: subscriptionId,
    originalTransactionId: subscriptionId,
    status: PurchaseStatus.ACTIVE,
    purchaseDate: new Date(),
    originalPurchaseDate: new Date(),
    priceAmount: "9.99",
    priceCurrency: "USD",
    environment: Environment.PRODUCTION,
  });
  return subscriber!.id;
}

async function readRevenueOutboxPayload(
  purchaseId: string,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateType, "REVENUE_EVENT"));
  const match = rows
    .map((r) => r.payload as Record<string, unknown>)
    .find((p) => p.purchaseId === purchaseId);
  if (!match) throw new Error("no REVENUE_EVENT outbox row for this purchase");
  return match;
}

async function purchaseIdFor(storeTransactionId: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, PROJECT_ID),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    );
  if (!row) throw new Error("purchase not found");
  return row.id;
}

describe("processStripeEvent (charge.refunded) — store-supplied country on revenue events", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `STCountry ${RUN_ID}` });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `identifier_${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { stripe: `price_${RUN_ID}` },
      displayName: `STCountry Product ${RUN_ID}`,
      accessIds: [],
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("a charge carrying billing_details.address.country produces a revenue event whose payload carries the country", async () => {
    const subscriptionId = `sub_with_country_${RUN_ID}`;
    const invoiceId = `in_with_country_${RUN_ID}`;
    await seedPurchase(subscriptionId);

    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: makeChargeRefundedEvent({
        eventId: `evt_with_country_${RUN_ID}`,
        invoiceId,
        country: "US",
      }),
      account: fakeAccount(subscriptionId),
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(subscriptionId);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload.country).toBe("US");
  });

  it("an unrecognised billing country produces a revenue event whose payload carries no country key (fail closed, not the raw value)", async () => {
    const subscriptionId = `sub_bad_country_${RUN_ID}`;
    const invoiceId = `in_bad_country_${RUN_ID}`;
    await seedPurchase(subscriptionId);

    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: makeChargeRefundedEvent({
        eventId: `evt_bad_country_${RUN_ID}`,
        invoiceId,
        country: "ZZ",
      }),
      account: fakeAccount(subscriptionId),
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(subscriptionId);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
    expect(payload.country).not.toBe("ZZ");
  });

  it("a charge with no billing address country produces a revenue event whose payload carries no country key", async () => {
    const subscriptionId = `sub_no_country_${RUN_ID}`;
    const invoiceId = `in_no_country_${RUN_ID}`;
    await seedPurchase(subscriptionId);

    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: makeChargeRefundedEvent({
        eventId: `evt_no_country_${RUN_ID}`,
        invoiceId,
        country: null,
      }),
      account: fakeAccount(subscriptionId),
    });
    expect(result.status).toBe("processed");

    const purchaseId = await purchaseIdFor(subscriptionId);
    const payload = await readRevenueOutboxPayload(purchaseId);
    expect(payload).not.toHaveProperty("country");
  });
});
