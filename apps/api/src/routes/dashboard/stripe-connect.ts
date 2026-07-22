import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import {
  connectClientId,
  getConnectPlatformStripe,
  isConnectConfigured,
  isConnectConfiguredForMode,
  type ConnectMode,
} from "../../lib/stripe-platform";
import { createOAuthState } from "../../services/stripe/oauth-state";

// =============================================================
// Dashboard: Stripe Connect
// =============================================================
//
// Connecting and disconnecting rotate who can move money on the
// customer's behalf, so both require OWNER — the same authority the
// removed credential-write route demanded.

const log = logger.child("route:dashboard:stripe-connect");

function redirectUri(): string {
  // Strip a trailing slash — otherwise a PUBLIC_BASE_URL like
  // "https://host/" produces "https://host//stripe/oauth/callback",
  // which will not byte-match the redirect_uri registered with Stripe.
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${base}/stripe/oauth/callback`;
}

// Below this age, `GET .../connection` re-reads the account from Stripe
// before answering rather than trusting the stored row. Without this, a
// project that connected before Stripe finished verifying it is stuck
// forever with `charges_enabled: false` unless the operator's webhook
// endpoint happens to have `account.updated` selected — there is
// otherwise no path that ever re-checks. Threshold is short enough that
// the status genuinely reflects Stripe, but long enough that repeatedly
// opening the page doesn't hammer the Stripe API.
const CONNECTION_STALE_MS = 60_000;

type StripeConnectionRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.stripeConnectionRepo.findActiveByProject>>
>;

/**
 * Best-effort refresh of a connection row from Stripe when it looks stale.
 * A Stripe outage (or any failure) must degrade to serving the row we
 * already have, not fail the whole status read — this is a read path, not
 * the source of truth for whether the connection exists.
 */
async function refreshIfStale(row: StripeConnectionRow): Promise<StripeConnectionRow> {
  const lastChecked = row.lastSyncedAt ?? row.connectedAt;
  if (Date.now() - lastChecked.getTime() < CONNECTION_STALE_MS) {
    return row;
  }

  const stripe = getConnectPlatformStripe(row.livemode);
  if (!stripe) return row;

  try {
    const account = await stripe.accounts.retrieve(row.stripeAccountId);
    const state = {
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      capabilities: account.capabilities ?? {},
      country: account.country ?? null,
      defaultCurrency: account.default_currency ?? null,
    };
    await drizzle.stripeConnectionRepo.updateAccountState(drizzle.db, row.id, state);
    return { ...row, ...state, lastSyncedAt: new Date() };
  } catch (err) {
    log.warn("stripe account refresh failed; serving the stored row", {
      projectId: row.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    return row;
  }
}

export const stripeConnectRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/projects/:projectId/stripe/connect -----
  // 302 to Stripe's consent screen.
  .get("/connect", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const mode: ConnectMode = c.req.query("mode") === "test" ? "test" : "live";

    // Mode-aware on purpose: isConnectConfigured() answers "is ANY mode
    // usable", which would 503 a deployment that has only test vars set
    // the moment it asked for ?mode=test. Gate on the mode actually
    // requested instead.
    if (!isConnectConfiguredForMode(mode)) {
      throw new HTTPException(503, {
        message: `Stripe Connect ${mode} mode is not configured on this deployment`,
      });
    }

    const clientId = connectClientId(mode);
    if (!clientId) {
      // Defensive only — isConnectConfiguredForMode(mode) already implies
      // this is non-null. Keeps the type narrow without a non-null assert.
      throw new HTTPException(503, {
        message: `Stripe Connect ${mode} mode is not configured on this deployment`,
      });
    }

    const existing = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: "Project already has an active Stripe connection",
      });
    }

    const state = await createOAuthState({ projectId, userId: user.id, mode });
    const url = new URL("https://connect.stripe.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", "read_write");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri());

    return c.redirect(url.toString(), 302);
  })

  // ----- GET /dashboard/projects/:projectId/stripe/connection -----
  .get("/connection", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const stored = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    const row = stored ? await refreshIfStale(stored) : null;
    return c.json(
      ok({
        platformConfigured: isConnectConfigured(),
        testModeAvailable: connectClientId("test") !== null,
        connection: row
          ? {
              accountId: row.stripeAccountId,
              livemode: row.livemode,
              chargesEnabled: row.chargesEnabled,
              payoutsEnabled: row.payoutsEnabled,
              country: row.country,
              defaultCurrency: row.defaultCurrency,
              connectedAt: row.connectedAt.toISOString(),
            }
          : null,
      }),
    );
  })

  // ----- DELETE /dashboard/projects/:projectId/stripe/connect -----
  .delete("/connect", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const row = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
    if (!row) {
      throw new HTTPException(404, { message: "No active Stripe connection" });
    }

    const stripe = getConnectPlatformStripe(row.livemode);
    const clientId = connectClientId(row.livemode ? "live" : "test");
    if (stripe && clientId) {
      try {
        await stripe.oauth.deauthorize({
          client_id: clientId,
          stripe_user_id: row.stripeAccountId,
        });
      } catch (err) {
        // Stripe may already consider the account deauthorized. Do not
        // strand the local row over it — log and soft-delete anyway.
        log.warn("stripe deauthorize failed; disconnecting locally", {
          projectId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.stripeConnectionRepo.markDisconnected(tx, row.id, "user");
      await audit(
        {
          projectId,
          userId: user.id,
          action: "stripe.disconnected",
          resource: "project",
          resourceId: projectId,
          before: { accountId: row.stripeAccountId, livemode: row.livemode },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ disconnected: true }));
  });
