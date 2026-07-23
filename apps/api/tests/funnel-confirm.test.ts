import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /public/funnel-sessions/:sessionId/confirm
// =============================================================
//
// The rule under test: the browser's word is not evidence. The client
// calls this after `stripe.confirmPayment` resolves, but anyone can call
// it at any time with nothing but a session id — so the server asks
// Stripe whether the money actually moved before it mints anything.
//
// The second rule: the plaintext token exists exactly once. A repeat call
// says `already_issued: true` and returns NO token, because there is no
// honest way to return one — only the hash was stored.
//
// `completeFunnelPurchase` is deliberately NOT mocked; the whole point of
// the repeat-call case is that the service and the route agree, and a
// stubbed service would let them disagree silently.

const findSessionById = vi.hoisted(() => vi.fn());
const setSessionState = vi.hoisted(() => vi.fn());
const findVersionById = vi.hoisted(() => vi.fn());
const findPurchaseBySession = vi.hoisted(() => vi.fn());
const markPaid = vi.hoisted(() => vi.fn());
const insertClaimToken = vi.hoisted(() => vi.fn());
const upsertSubscriber = vi.hoisted(() => vi.fn());
const outboxInsert = vi.hoisted(() => vi.fn());

// The purchase row is stateful so "call it twice" is a real second call
// against the state the first one left behind, not two reads of a fixture.
const purchase = vi.hoisted(() => ({
  status: "pending" as string,
  stripeSubscriptionId: null as string | null,
  stripePaymentIntentId: null as string | null,
  stripeCustomerId: "cus_1" as string | null,
  // Where the payment-intent endpoint records the SetupIntent this
  // attempt created, under the same key it writes orphan ids.
  rawPayload: {} as Record<string, unknown>,
}));

const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: "tx" })),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction },
      funnelSessionRepo: { findById: findSessionById, setState: setSessionState },
      funnelVersionRepo: { findById: findVersionById },
      funnelPurchaseRepo: { findBySession: findPurchaseBySession, markPaid },
      funnelClaimTokenRepo: { insert: insertClaimToken },
      subscriberRepo: { upsertSubscriber },
      outboxRepo: { insert: outboxInsert },
    },
  };
});

