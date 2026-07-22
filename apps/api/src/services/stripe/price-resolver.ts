import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { getConnectedStripe } from "../../lib/stripe-platform";

// =============================================================
// Stripe price resolution for web paywalls
// =============================================================
//
// A package carries no amount — the only link to a real price is
// `product.storeIds.stripe`, a price id on the CONNECTED account. On a
// page that takes money the displayed price and the charged price must
// be the same number by construction, so both come from here.
//
// Reading the Price also tells us recurring-vs-one-time, so nothing has
// to store that separately.

const log = logger.child("stripe-price-resolver");

const CACHE_TTL_SECONDS = 300;

export interface ResolvedPrice {
  packageIdentifier: string;
  priceId: string;
  /** Minor units, exactly as Stripe reports it. */
  unitAmount: number;
  /** Lowercase ISO-4217, as Stripe reports it. */
  currency: string;
  /** null for a one-time price. */
  interval: "day" | "week" | "month" | "year" | null;
  intervalCount: number | null;
  trialDays: number | null;
}

function cacheKey(accountId: string, priceId: string): string {
  return `stripe:price:${accountId}:${priceId}`;
}

/**
 * Resolve packages to real prices. A package with no Stripe price id, or
 * whose price cannot be read, is OMITTED rather than failing the whole
 * paywall — the page disables purchase for that package instead of
 * charging an unknown amount.
 */
export async function resolvePricesForPackages(
  projectId: string,
  packages: Array<{ packageIdentifier: string; stripePriceId: string | null }>,
): Promise<Record<string, ResolvedPrice>> {
  const wanted = packages.filter((p) => p.stripePriceId);
  if (wanted.length === 0) return {};

  const connected = await getConnectedStripe(projectId);
  if (!connected) return {};

  const out: Record<string, ResolvedPrice> = {};

  for (const pkg of wanted) {
    const priceId = pkg.stripePriceId as string;
    const key = cacheKey(connected.accountId, priceId);

    try {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as ResolvedPrice;
        // The cache is keyed by price, so the identifier belongs to this
        // request, not to whichever package populated the entry.
        out[pkg.packageIdentifier] = {
          ...parsed,
          packageIdentifier: pkg.packageIdentifier,
        };
        continue;
      }
    } catch (err) {
      log.warn("price cache read failed; falling through to Stripe", {
        projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const price = await connected.account.prices.retrieve(priceId);
      if (price.unit_amount == null) {
        log.warn("price has no unit_amount; omitting", { projectId, priceId });
        continue;
      }
      const resolved: ResolvedPrice = {
        packageIdentifier: pkg.packageIdentifier,
        priceId,
        unitAmount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? null,
        trialDays: price.recurring?.trial_period_days ?? null,
      };
      out[pkg.packageIdentifier] = resolved;
      await redis.set(key, JSON.stringify(resolved), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      // One unreadable price must not take the whole paywall down.
      log.warn("price lookup failed; omitting package", {
        projectId,
        priceId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
