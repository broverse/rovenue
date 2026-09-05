// =============================================================
// completeFunnelPurchase — the race, against a real Postgres
// =============================================================
//
// The unit test proves the *shape* of the loser's answer. It cannot
// prove the thing the design actually rests on, because it mocks
// `db.transaction` as a passthrough: that the loser's INSERT collides
// on `funnel_claim_tokens_session_id_unique`, that the resulting 23505
// aborts its transaction, and that everything it wrote before the
// INSERT — `upsertSubscriber`, `markPaid`, `setState` — is therefore
// discarded. That chain is a property of Postgres, so it needs a
// Postgres to demonstrate.
//
// Integration: hits the docker-compose dev stack (host port 5433 —
// tests/setup.ts supplies DATABASE_URL). Nothing is stubbed except a
// rendezvous barrier described below; every write is real.
//
// HOW THE TWO CALLS ARE MADE TO OVERLAP
// -------------------------------------
// `Promise.all` alone proves nothing: node is single-threaded, so the
// first call can easily run to commit before the second one's first
// await resumes, and the test would silently degrade into two
// sequential calls. So `funnelPurchaseRepo.findBySession` is wrapped in
// a two-party barrier: each caller reads the purchase row, then parks
// until the other has also read it. Both therefore observe `pending`
// inside their own open transaction — the READ COMMITTED situation the
// `status === "paid"` short-circuit cannot catch — before either has
// written anything. From the barrier onwards the two transactions are
// genuinely interleaved and Postgres, not the test, picks the winner.
//
// The barrier is deliberately placed at the *read* and not at the
// token INSERT. Parking both callers at the INSERT would deadlock the
// test: the second caller blocks on the first's uncommitted
// `funnel_purchases` row long before it reaches the INSERT, so it could
// never arrive at a barrier there while the first waits for it.
//
// HOW THE ROLLBACK IS OBSERVED
// ----------------------------
// Both callers write, and both write the *same* paid transition — so a
// loser that failed to roll back would leave the same `status = 'paid'`
// behind and be invisible. The two calls therefore carry DIFFERENT
// Stripe customer ids. Each anchors its own `stripe:<customer>`
// subscriber and stamps its own customer id onto the purchase, so if
// the loser's transaction survived we would see its customer id on
// `funnel_purchases` and its subscriber row in the table. Both must be
// absent.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@rovenue/db";
import { toFanoutEnvelope } from "../integrations-fanout/consumer";

/** Two-party rendezvous: the first arrival parks until the second
 *  arrives, then both proceed together. Hoisted so the `vi.mock`
 *  factory below (which vitest lifts to the top of the file) can close
 *  over it. */
const barrier = vi.hoisted(() => {
  const PARTIES = 2;
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    /** How many callers had reached the barrier when it opened. */
    arrivals: () => arrived,
    arrive: async (): Promise<void> => {
      arrived += 1;
      if (arrived >= PARTIES) release();
      await gate;
    },
  };
});

// Everything stays real; only the purchase read is instrumented, and
// only to add the barrier — it still returns the row the real
// repository read inside the caller's transaction.
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  const real = actual.drizzle.funnelPurchaseRepo;
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      funnelPurchaseRepo: {
        ...real,
        findBySession: async (db: Db, sessionId: string) => {
          const row = await real.findBySession(db, sessionId);
          await barrier.arrive();
          return row;
        },
      },
    },
  };
});

// Schema objects come off the `drizzle` namespace rather than the
// package root: not every funnel table is re-exported at top level, and
// the namespace is the copy the mock above passes through untouched.
const { drizzle, ProductType } = await import("@rovenue/db");
const {
  getDb,
  funnels,
  funnelVersions,
  funnelSessions,
  funnelPurchases,
  funnelClaimTokens,
  outboxEvents,
  projects,
  subscribers,
  revenueEvents,
  products,
  virtualCurrencies,
  virtualCurrencyRepo,
  productCurrencyGrantRepo,
  creditLedgerRepo,
} = drizzle;
const { completeFunnelPurchase } = await import("./complete-purchase");
const { hashToken } = await import("./token");
const { getBalance } = await import("../credit-engine");

