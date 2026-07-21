import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const findActiveByProject = vi.hoisted(() => vi.fn());
const insertConnection = vi.hoisted(() => vi.fn(async (_tx, v) => ({ id: "conn_1", ...v })));
const markDisconnected = vi.hoisted(() => vi.fn());
const oauthToken = vi.hoisted(() => vi.fn());
const oauthDeauthorize = vi.hoisted(() => vi.fn());
const accountsRetrieve = vi.hoisted(() => vi.fn());
const auditFn = vi.hoisted(() => vi.fn());
const assertProjectAccess = vi.hoisted(() => vi.fn());
// isConnectConfigured/connectClientId are plain env reads in the real
// module. `vi.mock(..., importOriginal)` factories are evaluated once
// and cached for the life of the test file — vi.resetModules() clears
// the *unmocked* module registry (which is why dynamic re-imports of
// ../src/lib/env or ../src/app pick up fresh process.env), but it does
// not force this factory to re-run. Driving these two functions from
// process.env, as the rest of this suite drives env.PUBLIC_BASE_URL /
// env.DASHBOARD_URL, would silently freeze at whatever value was live
// the first time this module was imported. Controlling them as regular
// mocks sidesteps that and keeps every test's env explicit.
const isConnectConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const connectClientIdMock = vi.hoisted(() =>
  vi.fn((mode: "live" | "test") => (mode === "live" ? "ca_live" : null)),
);

// createOAuthState/consumeOAuthState (used by both routes under test)
// go through ../src/lib/redis for real. Stub it with the same in-memory
// store used by oauth-state.test.ts so the nonce genuinely round-trips
// end-to-end instead of hitting a real (absent, in this test env) Redis.
const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
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
      db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
      // usageLockGuard runs on every /projects/:projectId/* dashboard
      // route and calls this with the (stubbed) drizzle.db above, which
      // has no query-builder surface. Stub it out so these route tests
      // exercise stripe-connect logic, not the usage-lock guard.
      projectRepo: {
        ...actual.drizzle.projectRepo,
        findProjectById: vi.fn(async () => null),
      },
      stripeConnectionRepo: {
        findActiveByProject,
        insert: insertConnection,
        markDisconnected,
      },
    },
  };
});

vi.mock("../src/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit")>();
  return { ...actual, audit: auditFn };
});

vi.mock("../src/lib/project-access", () => ({ assertProjectAccess }));

// The dashboard-auth middleware is replaced with a stub that injects a
// fixed user so these tests exercise the route logic, not Better Auth.
vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("../src/lib/stripe-platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/stripe-platform")>();
  return {
    ...actual,
    isConnectConfigured: isConnectConfiguredMock,
    connectClientId: connectClientIdMock,
    getConnectPlatformStripe: () => ({
      oauth: { token: oauthToken, deauthorize: oauthDeauthorize },
      accounts: { retrieve: accountsRetrieve },
    }),
  };
});

