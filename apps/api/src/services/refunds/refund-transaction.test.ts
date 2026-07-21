import { describe, it, expect, vi, beforeEach } from "vitest";

const refundsCreate = vi.fn();
const getConnectedStripe = vi.hoisted(() => vi.fn());
vi.mock("../../lib/stripe-platform", () => ({ getConnectedStripe }));
vi.mock("../../lib/project-credentials", () => ({
  loadGoogleCredentials: vi.fn(async () => ({ packageName: "com.app", serviceAccount: { client_email: "a@b.com", private_key: "k" } })),
}));
const ordersRefund = vi.fn();
vi.mock("googleapis", () => ({ google: { androidpublisher: () => ({ orders: { refund: ordersRefund } }) } }));
vi.mock("../google/google-auth", () => ({ getGoogleAccessToken: vi.fn(async () => "tok") }));

import { refundTransaction } from "./refund-transaction";

beforeEach(() => {
  refundsCreate.mockReset();
  ordersRefund.mockReset();
  getConnectedStripe.mockReset();
  getConnectedStripe.mockResolvedValue({
    stripe: { refunds: { create: refundsCreate } },
    accountId: "acct_1",
    livemode: true,
  });
});

it("rejects Apple", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "APP_STORE", storeTransactionId: "1000", status: "ACTIVE" } as any });
  expect(r).toEqual({ ok: false, code: "apple_unsupported", message: expect.any(String) });
});

it("rejects already-refunded", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "ch_1", status: "REFUNDED" } as any });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("already_refunded");
});

it("refunds a Stripe charge", async () => {
  refundsCreate.mockResolvedValue({ id: "re_1" });
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "ch_123", status: "ACTIVE" } as any });
  expect(refundsCreate).toHaveBeenCalledWith(
    { charge: "ch_123" },
    { idempotencyKey: "refund_pu", stripeAccount: "acct_1" },
  );
  expect(r).toEqual({ ok: true, store: "stripe", reference: "re_1" });
});

it("uses payment_intent when ref starts with pi_", async () => {
  refundsCreate.mockResolvedValue({ id: "re_2" });
  await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "pi_9", status: "ACTIVE" } as any });
  expect(refundsCreate).toHaveBeenCalledWith(
    { payment_intent: "pi_9" },
    { idempotencyKey: "refund_pu", stripeAccount: "acct_1" },
  );
});

it("issues the refund against the connected account", async () => {
  getConnectedStripe.mockResolvedValue({
    stripe: { refunds: { create: refundsCreate } },
    accountId: "acct_1",
    livemode: true,
  });
  refundsCreate.mockResolvedValue({ id: "re_1" });

  const r = await refundTransaction({
    projectId: "proj_1",
    purchase: { id: "pur_1", store: "STRIPE", storeTransactionId: "pi_123", status: "ACTIVE" } as any,
  });

  expect(r).toMatchObject({ ok: true, store: "stripe", reference: "re_1" });
  expect(refundsCreate).toHaveBeenCalledWith(
    { payment_intent: "pi_123" },
    { idempotencyKey: "refund_pur_1", stripeAccount: "acct_1" },
  );
});

it("refunds a Play order", async () => {
  ordersRefund.mockResolvedValue({});
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "PLAY_STORE", storeTransactionId: "GPA.1", status: "ACTIVE" } as any });
  expect(ordersRefund).toHaveBeenCalledWith({ packageName: "com.app", orderId: "GPA.1", revoke: true });
  expect(r).toEqual({ ok: true, store: "play", reference: "GPA.1" });
});

it("maps store SDK errors to store_error", async () => {
  refundsCreate.mockRejectedValue(new Error("charge already refunded"));
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "ch_x", status: "ACTIVE" } as any });
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.code).toBe("store_error"); expect(r.message).toContain("already refunded"); }
});

import { loadGoogleCredentials } from "../../lib/project-credentials";

it("returns store_error when the project has no Stripe connection", async () => {
  getConnectedStripe.mockResolvedValue(null);
  const r = await refundTransaction({
    projectId: "proj_1",
    purchase: { id: "pur_1", store: "STRIPE", storeTransactionId: "pi_123", status: "ACTIVE" } as any,
  });
  expect(r).toMatchObject({ ok: false, code: "store_error" });
});

it("returns store_error when Google credentials are null", async () => {
  (loadGoogleCredentials as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "PLAY_STORE", storeTransactionId: "GPA.2", status: "ACTIVE" } as any });
  expect(r).toEqual({ ok: false, code: "store_error", message: expect.any(String) });
});

it("returns store_error for an unsupported store", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "MANUAL", storeTransactionId: "tx_1", status: "ACTIVE" } as any });
  expect(r).toEqual({ ok: false, code: "store_error", message: expect.any(String) });
});

it("rejects REVOKED purchase as already_refunded", async () => {
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "ch_1", status: "REVOKED" } as any });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("already_refunded");
});