const subscriptionsRetrieve = vi.hoisted(() => vi.fn());
const paymentIntentsRetrieve = vi.hoisted(() => vi.fn());
const setupIntentsRetrieve = vi.hoisted(() => vi.fn());
const requireConnectedStripe = vi.hoisted(() =>
  vi.fn(async () => ({
    account: {
      subscriptions: { retrieve: subscriptionsRetrieve },
      paymentIntents: { retrieve: paymentIntentsRetrieve },
      setupIntents: { retrieve: setupIntentsRetrieve },
    },
    accountId: "acct_1",
    livemode: false,
  })),
);
class StripeNotConnectedError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no active Stripe connection`);
    this.name = "StripeNotConnectedError";
  }
}
vi.mock("../src/lib/stripe-platform", () => ({
  chargesEnabled: vi.fn(async () => true),
  requireConnectedStripe,
  StripeNotConnectedError,
}));

// The settlement predicate is wrapped, not stubbed: these tests must
// exercise the REAL rule (that is the point of the trial cases below)
// while still proving the route reaches for the shared function instead
// of carrying its own copy. A stub here would let the route and the
// webhook drift apart again without a single test turning red.
const settledPredicate = vi.hoisted(() => vi.fn());
vi.mock("../src/services/stripe/payment-settled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/stripe/payment-settled")>();
  return {
    ...actual,
    hasPaidOrAttachedACard: settledPredicate.mockImplementation(
      actual.hasPaidOrAttachedACard,
    ),
  };
});

// Same in-memory Redis as funnel-payment-intent.test.ts: SET NX refuses an
// existing key and the release script deletes only on a token match. The
// Lua itself is never executed here — src/lib/redis-lock.integration.test.ts
// covers that.
const lockStore = vi.hoisted(() => new Map<string, string>());
const redisDown = vi.hoisted(() => ({ value: false }));
vi.mock("../src/lib/redis", () => ({
  redis: {
    set: async (key: string, value: string, _px: string, _ttl: number, mode?: string) => {
      if (redisDown.value) throw new Error("ECONNREFUSED 127.0.0.1:6379");
      if (mode === "NX" && lockStore.has(key)) return null;
      lockStore.set(key, value);
      return "OK";
    },
    get: async (key: string) => lockStore.get(key) ?? null,
    eval: async (_script: string, _numKeys: number, key: string, token: string) => {
      if (lockStore.get(key) !== token) return 0;
      lockStore.delete(key);
      return 1;
    },
  },
}));

describe("POST /public/funnel-sessions/:sessionId/confirm", () => {
  beforeEach(() => {
    vi.resetModules();
    redisDown.value = false;
    lockStore.clear();

    purchase.status = "pending";
    purchase.stripeSubscriptionId = null;
    purchase.stripePaymentIntentId = "pi_1";
    purchase.stripeCustomerId = "cus_1";
    purchase.rawPayload = {};

    findSessionById.mockReset().mockResolvedValue({
      id: "sess_1",
      projectId: "proj_1",
      funnelId: "funnel_1",
      funnelVersionId: "version_1",
      state: "in_progress",
    });
    setSessionState.mockReset().mockResolvedValue(undefined);
    findVersionById.mockReset().mockResolvedValue({
      id: "version_1",
      settingsJson: {
        deep_link_scheme: "acme",
        universal_link_domain: "links.acme.test",
      },
    });
    findPurchaseBySession.mockReset().mockImplementation(async () => ({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      ...purchase,
    }));
    // markPaid is what the second call reads back as "already paid".
    markPaid.mockReset().mockImplementation(async () => {
      purchase.status = "paid";
    });
    insertClaimToken.mockReset().mockResolvedValue({ id: "token_1" });
    upsertSubscriber.mockReset().mockResolvedValue({ id: "subscriber_1" });
    outboxInsert.mockReset().mockResolvedValue(undefined);

    settledPredicate.mockClear();
    subscriptionsRetrieve.mockReset().mockResolvedValue({ id: "sub_1", status: "active" });
    paymentIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "pi_1", status: "succeeded" });
    setupIntentsRetrieve
      .mockReset()
      .mockResolvedValue({ id: "seti_1", status: "succeeded" });
    requireConnectedStripe.mockClear();
  });

  async function confirm(sessionId = "sess_1") {
    const { createApp } = await import("../src/app");
    const app = createApp();
    return app.request(`/public/funnel-sessions/${sessionId}/confirm`, {
      method: "POST",
    });
  }

  it("404s for a session that does not exist", async () => {
    findSessionById.mockResolvedValue(null);
    const res = await confirm();
    expect(res.status).toBe(404);
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  it("409s when no payment was ever started for the session", async () => {
    findPurchaseBySession.mockResolvedValue(null);
    const res = await confirm();
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("No payment started");
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  // THE contract test: the caller says it paid, Stripe says it did not.
  it("409s and mints nothing when Stripe says the intent has not succeeded", async () => {
    paymentIntentsRetrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    // Coded so a client can tell "Stripe hasn't reported settlement yet"
    // (retryable) apart from a terminal 409.
    expect(JSON.stringify(await res.json())).toContain("PAYMENT_NOT_SETTLED_YET");
    expect(insertClaimToken).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  it("503s (not 500) when the project disconnected Stripe mid-flow", async () => {
    requireConnectedStripe.mockRejectedValueOnce(
      new StripeNotConnectedError("proj_1"),
    );

    const res = await confirm();

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain(
      "PAYMENT_TEMPORARILY_UNAVAILABLE",
    );
    expect(insertClaimToken).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("mints a token and returns the claim links when the intent succeeded", async () => {
    const res = await confirm();
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
    expect(body.data.deep_link_url).toBe(
      `acme://onboarding-complete?token=${body.data.token}&project=proj_1`,
    );
    expect(body.data.universal_link_url).toBe(
      `https://links.acme.test/universal/funnels/open/${body.data.token}`,
    );
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith("pi_1");
    expect(markPaid).toHaveBeenCalledTimes(1);
    expect(setSessionState).toHaveBeenCalledWith(expect.anything(), "sess_1", "paid");
  });

  // THE exploit this endpoint shipped with. The subscription is created
  // at payment-intent time, and a trial package puts it at `trialing`
  // immediately — before the card form is touched. Both endpoints are
  // anonymous and take nothing but a session id, so anyone who walked the
  // funnel could have taken a claim token here for free.
  it("409s and mints nothing for a trialing subscription with no payment method", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: "seti_1",
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("Payment is not complete");
    expect(insertClaimToken).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  // A trial still has to be claimable — it captures nothing now, so the
  // card is the commitment, and the card is what Stripe records here.
  it("treats a trialing subscription with a card attached as settled", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: "pm_1",
    });

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });

  // THE other failure direction, and the reason this endpoint expands the
  // setup intent. `default_payment_method` is written when a subscription
  // PAYMENT succeeds, which for a trial is weeks away — so a genuine trial
  // buyer standing at the end of the card form has no card on the
  // subscription and would be refused forever. The setup intent they just
  // confirmed is the signal that is true right now.
  it("treats a trialing subscription with a succeeded setup intent as settled", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: { id: "seti_1", status: "succeeded" },
    });

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
    // Expanded through the account-scoped facade's params argument — a
    // bare id would carry no status to read.
    expect(subscriptionsRetrieve).toHaveBeenCalledWith("sub_1", {
      expand: ["pending_setup_intent"],
    });
  });

  it("409s when the expanded setup intent has not been confirmed", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: {
        id: "seti_1",
        status: "requires_payment_method",
      },
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  // =============================================================
  // The stored setup intent id
  // =============================================================
  //
  // Every earlier version of this gate read settlement from something
  // that is only true for a while: a field Stripe writes weeks later, an
  // object Stripe clears on success, a webhook the operator may not have
  // configured. The payment-intent endpoint therefore writes the
  // SetupIntent's id onto the purchase row at create time, and this
  // endpoint asks Stripe for it by id — a fact recorded at the moment it
  // happened, readable a minute later or a week later.

  it("settles a trial from the stored setup intent when Stripe has cleared the pending one", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = { setup_intent_id: "seti_stored" };
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: null,
    });
    setupIntentsRetrieve.mockResolvedValue({
      id: "seti_stored",
      status: "succeeded",
    });

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
    expect(setupIntentsRetrieve).toHaveBeenCalledWith("seti_stored");
    // Through the SAME predicate. The stored id changes which read
    // produces the status, not who decides what the status means.
    expect(settledPredicate).toHaveBeenCalledWith({
      status: "trialing",
      default_payment_method: null,
      pendingSetupIntentStatus: "succeeded",
    });
  });

  // The other direction, and it matters exactly as much: a stored id is
  // not itself proof of anything. The visitor who reached the card form
  // and never completed it has one too.
  it("409s when the stored setup intent was never confirmed", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = { setup_intent_id: "seti_stored" };
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: null,
    });
    setupIntentsRetrieve.mockResolvedValue({
      id: "seti_stored",
      status: "requires_payment_method",
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("409s for a trial with no card, no pending intent and no stored id", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = {};
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: null,
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
    // Nothing to ask about: there is no id to name.
    expect(setupIntentsRetrieve).not.toHaveBeenCalled();
  });

  // A bare id is a `pending_setup_intent` that came back unexpanded —
  // unreadable, exactly like an absent one. The stored id covers it.
  it("falls back to the stored id when the pending intent is a bare id", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = { setup_intent_id: "seti_stored" };
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: "seti_stored",
    });

    expect((await confirm()).status).toBe(200);
    expect(setupIntentsRetrieve).toHaveBeenCalledWith("seti_stored");
  });

  // The round-trip is made only where it can change the answer. A card on
  // the subscription already settles it.
  it("does not retrieve the stored intent when the subscription carries a card", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = { setup_intent_id: "seti_stored" };
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: "pm_1",
      pending_setup_intent: null,
    });

    expect((await confirm()).status).toBe(200);
    expect(setupIntentsRetrieve).not.toHaveBeenCalled();
  });

  // Unreadable is not settled — but it is also not a broken endpoint. A
  // 409 tells the browser to try again; a 500 tells it to give up.
  it("409s rather than 500s when the stored intent cannot be read", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    purchase.rawPayload = { setup_intent_id: "seti_stored" };
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: null,
    });
    setupIntentsRetrieve.mockRejectedValue(new Error("No such setupintent"));

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  it("treats an active subscription as settled", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_1", status: "active" });

    expect((await confirm()).status).toBe(200);
  });

  // The route must not carry its own reading of "has this person paid".
  // The webhook's backstop asserts the mirror image of this in
  // src/services/stripe/stripe-webhook.funnel.test.ts; between them, one
  // function decides and both call it.
  it("asks the shared settlement predicate, not a local copy", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      default_payment_method: "pm_1",
      pending_setup_intent: { id: "seti_1", status: "succeeded" },
    });

    await confirm();

    expect(settledPredicate).toHaveBeenCalledWith({
      status: "trialing",
      default_payment_method: "pm_1",
      pendingSetupIntentStatus: "succeeded",
    });
  });

  it("409s for a subscription that is still incomplete", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = null;
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_1", status: "incomplete" });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  // The subscription is asked FIRST when both ids are present: it is the
  // object that actually decides whether the buyer has access.
  it("asks about the subscription before the invoice's intent", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = "pi_1";
    subscriptionsRetrieve.mockResolvedValue({ id: "sub_1", status: "active" });

    expect((await confirm()).status).toBe(200);
    expect(paymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  // ...but a subscription that says no is not the last word. Stripe lags
  // `incomplete → active` behind the invoice's payment, and the row holds
  // that invoice's PaymentIntent. A `succeeded` intent is money that
  // moved, so falling through can only add a true.
  it("falls through to the invoice's intent when the subscription has not caught up", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = "pi_1";
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "incomplete",
      default_payment_method: null,
    });
    paymentIntentsRetrieve.mockResolvedValue({ id: "pi_1", status: "succeeded" });

    expect((await confirm()).status).toBe(200);
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith("pi_1");
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });

  it("409s when neither the subscription nor its intent has settled", async () => {
    purchase.stripeSubscriptionId = "sub_1";
    purchase.stripePaymentIntentId = "pi_1";
    subscriptionsRetrieve.mockResolvedValue({
      id: "sub_1",
      status: "incomplete",
      default_payment_method: null,
    });
    paymentIntentsRetrieve.mockResolvedValue({
      id: "pi_1",
      status: "requires_payment_method",
    });

    expect((await confirm()).status).toBe(409);
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  // The plaintext exists exactly once. The second caller is told so
  // plainly rather than handed a token that was never stored.
  it("returns already_issued and NO token on a second call", async () => {
    const first = (await (await confirm()).json()) as { data: { token: string } };
    expect(first.data.token).toEqual(expect.any(String));

    const res = await confirm();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.already_issued).toBe(true);
    expect(body.data).not.toHaveProperty("token");
    // Exactly one row, and the raw response cannot carry the plaintext.
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });

  // Losing the unique index race is a routine outcome of confirm and the
  // webhook running at once, not an error.
  it("reports already_issued when the token insert loses a 23505 race", async () => {
    insertClaimToken.mockRejectedValue(
      // The shape drizzle really throws: a DrizzleQueryError wrapper with
      // the pg error on `.cause`. The service matches the constraint as
      // well as the SQLSTATE — a 23505 on token_hash or the pkey is a
      // generator collision, not a race, and must not read as
      // already_issued.
      Object.assign(new Error("Failed query: insert into ..."), {
        cause: Object.assign(
          new Error(
            'duplicate key value violates unique constraint "funnel_claim_tokens_session_id_unique"',
          ),
          { code: "23505", constraint: "funnel_claim_tokens_session_id_unique" },
        ),
      }),
    );

    const res = await confirm();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.already_issued).toBe(true);
    expect(body.data).not.toHaveProperty("token");
  });

  // Shares the payment-intent endpoint's key on purpose: that endpoint's
  // `upsertPending` forces status back to "pending" and replaces the
  // Stripe ids, so letting it run against a row this endpoint is turning
  // paid would erase the record of a real charge.
  it("409s while the payment-intent endpoint holds the session's lock", async () => {
    lockStore.set("funnel:payment:sess_1", "another-holders-token");

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("PAYMENT_IN_FLIGHT");
    expect(insertClaimToken).not.toHaveBeenCalled();
    // It must not release a lock it never held.
    expect(lockStore.get("funnel:payment:sess_1")).toBe("another-holders-token");
  });

  it("503s rather than 500s when redis cannot be reached at all", async () => {
    redisDown.value = true;

    const res = await confirm();

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain(
      "PAYMENT_TEMPORARILY_UNAVAILABLE",
    );
    expect(insertClaimToken).not.toHaveBeenCalled();
  });

  it("releases the lock so the next call can take it", async () => {
    await confirm();
    expect(lockStore.has("funnel:payment:sess_1")).toBe(false);
  });
});
