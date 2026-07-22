import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { MemberRole } from "@rovenue/db";

const findActiveByProject = vi.hoisted(() => vi.fn());
const findActiveByAccountId = vi.hoisted(() => vi.fn());
const insertConnection = vi.hoisted(() => vi.fn(async (_tx, v) => ({ id: "conn_1", ...v })));
const markDisconnected = vi.hoisted(() => vi.fn());
const updateAccountState = vi.hoisted(() => vi.fn(async () => undefined));
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
// The connect route gates on the REQUESTED mode, so this is what it calls.
const isConnectConfiguredForModeMock = vi.hoisted(() =>
  vi.fn((mode: "live" | "test") => mode === "live"),
);
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
        findActiveByAccountId,
        insert: insertConnection,
        markDisconnected,
        updateAccountState,
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
    isConnectConfiguredForMode: isConnectConfiguredForModeMock,
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
    // STRIPE_CONNECT_CLIENT_ID / STRIPE_PLATFORM_SECRET_KEY are
    // deliberately NOT set here: isConnectConfigured, connectClientId
    // and getConnectPlatformStripe are all mocked below, so the real
    // env readers in ../src/lib/stripe-platform never run in this
    // suite and these two vars would be dead weight.
    findActiveByProject.mockReset().mockResolvedValue(null);
    // No other project holds the account unless a test says so.
    findActiveByAccountId.mockReset().mockResolvedValue(null);
    insertConnection
      .mockReset()
      .mockImplementation(async (_tx, v) => ({ id: "conn_1", ...v }));
    markDisconnected.mockReset();
    updateAccountState.mockReset().mockResolvedValue(undefined);
    oauthToken.mockReset();
    // Without this reset the disconnect test's queued rejection leaks
    // into whichever test runs next and asserts on deauthorize.
    oauthDeauthorize.mockReset().mockResolvedValue({});
    accountsRetrieve.mockReset();
    auditFn.mockReset();
    assertProjectAccess.mockReset().mockResolvedValue(undefined);
    isConnectConfiguredMock.mockReset().mockReturnValue(true);
    isConnectConfiguredForModeMock
      .mockReset()
      .mockImplementation((mode: "live" | "test") => mode === "live");
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
      isConnectConfiguredForModeMock.mockReturnValue(false);
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

    it("503s when ?mode=test but that mode is not configured", async () => {
      // Mode-aware: a deployment with only live vars set must refuse the
      // test flow specifically, not refuse everything.
      const app = await buildApp();
      const res = await app.request(`${connectPath}?mode=test`);
      expect(res.status).toBe(503);
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
      // Connect rotates who can move money on the customer's behalf —
      // OWNER is its only defence, so pin it here rather than relying
      // on the fully-mocked assertProjectAccess to fail open silently.
      expect(assertProjectAccess).toHaveBeenCalledWith(
        "proj_1",
        "user_1",
        MemberRole.OWNER,
      );
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

    // Everything below covers failures AFTER the token exchange has
    // succeeded. At that point a live Stripe authorization exists and the
    // nonce is spent, so the flow cannot be retried — these branches are
    // the only thing standing between the customer and an authorization
    // they cannot revoke through Rovenue.
    describe("post-exchange failures", () => {
      const GOOD_TOKEN = {
        stripe_user_id: "acct_new",
        livemode: true,
        scope: "read_write",
      };
      const GOOD_ACCOUNT = {
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "active" },
      };

      /**
       * A unique violation in the shape the route ACTUALLY receives.
       *
       * This used to be a bare `Object.assign(new Error(), { code })`,
       * which production never produces: drizzle 0.45.2 rethrows every
       * pg-core failure as a `DrizzleQueryError` and hangs the driver
       * error off `.cause`. With the flat fixture these three tests
       * passed against a route whose `err.code === "23505"` check could
       * never match in production — the fixture was the only thing that
       * ever satisfied it. Nesting it is what makes them load-bearing.
       */
      function uniqueViolation(constraint = "project_stripe_connections_active_uq") {
        const driver = Object.assign(
          new Error(`duplicate key value violates unique constraint "${constraint}"`),
          { code: "23505", constraint },
        );
        return Object.assign(
          new Error('Failed query: insert into "project_stripe_connections" ...'),
          { cause: driver },
        );
      }

      /**
       * Obtain a state nonce, then hit the callback.
       *
       * `arrangeRace` runs BETWEEN the two steps on purpose: the connect
       * route 409s when a connection already exists, so a winning row
       * staged up front would break the handshake instead of the insert.
       */
      async function runCallback(arrangeRace?: () => void) {
        const app = await buildApp();
        const state = await connectAndGetState(app);
        arrangeRace?.();
        return app.request(`/stripe/oauth/callback?state=${state}&code=good`);
      }

      it("revokes the authorization when the account lookup fails", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockRejectedValue(new Error("stripe is down"));

        const res = await runCallback();

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=error");
        expect(insertConnection).not.toHaveBeenCalled();
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      it("keeps the existing connection when the SAME account raced itself", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);
        insertConnection.mockRejectedValue(uniqueViolation());

        const res = await runCallback(() => {
          // The winning row is this very account — the double-tab case.
          findActiveByProject.mockResolvedValue({
            id: "conn_winner",
            stripeAccountId: "acct_new",
            livemode: true,
          });
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=already_connected");
        // Revoking here would break a working connection.
        expect(oauthDeauthorize).not.toHaveBeenCalled();
      });

      it("revokes the loser when a DIFFERENT account won the race", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);
        insertConnection.mockRejectedValue(uniqueViolation());

        const res = await runCallback(() => {
          findActiveByProject.mockResolvedValue({
            id: "conn_winner",
            stripeAccountId: "acct_other",
            livemode: true,
          });
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=already_connected");
        // acct_new has no local row, so disconnect could never reach it.
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      it("revokes when the winner cannot be determined at all", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);
        insertConnection.mockRejectedValue(uniqueViolation());

        const res = await runCallback(() => {
          // The re-read itself fails. We cannot prove the winner is this
          // same account, so the safe default is to revoke rather than
          // leave an authorization nobody can reach.
          findActiveByProject.mockRejectedValue(new Error("db unreachable"));
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=already_connected");
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      it("reconciles a violation buried under drizzle's wrapper, not just a flat one", async () => {
        // The regression guard. `insertConnection` rejects with the real
        // nested shape and nothing on the top-level error says 23505, so
        // a route reading `err.code` directly falls straight through to
        // the generic post-exchange path and answers stripe=error.
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);
        const wrapped = uniqueViolation();
        expect((wrapped as { code?: string }).code).toBeUndefined();
        insertConnection.mockRejectedValue(wrapped);

        const res = await runCallback(() => {
          findActiveByProject.mockResolvedValue({
            id: "conn_winner",
            stripeAccountId: "acct_new",
            livemode: true,
          });
        });

        expect(res.headers.get("location")).toContain("stripe=already_connected");
        expect(res.headers.get("location")).not.toContain("stripe=error");
      });

      it("does not reconcile a unique violation of some OTHER index", async () => {
        // Only the active-connection index means "another connect flow
        // won this project". A violation of anything else is an unknown
        // failure, and the authorization must be revoked rather than
        // reported as an already-connected project.
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);
        insertConnection.mockRejectedValue(uniqueViolation("audit_logs_pkey"));

        const res = await runCallback();

        expect(res.headers.get("location")).toContain("stripe=error");
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      it("refuses a token whose livemode disagrees with the requested mode", async () => {
        oauthToken.mockResolvedValue({ ...GOOD_TOKEN, livemode: false });
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);

        const res = await runCallback();

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=error");
        expect(insertConnection).not.toHaveBeenCalled();
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      // Webhooks for one Stripe account can only route to one project
      // (findActiveByAccountId tie-breaks on most-recent). Letting a second
      // project link the same account would silently freeze the first one's
      // subscription state, so the second link is refused outright.
      it("refuses an account already linked to a different project", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);

        const res = await runCallback(() => {
          findActiveByAccountId.mockResolvedValue({
            id: "conn_other",
            projectId: "proj_other",
            stripeAccountId: "acct_new",
          });
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("stripe=account_in_use");
        expect(insertConnection).not.toHaveBeenCalled();
        // The authorization we just obtained is revoked rather than left
        // dangling with no local row to disconnect it from.
        expect(oauthDeauthorize).toHaveBeenCalledWith({
          client_id: "ca_live",
          stripe_user_id: "acct_new",
        });
      });

      it("allows reconnecting the same account to the SAME project", async () => {
        oauthToken.mockResolvedValue(GOOD_TOKEN);
        accountsRetrieve.mockResolvedValue(GOOD_ACCOUNT);

        const res = await runCallback(() => {
          // Same project — not a conflict, and must not be revoked.
          findActiveByAccountId.mockResolvedValue({
            id: "conn_same",
            projectId: "proj_1",
            stripeAccountId: "acct_new",
          });
        });

        expect(res.headers.get("location")).not.toContain("account_in_use");
        expect(oauthDeauthorize).not.toHaveBeenCalled();
      });
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
      // Disconnect is the other money-moving route — same OWNER gate.
      expect(assertProjectAccess).toHaveBeenCalledWith(
        "proj_1",
        "user_1",
        MemberRole.OWNER,
      );
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

  describe("GET …/stripe/connection", () => {
    const connectionPath = "/dashboard/projects/proj_1/stripe/connection";

    it("calls assertProjectAccess with CUSTOMER_SUPPORT and reports not-connected", async () => {
      findActiveByProject.mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.request(connectionPath);
      expect(res.status).toBe(200);
      expect(assertProjectAccess).toHaveBeenCalledWith(
        "proj_1",
        "user_1",
        MemberRole.CUSTOMER_SUPPORT,
      );
      const body = await res.json();
      expect(body).toEqual({
        data: {
          platformConfigured: true,
          testModeAvailable: false,
          connection: null,
        },
      });
    });

    it("reports the connected shape with an ISO connectedAt", async () => {
      const connectedAt = new Date("2026-01-01T00:00:00.000Z");
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        stripeAccountId: "acct_1",
        livemode: true,
        chargesEnabled: true,
        payoutsEnabled: false,
        country: "TR",
        defaultCurrency: "try",
        connectedAt,
      });
      const app = await buildApp();
      const res = await app.request(connectionPath);
      expect(res.status).toBe(200);
      expect(assertProjectAccess).toHaveBeenCalledWith(
        "proj_1",
        "user_1",
        MemberRole.CUSTOMER_SUPPORT,
      );
      const body = await res.json();
      expect(body).toEqual({
        data: {
          platformConfigured: true,
          testModeAvailable: false,
          connection: {
            accountId: "acct_1",
            livemode: true,
            chargesEnabled: true,
            payoutsEnabled: false,
            country: "TR",
            defaultCurrency: "try",
            connectedAt: connectedAt.toISOString(),
          },
        },
      });
    });

    // The whole product gates paywall publishing on chargesEnabled, and the
    // ordinary case is connecting BEFORE Stripe finishes verifying you — so
    // the row is born false. Without a refresh here, the only thing that can
    // ever flip it is an account.updated webhook the operator may not have
    // subscribed to, and the project is stuck with no in-product remedy.
    it("re-reads a stale row from Stripe before answering", async () => {
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        projectId: "proj_1",
        stripeAccountId: "acct_1",
        livemode: true,
        chargesEnabled: false,
        payoutsEnabled: false,
        country: null,
        defaultCurrency: null,
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      accountsRetrieve.mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: "active" },
        country: "TR",
        default_currency: "try",
      });

      const app = await buildApp();
      const res = await app.request(connectionPath);

      expect(accountsRetrieve).toHaveBeenCalledWith("acct_1");
      expect(updateAccountState).toHaveBeenCalledWith(
        expect.anything(),
        "conn_1",
        expect.objectContaining({ chargesEnabled: true }),
      );
      const body = (await res.json()) as {
        data: { connection: { chargesEnabled: boolean } };
      };
      // The response reflects the refresh, not the stale row.
      expect(body.data.connection.chargesEnabled).toBe(true);
    });

    it("serves the stored row when Stripe is unreachable", async () => {
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        projectId: "proj_1",
        stripeAccountId: "acct_1",
        livemode: true,
        chargesEnabled: false,
        payoutsEnabled: false,
        country: null,
        defaultCurrency: null,
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      accountsRetrieve.mockRejectedValue(new Error("stripe is down"));

      const app = await buildApp();
      const res = await app.request(connectionPath);

      // A status read must degrade, not fail: the connection still exists.
      expect(res.status).toBe(200);
      expect(updateAccountState).not.toHaveBeenCalled();
      const body = (await res.json()) as {
        data: { connection: { chargesEnabled: boolean } };
      };
      expect(body.data.connection.chargesEnabled).toBe(false);
    });

    it("does not re-read a row that was just synced", async () => {
      findActiveByProject.mockResolvedValue({
        id: "conn_1",
        projectId: "proj_1",
        stripeAccountId: "acct_1",
        livemode: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        country: "TR",
        defaultCurrency: "try",
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastSyncedAt: new Date(),
      });

      const app = await buildApp();
      await app.request(connectionPath);

      // Opening the page repeatedly must not hammer Stripe.
      expect(accountsRetrieve).not.toHaveBeenCalled();
    });
  });
});
