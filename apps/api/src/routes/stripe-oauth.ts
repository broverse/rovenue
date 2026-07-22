import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { audit, extractRequestContext } from "../lib/audit";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { isUniqueViolationOf } from "../lib/pg-errors";
import {
  connectClientId,
  getConnectPlatformStripe,
  type ConnectMode,
} from "../lib/stripe-platform";
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

/**
 * The partial unique index that makes "one active connection per
 * project" true, from migration 0086_stripe_connect.sql:
 *
 *   CREATE UNIQUE INDEX "project_stripe_connections_active_uq"
 *     ON "project_stripe_connections" ("project_id")
 *     WHERE "disconnected_at" IS NULL;
 *
 * Postgres reports the index name in `constraint` for partial unique
 * indexes too, so this is matchable by name. Named rather than matched
 * on the SQLSTATE alone because "another connect flow won this project"
 * is the only unique violation whose answer is the reconciliation below;
 * anything else must take the deauthorize-and-report path.
 */
const ACTIVE_CONNECTION_UNIQUE = "project_stripe_connections_active_uq";

function dashboardRedirect(projectId: string | null, query: string): string {
  const base = env.DASHBOARD_URL.replace(/\/+$/, "");
  return projectId
    ? `${base}/projects/${projectId}/stores?${query}`
    : `${base}/?${query}`;
}

/**
 * An error this file authored itself. Its message is a literal we wrote,
 * so — unlike a Stripe error message — it provably cannot contain the
 * authorization code and is safe to log verbatim.
 */
class InternalOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalOAuthError";
  }
}

// A stable discriminator safe to log in place of `err.message`. Stripe's
// `invalid_grant` responses carry an `error_description` of the form
// "Authorization code does not exist: ac_…", so the raw message can
// contain the authorization code — which must never be logged.
function stripeErrorDiscriminator(
  err: unknown,
): { type: string; code: string | null } | { internal: string } | "unknown" {
  if (err instanceof Stripe.errors.StripeError) {
    return { type: err.type, code: err.code ?? null };
  }
  // Keep our own failures diagnosable instead of flattening them to the
  // same "unknown" a network fault produces.
  if (err instanceof InternalOAuthError) {
    return { internal: err.message };
  }
  return "unknown";
}

/**
 * Revoke an authorization we obtained but could not record locally.
 *
 * Swallows its own failures: the caller is mid-OAuth with a browser
 * waiting, so a failed cleanup must still let it redirect rather than
 * surface a JSON 500.
 */
async function bestEffortDeauthorize(
  stripe: Stripe,
  mode: ConnectMode,
  accountId: string,
  projectId: string,
): Promise<void> {
  const clientId = connectClientId(mode);
  if (!clientId) {
    log.error("cannot deauthorize stranded stripe authorization: no client id for mode", {
      projectId,
      mode,
    });
    return;
  }
  try {
    await stripe.oauth.deauthorize({
      client_id: clientId,
      stripe_user_id: accountId,
    });
    log.info("deauthorized stranded stripe authorization", { projectId });
  } catch (err) {
    log.error("failed to deauthorize stranded stripe authorization", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
    if (!token.stripe_user_id) {
      throw new InternalOAuthError("missing stripe_user_id");
    }
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
      throw new InternalOAuthError(
        `livemode mismatch: token livemode=${livemode}, state mode=${state.mode}`,
      );
    }

    // The partial unique index only guards (project_id, one active row) —
    // it does nothing to stop the SAME Stripe account being connected to a
    // SECOND project. findActiveByAccountId can only be checked here,
    // after the token exchange has told us which account this is. If
    // another project already holds this account, webhooks for it would
    // otherwise route to whichever project connected most recently
    // (findActiveByAccountId's tie-break), silently freezing the other
    // project's subscription state. Decision: reject the second
    // connection outright rather than let it race.
    const conflicting = await drizzle.stripeConnectionRepo.findActiveByAccountId(
      drizzle.db,
      accountId,
    );
    if (conflicting && conflicting.projectId !== state.projectId) {
      log.info("stripe oauth: account already connected to a different project", {
        projectId: state.projectId,
        otherProjectId: conflicting.projectId,
      });
      await bestEffortDeauthorize(stripe, state.mode, accountId, state.projectId);
      return c.redirect(
        dashboardRedirect(state.projectId, "stripe=account_in_use"),
        302,
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
    // nonces issued before either callback returned, and the other one
    // won. Whether we may walk away depends on WHICH account won.
    //
    // Drizzle wraps the driver error and hangs it off `.cause`, so the
    // code is one level down. Read at the top level this never matched:
    // the whole reconciliation below was unreachable and a routine
    // double-connect escaped as a 500 in the middle of OAuth, leaving a
    // live Stripe authorization with no local row and no way to revoke
    // it from the dashboard.
    if (isUniqueViolationOf(err, ACTIVE_CONNECTION_UNIQUE)) {
      // Guarded: this re-read runs inside the catch, so letting it throw
      // would escape to the generic JSON handler mid-OAuth.
      let winnerAccountId: string | null = null;
      try {
        const existing = await drizzle.stripeConnectionRepo.findActiveByProject(
          drizzle.db,
          state.projectId,
        );
        winnerAccountId = existing?.stripeAccountId ?? null;
      } catch (readErr) {
        log.error("stripe oauth: could not re-read the winning connection", {
          projectId: state.projectId,
          err: readErr instanceof Error ? readErr.message : String(readErr),
        });
      }

      if (winnerAccountId === accountId) {
        // Same account, twice (the double-tab case). The existing
        // connection IS this authorization — revoking it would break a
        // working setup.
        log.info("stripe oauth: project already connected to this account", {
          projectId: state.projectId,
        });
      } else {
        // A DIFFERENT account won, or we could not tell. The account we
        // just obtained has no local row, and disconnect needs one — so
        // without this the customer could never revoke it through
        // Rovenue.
        log.info(
          winnerAccountId === null
            ? "stripe oauth: could not identify the winner; revoking this one"
            : "stripe oauth: another account won; revoking this one",
          {
            projectId: state.projectId,
            knownWinner: winnerAccountId !== null,
          },
        );
        await bestEffortDeauthorize(stripe, state.mode, accountId, state.projectId);
      }

      return c.redirect(
        dashboardRedirect(state.projectId, "stripe=already_connected"),
        302,
      );
    }

    log.error("stripe oauth post-exchange failure", {
      projectId: state.projectId,
      err: err instanceof Error ? err.message : String(err),
    });

    await bestEffortDeauthorize(stripe, state.mode, accountId, state.projectId);

    return c.redirect(dashboardRedirect(state.projectId, "stripe=error"), 302);
  }

  log.info("stripe account connected", { projectId: state.projectId, livemode });
  return c.redirect(dashboardRedirect(state.projectId, "stripe=connected"), 302);
});
