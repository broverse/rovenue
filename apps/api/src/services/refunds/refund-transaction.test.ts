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

const verifyGoogleSubscription = vi.hoisted(() => vi.fn());
const verifyGoogleProductPurchase = vi.hoisted(() => vi.fn());
vi.mock("../google/google-verify", () => ({
  verifyGoogleSubscription,
  verifyGoogleProductPurchase,
}));

const findProductById = vi.hoisted(() => vi.fn());
vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      productRepo: { ...actual.drizzle.productRepo, findProductById },
    },
  };
});

import { refundTransaction } from "./refund-transaction";

// A realistic Play purchase row: `storeTransactionId` is ALWAYS the opaque
// purchase token (see google-webhook.ts / receipt-verify.ts) — never a
// `GPA.…` order id. The previous fixture hand-fed a "GPA.1"-shaped id and
// self-confirmed the broken code path that passed the token to
// `orders.refund`'s orderId parameter.
const PLAY_TOKEN =
  "opjcmghekkcbdapmneljecap.AO-J1OxWabcdefGHIJKLmnopQRstuVWxyz0123456789";

beforeEach(() => {
  refundsCreate.mockReset();
  ordersRefund.mockReset();
  verifyGoogleSubscription.mockReset();
  verifyGoogleProductPurchase.mockReset();
  findProductById.mockReset();
  getConnectedStripe.mockReset();
  getConnectedStripe.mockResolvedValue({
    account: { refunds: { create: refundsCreate } },
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
    { idempotencyKey: "refund_pu" },
  );
  expect(r).toEqual({ ok: true, store: "stripe", reference: "re_1" });
});

it("uses payment_intent when ref starts with pi_", async () => {
  refundsCreate.mockResolvedValue({ id: "re_2" });
  await refundTransaction({ projectId: "p", purchase: { id: "pu", store: "STRIPE", storeTransactionId: "pi_9", status: "ACTIVE" } as any });
  expect(refundsCreate).toHaveBeenCalledWith(
    { payment_intent: "pi_9" },
    { idempotencyKey: "refund_pu" },
  );
});

it("issues the refund against the connected account", async () => {
  getConnectedStripe.mockResolvedValue({
    account: { refunds: { create: refundsCreate } },
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
    { idempotencyKey: "refund_pur_1" },
  );
});

it("refunds a Play subscription by resolving the real order id from the token", async () => {
  ordersRefund.mockResolvedValue({});
  findProductById.mockResolvedValue({
    id: "prod_1",
    type: "SUBSCRIPTION",
    storeIds: { google: "pro_sub" },
  });
  verifyGoogleSubscription.mockResolvedValue({
    latestOrderId: "GPA.3333-1111-2222-44444",
    lineItems: [{ latestSuccessfulOrderId: "GPA.3333-1111-2222-44444..2" }],
  });

  const r = await refundTransaction({
    projectId: "p",
    purchase: { id: "pu", productId: "prod_1", store: "PLAY_STORE", storeTransactionId: PLAY_TOKEN, status: "ACTIVE" } as any,
  });

  expect(verifyGoogleSubscription).toHaveBeenCalledWith(
    { credentials: expect.objectContaining({ client_email: "a@b.com" }), packageName: "com.app" },
    PLAY_TOKEN,
  );
  expect(ordersRefund).toHaveBeenCalledWith({
    packageName: "com.app",
    orderId: "GPA.3333-1111-2222-44444..2",
    revoke: true,
  });
  expect(r).toEqual({ ok: true, store: "play", reference: "GPA.3333-1111-2222-44444..2" });
});

it("refunds a Play one-time product via purchases.products.get orderId", async () => {
  ordersRefund.mockResolvedValue({});
  findProductById.mockResolvedValue({
    id: "prod_2",
    type: "CONSUMABLE",
    storeIds: { google: "coins_100" },
  });
  verifyGoogleProductPurchase.mockResolvedValue({ orderId: "GPA.9999-8888-7777-66666" });

  const r = await refundTransaction({
    projectId: "p",
    purchase: { id: "pu2", productId: "prod_2", store: "PLAY_STORE", storeTransactionId: PLAY_TOKEN, status: "ACTIVE" } as any,
  });

  expect(verifyGoogleProductPurchase).toHaveBeenCalledWith(
    { credentials: expect.objectContaining({ client_email: "a@b.com" }), packageName: "com.app" },
    "coins_100",
    PLAY_TOKEN,
  );
  expect(ordersRefund).toHaveBeenCalledWith({
    packageName: "com.app",
    orderId: "GPA.9999-8888-7777-66666",
    revoke: true,
  });
  expect(r).toEqual({ ok: true, store: "play", reference: "GPA.9999-8888-7777-66666" });
});

it("returns store_error when no order id can be resolved for the token", async () => {
  findProductById.mockResolvedValue({
    id: "prod_1",
    type: "SUBSCRIPTION",
    storeIds: { google: "pro_sub" },
  });
  verifyGoogleSubscription.mockResolvedValue({ lineItems: [{}] }); // no order ids

  const r = await refundTransaction({
    projectId: "p",
    purchase: { id: "pu", productId: "prod_1", store: "PLAY_STORE", storeTransactionId: PLAY_TOKEN, status: "ACTIVE" } as any,
  });

  expect(ordersRefund).not.toHaveBeenCalled();
  expect(r).toMatchObject({ ok: false, code: "store_error" });
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
  const r = await refundTransaction({ projectId: "p", purchase: { id: "pu", productId: "prod_1", store: "PLAY_STORE", storeTransactionId: PLAY_TOKEN, status: "ACTIVE" } as any });
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
