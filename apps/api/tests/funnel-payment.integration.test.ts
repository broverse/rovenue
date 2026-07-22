// =============================================================
// Funnel on-page payment — end to end, against a real Postgres
// =============================================================
//
// Every piece of this flow already has unit coverage. What no mocked
// suite can show is that the pieces fit: the payment endpoint's
// `upsertPending` row is the row `/confirm` reads, the token it mints is
// the token the claim endpoint spends, the synthetic subscriber the
// completion anchors on Stripe's customer is the one the connected
// account's subscription event grants access to, and the claim merges
// exactly that row into the buyer's install.
//
// Integration: the docker-compose dev stack — Postgres on host 5433 and
// Redis on 6380 (tests/setup.ts supplies both URLs; there is deliberately
// no `process.env.DATABASE_URL ??=` above the imports here, because
// import hoisting parses lib/env before any top-of-file statement runs
// and that assignment would be dead code). The lock, the price cache and
// the rate limiter all run against that Redis for real.
//
// Stripe is stubbed at exactly one seam: `withAccount` in
// lib/stripe-account-scoped, the single factory every connected-account
// call goes through. Everything on this side of it is real — the
// connection row is read from Postgres by `chargesEnabled` /
// `requireConnectedStripe`, the price is resolved through the real
// resolver and its Redis cache, and the settlement rule is the shared
// predicate, not a test double.
//
// Test order is load-bearing: each `it` continues the session the
// previous one left behind. Do not reorder them.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { funnelClaimRoute } from "../src/routes/v1/funnel-claim";
import { processStripeEvent } from "../src/services/stripe/stripe-webhook";
import type { AccountScopedStripe } from "../src/lib/stripe-account-scoped";

// `vi.hoisted`, not a top-of-file assignment: lib/env parses process.env
// the moment it is imported, and imports are hoisted above statements.
// Both keys are read by the payment endpoint — the connection row below
// is `livemode: false`, so the TEST publishable key is the one it hands
// back, and a missing platform secret key makes `getConnectedStripe`
// return null however healthy the row is.
vi.hoisted(() => {
  process.env.STRIPE_PLATFORM_SECRET_KEY_TEST ??= "sk_test_funnel_e2e";
  process.env.STRIPE_PLATFORM_PUBLISHABLE_KEY_TEST ??= "pk_test_funnel_e2e";
});

// =============================================================
// The Stripe stub — one seam, at `withAccount`
// =============================================================
//
// It keeps state, because this suite drives a Stripe object through
// several statuses across several requests: the subscription that reads
// `incomplete` at the first `/confirm` is the same object that reads
// `active` at the second, and the purchase row's stored ids are what
// connects them. A per-call `mockResolvedValue` could not express that.