const RUN = Date.now();
const PROJECT_ID = `prj_fnlrace_${RUN}`;
const FUNNEL_ID = `fnl_race_${RUN}`;
const VERSION_ID = `fnv_race_${RUN}`;
const SESSION_ID = `fss_race_${RUN}`;
const PURCHASE_ID = `fpu_race_${RUN}`;

/** Distinct per caller so the loser's writes are identifiable — see
 *  "HOW THE ROLLBACK IS OBSERVED" above. */
const CALLERS = [
  { customer: `cus_confirm_${RUN}`, subscription: `sub_confirm_${RUN}` },
  { customer: `cus_webhook_${RUN}`, subscription: `sub_webhook_${RUN}` },
] as const;

describe("completeFunnelPurchase — concurrent confirm/webhook race", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Funnel Race ${RUN}` });
    await db.insert(funnels).values({
      id: FUNNEL_ID,
      projectId: PROJECT_ID,
      slug: `race-${RUN}`,
      name: "Race",
    });
    await db.insert(funnelVersions).values({
      id: VERSION_ID,
      funnelId: FUNNEL_ID,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    });
    await db.insert(funnelSessions).values({
      id: SESSION_ID,
      funnelId: FUNNEL_ID,
      funnelVersionId: VERSION_ID,
      projectId: PROJECT_ID,
      anonId: `anon_${RUN}`,
      state: "in_progress",
    });
    await db.insert(funnelPurchases).values({
      id: PURCHASE_ID,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      status: "pending",
      amountCents: 4900,
      currency: "usd",
    });
  });

  afterAll(async () => {
    const db = getDb();
    // funnel_purchases / funnel_claim_tokens / outbox_events have no FK
    // into the partitioned funnel_sessions, so the project cascade does
    // not reach them.
    await db.delete(funnelClaimTokens).where(eq(funnelClaimTokens.sessionId, SESSION_ID));
    await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, SESSION_ID));
    await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, SESSION_ID));
    await db.delete(funnelSessions).where(eq(funnelSessions.id, SESSION_ID));
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("mints exactly one token and discards the loser's transaction entirely", async () => {
    const results = await Promise.all(
      CALLERS.map((caller) =>
        completeFunnelPurchase({
          sessionId: SESSION_ID,
          stripeCustomerId: caller.customer,
          stripeSubscriptionId: caller.subscription,
          stripePaymentIntentId: null,
        }),
      ),
    );

    // Guard the premise: if only one caller ever reached the barrier the
    // two calls did not overlap and nothing below would mean anything.
    expect(barrier.arrivals()).toBe(2);

    // --- exactly one caller was handed a token -------------------
    const winnerIndex = results.findIndex((r) => !r.alreadyIssued);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = results[winnerIndex]!;
    const loser = results[loserIndex]!;
    if (winner.alreadyIssued) throw new Error("unreachable");

    expect(winner.token).toEqual(expect.any(String));
    expect(loser).toEqual({ alreadyIssued: true });
    expect(loser).not.toHaveProperty("token");

    const db = getDb();

    // --- exactly one funnel_claim_tokens row ---------------------
    const tokens = await db
      .select()
      .from(funnelClaimTokens)
      .where(eq(funnelClaimTokens.sessionId, SESSION_ID));
    expect(tokens).toHaveLength(1);
    // The stored row is the hash of the plaintext the winner returned —
    // i.e. the surviving row belongs to the caller that was given the
    // token, not to the one that rolled back.
    expect(tokens[0]!.tokenHash).toBe(hashToken(winner.token));
    expect(tokens[0]!.projectId).toBe(PROJECT_ID);

    // --- funnel_purchases.status = 'paid' ------------------------
    const [purchase] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.id, PURCHASE_ID));
    expect(purchase!.status).toBe("paid");
    expect(purchase!.paidAt).toBeInstanceOf(Date);

    // --- funnel_sessions.state = 'paid' --------------------------
    const [session] = await db
      .select()
      .from(funnelSessions)
      .where(eq(funnelSessions.id, SESSION_ID));
    expect(session!.state).toBe("paid");

    // --- exactly two outbox rows ---------------------------------
    // Four would mean the loser's emits committed too; zero or one
    // would mean the winner's did not.
    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, SESSION_ID));
    expect(outbox.map((row) => row.eventType).sort()).toEqual([
      "funnel.claim_token.issued",
      "funnel.session.paid",
    ]);
    for (const row of outbox) {
      expect(row.payload).toMatchObject({
        project_id: PROJECT_ID,
        funnel_id: FUNNEL_ID,
        purchase_id: PURCHASE_ID,
        token_id: tokens[0]!.id,
      });
    }

    // --- the loser's writes are gone -----------------------------
    // This is the part the mocked unit test cannot reach. The loser ran
    // upsertSubscriber and markPaid with ITS customer id before the
    // INSERT raised 23505; both must have been rolled back with it.
    const winnerCaller = CALLERS[winnerIndex]!;
    const loserCaller = CALLERS[loserIndex]!;
    expect(purchase!.stripeCustomerId).toBe(winnerCaller.customer);
    expect(purchase!.stripeSubscriptionId).toBe(winnerCaller.subscription);

    const anchored = await db
      .select({ rovenueId: subscribers.rovenueId })
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, `stripe:${loserCaller.customer}`),
        ),
      );
    expect(anchored).toHaveLength(0);

    // ...and the winner's synthetic subscriber is the one the purchase
    // points at, so the claim has something to merge into later.
    const [survivor] = await db
      .select({ id: subscribers.id })
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, `stripe:${winnerCaller.customer}`),
        ),
      );
    expect(survivor).toBeDefined();
    expect(purchase!.subscriberId).toBe(survivor!.id);
  });
});

// =============================================================
// completeFunnelPurchase — recording revenue for a one-time
// Stripe purchase (Task 7)
// =============================================================
//
// Before this, a one-time funnel purchase wrote a purchases row and an
// entitlement and NOTHING ELSE: no revenue_events row, no REVENUE_EVENT
// outbox row, no rovenue.revenue topic, no ClickHouse, no integration
// provider. The sale was invisible everywhere but the funnel tables.
//
// Every test here uses its own project (via `seedPendingOneTimeSession`)
// rather than sharing the race describe block's fixtures above, so
// cleanup here can never race the mocked-barrier suite above it.

describe("completeFunnelPurchase — one-time Stripe revenue", () => {
  const ONE_TIME_RUN = `${RUN}_1t`;
  let seedIndex = 0;
  const createdProjectIds: string[] = [];
  const createdSessionIds: string[] = [];

  async function seedPendingOneTimeSession(opts: {
    amountCents: number | null;
    currency: string | null;
    productType?: (typeof ProductType)[keyof typeof ProductType];
  }): Promise<{
    sessionId: string;
    purchaseId: string;
    paymentIntentId: string;
    projectId: string;
  }> {
    seedIndex += 1;
    const n = seedIndex;
    const db = getDb();
    const projectId = `prj_1t_${ONE_TIME_RUN}_${n}`;
    const funnelId = `fnl_1t_${ONE_TIME_RUN}_${n}`;
    const versionId = `fnv_1t_${ONE_TIME_RUN}_${n}`;
    const sessionId = `fss_1t_${ONE_TIME_RUN}_${n}`;
    const purchaseId = `fpu_1t_${ONE_TIME_RUN}_${n}`;
    const productId = `prd_1t_${ONE_TIME_RUN}_${n}`;
    const paymentIntentId = `pi_1t_${ONE_TIME_RUN}_${n}`;

    await db.insert(projects).values({ id: projectId, name: `OneTime ${ONE_TIME_RUN}-${n}` });
    await db.insert(funnels).values({
      id: funnelId,
      projectId,
      slug: `onetime-${ONE_TIME_RUN}-${n}`,
      name: "One-time",
    });
    await db.insert(funnelVersions).values({
      id: versionId,
      funnelId,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    });
    await db.insert(funnelSessions).values({
      id: sessionId,
      funnelId,
      funnelVersionId: versionId,
      projectId,
      anonId: `anon_1t_${ONE_TIME_RUN}_${n}`,
      state: "in_progress",
    });
    // A real product row: grantOneTimePurchase looks this up by id to
    // classify the revenue type (oneTimeRevenueTypeFor(product.type)) and
    // to walk product.accessIds — empty here, so the access-grant loop is
    // a no-op and the test stays focused on the revenue write.
    await db.insert(products).values({
      id: productId,
      projectId,
      identifier: `onetime-product-${ONE_TIME_RUN}-${n}`,
      type: opts.productType ?? ProductType.NON_CONSUMABLE,
      storeIds: {},
      displayName: "One-time product",
      accessIds: [],
    });
    await db.insert(funnelPurchases).values({
      id: purchaseId,
      sessionId,
      projectId,
      productId,
      status: "pending",
      amountCents: opts.amountCents,
      currency: opts.currency,
    });

    createdProjectIds.push(projectId);
    createdSessionIds.push(sessionId);

    return { sessionId, purchaseId, paymentIntentId, projectId };
  }

  afterAll(async () => {
    const db = getDb();
    // revenue_events cascades away with its project (FK onDelete:
    // cascade), but its co-located outbox row does NOT — outbox_events
    // has no FK at all, so the row must be found and deleted explicitly
    // before the project (and the revenue_events row it points at) is
    // gone.
    for (const projectId of createdProjectIds) {
      const revenueRows = await db
        .select({ id: revenueEvents.id })
        .from(revenueEvents)
        .where(eq(revenueEvents.projectId, projectId));
      for (const row of revenueRows) {
        await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, row.id));
      }
    }
    // funnel.session.paid / funnel.claim_token.issued outbox rows key on
    // the session id (see emitFunnelEvent), also unreachable by cascade.
    for (const sessionId of createdSessionIds) {
      await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, sessionId));
      await db.delete(funnelClaimTokens).where(eq(funnelClaimTokens.sessionId, sessionId));
      await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, sessionId));
    }
    for (const projectId of createdProjectIds) {
      // Cascades products, funnels/funnelVersions/funnelSessions,
      // subscribers, purchases, subscriber_access, revenue_events.
      await db.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("records revenue for a one-time funnel purchase", async () => {
    const { sessionId, paymentIntentId, projectId } = await seedPendingOneTimeSession({
      amountCents: 4999,
      currency: "usd",
    });

    const result = await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_1t_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("NON_RENEWING_PURCHASE");
    expect(rows[0]!.amount).toBe("49.9900");

    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, rows[0]!.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe("revenue.event.recorded");
    expect(outbox[0]!.aggregateType).toBe("REVENUE_EVENT");
  });

  it("Fix 2 (final review): a SUBSCRIPTION-typed product sold through the one-time funnel path still records revenue, as NON_RENEWING_PURCHASE", async () => {
    // The funnel decides one-time-vs-recurring from the Stripe price
    // (stripeSubscriptionId == null), not from the Rovenue product's
    // declared type — and the dashboard defaults new products to
    // type: "SUBSCRIPTION". An operator who leaves that default, attaches
    // a one-time price, and sells it through a funnel must still get a
    // revenue row, not silence.
    const { sessionId, paymentIntentId, projectId } = await seedPendingOneTimeSession({
      amountCents: 1999,
      currency: "usd",
      productType: ProductType.SUBSCRIPTION,
    });

    const result = await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_1t_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("NON_RENEWING_PURCHASE");
    expect(rows[0]!.amount).toBe("19.9900");
  });

  it("does not record a second revenue row when /confirm is replayed", async () => {
    // Both /confirm and the webhook backstop can arrive. The second
    // caller must not double-count the charge. In practice this second
    // call short-circuits on the pre-existing `status === "paid"` guard
    // before it ever reaches grantOneTimePurchase again — the dedupeKey
    // on the revenue write is defense for the genuine concurrent race
    // (proven separately above), not what this sequential replay
    // exercises. Recorded here so a regression in either guard is caught.
    const { sessionId, paymentIntentId, projectId } = await seedPendingOneTimeSession({
      amountCents: 2500,
      currency: "usd",
    });
    const args = {
      sessionId,
      stripeCustomerId: `cus_1t_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    };

    const first = await completeFunnelPurchase(args);
    const second = await completeFunnelPurchase(args);
    expect(first.alreadyIssued).toBe(false);
    expect(second.alreadyIssued).toBe(true);

    const db = getDb();
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(1);
  });

  it("still mints a claim token when the funnel row has no price", async () => {
    // The file's existing contract: nothing here may throw, because a
    // throw rolls back the paid transition and strands a buyer who
    // really paid.
    const { sessionId, paymentIntentId, projectId } = await seedPendingOneTimeSession({
      amountCents: null,
      currency: null,
    });

    const result = await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_1t_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });

    expect(result.alreadyIssued).toBe(false);
    if (result.alreadyIssued) throw new Error("unreachable");
    expect(result.token).toBeTruthy();

    // No price to convert means grantOneTimePurchase logs and skips the
    // revenue write (ruling 3) — it must not have written one anyway.
    const db = getDb();
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("puts the revenue row on the integrations fan-out envelope", async () => {
    // A recorded row is not a delivered event. This asserts the envelope
    // the consumer would build from the outbox row, using the REAL
    // `toFanoutEnvelope` (services/integrations-fanout/consumer.ts) — not
    // a hand-rolled shape that would prove nothing about delivery.
    //
    // There is no exported `publishedMessageFor` helper in this codebase;
    // the wrapper object below is the exact wire shape
    // workers/outbox-dispatcher.ts's `runOnce` JSON.stringifies onto
    // Kafka for every non-PAYWALL_EVENT topic (eventId/eventType/
    // aggregateId/createdAt/payload), reproduced here rather than
    // invented, so this is still a real production shape assertion.
    const { sessionId, paymentIntentId, projectId } = await seedPendingOneTimeSession({
      amountCents: 999,
      currency: "usd",
    });

    await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_1t_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });

    const db = getDb();
    const [revenueRow] = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(revenueRow).toBeDefined();

    const [outboxRow] = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, revenueRow!.id));
    expect(outboxRow).toBeDefined();

    const wireMessage = {
      eventId: outboxRow!.id,
      eventType: outboxRow!.eventType,
      aggregateId: outboxRow!.aggregateId,
      createdAt: outboxRow!.createdAt.toISOString(),
      payload: outboxRow!.payload,
    };

    const envelope = toFanoutEnvelope(wireMessage, "rovenue.revenue");
    expect(envelope?.eventType).toBe("revenue.event.recorded");
    expect(envelope?.revenueEventKind).toBe("NON_RENEWING_PURCHASE");
    expect(envelope?.projectId).toBe(projectId);
  });
});

