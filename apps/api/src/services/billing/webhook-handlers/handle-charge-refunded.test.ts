import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// handleChargeRefunded — per-refund delta, not cumulative (unit)
// =============================================================
//
// Stripe's `charge.amount_refunded` is the charge's CUMULATIVE refunded
// total; each `charge.refunded` delivery (one per refund) carries the
// growing cumulative. `incrementRefundedAmount` is additive, so recording
// the cumulative per event over-states refundedAmount on any charge
// refunded in more than one step ($3 then $4 on a $10 charge would record
// $3 + $7 = $10 after only $7 was returned). Contract pinned here: the
// handler records this refund's own amount, taken from the newest refund
// object (Stripe orders `refunds.data` most-recent-first), falling back
// to the cumulative only when the refunds sub-list is absent.
// =============================================================

const { incrementRefundedAmountMock } = vi.hoisted(() => ({
  incrementRefundedAmountMock: vi.fn(async () => undefined),
}));

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      billingInvoiceRepo: {
        ...actual.drizzle.billingInvoiceRepo,
        incrementRefundedAmount: incrementRefundedAmountMock,
      },
    },
  };
});

import { handleChargeRefunded } from "./handle-charge-refunded";
import type Stripe from "stripe";
import type { Db } from "@rovenue/db";

const tx = {} as Db;

function makeCtx(charge: Record<string, unknown>) {
  return {
    tx,
    projectId: "proj_1",
    event: {
      id: "evt_refund_1",
      type: "charge.refunded",
      data: { object: charge },
    } as unknown as Stripe.Event,
  };
}

beforeEach(() => {
  incrementRefundedAmountMock.mockClear();
});

describe("handleChargeRefunded", () => {
  test("records the newest refund's own amount, not the cumulative total", async () => {
    // Second partial refund of $4.00 on a charge already refunded $3.00
    // → cumulative 700, this refund 400.
    await handleChargeRefunded(
      makeCtx({
        id: "ch_1",
        invoice: "in_1",
        amount_refunded: 700,
        refunds: { data: [{ id: "re_2", amount: 400 }] },
      }),
    );
    expect(incrementRefundedAmountMock).toHaveBeenCalledWith(
      tx,
      "in_1",
      "4.0000",
    );
  });

  test("falls back to the cumulative total when the refunds sub-list is absent", async () => {
    await handleChargeRefunded(
      makeCtx({ id: "ch_2", invoice: "in_2", amount_refunded: 250 }),
    );
    expect(incrementRefundedAmountMock).toHaveBeenCalledWith(
      tx,
      "in_2",
      "2.5000",
    );
  });

  test("skips charges with no invoice", async () => {
    await handleChargeRefunded(makeCtx({ id: "ch_3", invoice: null }));
    expect(incrementRefundedAmountMock).not.toHaveBeenCalled();
  });
});
