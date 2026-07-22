import { beforeEach, describe, expect, test, vi } from "vitest";
import type Stripe from "stripe";

// =============================================================
// processStripeEvent — funnel session backstop (unit)
// =============================================================
//
// The buyer who pays on a funnel page and closes the tab never reaches
// `/funnel-sessions/:id/confirm`. The Connect webhook is their only
// remaining path to a claim token, so these tests pin two halves:
//
//   1. an event that proves payment DOES complete the session, on the
//      recurring path, the trial path and the one-time path;
//   2. an event that proves nothing does NOT — above all
//      `customer.subscription.created`, which the funnel's
//      `default_incomplete` + trial combination fires the instant a
//      visitor reaches the paywall, before any card exists.
//
// The suite runs in-process: no Postgres, no Stripe.

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(async () => ({
        outcome: "claimed" as const,
        row: { id: "whe_1" },
      })),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    funnelPurchaseRepo: {
      findBySession: vi.fn(async () => null as unknown),
      findByStripeSubscriptionId: vi.fn(async () => null as unknown),
    },
    // Touched by the domain sync that runs after the backstop; stubbed
    // so these tests exercise the backstop alone.
    subscriberRepo: {
      upsertSubscriber: vi.fn(async () => ({ id: "sub_row_1" })),
    },
    purchaseExtRepo: {
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(async () => ({ id: "pur_1", expiresDate: null })),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchaseByStoreTransaction: vi.fn(async () => undefined),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(async () => ({ id: "prod_1", accessIds: [] })),
    },
    accessRepo: {
      findAccessByPurchaseAndAccessId: vi.fn(async () => null),
      setAccessActiveAndExpiry: vi.fn(async () => undefined),
      createAccess: vi.fn(async () => undefined),
      revokeAccessByPurchaseId: vi.fn(async () => undefined),
    },
    revenueEventRepo: {
      createRevenueEvent: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

const { completeFunnelPurchase } = vi.hoisted(() => ({
  completeFunnelPurchase: vi.fn(async () => ({
    alreadyIssued: false as const,
    token: "claim_plaintext",
  })),
}));
vi.mock("../funnel/complete-purchase", () => ({ completeFunnelPurchase }));

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));
vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: vi.fn(async () => ({ apply: true, from: null })),
}));

// Wrapped, not stubbed. The trial cases below must run the REAL rule,
// and the wrapper is what proves the backstop reaches for the shared
// function rather than keeping its own copy — the copy /confirm used to
// keep is precisely how a trial with no card came to count as paid on
// one side and not the other.
const settledPredicate = vi.hoisted(() => vi.fn());
vi.mock("./payment-settled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./payment-settled")>();
  return {
    ...actual,
    hasPaidOrAttachedACard: settledPredicate.mockImplementation(
      actual.hasPaidOrAttachedACard,
    ),
  };
});

import { processStripeEvent } from "./stripe-webhook";

const PROJECT_ID = "prj_1";

/** The pending row the payment-intent endpoint left behind. */
const PENDING_PURCHASE = {
  id: "fp_1",
  sessionId: "sess_1",
  projectId: PROJECT_ID,
  status: "pending",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  stripePaymentIntentId: null,
};

function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated",
  subscription: Record<string, unknown>,
): Stripe.Event {
  return {
    id: `evt_${type}_${Math.random()}`,
    type,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_1" } }] },
        ...subscription,
      },
    },
  } as unknown as Stripe.Event;
}

function run(event: Stripe.Event) {
  return processStripeEvent({
    projectId: PROJECT_ID,
    event,
    account: {} as never,
  });
}

