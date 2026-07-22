import { beforeEach, describe, expect, test, vi } from "vitest";
import type Stripe from "stripe";

// =============================================================
// processStripeEvent — a subscription event AFTER a funnel claim
// =============================================================
//
// A funnel visitor pays before they have an install, so
// `completeFunnelPurchase` anchors a synthetic subscriber on the Stripe
// customer: `rovenueId = stripe:<customer>`. When the buyer installs and
// redeems the claim token, that synthetic is merged into the installed
// subscriber and soft-deleted with `mergedInto` pointing at it.
//
// `resolveSubscriber` derives the SAME `stripe:<customer>` anchor from
// every later subscription event. `upsertSubscriber` conflicts on
// (projectId, rovenueId) and returns the matching row REGARDLESS of
// `deletedAt` — so resolving through it would hand every renewal, trial
// conversion and status change straight back to the retired row and
// `grantAccess` would write the renewal's access there. The buyer's real
// subscriber would get the one grant the merge moved and then never
// another. `customer.subscription.updated` fires on the very next
// renewal, so it is not a corner case.
//
// The fixture below is deliberately faithful about the one behaviour
// that causes it: `upsertSubscriber` here returns the soft-deleted row,
// exactly as ON CONFLICT does. If the handler ever goes back to calling
// it first, these tests go red.
// =============================================================

const SYNTHETIC = {
  id: "sub_synthetic",
  projectId: "prj_1",
  rovenueId: "stripe:cus_funnel",
  appUserId: "stripe:cus_funnel",
  deletedAt: new Date("2026-07-01T00:00:00Z"),
  mergedInto: "sub_installed",
};

const INSTALLED = {
  id: "sub_installed",
  projectId: "prj_1",
  rovenueId: "rov_device_1",
  appUserId: null,
  deletedAt: null,
  mergedInto: null,
};

const { drizzleMock, subscribers } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };

  /** Stands in for the subscribers table, keyed by id. */
  const subscribers = new Map<string, Record<string, unknown>>();

  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(async () => ({
        outcome: "claimed" as const,
        row: { id: "whe_1" },
      })),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    subscriberRepo: {
      // The merge-aware resolution: find by (projectId, rovenueId), and
      // when the row is soft-deleted follow `mergedInto` to the live
      // survivor. Mirrors repositories/subscribers.resolveSubscriberByRovenueId.
      resolveSubscriberByRovenueId: vi.fn(
        async (_db: unknown, args: { projectId: string; rovenueId: string }) => {
          let row = [...subscribers.values()].find(
            (s) =>
              s.projectId === args.projectId && s.rovenueId === args.rovenueId,
          );
          if (!row) return null;
          for (let i = 0; i < 5 && row?.deletedAt && row?.mergedInto; i++) {
            row = subscribers.get(row.mergedInto as string);
            if (!row) return null;
          }
          return row?.deletedAt ? null : (row ?? null);
        },
      ),
      // ON CONFLICT (projectId, rovenueId) DO UPDATE ... RETURNING —
      // which is blind to `deletedAt`. This is the trap.
      upsertSubscriber: vi.fn(
        async (_db: unknown, args: { projectId: string; rovenueId: string }) => {
          const existing = [...subscribers.values()].find(
            (s) =>
              s.projectId === args.projectId && s.rovenueId === args.rovenueId,
          );
          if (existing) return existing;
          const created = {
            id: `sub_new_${subscribers.size}`,
            projectId: args.projectId,
            rovenueId: args.rovenueId,
            appUserId: args.rovenueId,
            deletedAt: null,
            mergedInto: null,
          };
          subscribers.set(created.id, created);
          return created;
        },
      ),
      findSubscriberById: vi.fn(async (_db: unknown, id: string) =>
        subscribers.get(id) ?? null,
      ),
    },
    purchaseExtRepo: {
      findPurchaseByStoreTransaction: vi.fn(async () => null),
    },
    purchaseRepo: {
      upsertPurchase: vi.fn(async () => ({
        id: "pur_1",
        expiresDate: null,
      })),
      updatePurchase: vi.fn(async () => undefined),
      updatePurchaseByStoreTransaction: vi.fn(async () => undefined),
    },
    offeringRepo: {
      findProductByStoreId: vi.fn(async () => ({
        id: "prod_1",
        accessIds: ["acc_pro"],
      })),
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
    funnelPurchaseRepo: {
      findBySession: vi.fn(async () => null as unknown),
      findByStripeSubscriptionId: vi.fn(async () => null as unknown),
    },
  };
  return { drizzleMock, subscribers };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

