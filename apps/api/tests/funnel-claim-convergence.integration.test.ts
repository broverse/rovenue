// =============================================================
// Claim-time convergence, against a real Postgres
// =============================================================
//
// The mocked suite (funnel-claim-convergence.test.ts) *simulates* the
// property this endpoint rests on: the merge is written through the
// claim transaction's `tx`, the entitlements are read back through
// `drizzle.db`, and those are two different connections — so the read
// has to happen after the commit or it sees nothing. A simulation of
// that is only as honest as the simulation. Here the two connections
// are real, the transaction is a real transaction, and `reassignAllAssets`
// really moves rows.
//
// It also covers what no mock can: that the rows actually land where
// the response says they did — the purchase, the access row, the
// soft-delete with `mergedInto` — and that a replayed claim moves
// nothing a second time, because `tryClaim`'s
// `UPDATE ... WHERE claimed_at IS NULL` already spent the token.
//
// Integration: hits the docker-compose dev stack (host port 5433 —
// tests/setup.ts supplies DATABASE_URL). Nothing is stubbed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { funnelClaimRoute } from "../src/routes/v1/funnel-claim";
import { generateClaimToken, hashToken } from "../src/services/funnel/token";

const {
  getDb,
  access,
  funnels,
  funnelVersions,
  funnelSessions,
  funnelPurchases,
  funnelClaimTokens,
  outboxEvents,
  products,
  projects,
  purchases,
  subscriberAccess,
  subscribers,
} = drizzle;

const RUN = Date.now();
const PROJECT_ID = `prj_fnlclaim_${RUN}`;
const OTHER_PROJECT_ID = `prj_fnlother_${RUN}`;
const FUNNEL_ID = `fnl_claim_${RUN}`;
const VERSION_ID = `fnv_claim_${RUN}`;
const SESSION_ID = `fss_claim_${RUN}`;
const FUNNEL_PURCHASE_ID = `fpu_claim_${RUN}`;
const SYNTHETIC_ID = `sub_synth_${RUN}`;
const ACCESS_ID = `acc_${RUN}`;
const ACCESS_IDENTIFIER = `pro_${RUN}`;
const PRODUCT_ID = `prd_${RUN}`;
const PURCHASE_ID = `pur_${RUN}`;
const ACCESS_ROW_ID = `sac_${RUN}`;
const TOKEN_ID = `tok_${RUN}`;
const DEVICE_ID = `rov_device_${RUN}`;
const OTHER_DEVICE_ID = `rov_other_${RUN}`;

const TOKEN = generateClaimToken();

function buildApp() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("project", {
        id: PROJECT_ID,
        name: "Claim Convergence",
        slug: `claim-${RUN}`,
        keyKind: "public",
        apiKeyId: "key_1",
      } as never);
      await next();
    })
    .route("/v1", funnelClaimRoute);
}

function claim(anonId: string, token = TOKEN) {
  return buildApp().request("/v1/subscribers/claim-funnel-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, anon_id: anonId }),
  });
}