describe("processStripeEvent — funnel session backstop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "claimed" as const,
      row: { id: "whe_1" },
    });
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue(
      PENDING_PURCHASE,
    );
    drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId.mockResolvedValue(
      PENDING_PURCHASE,
    );
    completeFunnelPurchase.mockResolvedValue({
      alreadyIssued: false as const,
      token: "claim_plaintext",
    });
  });

  // ---------------------------------------------------------------
  // Completes
  // ---------------------------------------------------------------

  test("completes the session from a paid invoice, resolved via the subscription", async () => {
    const event = {
      id: "evt_invoice_paid_1",
      type: "invoice.paid",
      data: {
        object: { id: "in_1", subscription: "sub_1", amount_paid: 4900 },
      },
    } as unknown as Stripe.Event;

    await run(event);

    // Stripe copies subscription metadata onto neither the invoice nor
    // its PaymentIntent, so the session id comes from the row that
    // already records this subscription — no Stripe round-trip.
    expect(
      drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId,
    ).toHaveBeenCalledWith(expect.anything(), "sub_1");
    expect(completeFunnelPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_1" }),
    );
  });

  test("completes the session once the subscription is active", async () => {
    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).toHaveBeenCalledWith({
      sessionId: "sess_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripePaymentIntentId: null,
    });
  });

  test("completes a trial once the card is actually attached", async () => {
    await run(subscriptionEvent("customer.subscription.updated", {
      status: "trialing",
      default_payment_method: "pm_1",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_1" }),
    );
  });

  test("completes the one-time path from payment_intent.succeeded", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_1",
    });

    const event = {
      id: "evt_pi_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          customer: "cus_1",
          metadata: { rovenue_funnel_session_id: "sess_1" },
        },
      },
    } as unknown as Stripe.Event;

    const result = await run(event);

    expect(result.status).toBe("processed");
    expect(completeFunnelPurchase).toHaveBeenCalledWith({
      sessionId: "sess_1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      stripePaymentIntentId: "pi_1",
    });
  });

  // ---------------------------------------------------------------
  // Does not complete
  // ---------------------------------------------------------------

  // THE trap. `default_incomplete` + a trial puts the subscription into
  // `trialing` immediately, so this event fires while the visitor is
  // still looking at the card form. Completing here would grant
  // entitlements to someone who merely reached the paywall.
  test("does NOT complete a trialing subscription with no payment method", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "trialing",
      default_payment_method: null,
      pending_setup_intent: "seti_1",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("does NOT complete an incomplete subscription awaiting its first payment", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "incomplete",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // A trial's opening invoice is for 0 and is marked paid at once — the
  // same "before the card" moment, arriving as invoice.paid.
  test("does NOT complete on a zero-amount trial-start invoice", async () => {
    await run({
      id: "evt_invoice_zero",
      type: "invoice.paid",
      data: { object: { id: "in_0", subscription: "sub_1", amount_paid: 0 } },
    } as unknown as Stripe.Event);

    expect(
      drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId,
    ).not.toHaveBeenCalled();
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("ignores an event with no funnel session id", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "active",
      metadata: {},
    }));

    expect(drizzleMock.funnelPurchaseRepo.findBySession).not.toHaveBeenCalled();
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  test("ignores a session id belonging to another project", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      projectId: "prj_other",
    });

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // The visitor changed package: `upsertPending` replaced the row's ids,
  // and a late event from the superseded subscription must not complete
  // the session against the package they abandoned.
  test("ignores an event from a superseded stripe object", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockResolvedValue({
      ...PENDING_PURCHASE,
      stripeSubscriptionId: "sub_current",
    });

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // The mirror of the assertion in tests/funnel-confirm.test.ts: both
  // ends of the completion ask ONE function whether the buyer paid.
  test("asks the shared settlement predicate, not a local copy", async () => {
    await run(subscriptionEvent("customer.subscription.created", {
      status: "trialing",
      default_payment_method: null,
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(settledPredicate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "trialing" }),
    );
    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Containment
  // ---------------------------------------------------------------

  // The backstop runs before the domain sync so a sync failure cannot
  // swallow it. That ordering must not buy the buyer's safety net with
  // the account owner's billing state: a funnel-side throw is logged and
  // the switch below still runs.
  test("a failing backstop does not fail the event or skip the domain sync", async () => {
    drizzleMock.funnelPurchaseRepo.findBySession.mockRejectedValue(
      new Error("funnel_sessions partition unavailable"),
    );

    const result = await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(result.status).toBe("processed");
    expect(drizzleMock.purchaseRepo.upsertPurchase).toHaveBeenCalled();
    expect(
      drizzleMock.webhookEventRepo.updateWebhookEvent,
    ).toHaveBeenCalledWith(
      expect.anything(),
      "whe_1",
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });

  // Every renewal invoice for the life of a funnel-sold subscription
  // arrives here. `completeFunnelPurchase` would open a transaction and
  // re-read the partitioned funnel_sessions table only to discover the
  // row is already paid — the row in hand says so for free.
  test("does not re-enter the completion service for an already-paid row", async () => {
    drizzleMock.funnelPurchaseRepo.findByStripeSubscriptionId.mockResolvedValue({
      ...PENDING_PURCHASE,
      status: "paid",
    });

    await run({
      id: "evt_invoice_renewal",
      type: "invoice.paid",
      data: {
        object: { id: "in_2", subscription: "sub_1", amount_paid: 4900 },
      },
    } as unknown as Stripe.Event);

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------
  // Racing the browser's confirm
  // ---------------------------------------------------------------

  // `confirm` got there first: the winner's return value held the only
  // plaintext copy, so this caller is told so and carries no token. The
  // event is still fully processed — losing that race is routine, not a
  // failure.
  test("is a no-op when confirm already completed the session", async () => {
    completeFunnelPurchase.mockResolvedValue({ alreadyIssued: true } as never);

    await expect(
      run(subscriptionEvent("customer.subscription.updated", {
        status: "active",
        metadata: { rovenue_funnel_session_id: "sess_1" },
      })),
    ).resolves.toMatchObject({ status: "processed" });
  });

  test("does not run the backstop at all for a duplicate event", async () => {
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "duplicate" as const,
    } as never);

    await run(subscriptionEvent("customer.subscription.updated", {
      status: "active",
      metadata: { rovenue_funnel_session_id: "sess_1" },
    }));

    expect(completeFunnelPurchase).not.toHaveBeenCalled();
  });
});