// =============================================================
// completeFunnelPurchase — CONSUMABLE credit grant (residual B)
// =============================================================
//
// Before this, a CONSUMABLE sold through the funnel wrote a CREDIT_PURCHASE
// revenue row (Task 7, above) but granted no virtual currency at all: the
// funnel path only ever called grantAccess-equivalent logic, never
// grantPurchaseCurrencies. The dashboard's "credit revenue" panels would
// report money for packages that granted the buyer nothing.
//
// Credits are granted AFTER completeFunnelPurchase's transaction commits —
// see the ConsumableGrantInfo doc comment in complete-purchase.ts for why
// that has to be outside the paid-transition transaction. This describe
// block proves the whole path end to end against a real Postgres: a
// CONSUMABLE with currency grants ends with both the revenue row and the
// credit_ledger entries, a NON_CONSUMABLE gets neither, and a replay does
// not double-grant.

describe("completeFunnelPurchase — CONSUMABLE credit grant", () => {
  const CREDIT_RUN = `${RUN}_credit`;
  let seedIndex = 0;
  const createdProjectIds: string[] = [];
  const createdSessionIds: string[] = [];

  async function seedPendingSessionWithGrants(opts: {
    productType: (typeof ProductType)[keyof typeof ProductType];
    amountCents: number;
    currency: string;
    grants: Array<{ code: string; amount: number }>;
  }): Promise<{
    sessionId: string;
    purchaseId: string;
    paymentIntentId: string;
    projectId: string;
    currencyIds: Record<string, string>;
  }> {
    seedIndex += 1;
    const n = seedIndex;
    const db = getDb();
    const projectId = `prj_cr_${CREDIT_RUN}_${n}`;
    const funnelId = `fnl_cr_${CREDIT_RUN}_${n}`;
    const versionId = `fnv_cr_${CREDIT_RUN}_${n}`;
    const sessionId = `fss_cr_${CREDIT_RUN}_${n}`;
    const purchaseId = `fpu_cr_${CREDIT_RUN}_${n}`;
    const productId = `prd_cr_${CREDIT_RUN}_${n}`;
    const paymentIntentId = `pi_cr_${CREDIT_RUN}_${n}`;

    await db.insert(projects).values({ id: projectId, name: `Credit ${CREDIT_RUN}-${n}` });
    await db.insert(funnels).values({
      id: funnelId,
      projectId,
      slug: `credit-${CREDIT_RUN}-${n}`,
      name: "Credit",
    });
    await db.insert(funnelVersions).values({
      id: versionId,
      funnelId,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    });
    await db.insert(funnelSessions).values({
      id: sessionId,
      funnelId,
      funnelVersionId: versionId,
      projectId,
      anonId: `anon_cr_${CREDIT_RUN}_${n}`,
      state: "in_progress",
    });
    await db.insert(products).values({
      id: productId,
      projectId,
      identifier: `credit-product-${CREDIT_RUN}-${n}`,
      type: opts.productType,
      storeIds: {},
      displayName: "Credit product",
      accessIds: [],
    });

    const currencyIds: Record<string, string> = {};
    for (const grant of opts.grants) {
      const currency = await virtualCurrencyRepo.createVirtualCurrency(db, {
        projectId,
        code: grant.code,
        name: grant.code,
      });
      currencyIds[grant.code] = currency.id;
    }
    if (opts.grants.length > 0) {
      await productCurrencyGrantRepo.setProductGrants(
        db,
        productId,
        opts.grants.map((grant) => ({
          currencyId: currencyIds[grant.code]!,
          amount: grant.amount,
        })),
      );
    }

    await db.insert(funnelPurchases).values({
      id: purchaseId,
      sessionId,
      projectId,
      productId,
      status: "pending",
      amountCents: opts.amountCents,
      currency: opts.currency,
    });

    createdProjectIds.push(projectId);
    createdSessionIds.push(sessionId);

    return { sessionId, purchaseId, paymentIntentId, projectId, currencyIds };
  }

  afterAll(async () => {
    const db = getDb();
    for (const projectId of createdProjectIds) {
      const revenueRows = await db
        .select({ id: revenueEvents.id })
        .from(revenueEvents)
        .where(eq(revenueEvents.projectId, projectId));
      for (const row of revenueRows) {
        await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, row.id));
      }
    }
    for (const sessionId of createdSessionIds) {
      await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, sessionId));
      await db.delete(funnelClaimTokens).where(eq(funnelClaimTokens.sessionId, sessionId));
      await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, sessionId));
    }
    // credit_ledger is DB-enforced append-only; the project cascade's
    // implicit DELETE into it is rejected unless explicitly authorized for
    // this transaction (see packages/db 0081_credit_ledger_invariants.sql).
    await creditLedgerRepo.withLedgerDeleteAuthorized(db, async (tx) => {
      for (const projectId of createdProjectIds) {
        // Cascades products (and product_currency_grants with it),
        // virtual_currencies, funnels/funnelVersions/funnelSessions,
        // subscribers, purchases, subscriber_access, revenue_events,
        // and now credit_ledger too.
        await tx.delete(projects).where(eq(projects.id, projectId));
      }
    });
  });

  it("grants credits and records CREDIT_PURCHASE revenue for a CONSUMABLE sold through the funnel", async () => {
    const { sessionId, paymentIntentId, projectId, currencyIds } =
      await seedPendingSessionWithGrants({
        productType: ProductType.CONSUMABLE,
        amountCents: 999,
        currency: "usd",
        grants: [
          { code: "GLD", amount: 1000 },
          { code: "GEM", amount: 5 },
        ],
      });

    const result = await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_cr_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();

    // The revenue row is CREDIT_PURCHASE, not NON_RENEWING_PURCHASE.
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("CREDIT_PURCHASE");

    // The credits actually landed for the subscriber the purchase was
    // anchored on.
    const [funnelPurchaseRow] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, sessionId));
    const subscriberId = funnelPurchaseRow!.subscriberId!;
    expect(subscriberId).toBeTruthy();

    expect(await getBalance(subscriberId, currencyIds.GLD!)).toBe(1000);
    expect(await getBalance(subscriberId, currencyIds.GEM!)).toBe(5);
  });

  it("grants no credits for a NON_CONSUMABLE product even when currency grants are configured", async () => {
    // A NON_CONSUMABLE would not normally carry product_currency_grants
    // rows, but configuring one anyway and confirming nothing is granted
    // exercises the actual `product.type !== CONSUMABLE` gate rather than
    // trivially passing because there was nothing to grant.
    const { sessionId, paymentIntentId, projectId, currencyIds } =
      await seedPendingSessionWithGrants({
        productType: ProductType.NON_CONSUMABLE,
        amountCents: 1999,
        currency: "usd",
        grants: [{ code: "GLD", amount: 1000 }],
      });

    const result = await completeFunnelPurchase({
      sessionId,
      stripeCustomerId: `cus_cr_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("NON_RENEWING_PURCHASE");

    const [funnelPurchaseRow] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, sessionId));
    const subscriberId = funnelPurchaseRow!.subscriberId!;
    expect(await getBalance(subscriberId, currencyIds.GLD!)).toBe(0);
  });

  it("does not double-grant credits when /confirm is replayed", async () => {
    const { sessionId, paymentIntentId, currencyIds } =
      await seedPendingSessionWithGrants({
        productType: ProductType.CONSUMABLE,
        amountCents: 500,
        currency: "usd",
        grants: [{ code: "GLD", amount: 250 }],
      });

    const args = {
      sessionId,
      stripeCustomerId: `cus_cr_${sessionId}`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: paymentIntentId,
    };
    const first = await completeFunnelPurchase(args);
    const second = await completeFunnelPurchase(args);
    expect(first.alreadyIssued).toBe(false);
    expect(second.alreadyIssued).toBe(true);

    const db = getDb();
    const [funnelPurchaseRow] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, sessionId));
    const subscriberId = funnelPurchaseRow!.subscriberId!;
    // Still exactly one grant's worth, not two.
    expect(await getBalance(subscriberId, currencyIds.GLD!)).toBe(250);
  });
});
