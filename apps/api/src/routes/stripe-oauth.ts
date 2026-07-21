import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { audit, extractRequestContext } from "../lib/audit";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { connectClientId, getConnectPlatformStripe } from "../lib/stripe-platform";
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
//
// This is a browser-facing route: every branch redirects. Once the
// token exchange has succeeded there is a live Stripe authorization
// on the other end, so failures past that point must either persist
// it or best-effort deauthorize it — never fall through to the
// generic JSON error handler.

const log = logger.child("route:stripe-oauth");

// Shape createOAuthState issues: 32 random bytes, base64url-encoded
// (no padding) → exactly 43 characters. Reject anything else before
// it ever reaches Redis.
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;

// `error` is attacker-controlled (Stripe just relays whatever query
// string the browser was redirected with) and unbounded. Bound it
// before it goes in the log.
const MAX_LOGGED_ERROR_PARAM_LENGTH = 100;

function dashboardRedirect(projectId: string | null, query: string): string {
  const base = env.DASHBOARD_URL.replace(/\/+$/, "");
  return projectId
    ? `${base}/projects/${projectId}/stores?${query}`
    : `${base}/?${query}`;
}

// A stable discriminator safe to log in place of `err.message`. Stripe's
// `invalid_grant` responses carry an `error_description` of the form
// "Authorization code does not exist: ac_…", so the raw message can
// contain the authorization code — which must never be logged.
function stripeErrorDiscriminator(
  err: unknown,
): { type: string; code: string | null } | "unknown" {
  if (err instanceof Stripe.errors.StripeError) {
    return { type: err.type, code: err.code ?? null };
  }
  return "unknown";
}

export const stripeOAuthRoute = new Hono().get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  const errorParam = c.req.query("error");
  const code = c.req.query("code");

  const state =
    stateParam && STATE_FORMAT.test(stateParam)
      ? await consumeOAuthState(stateParam)
      : null;

  // The customer declined on Stripe's consent screen. Nothing to write.
  if (errorParam) {
    log.info("stripe oauth declined", {
      error: errorParam.slice(0, MAX_LOGGED_ERROR_PARAM_LENGTH),
    });
    return c.redirect(
      dashboardRedirect(state?.projectId ?? null, "stripe=declined"),
      302,
    );
  }

  if (!state) {
    throw new HTTPException(400, { message: "Invalid or expired state" });
  }
  if (!code) {
    throw new HTTPException(400, { message: "Missing authorization code" });
  }

  const stripe = getConnectPlatformStripe(state.mode === "live");
  if (!stripe) {
    throw new HTTPException(503, { message: "Stripe Connect is not configured" });
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
      err: stripeErrorDiscriminator(err),
    });
    throw new HTTPException(502, { message: "Stripe rejected the authorization" });
  }

  // From here the authorization is LIVE on Stripe's side. A failure in
  // this section must not strand it: unique-violation means another
  // concurrent flow already won (the existing connection is legitimate,
  // do not deauthorize it); anything else gets a best-effort
  // deauthorize so the customer isn't left with an authorization they
  // can't revoke through Rovenue.
  try {
    // The token response's livemode must agree with the mode the
    // customer started the flow in — otherwise the stored row's
    // livemode would disagree with the platform client used to charge
    // against it.
    const expectedLivemode = state.mode === "live";
    if (livemode !== expectedLivemode) {
      throw new Error(
        `livemode mismatch: token livemode=${livemode}, state mode=${state.mode}`,
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
  } catch (err) {
    // Postgres unique_violation on the partial index (project_id WHERE
    // disconnected_at IS NULL): two concurrent connect flows both had
    // nonces issued before either callback returned. The other one won
    // — this account IS authorized on Stripe, but so is the other, and
    // the existing connection is legitimate. Do not deauthorize either;
    // just tell the customer they're already connected.
    if ((err as { code?: string })?.code === "23505") {
      log.info("stripe oauth: project already has an active connection", {
        projectId: state.projectId,
      });
      return c.redirect(
        dashboardRedirect(state.projectId, "stripe=already_connected"),
        302,
      );
    }

    log.error("stripe oauth post-exchange failure", {
      projectId: state.projectId,
      err: err instanceof Error ? err.message : String(err),
    });

    const clientId = connectClientId(state.mode);
    if (clientId) {
      try {
        await stripe.oauth.deauthorize({
          client_id: clientId,
          stripe_user_id: accountId,
        });
        log.info("deauthorized stranded stripe authorization", {
          projectId: state.projectId,
        });
      } catch (deauthErr) {
        log.error("failed to deauthorize stranded stripe authorization", {
          projectId: state.projectId,
          err: deauthErr instanceof Error ? deauthErr.message : String(deauthErr),
        });
      }
    } else {
      log.error("cannot deauthorize stranded stripe authorization: no client id for mode", {
        projectId: state.projectId,
        mode: state.mode,
      });
    }

    return c.redirect(dashboardRedirect(state.projectId, "stripe=error"), 302);
  }

  log.info("stripe account connected", { projectId: state.projectId, livemode });
  return c.redirect(dashboardRedirect(state.projectId, "stripe=connected"), 302);
});