describe("Stripe Connect routes", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    redisStore.clear();
    process.env = { ...original };
    process.env.PUBLIC_BASE_URL = "https://api.example.com";
    process.env.DASHBOARD_URL = "https://app.example.com";
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_live";
    process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_live_fake";
    delete process.env.STRIPE_CONNECT_CLIENT_ID_TEST;
    findActiveByProject.mockReset().mockResolvedValue(null);
    insertConnection.mockClear();
    markDisconnected.mockReset();
    oauthToken.mockReset();
    accountsRetrieve.mockReset();
    auditFn.mockReset();
    assertProjectAccess.mockReset().mockResolvedValue(undefined);
    isConnectConfiguredMock.mockReset().mockReturnValue(true);
    connectClientIdMock
      .mockReset()
      .mockImplementation((mode: "live" | "test") =>
        mode === "live" ? "ca_live" : null,
      );
  });

  afterEach(() => {
    process.env = { ...original };
  });

  async function buildApp() {
    const { createApp } = await import("../src/app");
    return createApp();
  }

  const connectPath = "/dashboard/projects/proj_1/stripe/connect";

  describe("GET …/stripe/connect", () => {
    it("503s when the platform is unconfigured", async () => {
      isConnectConfiguredMock.mockReturnValue(false);
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(503);
    });

    it("409s when an active connection already exists", async () => {
      findActiveByProject.mockResolvedValue({ id: "conn_1" });
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(409);
    });

    it("400s when ?mode=test but no test client id is set", async () => {
      const app = await buildApp();
      const res = await app.request(`${connectPath}?mode=test`);
      expect(res.status).toBe(400);
    });

    it("403s for a non-OWNER", async () => {
      assertProjectAccess.mockRejectedValue(
        new HTTPException(403, { message: "forbidden" }),
      );
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(403);
    });

    it("302s to Stripe with response_type, scope, state and redirect_uri", async () => {
      const app = await buildApp();
      const res = await app.request(connectPath);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(
        "https://connect.stripe.com/oauth/authorize",
      );
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("scope")).toBe("read_write");
      expect(location.searchParams.get("client_id")).toBe("ca_live");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://api.example.com/stripe/oauth/callback",
      );
      expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("GET /stripe/oauth/callback", () => {
    async function connectAndGetState(app: Awaited<ReturnType<typeof buildApp>>) {
      const res = await app.request(connectPath);
      const location = new URL(res.headers.get("location") ?? "");
      return location.searchParams.get("state") ?? "";
    }

    it("400s on an unknown or expired state", async () => {
      const app = await buildApp();
      const res = await app.request("/stripe/oauth/callback?state=nope&code=c");
      expect(res.status).toBe(400);
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("400s when the same state is replayed", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_1",
        livemode: true,
        scope: "read_write",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "active" },
        country: "TR",
        default_currency: "try",
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      await app.request(`/stripe/oauth/callback?state=${state}&code=c`);
      const replay = await app.request(
        `/stripe/oauth/callback?state=${state}&code=c`,
      );
      expect(replay.status).toBe(400);
      expect(insertConnection).toHaveBeenCalledTimes(1);
    });

    it("redirects with stripe=declined when Stripe returns ?error", async () => {
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&error=access_denied`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("stripe=declined");
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("502s and writes nothing when the token exchange rejects", async () => {
      oauthToken.mockRejectedValue(new Error("invalid_grant"));
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&code=bad`,
      );
      expect(res.status).toBe(502);
      expect(insertConnection).not.toHaveBeenCalled();
    });

    it("persists the account id, livemode and capabilities on success", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_success",
        livemode: true,
        scope: "read_write",
        access_token: "sk_live_LEAK",
        refresh_token: "rt_LEAK",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: false,
        capabilities: { card_payments: "active" },
        country: "TR",
        default_currency: "try",
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      const res = await app.request(
        `/stripe/oauth/callback?state=${state}&code=good`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("stripe=connected");
      expect(insertConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "proj_1",
          stripeAccountId: "acct_success",
          livemode: true,
          chargesEnabled: true,
          payoutsEnabled: false,
          connectedBy: "user_1",
        }),
      );
      expect(auditFn).toHaveBeenCalledWith(
        expect.objectContaining({ action: "stripe.connected" }),
        expect.anything(),
      );
    });

    it("never hands an OAuth token to the repository", async () => {
      oauthToken.mockResolvedValue({
        stripe_user_id: "acct_1",
        livemode: true,
        scope: "read_write",
        access_token: "sk_live_LEAK",
        refresh_token: "rt_LEAK",
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: {},
      });
      const app = await buildApp();
      const state = await connectAndGetState(app);
      await app.request(`/stripe/oauth/callback?state=${state}&code=good`);
      const written = JSON.stringify(insertConnection.mock.calls[0]?.[1] ?? {});
      expect(written).not.toContain("LEAK");
      expect(written).not.toContain("access_token");
      expect(written).not.toContain("refresh_token");
    });
  });

  describe("DELETE …/stripe/connect", () => {
    it("404s when there is nothing to disconnect", async () => {
      const app = await buildApp();
      const res = await app.request(connectPath, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("soft-deletes locally even when Stripe's deauthorize fails", async () => {
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        stripeAccountId: "acct_1",
        livemode: true,
      });
      oauthDeauthorize.mockRejectedValue(new Error("already deauthorized"));
      const app = await buildApp();
      const res = await app.request(connectPath, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(markDisconnected).toHaveBeenCalledWith(
        expect.anything(),
        "conn_1",
        "user",
      );
      expect(auditFn).toHaveBeenCalledWith(
        expect.objectContaining({ action: "stripe.disconnected" }),
        expect.anything(),
      );
    });
  });
});