const stripeStub = vi.hoisted(() => {
  // One token per run, in every id this stub mints and every row the
  // suite writes, so a rerun cannot collide with what a previous run
  // left behind (and a crashed run cannot poison the next one).
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${run}_${++seq}`;

  type Bag = Record<string, unknown>;

  const prices = new Map<string, Bag>();
  const customers = new Map<string, Bag>();
  const subscriptions = new Map<string, Bag>();
  const paymentIntents = new Map<string, Bag>();
  const setupIntents = new Map<string, Bag>();
  const stampedSetupIntents: string[] = [];

  /**
   * Stripe returns `pending_setup_intent` as a bare id unless the caller
   * expands it, and the funnel's two readers differ on whether they do —
   * so the stub stores the id and expands on request, rather than
   * handing every caller the object and hiding a real distinction.
   */
  function expand(subscription: Bag, paths?: string[]): Bag {
    const out = { ...subscription };
    if (
      paths?.includes("pending_setup_intent") &&
      typeof subscription.pending_setup_intent === "string"
    ) {
      out.pending_setup_intent =
        setupIntents.get(subscription.pending_setup_intent) ?? null;
    }
    return out;
  }

  const account = {
    prices: {
      retrieve: async (id: string) => {
        const price = prices.get(id);
        if (!price) throw new Error(`No such price: ${id}`);
        return price;
      },
    },
    customers: {
      create: async (params: { email: string }) => {
        const customer = { id: nextId("cus"), email: params.email };
        customers.set(customer.id, customer);
        return customer;
      },
      update: async (id: string, params: { email?: string }) => {
        const customer = customers.get(id);
        if (!customer) throw new Error(`No such customer: ${id}`);
        if (params.email) customer.email = params.email;
        return customer;
      },
    },
    paymentIntents: {
      create: async (params: Bag) => {
        const id = nextId("pi");
        const intent: Bag = {
          id,
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          amount: params.amount,
          currency: params.currency,
          customer: params.customer,
          metadata: params.metadata ?? {},
        };
        paymentIntents.set(id, intent);
        return intent;
      },
      retrieve: async (id: string) => {
        const intent = paymentIntents.get(id);
        if (!intent) throw new Error(`No such payment intent: ${id}`);
        return intent;
      },
      cancel: async (id: string) => {
        const intent = paymentIntents.get(id);
        if (!intent) throw new Error(`No such payment intent: ${id}`);
        intent.status = "canceled";
        return intent;
      },
    },
    subscriptions: {
      create: async (params: Bag) => {
        const items = params.items as Array<{ price: string }>;
        const price = prices.get(items[0]!.price);
        if (!price) throw new Error(`No such price: ${items[0]!.price}`);

        const nowSeconds = Math.floor(Date.now() / 1000);
        const trial = Boolean(params.trial_period_days);
        const id = nextId("sub");
        const subscription: Bag = {
          id,
          object: "subscription",
          customer: params.customer,
          metadata: params.metadata ?? {},
          // A trial is parked at `trialing` from the moment it is
          // created — before any card. Everything else opens at
          // `incomplete` because the route creates with
          // `payment_behavior: "default_incomplete"`.
          status: trial ? "trialing" : "incomplete",
          default_payment_method: null,
          start_date: nowSeconds,
          current_period_end: nowSeconds + 30 * 24 * 60 * 60,
          cancel_at_period_end: false,
          canceled_at: null,
          items: {
            data: [{ id: nextId("si"), price }],
          },
          pending_setup_intent: null,
          latest_invoice: null,
        };

        if (trial) {
          const setupId = nextId("seti");
          setupIntents.set(setupId, {
            id: setupId,
            status: "requires_payment_method",
            client_secret: `${setupId}_secret`,
            metadata: {},
          });
          subscription.pending_setup_intent = setupId;
          subscription.latest_invoice = {
            id: nextId("in"),
            amount_paid: 0,
            payment_intent: null,
          };
        } else {
          const intentId = nextId("pi");
          const intent: Bag = {
            id: intentId,
            status: "requires_payment_method",
            client_secret: `${intentId}_secret`,
            metadata: params.metadata ?? {},
          };
          paymentIntents.set(intentId, intent);
          subscription.latest_invoice = {
            id: nextId("in"),
            amount_paid: 0,
            payment_intent: intent,
          };
        }

        subscriptions.set(id, subscription);
        return expand(subscription, params.expand as string[] | undefined);
      },
      retrieve: async (id: string, params?: { expand?: string[] }) => {
        const subscription = subscriptions.get(id);
        if (!subscription) throw new Error(`No such subscription: ${id}`);
        return expand(subscription, params?.expand);
      },
      update: async (id: string, params: Bag) => {
        const subscription = subscriptions.get(id);
        if (!subscription) throw new Error(`No such subscription: ${id}`);
        Object.assign(subscription, params);
        return subscription;
      },
      cancel: async (id: string) => {
        const subscription = subscriptions.get(id);
        if (!subscription) throw new Error(`No such subscription: ${id}`);
        subscription.status = "canceled";
        return subscription;
      },
    },
    setupIntents: {
      update: async (id: string, params: { metadata?: Record<string, string> }) => {
        const intent = setupIntents.get(id);
        if (!intent) throw new Error(`No such setup intent: ${id}`);
        intent.metadata = { ...(intent.metadata as Bag), ...params.metadata };
        stampedSetupIntents.push(id);
        return intent;
      },
      retrieve: async (id: string) => {
        const intent = setupIntents.get(id);
        if (!intent) throw new Error(`No such setup intent: ${id}`);
        return intent;
      },
    },
    invoices: {
      retrieve: async (id: string) => {
        throw new Error(`unexpected invoices.retrieve(${id})`);
      },
    },
    refunds: {
      create: async () => {
        throw new Error("unexpected refunds.create");
      },
    },
    paymentMethodDomains: {
      create: async () => {
        throw new Error("unexpected paymentMethodDomains.create");
      },
      list: async () => ({ data: [] }),
    },
  };

  return {
    run,
    account,
    prices,
    customers,
    subscriptions,
    paymentIntents,
    setupIntents,
    stampedSetupIntents,
  };
});

// The ONLY Stripe seam. `stripe-platform` still runs for real — it reads
// the connection row out of Postgres, decides live vs test, and calls
// this factory — so everything the route depends on except the network
// is exercised.
vi.mock("../src/lib/stripe-account-scoped", () => ({
  withAccount: () => stripeStub.account,
}));

const {
  getDb,
  access,
  funnels,
  funnelVersions,
  funnelSessions,
  funnelPurchases,
  funnelClaimTokens,
  outboxEvents,
  offerings,
  paywalls,
  products,
  projectStripeConnections,
  projects,
  purchases,
  subscriberAccess,
  subscribers,
  webhookEvents,
} = drizzle;

const RUN = stripeStub.run;

const PROJECT_ID = `prj_fnlpay_${RUN}`;
const ACCOUNT_ID = `acct_fnlpay_${RUN}`;
const FUNNEL_ID = `fnl_pay_${RUN}`;
const VERSION_ID = `fnv_pay_${RUN}`;
const PAYWALL_PAGE_ID = `pg_paywall_${RUN}`;
const PAYWALL_ID = `pwl_pay_${RUN}`;
const OFFERING_ID = `ofr_pay_${RUN}`;
const ACCESS_ID = `acc_pay_${RUN}`;
const ACCESS_IDENTIFIER = `pro_${RUN}`;

const PRODUCT_ID = `prd_pay_${RUN}`;
const TRIAL_PRODUCT_ID = `prd_trial_${RUN}`;
const PRICE_ID = `price_monthly_${RUN}`;
const TRIAL_PRICE_ID = `price_trial_${RUN}`;
const PACKAGE_IDENTIFIER = "$rov_monthly";
const TRIAL_PACKAGE_IDENTIFIER = "$rov_trial";
const PRICE_UNIT_AMOUNT = 4900;

// Session A walks the whole browser path; session B closes the tab and is
// completed by the webhook alone.
const SESSION_A = `fss_paid_${RUN}`;
const SESSION_B = `fss_tab_${RUN}`;
const SESSION_IDS = [SESSION_A, SESSION_B];

const DEVICE_ID = `rov_device_${RUN}`;
const BUYER_EMAIL = `buyer-${RUN}@example.test`;

// A run-unique client ip so the endpoint rate limiter (30/min, real
// Redis) buckets each run separately — two runs in the same minute must
// not add up.
const CLIENT_IP = `10.${(Date.now() >> 16) & 255}.${(Date.now() >> 8) & 255}.${Date.now() & 255}`;

let eventSeq = 0;
let lastEventId = "";

// =============================================================
// Drivers
// =============================================================

async function publicApp() {
  const { createApp } = await import("../src/app");
  return createApp();
}

async function startPayment(
  sessionId: string,
  packageIdentifier: string,
  email = BUYER_EMAIL,
) {
  const app = await publicApp();
  return app.request(`/public/funnel-sessions/${sessionId}/payment-intent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": CLIENT_IP,
    },
    body: JSON.stringify({ package_identifier: packageIdentifier, email }),
  });
}

