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
    },
  };
});

const { completeFunnelPurchase } = await import("./complete-purchase");
const { hashToken } = await import("./token");

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
    });
    markPaid.mockReset().mockResolvedValue(undefined);
    insertClaimToken.mockReset().mockResolvedValue({ id: "token_1" });
    upsertSubscriber.mockReset().mockResolvedValue({ id: "subscriber_1" });
    outboxInsert.mockReset().mockResolvedValue(undefined);
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
  it("treats a 23505 on the token insert as already issued rather than an error", async () => {
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
    expect(result).not.toHaveProperty("token");
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
    insertClaimToken.mockRejectedValue(
      Object.assign(
        new Error(`duplicate key value violates unique constraint "${constraint}"`),
        { code: "23505", constraint },
      ),
    );

    await expect(completeFunnelPurchase(INPUT)).rejects.toThrow("duplicate key");
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
});
