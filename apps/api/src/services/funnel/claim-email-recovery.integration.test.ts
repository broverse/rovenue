// =============================================================
// The email recovery path, end to end at the repository level
// =============================================================
//
// Someone pays on a funnel page, closes the tab, and installs the app
// four days later on a phone that has never seen the funnel: no session
// id, no referrer, no fingerprint worth trusting. `POST
// /v1/sdk/claim-via-email` is the whole recovery story for that buyer,
// and it finds them with exactly one query —
// `funnelClaimTokenRepo.findByEmailHash(db, projectId, hash)`.
//
// That query returned nothing for every buyer who ever existed, because
// no code path wrote `funnel_claim_tokens.email_hash`. The unit tests
// around this change prove each hop in isolation — the route hashes, the
// completion copies — but each of them asserts against a value it
// produced itself, so all of them would still pass if the write side and
// the read side disagreed about normalisation or algorithm. This is the
// test that cannot: it hashes on the write side, mints through the real
// service against a real Postgres, and then looks the token up the way
// the claim endpoint does, deriving the argument from a DIFFERENTLY CASED
// spelling of the same address.
//
// Integration: hits the docker-compose dev stack (host port 5433 —
// tests/setup.ts supplies DATABASE_URL). Nothing is stubbed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { completeFunnelPurchase } from "./complete-purchase";
import { hashEmail } from "./token";

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
  funnelClaimTokenRepo,
} = drizzle;

const RUN = Date.now();
const PROJECT_ID = `prj_fnlmail_${RUN}`;
const FUNNEL_ID = `fnl_mail_${RUN}`;
const VERSION_ID = `fnv_mail_${RUN}`;
const CUSTOMER_ID = `cus_mail_${RUN}`;

// Unique per run so a re-run cannot match a leftover row from a previous
// one — `findByEmailHash` deliberately ignores the session and returns
// the newest unclaimed token for the project, so a shared address would
// make the assertion meaningless.
const BUYER_EMAIL = `buyer+${RUN}@example.com`;

/** What the visitor typed at checkout, and what they type into the app
 *  days later. Same mailbox, different shift key. */
const AS_TYPED_AT_CHECKOUT = BUYER_EMAIL.toUpperCase();
const AS_TYPED_IN_THE_APP = BUYER_EMAIL.toLowerCase();

interface Fixture {
  sessionId: string;
  purchaseId: string;
}

/** One funnel session that has reached the "card accepted, row pending"
 *  state the confirm/webhook handlers pick up from. */
async function seedPendingPurchase(
  label: string,
  emailHash: string | null,
): Promise<Fixture> {
  const db = getDb();
  const sessionId = `fss_mail_${label}_${RUN}`;
  const purchaseId = `fpu_mail_${label}_${RUN}`;
  await db.insert(funnelSessions).values({
    id: sessionId,
    funnelId: FUNNEL_ID,
    funnelVersionId: VERSION_ID,
    projectId: PROJECT_ID,
    anonId: `anon_${label}_${RUN}`,
    state: "in_progress",
  });
  await db.insert(funnelPurchases).values({
    id: purchaseId,
    sessionId,
    projectId: PROJECT_ID,
    status: "pending",
    amountCents: 4900,
    currency: "usd",
    // Written by the payment-intent route in production; written here
    // with the same `hashEmail` the route calls.
    emailHash,
  });
  return { sessionId, purchaseId };
}

describe("funnel claim token — email recovery", () => {
  let paid: Fixture;
  let legacy: Fixture;

  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Funnel Mail ${RUN}` });
    await db.insert(funnels).values({
      id: FUNNEL_ID,
      projectId: PROJECT_ID,
      slug: `mail-${RUN}`,
      name: "Mail",
    });
    await db.insert(funnelVersions).values({
      id: VERSION_ID,
      funnelId: FUNNEL_ID,
      versionNo: 1,
      pagesJson: [],
      themeJson: {},
      settingsJson: {},
    });
    paid = await seedPendingPurchase("paid", hashEmail(AS_TYPED_AT_CHECKOUT));
    legacy = await seedPendingPurchase("legacy", null);
  });

  afterAll(async () => {
    const db = getDb();
    // funnel_purchases / funnel_claim_tokens / outbox_events have no FK
    // into the partitioned funnel_sessions, so the project cascade does
    // not reach them.
    for (const fixture of [paid, legacy]) {
      if (!fixture) continue;
      await db
        .delete(funnelClaimTokens)
        .where(eq(funnelClaimTokens.sessionId, fixture.sessionId));
      await db
        .delete(funnelPurchases)
        .where(eq(funnelPurchases.sessionId, fixture.sessionId));
      await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, fixture.sessionId));
      await db.delete(funnelSessions).where(eq(funnelSessions.id, fixture.sessionId));
    }
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("mints a token that findByEmailHash can find from the address alone", async () => {
    const result = await completeFunnelPurchase({
      sessionId: paid.sessionId,
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: null,
      stripePaymentIntentId: `pi_mail_${RUN}`,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();

    // THE assertion. The lookup argument is derived from the lowercase
    // spelling, while the stored hash was derived from the uppercase one
    // — so this passes only if one normalisation governs both sides.
    const found = await funnelClaimTokenRepo.findByEmailHash(
      db,
      PROJECT_ID,
      hashEmail(AS_TYPED_IN_THE_APP),
    );
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe(paid.sessionId);
    expect(found!.projectId).toBe(PROJECT_ID);
    expect(found!.claimedAt).toBeNull();
    // Not expired, or the endpoint discards it and answers 202 anyway.
    expect(found!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Only the digest crossed the boundary. A dump of either table must
    // not be a mailing list.
    const [storedPurchase] = await db
      .select()
      .from(funnelPurchases)
      .where(eq(funnelPurchases.id, paid.purchaseId));
    expect(storedPurchase!.emailHash).toBe(hashEmail(BUYER_EMAIL));
    expect(JSON.stringify(storedPurchase)).not.toContain("@example.com");
    expect(JSON.stringify(found)).not.toContain("@example.com");
  });

  it("finds nothing for an address that never bought", async () => {
    const db = getDb();
    const found = await funnelClaimTokenRepo.findByEmailHash(
      db,
      PROJECT_ID,
      hashEmail(`someone-else+${RUN}@example.com`),
    );
    expect(found).toBeNull();
  });

  // Rows that predate migration 0091 have no hash. They must still
  // complete — the buyer paid — and they must not become findable by
  // some other buyer's empty-ish hash.
  it("still mints a token for a purchase written before the column existed", async () => {
    const result = await completeFunnelPurchase({
      sessionId: legacy.sessionId,
      stripeCustomerId: `${CUSTOMER_ID}_legacy`,
      stripeSubscriptionId: null,
      stripePaymentIntentId: `pi_mail_legacy_${RUN}`,
    });
    expect(result.alreadyIssued).toBe(false);

    const db = getDb();
    const [token] = await db
      .select()
      .from(funnelClaimTokens)
      .where(eq(funnelClaimTokens.sessionId, legacy.sessionId));
    expect(token).toBeDefined();
    expect(token!.emailHash).toBeNull();

    // NULL is not a value `findByEmailHash` can match, so this token is
    // reachable by session id and deferred match only — never by someone
    // else's email.
    const found = await funnelClaimTokenRepo.findByEmailHash(
      db,
      PROJECT_ID,
      hashEmail(""),
    );
    expect(found?.sessionId).not.toBe(legacy.sessionId);
  });
});
