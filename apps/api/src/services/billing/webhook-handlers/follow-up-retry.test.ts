import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// dispatchStripeBillingEvent — post-commit follow-up durability (unit)
// =============================================================
//
// Regression for the P1: the dispatcher used to mark the webhook row
// PROCESSED *inside* the handler tx and run the follow-up
// (stripe.subscriptions.create) afterwards. If the follow-up threw,
// Stripe's retry deduped to `duplicate` at the claim and the
// subscription was never created — a silently-lost upgrade.
//
// Contract pinned here (in-process, no Postgres): when a handler
// returns a follow-up, the row is marked PROCESSED only AFTER the
// follow-up succeeds; a follow-up failure marks the row FAILED
// (re-claimable) and rethrows so Stripe/BullMQ retry.
// =============================================================

const { drizzleMock, dbMock, handleSetupIntentSucceededMock } = vi.hoisted(
  () => {
    const dbMock = {
      transaction: vi.fn(),
    };
    const drizzleMock = {
      billingSubscriptionRepo: {
        findByStripeCustomerId: vi.fn(),
      },
      webhookEventRepo: {
        claimWebhookEvent: vi.fn(),
        updateWebhookEvent: vi.fn(async () => undefined),
      },
    };
    const handleSetupIntentSucceededMock = vi.fn();
    return { drizzleMock, dbMock, handleSetupIntentSucceededMock };
  },
);

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    db: dbMock,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});

vi.mock("./handle-setup-intent-succeeded", () => ({
  handleSetupIntentSucceeded: handleSetupIntentSucceededMock,
}));

import { dispatchStripeBillingEvent } from "./index";
import type Stripe from "stripe";

type UpdatePatch = { status?: string; incrementRetryCount?: boolean };
function updateCalls(): UpdatePatch[] {
  return drizzleMock.webhookEventRepo.updateWebhookEvent.mock.calls.map(
    (c) => (c as unknown as [unknown, unknown, UpdatePatch])[2],
  );
}

function makeEvent(): Stripe.Event {
  return {
    id: "evt_setup_intent_1",
    type: "setup_intent.succeeded",
    data: { object: { id: "seti_1", customer: "cus_1" } },
  } as unknown as Stripe.Event;
}

describe("dispatchStripeBillingEvent — follow-up durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleMock.billingSubscriptionRepo.findByStripeCustomerId.mockResolvedValue(
      { projectId: "prj_test" },
    );
    drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
      outcome: "claimed",
      row: { id: "wh_1", status: "PROCESSING" },
    });
    dbMock.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({} as unknown),
    );
  });

  test("does not mark PROCESSED inside the tx, then marks PROCESSED only after the follow-up succeeds", async () => {
    const followUp = vi.fn(async () => undefined);
    let processedDuringTx = false;
    handleSetupIntentSucceededMock.mockResolvedValueOnce({ followUp });

    // Record whether PROCESSED was written while the tx callback was still
    // on the stack (it must not be — the follow-up hasn't run yet).
    dbMock.transaction.mockImplementationOnce(
      async (cb: (tx: unknown) => unknown) => {
        await cb({} as unknown);
        if (updateCalls().some((p) => p?.status === "PROCESSED")) {
          processedDuringTx = true;
        }
      },
    );

    const result = await dispatchStripeBillingEvent(makeEvent());

    expect(result).toEqual({ status: "ok" });
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(processedDuringTx).toBe(false);
    // Exactly one PROCESSED write, after the follow-up.
    const processedCalls = updateCalls().filter(
      (p) => p?.status === "PROCESSED",
    );
    expect(processedCalls).toHaveLength(1);
  });

  test("marks the row FAILED and rethrows when the follow-up throws — never PROCESSED", async () => {
    const followUp = vi.fn(async () => {
      throw new Error("stripe boom");
    });
    handleSetupIntentSucceededMock.mockResolvedValueOnce({ followUp });

    await expect(dispatchStripeBillingEvent(makeEvent())).rejects.toThrow(
      "stripe boom",
    );

    const calls = updateCalls();
    expect(calls.some((p) => p?.status === "PROCESSED")).toBe(false);
    const failed = calls.find((p) => p?.status === "FAILED");
    expect(failed).toBeDefined();
    expect(failed?.incrementRetryCount).toBe(true);
  });
});
