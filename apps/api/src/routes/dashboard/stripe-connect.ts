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

export const stripeConnectRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/projects/:projectId/stripe/connect -----
  // 302 to Stripe's consent screen.
  .get("/connect", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    if (!isConnectConfigured()) {
      throw new HTTPException(503, {
        message: "Stripe Connect is not configured on this deployment",
      });
    }

    const mode: ConnectMode = c.req.query("mode") === "test" ? "test" : "live";
    const clientId = connectClientId(mode);
    if (!clientId) {
      throw new HTTPException(400, {
        message: `Stripe Connect ${mode} mode is not configured`,
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

    const row = await drizzle.stripeConnectionRepo.findActiveByProject(
      drizzle.db,
      projectId,
    );
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
