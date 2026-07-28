import { drizzle } from "@rovenue/db";
import type {
  OfferingResolvedPrices,
  ResolvedPackageInfo,
  ResolvedStoreEntry,
} from "@rovenue/shared";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import {
  loadAppleCredentials,
  loadGoogleCredentials,
  type AppleCredentials,
  type GoogleCredentials,
} from "../lib/project-credentials";
import { packagesSchema, parseStoreIds } from "../lib/offering-hydration";
import {
  listAppStoreSubscriptionPrices,
  type AppStoreConnectConfig,
  type AppleSubscriptionPrice,
} from "./apple/app-store-connect";
import {
  listGooglePlaySubscriptionPrices,
  type GooglePlanPrice,
} from "./google/google-play-prices";
import { resolvePricesForPackages, type ResolvedPrice } from "./stripe/price-resolver";

// =============================================================
// Offering price resolver — three stores, one paywall
// =============================================================
//
// Walks an offering's packages, and for every package resolves the
// live price on each store the product is mapped to (Apple, Google,
// Stripe). The three stores resolve independently — a thrown error
// on one must never take down the other two, so each store's lookup
// runs inside its own try/catch and the three run concurrently.
//
// Apple and Google are cached in Redis (they're slow, rate-limited
// walks over the whole catalog); Stripe caches internally in
// resolvePricesForPackages, so it is left alone here.

const log = logger.child("offering-price-resolver");

export const RESOLVED_PRICE_CACHE_TTL_SECONDS = 900;

/** The literal `productType` enum value that apple/google resolve prices for (packages/db/src/drizzle/enums.ts). */
const SUBSCRIPTION_PRODUCT_TYPE = "SUBSCRIPTION";

const STRIPE_INTERVAL_UNIT: Record<string, string> = {
  day: "D",
  week: "W",
  month: "M",
  year: "Y",
};

function intervalToIso(
  interval: "day" | "week" | "month" | "year" | null,
  intervalCount: number | null,
): string | null {
  if (!interval) return null;
  const unit = STRIPE_INTERVAL_UNIT[interval];
  if (!unit) return null;
  return `P${intervalCount ?? 1}${unit}`;
}

function cacheKey(store: "apple" | "google", projectId: string, offeringId: string): string {
  return `paywall:resolved:${store}:${projectId}:${offeringId}`;
}

/** Redis SCAN page size for `purgeResolvedPriceCache` — non-blocking on a busy instance, unlike KEYS. */
const CACHE_PURGE_SCAN_COUNT = 200;

/**
 * Deletes every cached resolved-price entry for a project (both stores,
 * every offering) so the next `resolveOfferingPrices` call re-fetches
 * live prices instead of serving a now-stale mapping. Catalog mutations
 * (product/offering create-update-delete) call this fire-and-forget —
 * same convention as `purgeProjectCatalogCache` in `../lib/edge-cache`.
 * SCAN (never KEYS) so a large keyspace never blocks Redis.
 */
export async function purgeResolvedPriceCache(projectId: string): Promise<void> {
  const pattern = `paywall:resolved:*:${projectId}:*`;
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      CACHE_PURGE_SCAN_COUNT,
    );
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}

function toOkEntry(price: {
  period: string | null;
  amountMinor: number;
  currency: string;
  trialDays: number | null;
}): ResolvedStoreEntry {
  return {
    status: "ok",
    amountMinor: price.amountMinor,
    currency: price.currency,
    period: price.period,
    trialDays: price.trialDays,
  };
}

interface Overrides {
  findOffering?: typeof drizzle.offeringRepo.findOfferingById;
  findProducts?: typeof drizzle.productRepo.findProductsByIds;
  loadApple?: typeof loadAppleCredentials;
  loadGoogle?: typeof loadGoogleCredentials;
  listAppStorePrices?: (
    config: AppStoreConnectConfig,
    wantedProductIds: ReadonlyArray<string>,
  ) => Promise<Map<string, AppleSubscriptionPrice>>;
  listGooglePlayPrices?: (input: {
    packageName: string;
    serviceAccount: GoogleCredentials["serviceAccount"];
    wanted: ReadonlyArray<{ productId: string; basePlanId: string }>;
  }) => Promise<Map<string, GooglePlanPrice>>;
  resolveStripePrices?: (
    projectId: string,
    packages: Array<{ packageIdentifier: string; stripePriceId: string | null }>,
  ) => Promise<Record<string, ResolvedPrice>>;
}

