import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const SECRET = "whsec_connect_test";

const findActiveByAccountId = vi.hoisted(() => vi.fn());
const markDisconnected = vi.hoisted(() => vi.fn());
const updateAccountState = vi.hoisted(() => vi.fn());
const enqueueWebhookEvent = vi.hoisted(() =>
  vi.fn(async () => ({ id: "job_1" })),
);

// The replay guard talks to Redis for real; Redis is not running in
// this test environment. Stub it with the same in-memory Map + real
// set/getdel semantics used by stripe-connect-routes.test.ts so the
// "same event id twice" test actually exercises the NX short-circuit
// instead of failing open.
const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    set: vi.fn(
      async (
        key: string,
        value: string,
        ..._rest: unknown[]
      ) => {
        if (redisStore.has(key)) return null;
        redisStore.set(key, value);
        return "OK";
      },
    ),
    getdel: vi.fn(async (key: string) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      stripeConnectionRepo: {
        findActiveByAccountId,
        markDisconnected,
        updateAccountState,
      },
    },
  };
});

vi.mock("../src/services/webhook-processor", () => ({ enqueueWebhookEvent }));

describe("POST /webhooks/stripe/connect", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    redisStore.clear();
    process.env = { ...original };
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET;
    findActiveByAccountId.mockReset();
    markDisconnected.mockReset();
    updateAccountState.mockReset();
    enqueueWebhookEvent.mockClear();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  function post(payload: unknown, signed = true) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signed
      ? Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: SECRET,
          timestamp,
        })
      : "t=1,v1=deadbeef";
    return { body, headers: { "stripe-signature": signature } };
  }

  function event(overrides: Record<string, unknown>) {
    return {
      id: "evt_1",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      account: "acct_connected",
      data: { object: {} },
      ...overrides,
    };
  }

  it("401s when the signature does not verify", async () => {
    const app = await buildApp();
    const { body, headers } = post(event({}), false);
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(401);
  });

  it("400s when the event has no account field", async () => {
    // A platform event reaching the Connect endpoint is a
    // misconfiguration and must be loud, not silently dropped.
    const app = await buildApp();
    const { body, headers } = post(event({ account: undefined }));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(400);
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("202s with unknown_account when no active connection matches", async () => {
    // In-flight events after a disconnect must not be retried forever.
    findActiveByAccountId.mockResolvedValue(null);
    const app = await buildApp();
    const { body, headers } = post(event({}));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { status: "unknown_account" } });
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("enqueues with the resolved projectId and source STRIPE", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(event({}));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(enqueueWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "STRIPE", projectId: "proj_1" }),
    );
  });

  it("does not enqueue the same event id twice", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(event({ id: "evt_dup" }));
    await app.request("/webhooks/stripe/connect", { method: "POST", body, headers });
    const second = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    // The replay guard short-circuits the duplicate before the queue.
    // webhookReplayGuard (shared, unmodified) answers 200 + a
    // {status:"duplicate"} body on a dedup hit — see
    // tests/webhook-replay-guard.test.ts "rejects a replayed event
    // with 200 + replayed body" for the same contract on another
    // source.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      data: { status: "duplicate", source: "stripe" },
    });
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it("soft-disconnects on account.application.deauthorized", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(
      event({ id: "evt_deauth", type: "account.application.deauthorized" }),
    );
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(markDisconnected).toHaveBeenCalledWith(
      expect.anything(),
      "conn_1",
      "stripe_deauthorized",
    );
    expect(enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("refreshes capabilities on account.updated", async () => {
    findActiveByAccountId.mockResolvedValue({
      id: "conn_1",
      projectId: "proj_1",
      stripeAccountId: "acct_connected",
      livemode: false,
    });
    const app = await buildApp();
    const { body, headers } = post(
      event({
        id: "evt_updated",
        type: "account.updated",
        data: {
          object: {
            charges_enabled: true,
            payouts_enabled: true,
            capabilities: { card_payments: "active" },
            country: "TR",
            default_currency: "try",
          },
        },
      }),
    );
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(202);
    expect(updateAccountState).toHaveBeenCalledWith(
      expect.anything(),
      "conn_1",
      expect.objectContaining({ chargesEnabled: true, country: "TR" }),
    );
  });

  it("is not swallowed by the legacy /stripe/:projectId route", async () => {
    findActiveByAccountId.mockResolvedValue(null);
    const app = await buildApp();
    const { body, headers } = post(event({}));
    const res = await app.request("/webhooks/stripe/connect", {
      method: "POST",
      body,
      headers,
    });
    // The legacy route answers 401 for an unknown project; the Connect
    // route answers 202 unknown_account. Anything else means the mount
    // order regressed.
    expect(res.status).toBe(202);
  });
});
