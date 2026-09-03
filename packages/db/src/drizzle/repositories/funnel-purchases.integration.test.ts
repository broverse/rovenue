// =============================================================
// upsertPending — fencing token guard
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
import { getDb } from "../client";
import { funnelPurchases, projects } from "../schema";
import {
  findLatestStripeCustomerIdForSubscriber,
  upsertPending,
} from "./funnel-purchases";

const RUN_ID = Date.now();
const P = `prj_fence_${RUN_ID}`;
const SESSION = `sess_fence_${RUN_ID}`;
const P2 = `prj_cust_${RUN_ID}`;
const SESSIONS = {
  pending: `sess_cust_pending_${RUN_ID}`,
  paidOld: `sess_cust_paid_old_${RUN_ID}`,
  refundedNew: `sess_cust_refunded_new_${RUN_ID}`,
  noCustomer: `sess_cust_none_${RUN_ID}`,
};

afterAll(async () => {
  const db = getDb();
  await db.delete(funnelPurchases).where(eq(funnelPurchases.sessionId, SESSION));
  await db.delete(projects).where(eq(projects.id, P));
  await db
    .delete(funnelPurchases)
    .where(
      or(...Object.values(SESSIONS).map((s) => eq(funnelPurchases.sessionId, s))),
    );
  await db.delete(projects).where(eq(projects.id, P2));
});

describe("upsertPending — fencing token", () => {
  it("accepts a strictly greater token and rejects a stale one", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "fence-test-project" });

    // First attempt: no row yet, so the INSERT path runs (no conflict,
    // guard does not apply).
    const first = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_first",
      fenceToken: 1,
    });
    expect(first).not.toBeNull();
    expect(first?.fenceToken).toBe(1);

    // A newer holder read 1 and writes 2 — strictly greater, accepted.
    const newer = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_newer",
      fenceToken: 2,
    });
    expect(newer).not.toBeNull();
    expect(newer?.stripePaymentIntentId).toBe("pi_newer");

    // A stale holder that also read 1 now tries to write 2. `2 < 2` is
    // false, so SQL refuses it and nothing is returned.
    const stale = await upsertPending(db, {
      sessionId: SESSION,
      projectId: P,
      stripePaymentIntentId: "pi_stale",
      fenceToken: 2,
    });
    expect(stale).toBeNull();

    // The newer holder's row must be untouched.
    const [row] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, SESSION));
    expect(row?.stripePaymentIntentId).toBe("pi_newer");
    expect(row?.fenceToken).toBe(2);
  });
});

// =============================================================
// findLatestStripeCustomerIdForSubscriber — the billing-portal
// endpoint's ONLY source of a subscriber's Stripe customer.
// =============================================================

describe("findLatestStripeCustomerIdForSubscriber", () => {
  const SUBSCRIBER_ID = `sub_cust_${RUN_ID}`;

  it("returns the most recently billed customer, ignoring pending and customer-less rows", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P2, name: "customer-lookup-project" });

    // An unrelated, currently-live attempt for the SAME subscriber — has
    // a real Stripe customer already (created before payment confirms),
    // but never billed. Must not be returned.
    await db.insert(funnelPurchases).values({
      sessionId: SESSIONS.pending,
      projectId: P2,
      subscriberId: SUBSCRIBER_ID,
      status: "pending",
      stripeCustomerId: "cus_pending_never_billed",
      fenceToken: 1,
    });

    // An older paid attempt.
    await db.insert(funnelPurchases).values({
      sessionId: SESSIONS.paidOld,
      projectId: P2,
      subscriberId: SUBSCRIBER_ID,
      status: "paid",
      stripeCustomerId: "cus_old",
      paidAt: new Date("2026-01-01T00:00:00Z"),
      fenceToken: 1,
    });

    // A newer, refunded attempt — still a real billing history, and
    // strictly more recent than the paid one above.
    await db.insert(funnelPurchases).values({
      sessionId: SESSIONS.refundedNew,
      projectId: P2,
      subscriberId: SUBSCRIBER_ID,
      status: "refunded",
      stripeCustomerId: "cus_new_refunded",
      paidAt: new Date("2026-06-01T00:00:00Z"),
      fenceToken: 1,
    });

    // A row for a DIFFERENT subscriber must never leak in.
    await db.insert(funnelPurchases).values({
      sessionId: SESSIONS.noCustomer,
      projectId: P2,
      subscriberId: `sub_other_${RUN_ID}`,
      status: "paid",
      stripeCustomerId: "cus_belongs_to_someone_else",
      paidAt: new Date("2026-08-01T00:00:00Z"),
      fenceToken: 1,
    });

    const result = await findLatestStripeCustomerIdForSubscriber(
      db,
      SUBSCRIBER_ID,
    );
    expect(result).toBe("cus_new_refunded");
  });

  it("returns null for a subscriber with no billed funnel purchase", async () => {
    const db = getDb();
    const result = await findLatestStripeCustomerIdForSubscriber(
      db,
      `sub_unknown_${RUN_ID}`,
    );
    expect(result).toBeNull();
  });
});
