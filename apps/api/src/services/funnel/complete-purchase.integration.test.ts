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
const { drizzle } = await import("@rovenue/db");
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
} = drizzle;
const { completeFunnelPurchase } = await import("./complete-purchase");
const { hashToken } = await import("./token");

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