describe("POST /v1/subscribers/claim-funnel-token — real Postgres", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values([
      { id: PROJECT_ID, name: `Claim Convergence ${RUN}` },
      { id: OTHER_PROJECT_ID, name: `Other ${RUN}` },
    ]);
    await db.insert(access).values({
      id: ACCESS_ID,
      projectId: PROJECT_ID,
      identifier: ACCESS_IDENTIFIER,
      displayName: "Pro",
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pro_monthly_${RUN}`,
      type: "SUBSCRIPTION",
      storeIds: { stripe: `price_${RUN}` },
      displayName: "Pro Monthly",
      accessIds: [ACCESS_ID],
    });
    await db.insert(funnels).values({
      id: FUNNEL_ID,
      projectId: PROJECT_ID,
      slug: `claim-${RUN}`,
      name: "Claim",
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
      state: "paid",
    });

    // The synthetic subscriber the payment anchored on the Stripe
    // customer, exactly as completeFunnelPurchase writes it — the buyer
    // had no install when they paid.
    await db.insert(subscribers).values({
      id: SYNTHETIC_ID,
      projectId: PROJECT_ID,
      rovenueId: `stripe:cus_${RUN}`,
      appUserId: `stripe:cus_${RUN}`,
    });
    await db.insert(purchases).values({
      id: PURCHASE_ID,
      projectId: PROJECT_ID,
      subscriberId: SYNTHETIC_ID,
      productId: PRODUCT_ID,
      store: "STRIPE",
      storeTransactionId: `txn_${RUN}`,
      originalTransactionId: `txn_${RUN}`,
      status: "ACTIVE",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      environment: "SANDBOX",
    });
    await db.insert(subscriberAccess).values({
      id: ACCESS_ROW_ID,
      subscriberId: SYNTHETIC_ID,
      purchaseId: PURCHASE_ID,
      accessId: ACCESS_ID,
      isActive: true,
      expiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      store: "STRIPE",
    });
    await db.insert(funnelPurchases).values({
      id: FUNNEL_PURCHASE_ID,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      status: "paid",
      paidAt: new Date(),
      amountCents: 4900,
      currency: "usd",
      stripeCustomerId: `cus_${RUN}`,
      subscriberId: SYNTHETIC_ID,
    });
    await db.insert(funnelClaimTokens).values({
      id: TOKEN_ID,
      tokenHash: hashToken(TOKEN),
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => {
    const db = getDb();
    // funnel_* and outbox rows have no FK into the partitioned
    // funnel_sessions, so the project cascade does not reach them.
    await db
      .delete(funnelClaimTokens)
      .where(eq(funnelClaimTokens.sessionId, SESSION_ID));
    await db
      .delete(funnelPurchases)
      .where(eq(funnelPurchases.sessionId, SESSION_ID));
    await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, SESSION_ID));
    await db.delete(funnelSessions).where(eq(funnelSessions.id, SESSION_ID));
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
  });

  it("moves the purchase onto the installed subscriber and reports its entitlements", async () => {
    const res = await claim(DEVICE_ID);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        subscriber_id: string;
        entitlements: string[];
        funnel_answers: Record<string, unknown>;
      };
    };

    const db = getDb();
    const [installed] = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, DEVICE_ID),
        ),
      );
    expect(installed).toBeDefined();
    expect(body.data.subscriber_id).toBe(installed!.id);

    // THE assertion. Every entitlement in this array was on the
    // synthetic subscriber a moment ago; the response is read on a
    // different connection from the one that moved it, so an empty
    // array here means the read outran the commit. It reports the
    // catalog IDENTIFIER, matching GET /v1/me/entitlements — not the
    // internal access row id, which would match nothing the SDK can
    // check.
    expect(body.data.entitlements).toEqual([ACCESS_IDENTIFIER]);

    // --- the rows really moved ---------------------------------
    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, PURCHASE_ID));
    expect(purchase!.subscriberId).toBe(installed!.id);

    const accessRows = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, installed!.id));
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]!.accessId).toBe(ACCESS_ID);
    expect(accessRows[0]!.isActive).toBe(true);

    // The funnel purchase follows the assets. Leaving it on the
    // synthetic would point every funnel report that joins
    // `funnel_purchases.subscriber_id` at a row this same transaction
    // soft-deleted.
    const [funnelPurchase] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.id, FUNNEL_PURCHASE_ID));
    expect(funnelPurchase!.subscriberId).toBe(installed!.id);

    // --- the synthetic row is retired, pointing at the survivor --
    const [synthetic] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, SYNTHETIC_ID));
    expect(synthetic!.deletedAt).toBeInstanceOf(Date);
    expect(synthetic!.mergedInto).toBe(installed!.id);

    // --- and the claim itself committed -------------------------
    const [token] = await db
      .select()
      .from(funnelClaimTokens)
      .where(eq(funnelClaimTokens.id, TOKEN_ID));
    expect(token!.claimedAt).toBeInstanceOf(Date);
    expect(token!.claimedBySubscriberId).toBe(installed!.id);

    const [session] = await db
      .select()
      .from(funnelSessions)
      .where(eq(funnelSessions.id, SESSION_ID));
    expect(session!.state).toBe("completed");
  });

  // Single use, for real. `tryClaim` already spent the token, so the
  // replay returns the same snapshot without reaching the merge — the
  // access row is not moved twice and no second subscriber is retired.
  it("replays the same claim without moving anything a second time", async () => {
    const db = getDb();
    const before = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.id, SYNTHETIC_ID),
        ),
      );

    const res = await claim(DEVICE_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entitlements: string[] } };
    expect(body.data.entitlements).toEqual([ACCESS_IDENTIFIER]);

    const after = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, SYNTHETIC_ID));
    // Same soft-delete instant: nothing merged again.
    expect(after[0]!.deletedAt?.getTime()).toBe(before[0]!.deletedAt?.getTime());
    expect(after[0]!.mergedInto).toBe(before[0]!.mergedInto);

    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, PURCHASE_ID));
    expect(purchase!.subscriberId).not.toBe(SYNTHETIC_ID);
  });

  // A second device presenting the same token is not the buyer. It must
  // not be handed the purchase.
  it("refuses a spent token presented by a different device", async () => {
    const res = await claim(OTHER_DEVICE_ID);
    expect(res.status).toBe(409);

    const db = getDb();
    const rows = await db
      .select()
      .from(subscribers)
      .where(
        and(
          eq(subscribers.projectId, PROJECT_ID),
          eq(subscribers.rovenueId, OTHER_DEVICE_ID),
        ),
      );
    // The row exists (resolve/upsert runs before the claim check) but it
    // owns nothing.
    if (rows[0]) {
      const stolen = await db
        .select()
        .from(subscriberAccess)
        .where(eq(subscriberAccess.subscriberId, rows[0].id));
      expect(stolen).toHaveLength(0);
    }
  });
});