async function confirm(sessionId: string) {
  const app = await publicApp();
  return app.request(`/public/funnel-sessions/${sessionId}/confirm`, {
    method: "POST",
    headers: { "x-forwarded-for": CLIENT_IP },
  });
}

/**
 * The Connect webhook's own work, minus the queue. The HTTP route
 * verifies a signature and enqueues; `processStripeEvent` is what the
 * BullMQ worker then runs, and it is the half that carries the funnel
 * backstop.
 */
function deliverWebhook(type: string, object: unknown, eventId?: string) {
  lastEventId = eventId ?? `evt_${RUN}_${++eventSeq}`;
  return processStripeEvent({
    projectId: PROJECT_ID,
    event: {
      id: lastEventId,
      type,
      created: Math.floor(Date.now() / 1000),
      account: ACCOUNT_ID,
      data: { object },
    } as unknown as Stripe.Event,
    account: stripeStub.account as unknown as AccountScopedStripe,
  });
}

function claim(anonId: string, token: string) {
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("project", {
        id: PROJECT_ID,
        name: "Funnel Payment E2E",
        slug: `fnlpay-${RUN}`,
        keyKind: "public",
        apiKeyId: `key_${RUN}`,
      } as never);
      await next();
    })
    .route("/v1", funnelClaimRoute);

  return app.request("/v1/subscribers/claim-funnel-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, anon_id: anonId }),
  });
}