interface PackageRow {
  packageIdentifier: string;
  productId: string;
  displayName: string;
  metadataPeriod: string | null;
  type: string;
  storeIds: Record<string, string>;
  androidBasePlanId: string | null;
}

function isSubscription(row: PackageRow): boolean {
  return row.type === SUBSCRIPTION_PRODUCT_TYPE;
}

/** Redis cache payload shape: a wrapped price map plus the timestamp it was fetched at. */
interface CachedPricePayload<T> {
  fetchedAt: string;
  entries: Record<string, T>;
}

/**
 * Narrows a parsed cache read to the current wrapped shape. A cached value
 * written before the fetchedAt wrapper existed (bare `Record<string, T>`)
 * fails this check and is treated as a cache miss — the cheapest correct
 * migration given the 15-minute TTL backstop.
 */
function isCachedPricePayload(raw: unknown): raw is CachedPricePayload<unknown> {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as { fetchedAt?: unknown; entries?: unknown };
  return typeof candidate.fetchedAt === "string" && typeof candidate.entries === "object" && candidate.entries !== null;
}

interface StoreEntriesResult {
  entries: Map<string, ResolvedStoreEntry>;
  /**
   * ISO timestamp the underlying price data was fetched at: "now" for a
   * fresh live fetch, or the stored payload's fetchedAt on a cache hit.
   * Null when no live lookup happened for this store (no eligible
   * packages, nothing mapped, credentials missing, or the lookup errored)
   * — such a store contributes nothing to the offering-level fetchedAt.
   */
  fetchedAt: string | null;
}

async function resolveAppleEntries(
  projectId: string,
  offeringId: string,
  rows: PackageRow[],
  o: Overrides,
): Promise<StoreEntriesResult> {
  const entries = new Map<string, ResolvedStoreEntry>();
  const eligible = rows.filter((r) => r.storeIds.apple);
  if (eligible.length === 0) return { entries, fetchedAt: null };

  const mapped: PackageRow[] = [];
  for (const row of eligible) {
    if (isSubscription(row)) {
      mapped.push(row);
    } else {
      entries.set(row.packageIdentifier, { status: "no_mapping" });
    }
  }
  if (mapped.length === 0) return { entries, fetchedAt: null };

  try {
    const loadApple = o.loadApple ?? loadAppleCredentials;
    const creds: AppleCredentials | null = await loadApple(projectId);
    if (!creds || !creds.keyId || !creds.issuerId || !creds.privateKey) {
      for (const row of mapped) entries.set(row.packageIdentifier, { status: "not_configured" });
      return { entries, fetchedAt: null };
    }

    const config: AppStoreConnectConfig = {
      keyId: creds.keyId,
      issuerId: creds.issuerId,
      privateKey: creds.privateKey,
      bundleId: creds.bundleId,
      appAppleId: creds.appAppleId,
    };

    const key = cacheKey("apple", projectId, offeringId);
    let priceMap: Map<string, AppleSubscriptionPrice> | undefined;
    let fetchedAt: string | null = null;

    const cached = await redis.get(key);
    if (cached) {
      const parsed: unknown = JSON.parse(cached);
      if (isCachedPricePayload(parsed)) {
        priceMap = new Map(
          Object.entries(parsed.entries as Record<string, AppleSubscriptionPrice>),
        );
        fetchedAt = parsed.fetchedAt;
      }
    }
    if (!priceMap) {
      const list = o.listAppStorePrices ?? listAppStoreSubscriptionPrices;
      const wantedIds = mapped.map((row) => row.storeIds.apple!);
      priceMap = await list(config, wantedIds);
      fetchedAt = new Date().toISOString();
      const payload: CachedPricePayload<AppleSubscriptionPrice> = {
        fetchedAt,
        entries: Object.fromEntries(priceMap),
      };
      await redis.set(key, JSON.stringify(payload), "EX", RESOLVED_PRICE_CACHE_TTL_SECONDS);
    }

    for (const row of mapped) {
      const price = priceMap.get(row.storeIds.apple!);
      entries.set(row.packageIdentifier, price ? toOkEntry(price) : { status: "error" });
    }

    return { entries, fetchedAt };
  } catch (err) {
    log.warn("apple price resolution failed; isolating from other stores", {
      projectId,
      offeringId,
      err: err instanceof Error ? err.message : String(err),
    });
    for (const row of mapped) entries.set(row.packageIdentifier, { status: "error" });
    return { entries, fetchedAt: null };
  }
}

