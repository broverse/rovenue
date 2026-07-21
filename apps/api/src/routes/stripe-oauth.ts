import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { audit, extractRequestContext } from "../lib/audit";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { getConnectPlatformStripe } from "../lib/stripe-platform";
import { consumeOAuthState } from "../services/stripe/oauth-state";

// =============================================================
// Stripe OAuth callback
// =============================================================
//
// Unauthenticated by necessity — Stripe redirects the customer's
// browser straight here. All trust rides on the single-use `state`
// nonce, which is deleted the moment we read it.
//
// One fixed redirect_uri serves every project; the nonce carries the
// project, so nothing project-specific is registered with Stripe.

const log = logger.child("route:stripe-oauth");

function dashboardRedirect(projectId: string | null, query: string): string {
  const base = env.DASHBOARD_URL ?? "http://localhost:5173";
  return projectId
    ? `${base}/projects/${projectId}/stores?${query}`
    : `${base}/?${query}`;
}

export const stripeOAuthRoute = new Hono().get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  const errorParam = c.req.query("error");
  const code = c.req.query("code");

  const state = stateParam ? await consumeOAuthState(stateParam) : null;

  // The customer declined on Stripe's consent screen. Nothing to write.
  if (errorParam) {
    log.info("stripe oauth declined", { error: errorParam });
    return c.redirect(
      dashboardRedirect(state?.projectId ?? null, "stripe=declined"),
      302,
    );
  }

  if (!state) {
    return c.json(
      { error: { code: "INVALID_STATE", message: "Invalid or expired state" } },
      400,
    );
  }
  if (!code) {
    return c.json(
      { error: { code: "MISSING_CODE", message: "Missing authorization code" } },
      400,
    );
  }

  const stripe = getConnectPlatformStripe(state.mode === "live");
  if (!stripe) {
    return c.json(
      { error: { code: "NOT_CONFIGURED", message: "Stripe Connect is not configured" } },
      503,
    );
  }

  let accountId: string;
  let livemode: boolean;
  let scope: string;
  try {
    // NOTE: the access_token / refresh_token on this response are
    // deliberately ignored and never persisted or logged. Direct
    // charges on a Standard account need only the account id.
    const token = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    if (!token.stripe_user_id) throw new Error("missing stripe_user_id");
    accountId = token.stripe_user_id;
    livemode = Boolean(token.livemode);
    scope = token.scope ?? "read_write";
  } catch (err) {
    log.error("stripe oauth token exchange failed", {
      projectId: state.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: { code: "OAUTH_EXCHANGE_FAILED", message: "Stripe rejected the authorization" } },
      502,
    );
  }

  const account = await stripe.accounts.retrieve(accountId);

  await drizzle.db.transaction(async (tx) => {
    await drizzle.stripeConnectionRepo.insert(tx, {
      projectId: state.projectId,
      stripeAccountId: accountId,
      livemode,
      scope,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      capabilities: account.capabilities ?? {},
      country: account.country ?? null,
      defaultCurrency: account.default_currency ?? null,
      connectedBy: state.userId,
      lastSyncedAt: new Date(),
    });
    await audit(
      {
        projectId: state.projectId,
        userId: state.userId,
        action: "stripe.connected",
        resource: "project",
        resourceId: state.projectId,
        after: { accountId, livemode, chargesEnabled: Boolean(account.charges_enabled) },
        ...extractRequestContext(c),
      },
      tx,
    );
  });

  log.info("stripe account connected", { projectId: state.projectId, livemode });
  return c.redirect(dashboardRedirect(state.projectId, "stripe=connected"), 302);
});
