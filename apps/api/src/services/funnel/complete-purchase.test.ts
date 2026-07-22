import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// completeFunnelPurchase
// =============================================================
//
// Two callers race here on purpose — the browser's /confirm and the
// Connect webhook — so the property under test is not "it writes the
// rows" but "whichever caller loses says so plainly". Only the token's
// HASH is stored, so the plaintext exists exactly once, in the winner's
// return value. The loser gets `alreadyIssued: true` and NO token.
//
// The two losing paths are different and both are covered: the cheap one
// (it read a row that already said `paid`) and the real one (it read a
// pending row, and lost the insert race on `funnel_claim_tokens.session_id`
// — a 23505 that must not surface as a 500).

const findSessionById = vi.hoisted(() => vi.fn());
const setSessionState = vi.hoisted(() => vi.fn());
const findPurchaseBySession = vi.hoisted(() => vi.fn());
const markPaid = vi.hoisted(() => vi.fn());
const insertClaimToken = vi.hoisted(() => vi.fn());
const upsertSubscriber = vi.hoisted(() => vi.fn());
const outboxInsert = vi.hoisted(() => vi.fn());
// The one-time grant's collaborators. A funnel package with a
// non-recurring price is charged through a bare PaymentIntent, so there
// is no subscription for the Stripe webhook to build a purchase from —
// this transaction is the only thing that can write one.
const findProductsByIds = vi.hoisted(() => vi.fn());
const upsertPurchase = vi.hoisted(() => vi.fn());
const findAccessByPurchaseAndAccessId = vi.hoisted(() => vi.fn());
const createAccess = vi.hoisted(() => vi.fn());
const setAccessActiveAndExpiry = vi.hoisted(() => vi.fn());

// A sentinel the assertions can compare against by identity: every write
// must be handed THIS object, not `drizzle.db`, or it is not in the
// transaction and the outbox invariant is broken.
const TX = vi.hoisted(() => ({ marker: "tx" }));
const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction },
      funnelSessionRepo: { findById: findSessionById, setState: setSessionState },
      funnelPurchaseRepo: { findBySession: findPurchaseBySession, markPaid },
      funnelClaimTokenRepo: { insert: insertClaimToken },
      subscriberRepo: { upsertSubscriber },
      outboxRepo: { insert: outboxInsert },
      offeringRepo: { findProductsByIds },
      purchaseRepo: { upsertPurchase },
      accessRepo: {
        findAccessByPurchaseAndAccessId,
        createAccess,
        setAccessActiveAndExpiry,
      },
    },
  };
});

const { completeFunnelPurchase } = await import("./complete-purchase");
const { hashEmail, hashToken } = await import("./token");

// What the payment-intent route parked on the purchase row. Derived with
// the real `hashEmail` rather than a made-up string so the fixture is the
// value `POST /v1/sdk/claim-via-email` would actually look up by.
const BUYER_EMAIL = "buyer@example.com";
const PURCHASE_EMAIL_HASH = hashEmail(BUYER_EMAIL);

const INPUT = {
  sessionId: "sess_1",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1" as string | null,
  stripePaymentIntentId: null as string | null,
};