async function purchaseRow(sessionId: string) {
  const [row] = await getDb()
    .select()
    .from(funnelPurchases)
    .where(eq(funnelPurchases.sessionId, sessionId));
  return row ?? null;
}

async function sessionRow(sessionId: string) {
  const [row] = await getDb()
    .select()
    .from(funnelSessions)
    .where(eq(funnelSessions.id, sessionId));
  return row ?? null;
}

async function tokenRows(sessionId: string) {
  return getDb()
    .select()
    .from(funnelClaimTokens)
    .where(eq(funnelClaimTokens.sessionId, sessionId));
}

// The token is returned exactly once, by whichever caller wins the mint.
let claimToken = "";

describe("funnel on-page payment — real Postgres", () => {
  beforeAll(async () => {
    const db = getDb();

    await db.insert(projects).values({ id: PROJECT_ID, name: `Funnel Pay ${RUN}` });

    // A genuinely connected, verified account: `chargesEnabled` reads
    // this row and refuses the endpoint outright without the capability.
    await db.insert(projectStripeConnections).values({
      projectId: PROJECT_ID,
      stripeAccountId: ACCOUNT_ID,
      livemode: false,
      scope: "read_write",
      chargesEnabled: true,
      payoutsEnabled: true,
      capabilities: { card_payments: "active" },
      country: "US",
      defaultCurrency: "usd",
    });

    // The catalog row. The claim response maps `subscriber_access.accessId`
    // through this table and returns its IDENTIFIER — without the row the
    // entitlements array comes back empty and reads like a merge bug.
    await db.insert(access).values({
      id: ACCESS_ID,
      projectId: PROJECT_ID,
      identifier: ACCESS_IDENTIFIER,
      displayName: "Pro",
    });

    await db.insert(products).values([
      {
        id: PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: `pro_monthly_${RUN}`,
        type: "SUBSCRIPTION",
        storeIds: { stripe: PRICE_ID },
        displayName: "Pro Monthly",
        accessIds: [ACCESS_ID],
      },
      {
        id: TRIAL_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: `pro_trial_${RUN}`,
        type: "SUBSCRIPTION",
        storeIds: { stripe: TRIAL_PRICE_ID },
        displayName: "Pro Trial",
        accessIds: [ACCESS_ID],
      },
    ]);

    await db.insert(offerings).values({
      id: OFFERING_ID,
      projectId: PROJECT_ID,
      identifier: `default_${RUN}`,
      packages: [
        { identifier: PACKAGE_IDENTIFIER, productId: PRODUCT_ID, order: 0 },
        { identifier: TRIAL_PACKAGE_IDENTIFIER, productId: TRIAL_PRODUCT_ID, order: 1 },
      ],
    });

    await db.insert(paywalls).values({
      id: PAYWALL_ID,
      projectId: PROJECT_ID,
      identifier: `paywall_${RUN}`,
      name: "Funnel Paywall",
      offeringId: OFFERING_ID,
    });

    await db.insert(funnels).values({
      id: FUNNEL_ID,
      projectId: PROJECT_ID,
      slug: `pay-${RUN}`,
      name: "Payment",
    });
    await db.insert(funnelVersions).values({
      id: VERSION_ID,
      funnelId: FUNNEL_ID,
      versionNo: 1,
      // The published page tree is what makes a package chargeable: the
      // endpoint resolves the named package through THIS paywall.
      pagesJson: [
        { id: `pg_q_${RUN}`, type: "question" },
        { id: PAYWALL_PAGE_ID, type: "paywall", paywallId: PAYWALL_ID },
      ],
      themeJson: {},
      settingsJson: {
        deep_link_scheme: "acme",
        universal_link_domain: "links.acme.test",
      },
    });

    await db.insert(funnelSessions).values([
      {
        id: SESSION_A,
        funnelId: FUNNEL_ID,
        funnelVersionId: VERSION_ID,
        projectId: PROJECT_ID,
        anonId: `anon_a_${RUN}`,
        state: "in_progress",
      },
      {
        id: SESSION_B,
        funnelId: FUNNEL_ID,
        funnelVersionId: VERSION_ID,
        projectId: PROJECT_ID,
        anonId: `anon_b_${RUN}`,
        state: "in_progress",
      },
    ]);

    // The Prices as the connected account reports them. Everything the
    // endpoint charges is derived from these numbers — the request body
    // has no amount field at all.
    stripeStub.prices.set(PRICE_ID, {
      id: PRICE_ID,
      unit_amount: PRICE_UNIT_AMOUNT,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1, trial_period_days: null },
    });
    stripeStub.prices.set(TRIAL_PRICE_ID, {
      id: TRIAL_PRICE_ID,
      unit_amount: 2900,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1, trial_period_days: 7 },
    });
  }, 60_000);

  afterAll(async () => {
    const db = getDb();
    // The funnel_* tables carry no FK into projects (session_id is not a
    // FK either — funnel_sessions is partitioned), so the project cascade
    // does not reach them. Everything else — purchases, subscriber_access,
    // products, offerings, paywalls, the connection row — goes with the
    // project delete at the end.
    //
    // `webhook_events` is deleted by hand and BEFORE the subscribers:
    // it cascades from the project but only RESTRICTS on
    // `subscriberId`, so deleting subscribers while a processed event
    // still points at one fails on the FK.
    await db
      .delete(funnelClaimTokens)
      .where(inArray(funnelClaimTokens.sessionId, SESSION_IDS));
    await db
      .delete(funnelPurchases)
      .where(inArray(funnelPurchases.sessionId, SESSION_IDS));
    await db
      .delete(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, SESSION_IDS));
    await db
      .delete(funnelSessions)
      .where(inArray(funnelSessions.id, SESSION_IDS));
    await db.delete(webhookEvents).where(eq(webhookEvents.projectId, PROJECT_ID));
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  }, 60_000);

  // =============================================================
  // The browser path
  // =============================================================

  // The client never says what to charge; it names a package. A package
  // the funnel's own offering does not contain is the smuggling attempt,
  // and it must be refused before anything exists on Stripe.
  it("400s and writes nothing for a package outside the funnel's offering", async () => {
    const res = await startPayment(SESSION_A, "$rov_not_in_this_offering");

    expect(res.status).toBe(400);
    expect(await purchaseRow(SESSION_A)).toBeNull();
    expect(stripeStub.subscriptions.size).toBe(0);
    expect(stripeStub.customers.size).toBe(0);
  }, 30_000);

  it("creates the subscription and writes a pending row priced from the Price", async () => {
    const res = await startPayment(SESSION_A, PACKAGE_IDENTIFIER);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        client_secret: string;
        mode: string;
        publishable_key: string;
        stripe_account: string;
      };
    };
    expect(body.data.mode).toBe("payment");
    expect(body.data.stripe_account).toBe(ACCOUNT_ID);
    // Test-mode connection ⇒ the TEST publishable key, or Stripe.js
    // rejects the secret this response also carries.
    expect(body.data.publishable_key).toBe("pk_test_funnel_e2e");
    expect(body.data.client_secret).toMatch(/^pi_.*_secret$/);

    // One subscription on the connected account, created incomplete.
    expect(stripeStub.subscriptions.size).toBe(1);
    const subscription = [...stripeStub.subscriptions.values()][0]!;
    expect(subscription.status).toBe("incomplete");

    const row = await purchaseRow(SESSION_A);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.projectId).toBe(PROJECT_ID);
    expect(row!.productId).toBe(PRODUCT_ID);
    // THE assertion: the amount is the Price's, not the client's.
    expect(row!.amountCents).toBe(PRICE_UNIT_AMOUNT);
    expect(row!.currency).toBe("usd");
    expect(row!.stripeSubscriptionId).toBe(subscription.id);
    expect(row!.stripeCustomerId).toBe(subscription.customer);
    // The buyer's address is on the row as a digest only — it is what
    // the claim token carries so the magic-link path stays reachable.
    expect(row!.emailHash).toEqual(expect.any(String));
  }, 30_000);

  // The browser calls `/confirm` when `stripe.confirmPayment` resolves,
  // but the endpoint is anonymous and takes nothing but a session id, so
  // the client's word is not evidence. Here Stripe really has not settled.
  it("409s and leaves the session in progress while Stripe still says incomplete", async () => {
    const res = await confirm(SESSION_A);

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("Payment is not complete");

    const row = await purchaseRow(SESSION_A);
    expect(row!.status).toBe("pending");
    expect((await sessionRow(SESSION_A))!.state).toBe("in_progress");
    expect(await tokenRows(SESSION_A)).toHaveLength(0);
  }, 30_000);

  it("flips purchase and session to paid and mints exactly one token once Stripe says active", async () => {
    const row = await purchaseRow(SESSION_A);
    const subscription = stripeStub.subscriptions.get(row!.stripeSubscriptionId!)!;
    // The card cleared: Stripe moves the subscription off `incomplete`.
    subscription.status = "active";

    const res = await confirm(SESSION_A);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        already_issued: boolean;
        token: string;
        deep_link_url: string;
        universal_link_url: string;
      };
    };
    expect(body.data.already_issued).toBe(false);
    expect(body.data.token).toEqual(expect.any(String));
    claimToken = body.data.token;
    expect(body.data.deep_link_url).toBe(
      `acme://onboarding-complete?token=${claimToken}&project=${PROJECT_ID}`,
    );
    expect(body.data.universal_link_url).toBe(
      `https://links.acme.test/universal/funnels/open/${claimToken}`,
    );

    const paid = await purchaseRow(SESSION_A);
    expect(paid!.status).toBe("paid");
    expect(paid!.paidAt).toBeInstanceOf(Date);
    // The completion anchors a synthetic subscriber on the Stripe
    // customer; the claim merges that row into the buyer's install.
    expect(paid!.subscriberId).toEqual(expect.any(String));

    expect((await sessionRow(SESSION_A))!.state).toBe("paid");
    expect(await tokenRows(SESSION_A)).toHaveLength(1);

    const [synthetic] = await getDb()
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, paid!.subscriberId!));
    expect(synthetic!.rovenueId).toBe(`stripe:${paid!.stripeCustomerId}`);
  }, 30_000);

  // The plaintext exists exactly once — only its hash was stored — so a
  // repeat call says so plainly instead of minting a second token.
  it("does not mint a second token when /confirm is called again", async () => {
    const res = await confirm(SESSION_A);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.already_issued).toBe(true);
    expect(body.data).not.toHaveProperty("token");

    expect(await tokenRows(SESSION_A)).toHaveLength(1);
  }, 30_000);

  // Where the entitlements come from. `completeFunnelPurchase` mints the
  // token and anchors the subscriber but grants nothing — the purchase
  // and its access rows are written by the connected account's own
  // subscription event, onto that same synthetic row.
  it("grants the synthetic subscriber real access when the subscription event lands", async () => {
    const row = await purchaseRow(SESSION_A);
    const subscription = stripeStub.subscriptions.get(row!.stripeSubscriptionId!)!;

    const result = await deliverWebhook("customer.subscription.updated", subscription);
    expect(result.status).toBe("processed");

    const accessRows = await getDb()
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, row!.subscriberId!));
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]!.accessId).toBe(ACCESS_ID);
    expect(accessRows[0]!.isActive).toBe(true);

    // The completion was already done by `/confirm`; the backstop sees a
    // paid row and mints nothing.
    expect(await tokenRows(SESSION_A)).toHaveLength(1);
  }, 30_000);

  it("merges the synthetic subscriber into the install and returns its entitlements", async () => {
    const before = await purchaseRow(SESSION_A);
    const syntheticId = before!.subscriberId!;

    const res = await claim(DEVICE_ID, claimToken);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { subscriber_id: string; entitlements: string[] };
    };

    const db = getDb();
    const [installed] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.rovenueId, DEVICE_ID));
    expect(installed).toBeDefined();
    expect(body.data.subscriber_id).toBe(installed!.id);

    // THE assertion this whole file exists for: the buyer who paid on a
    // web page before they had an install ends up holding, on the
    // device, the catalog identifier the SDK checks.
    expect(body.data.entitlements).toEqual([ACCESS_IDENTIFIER]);

    const movedAccess = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, installed!.id));
    expect(movedAccess).toHaveLength(1);

    const movedPurchases = await db
      .select()
      .from(purchases)
      .where(eq(purchases.subscriberId, installed!.id));
    expect(movedPurchases).toHaveLength(1);

    const [synthetic] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, syntheticId));
    expect(synthetic!.deletedAt).toBeInstanceOf(Date);
    expect(synthetic!.mergedInto).toBe(installed!.id);

    // The funnel purchase follows the assets, or every funnel report
    // joining it lands on a row this transaction just retired.
    expect((await purchaseRow(SESSION_A))!.subscriberId).toBe(installed!.id);
    expect((await sessionRow(SESSION_A))!.state).toBe("completed");
  }, 30_000);

  // =============================================================
  // The tab-closed path — session B never calls /confirm
  // =============================================================

  // A trial subscription reads `trialing` from the moment the visitor
  // picks the package, BEFORE the card form is touched, and
  // `customer.subscription.created` fires there too. Completing on that
  // would hand a claim token to someone who never paid. This is a guard,
  // not a gap: the webhook and `/confirm` share one predicate and both
  // refuse it.
  it("refuses to complete a trial that has no card yet", async () => {
    const started = await startPayment(SESSION_B, TRIAL_PACKAGE_IDENTIFIER);
    expect(started.status).toBe(200);

    const body = (await started.json()) as { data: { mode: string } };
    // A trial captures nothing now — the card is only stored.
    expect(body.data.mode).toBe("setup");

    const row = await purchaseRow(SESSION_B);
    expect(row!.status).toBe("pending");
    // The SetupIntent id is parked on the row so settlement never
    // depends on Stripe still exposing `pending_setup_intent`.
    expect((row!.rawPayload as Record<string, unknown>).setup_intent_id).toEqual(
      expect.any(String),
    );
    expect(stripeStub.stampedSetupIntents).toHaveLength(1);

    const subscription = stripeStub.subscriptions.get(row!.stripeSubscriptionId!)!;
    expect(subscription.status).toBe("trialing");
    expect(subscription.default_payment_method).toBeNull();

    const result = await deliverWebhook("customer.subscription.created", subscription);
    expect(result.status).toBe("processed");

    expect((await purchaseRow(SESSION_B))!.status).toBe("pending");
    expect((await sessionRow(SESSION_B))!.state).toBe("in_progress");
    expect(await tokenRows(SESSION_B)).toHaveLength(0);
  }, 30_000);

  // ...and the buyer who closes the tab after entering their card is
  // completed by the webhook alone: no second request from the browser
  // ever arrives, and they still get a token.
  it("completes the session from the webhook once the trial's card is attached", async () => {
    const row = await purchaseRow(SESSION_B);
    const subscription = stripeStub.subscriptions.get(row!.stripeSubscriptionId!)!;
    subscription.default_payment_method = `pm_${RUN}`;

    const result = await deliverWebhook("customer.subscription.updated", subscription);
    expect(result.status).toBe("processed");

    const paid = await purchaseRow(SESSION_B);
    expect(paid!.status).toBe("paid");
    expect(paid!.subscriberId).toEqual(expect.any(String));
    expect((await sessionRow(SESSION_B))!.state).toBe("paid");

    const tokens = await tokenRows(SESSION_B);
    expect(tokens).toHaveLength(1);
    // Minted by the webhook, so no plaintext was ever returned to
    // anyone — the buyer reaches it through the deferred-match or
    // magic-link paths, which is what the stored email digest is for.
    expect(tokens[0]!.emailHash).toEqual(expect.any(String));
    expect(tokens[0]!.claimedAt).toBeNull();
  }, 30_000);

  // Stripe redelivers. The same event id must not mint a second token —
  // and must not even reach the completion, because `claimWebhookEvent`
  // answers `duplicate` on (source, event id) first.
  it("is idempotent on a redelivered webhook", async () => {
    const row = await purchaseRow(SESSION_B);
    const subscription = stripeStub.subscriptions.get(row!.stripeSubscriptionId!)!;

    const result = await deliverWebhook(
      "customer.subscription.updated",
      subscription,
      lastEventId,
    );
    expect(result.status).toBe("duplicate");

    expect(await tokenRows(SESSION_B)).toHaveLength(1);
    expect((await purchaseRow(SESSION_B))!.status).toBe("paid");
  }, 30_000);
});