vi.mock("../fx", () => ({
  convertToUsd: vi.fn(async (amount: number) => amount),
}));
vi.mock("../notifications/refund-emit", () => ({
  maybeEmitRefundDetected: vi.fn(async () => undefined),
}));
vi.mock("../subscription-transition-guard", () => ({
  guardStatusWrite: vi.fn(async () => ({ apply: true, from: null })),
}));

import { processStripeEvent } from "./stripe-webhook";

const PROJECT_ID = "prj_1";

// Nothing in these paths calls Stripe; a facade that would throw if it
// were reached is the honest stub.
const account = {
  subscriptions: {
    retrieve: vi.fn(async () => {
      throw new Error("no Stripe call expected");
    }),
    update: vi.fn(async () => {
      throw new Error("no Stripe call expected");
    }),
  },
} as unknown as Parameters<typeof processStripeEvent>[0]["account"];

function run(event: Stripe.Event) {
  return processStripeEvent({ projectId: PROJECT_ID, event, account });
}

function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated",
): Stripe.Event {
  return {
    id: `evt_${type}_1`,
    type,
    data: {
      object: {
        id: "sub_stripe_1",
        status: "active",
        customer: "cus_funnel",
        items: {
          data: [
            {
              price: {
                id: "price_1",
                unit_amount: 4900,
                currency: "usd",
              },
            },
          ],
        },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        start_date: Math.floor(Date.now() / 1000),
        cancel_at_period_end: false,
        canceled_at: null,
        metadata: {},
      } as unknown as Stripe.Subscription,
    },
  } as unknown as Stripe.Event;
}

describe("processStripeEvent — the funnel claim retired the anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.clear();
    subscribers.set(SYNTHETIC.id, { ...SYNTHETIC });
    subscribers.set(INSTALLED.id, { ...INSTALLED });
  });

  test.each([
    ["customer.subscription.updated"],
    ["customer.subscription.created"],
  ] as const)(
    "%s after a claim grants access to the claimer, not the retired synthetic",
    async (type) => {
      const result = await run(subscriptionEvent(type));
      expect(result).toMatchObject({ status: "processed" });

      // THE assertion: the renewal's access lands on the subscriber the
      // buyer actually installed, not on the row the claim retired.
      expect(drizzleMock.accessRepo.createAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subscriberId: INSTALLED.id }),
      );
      expect(drizzleMock.accessRepo.createAccess).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ subscriberId: SYNTHETIC.id }),
      );

      // ...and the purchase row is hung off the same live subscriber.
      expect(drizzleMock.purchaseRepo.upsertPurchase).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          create: expect.objectContaining({ subscriberId: INSTALLED.id }),
        }),
      );

      // The soft-delete-blind upsert is never what answers when a row
      // already exists — that is the whole mechanism of the bug.
      expect(drizzleMock.subscriberRepo.upsertSubscriber).not.toHaveBeenCalled();
    },
  );

  test("still creates the anchor subscriber when no row exists at all", async () => {
    // Not every Stripe subscription came through a funnel. With nothing
    // to resolve, the create path must still run or the webhook would
    // 500 on every first-time customer.
    subscribers.clear();

    const result = await run(subscriptionEvent("customer.subscription.created"));
    expect(result).toMatchObject({ status: "processed" });

    expect(drizzleMock.subscriberRepo.upsertSubscriber).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: PROJECT_ID,
        rovenueId: "stripe:cus_funnel",
        createAttributes: { stripe_customer_id: "cus_funnel" },
      }),
    );
    expect(drizzleMock.accessRepo.createAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subscriberId: "sub_new_0" }),
    );
  });

  test("an explicit app_user_id in metadata resolves through the merge too", async () => {
    // A subscription created with app-user metadata anchors on that
    // label instead — same soft-delete hazard, same resolution.
    subscribers.clear();
    subscribers.set("sub_labelled", {
      id: "sub_labelled",
      projectId: PROJECT_ID,
      rovenueId: "user_42",
      appUserId: "user_42",
      deletedAt: new Date("2026-07-01T00:00:00Z"),
      mergedInto: INSTALLED.id,
    });
    subscribers.set(INSTALLED.id, { ...INSTALLED });

    const event = subscriptionEvent("customer.subscription.updated");
    (event.data.object as Stripe.Subscription).metadata = {
      app_user_id: "user_42",
    };

    await run(event);

    expect(drizzleMock.accessRepo.createAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subscriberId: INSTALLED.id }),
    );
  });
});