async function resolveGoogleEntries(
  projectId: string,
  offeringId: string,
  rows: PackageRow[],
  o: Overrides,
): Promise<StoreEntriesResult> {
  const entries = new Map<string, ResolvedStoreEntry>();
  const eligible = rows.filter((r) => r.storeIds.google);
  if (eligible.length === 0) return { entries, fetchedAt: null };

  const mapped: PackageRow[] = [];
  for (const row of eligible) {
    if (isSubscription(row) && row.androidBasePlanId) {
      mapped.push(row);
    } else {
      entries.set(row.packageIdentifier, { status: "no_mapping" });
    }
  }
  if (mapped.length === 0) return { entries, fetchedAt: null };

  try {
    const loadGoogle = o.loadGoogle ?? loadGoogleCredentials;
    const creds: GoogleCredentials | null = await loadGoogle(projectId);
    if (!creds) {
      for (const row of mapped) entries.set(row.packageIdentifier, { status: "not_configured" });
      return { entries, fetchedAt: null };
    }

    const key = cacheKey("google", projectId, offeringId);
    let priceMap: Map<string, GooglePlanPrice> | undefined;
    let fetchedAt: string | null = null;

    const cached = await redis.get(key);
    if (cached) {
      const parsed: unknown = JSON.parse(cached);
      if (isCachedPricePayload(parsed)) {
        priceMap = new Map(Object.entries(parsed.entries as Record<string, GooglePlanPrice>));
        fetchedAt = parsed.fetchedAt;
      }
    }
    if (!priceMap) {
      const list = o.listGooglePlayPrices ?? listGooglePlaySubscriptionPrices;
      const wanted = mapped.map((row) => ({
        productId: row.storeIds.google!,
        basePlanId: row.androidBasePlanId!,
      }));
      priceMap = await list({
        packageName: creds.packageName,
        serviceAccount: creds.serviceAccount,
        wanted,
      });
      fetchedAt = new Date().toISOString();
      const payload: CachedPricePayload<GooglePlanPrice> = {
        fetchedAt,
        entries: Object.fromEntries(priceMap),
      };
      await redis.set(key, JSON.stringify(payload), "EX", RESOLVED_PRICE_CACHE_TTL_SECONDS);
    }

    for (const row of mapped) {
      const mapKey = `${row.storeIds.google}:${row.androidBasePlanId}`;
      const price = priceMap.get(mapKey);
      entries.set(row.packageIdentifier, price ? toOkEntry(price) : { status: "error" });
    }

    return { entries, fetchedAt };
  } catch (err) {
    log.warn("google price resolution failed; isolating from other stores", {
      projectId,
      offeringId,
      err: err instanceof Error ? err.message : String(err),
    });
    for (const row of mapped) entries.set(row.packageIdentifier, { status: "error" });
    return { entries, fetchedAt: null };
  }
}