describe("completeFunnelPurchase", () => {
  beforeEach(() => {
    transaction.mockClear();
    findSessionById.mockReset().mockResolvedValue({
      id: "sess_1",
      projectId: "proj_1",
      funnelId: "funnel_1",
      funnelVersionId: "version_1",
      state: "in_progress",
    });
    setSessionState.mockReset().mockResolvedValue(undefined);
    findPurchaseBySession.mockReset().mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      emailHash: PURCHASE_EMAIL_HASH,
    });
    markPaid.mockReset().mockResolvedValue(undefined);
    insertClaimToken.mockReset().mockResolvedValue({ id: "token_1" });
    upsertSubscriber.mockReset().mockResolvedValue({ id: "subscriber_1" });
    outboxInsert.mockReset().mockResolvedValue(undefined);
    findProductsByIds
      .mockReset()
      .mockResolvedValue([{ id: "prod_1", accessIds: ["access_1"] }]);
    upsertPurchase.mockReset().mockResolvedValue({ id: "purchase_row_1" });
    findAccessByPurchaseAndAccessId.mockReset().mockResolvedValue(null);
    createAccess.mockReset().mockResolvedValue(undefined);
    setAccessActiveAndExpiry.mockReset().mockResolvedValue(undefined);
  });

  it("marks the purchase paid, moves the session to paid and mints one token", async () => {
    const result = await completeFunnelPurchase(INPUT);

    expect(result.alreadyIssued).toBe(false);
    if (result.alreadyIssued) throw new Error("unreachable");
    expect(result.token).toEqual(expect.any(String));
    expect(result.token.length).toBeGreaterThan(20);

    expect(markPaid).toHaveBeenCalledWith(TX, "purchase_1", {
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripePaymentIntentId: null,
      subscriberId: "subscriber_1",
    });
    expect(setSessionState).toHaveBeenCalledWith(TX, "sess_1", "paid");
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });

  it("stores only the hash of the token it returns", async () => {
    const result = await completeFunnelPurchase(INPUT);
    if (result.alreadyIssued) throw new Error("unreachable");

    const row = insertClaimToken.mock.calls[0]?.[1] as {
      tokenHash: string;
      sessionId: string;
      projectId: string;
      expiresAt: Date;
    };
    expect(row.tokenHash).toBe(hashToken(result.token));
    // The plaintext must never reach a column.
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(row.sessionId).toBe("sess_1");
    expect(row.projectId).toBe("proj_1");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // The magic link is the only recovery path for a buyer who pays and
  // never returns to the tab — different device, days later, no session
  // id. `findByEmailHash` is how that buyer is found, and it reads
  // funnel_claim_tokens.email_hash, so the hash the payment-intent route
  // parked on the purchase row has to make this hop or the whole path is
  // dead. It was dead before this: nothing ever wrote the column.
  it("copies the purchase's emailHash onto the claim token", async () => {
    await completeFunnelPurchase(INPUT);

    const row = insertClaimToken.mock.calls[0]?.[1] as { emailHash: string | null };
    expect(row.emailHash).toBe(PURCHASE_EMAIL_HASH);
    // A digest, not the address — the token table holds a hash precisely
    // so a database leak is not an email leak.
    expect(JSON.stringify(row)).not.toContain(BUYER_EMAIL);
    expect(row.emailHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // Purchase rows written before migration 0091 have no hash. Those
  // buyers really paid, so the token must still be minted; they simply
  // lose the email fallback. Making the hash a precondition here would
  // strand them at `pending` with no token at all.
  it.each([null, undefined])(
    "still completes and still mints a token when emailHash is %s",
    async (missing) => {
      findPurchaseBySession.mockResolvedValue({
        id: "purchase_1",
        sessionId: "sess_1",
        projectId: "proj_1",
        status: "pending",
        emailHash: missing,
      });

      const result = await completeFunnelPurchase(INPUT);

      expect(result.alreadyIssued).toBe(false);
      if (result.alreadyIssued) throw new Error("unreachable");
      expect(result.token).toEqual(expect.any(String));
      expect(insertClaimToken).toHaveBeenCalledTimes(1);
      const row = insertClaimToken.mock.calls[0]?.[1] as { emailHash: string | null };
      // Normalised to null rather than left `undefined`, so the insert
      // writes an explicit NULL instead of relying on column defaults.
      expect(row.emailHash).toBeNull();
      expect(markPaid).toHaveBeenCalled();
      expect(setSessionState).toHaveBeenCalledWith(TX, "sess_1", "paid");
    },
  );

  it("anchors a synthetic subscriber on the stripe customer", async () => {
    await completeFunnelPurchase(INPUT);

    // `stripe:<customer>` is the shape the Connect webhook's
    // resolveSubscriber falls back to, so both paths converge on one row.
    expect(upsertSubscriber).toHaveBeenCalledWith(TX, {
      projectId: "proj_1",
      rovenueId: "stripe:cus_1",
      appUserId: "stripe:cus_1",
      createAttributes: { stripe_customer_id: "cus_1" },
    });
  });

  it("emits funnel.session.paid and funnel.claim_token.issued in the same transaction", async () => {
    await completeFunnelPurchase(INPUT);

    const kinds = outboxInsert.mock.calls.map(
      (call) => (call[1] as { eventType: string }).eventType,
    );
    expect(kinds).toEqual([
      "funnel.session.paid",
      "funnel.claim_token.issued",
    ]);
    // The outbox row is only guaranteed to be visible if the domain
    // change committed too — which requires the caller's tx, not the pool.
    for (const call of outboxInsert.mock.calls) expect(call[0]).toBe(TX);

    const payload = (outboxInsert.mock.calls[0]?.[1] as { payload: Record<string, unknown> })
      .payload;
    expect(payload).toMatchObject({
      funnel_id: "funnel_1",
      version_id: "version_1",
      project_id: "proj_1",
      purchase_id: "purchase_1",
      token_id: "token_1",
    });
  });

  // The plaintext exists exactly once. A second caller cannot be given it
  // and must not be handed a fake — hence no `token` on this variant.
  it("returns alreadyIssued with NO token when the row already reads paid", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "paid",
    });

    const result = await completeFunnelPurchase(INPUT);

    expect(result).toEqual({ alreadyIssued: true });
    expect(result).not.toHaveProperty("token");
    expect(insertClaimToken).not.toHaveBeenCalled();
    expect(markPaid).not.toHaveBeenCalled();
    expect(outboxInsert).not.toHaveBeenCalled();
  });

  // The status read above is NOT what makes this safe under concurrency:
  // at READ COMMITTED both racers can read `pending`. What actually
  // decides the race is the unique index on funnel_claim_tokens.session_id
  // — the loser's INSERT raises 23505 and its whole transaction (markPaid
  // included) rolls back, harmlessly, because the winner already
  // committed. That must read as "already issued", not as a 500.
  // The shape drizzle actually throws. It does NOT rethrow the pg error:
  // it wraps it in a DrizzleQueryError whose message is "Failed query: …"
  // and hangs the driver error off `.cause`, so `code` and `constraint`
  // are one level down. Building the fixture this way is the whole point
  // — a fixture that puts them on the top-level error passes against an
  // implementation that would 500 on every real race.
  function drizzleWrapped(constraint: string): Error {
    const pgError = Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint}"`),
      { code: "23505", constraint, severity: "ERROR" },
    );
    return Object.assign(
      new Error("Failed query: insert into \"funnel_claim_tokens\" ...\nparams: ..."),
      { cause: pgError },
    );
  }

  it("treats a 23505 on the token insert as already issued rather than an error", async () => {
    insertClaimToken.mockRejectedValue(
      drizzleWrapped("funnel_claim_tokens_session_id_unique"),
    );

    const result = await completeFunnelPurchase(INPUT);

    expect(result).toEqual({ alreadyIssued: true });
    expect(result).not.toHaveProperty("token");
  });

  // A driver that hands the error over unwrapped must still be read.
  it("treats an unwrapped 23505 on session_id as already issued too", async () => {
    insertClaimToken.mockRejectedValue(
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "funnel_claim_tokens_session_id_unique"',
        ),
        { code: "23505", constraint: "funnel_claim_tokens_session_id_unique" },
      ),
    );

    const result = await completeFunnelPurchase(INPUT);

    expect(result).toEqual({ alreadyIssued: true });
  });

  // That INSERT can violate three unique constraints. Only session_id
  // means "someone else already issued this session's token". A collision
  // on token_hash or on the primary key means a generator collided, and
  // swallowing it as `alreadyIssued` would roll back the paid transition
  // and strand a real payer at `pending` with no token — so the code
  // matches the constraint, not just the SQLSTATE.
  it.each([
    "funnel_claim_tokens_token_hash_unique",
    "funnel_claim_tokens_pkey",
  ])("rethrows a 23505 on %s rather than claiming already issued", async (constraint) => {
    insertClaimToken.mockRejectedValue(drizzleWrapped(constraint));

    await expect(completeFunnelPurchase(INPUT)).rejects.toThrow("Failed query");
  });

  it("rethrows any other database error", async () => {
    insertClaimToken.mockRejectedValue(
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    );

    await expect(completeFunnelPurchase(INPUT)).rejects.toThrow("deadlock detected");
  });

  it("throws when the session does not exist", async () => {
    findSessionById.mockResolvedValue(null);
    await expect(completeFunnelPurchase(INPUT)).rejects.toThrow(/sess_1 not found/);
  });

  it("throws when no purchase was ever started for the session", async () => {
    findPurchaseBySession.mockResolvedValue(null);
    await expect(completeFunnelPurchase(INPUT)).rejects.toThrow(/no purchase/);
  });

  // =============================================================
  // The one-time purchase
  // =============================================================
  //
  // A funnel package with a non-recurring price is charged through a bare
  // `paymentIntents.create`. There is no subscription, so the Stripe
  // webhook's `upsertPurchaseFromSubscription` — the ONLY path that
  // writes a `purchases` row or grants access — never runs, and
  // `payment_intent.succeeded` is deliberately absent from its
  // DOMAIN_SYNC map. The buyer paid, `/confirm` answered 200, the claim
  // merged a synthetic subscriber that owned nothing, and `entitlements`
  // came back empty with nothing logged anywhere. This transaction is the
  // only place that can write it, so it does.

  const ONE_TIME_INPUT = {
    sessionId: "sess_1",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: null as string | null,
    stripePaymentIntentId: "pi_onetime_1" as string | null,
  };

  /** The pending row a one-time attempt leaves behind. */
  function oneTimePurchaseRow(patch: Record<string, unknown> = {}) {
    return {
      id: "purchase_1",
      sessionId: "sess_1",
      projectId: "proj_1",
      status: "pending",
      emailHash: PURCHASE_EMAIL_HASH,
      productId: "prod_1",
      amountCents: 9900,
      currency: "usd",
      ...patch,
    };
  }

  it("writes a purchases row for a one-time funnel purchase", async () => {
    findPurchaseBySession.mockResolvedValue(oneTimePurchaseRow());

    const result = await completeFunnelPurchase(ONE_TIME_INPUT);

    expect(result.alreadyIssued).toBe(false);
    expect(upsertPurchase).toHaveBeenCalledTimes(1);
    const [handle, args] = upsertPurchase.mock.calls[0] as [
      unknown,
      {
        store: string;
        storeTransactionId: string;
        create: Record<string, unknown>;
      },
    ];
    // In the caller's transaction, like every other write here.
    expect(handle).toBe(TX);
    // The PaymentIntent is the natural key, which is what makes a
    // retried /confirm and a redelivered webhook converge on one row
    // rather than inserting a second.
    expect(args.store).toBe("STRIPE");
    expect(args.storeTransactionId).toBe("pi_onetime_1");
    expect(args.create).toMatchObject({
      projectId: "proj_1",
      subscriberId: "subscriber_1",
      productId: "prod_1",
      storeTransactionId: "pi_onetime_1",
      originalTransactionId: "pi_onetime_1",
      status: "ACTIVE",
      isTrial: false,
      // A one-time purchase does not lapse.
      expiresDate: null,
      autoRenewStatus: false,
      environment: "PRODUCTION",
      // Minor units on the funnel row, decimal string on the purchase.
      priceAmount: "99",
      priceCurrency: "USD",
    });
  });

  it("grants the product's access on the synthetic subscriber", async () => {
    findPurchaseBySession.mockResolvedValue(oneTimePurchaseRow());
    findProductsByIds.mockResolvedValue([
      { id: "prod_1", accessIds: ["access_1", "access_2"] },
    ]);

    await completeFunnelPurchase(ONE_TIME_INPUT);

    expect(createAccess).toHaveBeenCalledTimes(2);
    expect(createAccess).toHaveBeenCalledWith(TX, {
      subscriberId: "subscriber_1",
      purchaseId: "purchase_row_1",
      accessId: "access_1",
      isActive: true,
      expiresDate: null,
      store: "STRIPE",
    });
  });

  // Idempotent: a retried /confirm must reactivate the row it already
  // wrote rather than insert a duplicate entitlement.
  it("reactivates an existing access row instead of creating a second", async () => {
    findPurchaseBySession.mockResolvedValue(oneTimePurchaseRow());
    findAccessByPurchaseAndAccessId.mockResolvedValue({ id: "access_row_1" });

    await completeFunnelPurchase(ONE_TIME_INPUT);

    expect(setAccessActiveAndExpiry).toHaveBeenCalledWith(
      TX,
      "access_row_1",
      true,
      null,
    );
    expect(createAccess).not.toHaveBeenCalled();
  });

  // The other half of the rule. A recurring package's purchase row and
  // access are written by the Connect webhook's subscription handler;
  // doing it here as well would write the same purchase twice, under two
  // different natural keys.
  it("writes NO purchases row for a recurring purchase", async () => {
    await completeFunnelPurchase(INPUT);

    expect(upsertPurchase).not.toHaveBeenCalled();
    expect(createAccess).not.toHaveBeenCalled();
    expect(findProductsByIds).not.toHaveBeenCalled();
  });

  // Nothing about a missing product may abort the transaction: that would
  // roll back the paid transition and leave a buyer who really paid with
  // no claim token and a /confirm that 500s on every retry. The token is
  // still minted; the gap is loud in the log instead.
  it.each([
    ["no product on the row", { productId: null }],
    ["a product that no longer exists", {}],
  ])("still mints the token when there is %s", async (_label, patch) => {
    findPurchaseBySession.mockResolvedValue(oneTimePurchaseRow(patch));
    findProductsByIds.mockResolvedValue([]);

    const result = await completeFunnelPurchase(ONE_TIME_INPUT);

    expect(result.alreadyIssued).toBe(false);
    if (result.alreadyIssued) throw new Error("unreachable");
    expect(result.token).toEqual(expect.any(String));
    expect(upsertPurchase).not.toHaveBeenCalled();
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });

  it("still mints the token when the row records neither stripe object", async () => {
    findPurchaseBySession.mockResolvedValue(oneTimePurchaseRow());

    const result = await completeFunnelPurchase({
      ...ONE_TIME_INPUT,
      stripePaymentIntentId: null,
    });

    expect(result.alreadyIssued).toBe(false);
    expect(upsertPurchase).not.toHaveBeenCalled();
    expect(insertClaimToken).toHaveBeenCalledTimes(1);
  });
});
