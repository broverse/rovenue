import Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { env } from "./env";
import { logger } from "./logger";
import { withAccount, type AccountScopedStripe } from "./stripe-account-scoped";

// =============================================================
// Platform-Stripe client for Stripe Connect
// =============================================================
//
// Distinct from apps/api/src/lib/stripe-billing.ts, which talks to
// Rovenue's own billing account and is cloud-only. This client is
// Rovenue acting as a Connect *platform*: every customer-facing call
// runs against these keys plus a `Stripe-Account` header naming the
// connected account. Not HOST_MODE gated — self-hosted installs
// register their own platform.
//
// Live and test are fully separate worlds: separate client ids,
// separate secret keys, separate `acct_` namespaces. `livemode` on the
// connection row picks which one to use.

const log = logger.child("stripe-platform");

export type ConnectMode = "live" | "test";

const cached: { live: Stripe | null; test: Stripe | null } = {
  live: null,
  test: null,
};

function platformKey(livemode: boolean): string | undefined {
  return livemode
    ? env.STRIPE_PLATFORM_SECRET_KEY
    : env.STRIPE_PLATFORM_SECRET_KEY_TEST;
}

/** The OAuth client id for a mode, or null when that mode is unconfigured. */
export function connectClientId(mode: ConnectMode): string | null {
  const id =
    mode === "live"
      ? env.STRIPE_CONNECT_CLIENT_ID
      : env.STRIPE_CONNECT_CLIENT_ID_TEST;
  return id ?? null;
}

/**
 * True when the given mode has both a Connect client id and a platform
 * secret key configured, so its OAuth flow can actually run. A self-hosted
 * deployment that has only filled in the `_TEST` variables is fully usable
 * for `mode: "test"` even though `isConnectConfigured()` below would answer
 * differently — gate a specific flow (the connect route, a specific
 * webhook) on this, keyed to the mode actually being requested.
 */
export function isConnectConfiguredForMode(mode: ConnectMode): boolean {
  const clientId = connectClientId(mode);
  const secretKey = platformKey(mode === "live");
  return Boolean(clientId && secretKey);
}

/**
 * True when AT LEAST ONE mode (live or test) is usable — i.e. either
 * `isConnectConfiguredForMode("live")` or `isConnectConfiguredForMode("test")`.
 * This answers "is Connect usable on this deployment at all", which is the
 * right question for initialization-style checks and for the
 * `platformConfigured` flag the dashboard uses to decide whether to render
 * the Connect card at all. It is deliberately NOT the right check for
 * gating a specific mode's flow — a deployment can have only test-mode
 * configured and still be fully usable for that mode, so use
 * `isConnectConfiguredForMode(mode)` for anything mode-specific.
 */
export function isConnectConfigured(): boolean {
  return isConnectConfiguredForMode("live") || isConnectConfiguredForMode("test");
}

/**
 * Memoised platform client for one mode. Returns null when that mode's
 * secret key is unset so callers can degrade instead of throwing.
 */
export function getConnectPlatformStripe(livemode: boolean): Stripe | null {
  const slot = livemode ? "live" : "test";
  const existing = cached[slot];
  if (existing) return existing;

  const key = platformKey(livemode);
  if (!key) {
    log.warn("platform Stripe key missing for mode", { livemode });
    return null;
  }

  const client = new Stripe(key, {
    apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: { name: "rovenue-connect", version: "0.1.0" },
  });
  cached[slot] = client;
  return client;
}

// Test-only — clears both cached clients so callers re-read env.
export function _resetConnectPlatformStripeForTests(): void {
  cached.live = null;
  cached.test = null;
}

export interface ConnectedStripe {
  /**
   * Account-scoped facade. Every method already carries
   * `{ stripeAccount }`, so there is no call site at which it could be
   * forgotten — see stripe-account-scoped.ts for why the raw client is
   * deliberately not exposed here.
   */
  readonly account: AccountScopedStripe;
  readonly accountId: string;
  readonly livemode: boolean;
}

/** Single lookup point for a project's active Stripe connection row. */
async function fetchActiveConnection(projectId: string) {
  return drizzle.stripeConnectionRepo.findActiveByProject(
    drizzle.db,
    projectId,
  );
}

/**
 * Resolve a project's connected account into a ready-to-use client.
 * Returns null rather than throwing so read paths (health, dashboard
 * status) can branch on it; write paths should use
 * `requireConnectedStripe` instead.
 *
 * The returned `account` facade already binds
 * `{ stripeAccount: accountId }` to every call — that header is what
 * makes an operation act on the customer's connected account rather
 * than on Rovenue's platform account.
 */
export async function getConnectedStripe(
  projectId: string,
): Promise<ConnectedStripe | null> {
  const connection = await fetchActiveConnection(projectId);
  if (!connection) return null;

  const stripe = getConnectPlatformStripe(connection.livemode);
  if (!stripe) {
    log.error("connection exists but its platform key is unset", {
      projectId,
      livemode: connection.livemode,
    });
    return null;
  }

  return {
    account: withAccount(stripe, connection.stripeAccountId),
    accountId: connection.stripeAccountId,
    livemode: connection.livemode,
  };
}

export class StripeNotConnectedError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no active Stripe connection`);
    this.name = "StripeNotConnectedError";
  }
}

export async function requireConnectedStripe(
  projectId: string,
): Promise<ConnectedStripe> {
  const connected = await getConnectedStripe(projectId);
  if (!connected) throw new StripeNotConnectedError(projectId);
  return connected;
}

/**
 * Can this project actually take a card payment right now? Connecting
 * is not enough — Stripe withholds `charges_enabled` and the
 * `card_payments` capability until onboarding and verification finish.
 */
export async function chargesEnabled(projectId: string): Promise<boolean> {
  const connection = await fetchActiveConnection(projectId);
  if (!connection || !connection.chargesEnabled) return false;
  const caps = (connection.capabilities ?? {}) as Record<string, unknown>;
  return caps.card_payments === "active";
}
