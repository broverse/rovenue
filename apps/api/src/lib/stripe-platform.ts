import Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { env } from "./env";
import { logger } from "./logger";

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
 * True when the deployment can run the live Connect flow at all.
 *
 * Deliberately only inspects live-mode env vars: answers "can the LIVE Connect
 * flow run", not "is either mode usable". This asymmetry is intentional so
 * callers can distinguish between "live Connect is available" (gating UI/flows)
 * vs "any mode is configured" (for initialization checks).
 */
export function isConnectConfigured(): boolean {
  return Boolean(env.STRIPE_CONNECT_CLIENT_ID && env.STRIPE_PLATFORM_SECRET_KEY);
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
  readonly stripe: Stripe;
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
 * Every Stripe call made with this client MUST pass
 * `{ stripeAccount: accountId }` as the request-options argument —
 * that header is what makes it a direct charge on the customer's
 * account rather than on Rovenue's platform account.
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
    stripe,
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