async function resolveStripeEntries(
  projectId: string,
  rows: PackageRow[],
  o: Overrides,
): Promise<Map<string, ResolvedStoreEntry>> {
  const entries = new Map<string, ResolvedStoreEntry>();
  const eligible = rows.filter((r) => r.storeIds.stripe);
  if (eligible.length === 0) return entries;

  try {
    const resolve = o.resolveStripePrices ?? resolvePricesForPackages;
    const resolved = await resolve(
      projectId,
      eligible.map((row) => ({
        packageIdentifier: row.packageIdentifier,
        stripePriceId: row.storeIds.stripe!,
      })),
    );
    for (const row of eligible) {
      const price = resolved[row.packageIdentifier];
      if (!price) {
        entries.set(row.packageIdentifier, { status: "error" });
        continue;
      }
      entries.set(row.packageIdentifier, {
        status: "ok",
        amountMinor: price.unitAmount,
        currency: price.currency.toUpperCase(),
        period: intervalToIso(price.interval, price.intervalCount),
        trialDays: price.trialDays,
      });
    }
  } catch (err) {
    log.warn("stripe price resolution failed; isolating from other stores", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    for (const row of eligible) entries.set(row.packageIdentifier, { status: "error" });
  }

  return entries;
}

export async function resolveOfferingPrices(
  projectId: string,
  offeringId: string,
  overrides: Overrides = {},
): Promise<OfferingResolvedPrices | null> {
  const findOffering = overrides.findOffering ?? drizzle.offeringRepo.findOfferingById;
  const offering = await findOffering(drizzle.db, projectId, offeringId);
  if (!offering) return null;

  const parsedPackages = packagesSchema.safeParse(offering.packages);
  const slots = parsedPackages.success ? parsedPackages.data : [];

  const findProducts = overrides.findProducts ?? drizzle.productRepo.findProductsByIds;
  const products = await findProducts(
    drizzle.db,
    projectId,
    slots.map((slot) => slot.productId),
  );
  const productById = new Map(products.map((p) => [p.id, p] as const));

  const rows: PackageRow[] = [];
  for (const slot of slots) {
    const product = productById.get(slot.productId);
    if (!product || !product.isActive) continue;
    const metadata = product.metadata as Record<string, unknown> | null;
    rows.push({
      packageIdentifier: slot.identifier,
      productId: product.id,
      displayName: product.displayName,
      metadataPeriod: typeof metadata?.period === "string" ? metadata.period : null,
      type: product.type,
      storeIds: parseStoreIds(product.storeIds),
      androidBasePlanId: product.androidBasePlanId ?? null,
    });
  }

  const [appleResult, googleResult, stripeEntries] = await Promise.all([
    resolveAppleEntries(projectId, offeringId, rows, overrides),
    resolveGoogleEntries(projectId, offeringId, rows, overrides),
    resolveStripeEntries(projectId, rows, overrides),
  ]);
  const appleEntries = appleResult.entries;
  const googleEntries = googleResult.entries;

  const packages: ResolvedPackageInfo[] = rows.map((row) => {
    const stores: ResolvedPackageInfo["stores"] = {};
    const apple = appleEntries.get(row.packageIdentifier);
    if (apple) stores.apple = apple;
    const google = googleEntries.get(row.packageIdentifier);
    if (google) stores.google = google;
    const stripe = stripeEntries.get(row.packageIdentifier);
    if (stripe) stores.stripe = stripe;

    return {
      packageIdentifier: row.packageIdentifier,
      productId: row.productId,
      displayName: row.displayName,
      metadataPeriod: row.metadataPeriod,
      stores,
    };
  });

  // "No store price in this response is older than this" — the oldest of
  // the Apple/Google fetch timestamps that actually contributed live data
  // (see StoreEntriesResult.fetchedAt). Stripe doesn't expose one (its own
  // internal cache is opaque here). Nothing contributed -> fall back to
  // the response-generation time.
  const storeFetchedAts = [appleResult.fetchedAt, googleResult.fetchedAt].filter(
    (v): v is string => v !== null,
  );
  const fetchedAt =
    storeFetchedAts.length > 0
      ? storeFetchedAts.reduce((oldest, current) => (current < oldest ? current : oldest))
      : new Date().toISOString();

  return {
    offeringId,
    packages,
    fetchedAt,
  };
}
