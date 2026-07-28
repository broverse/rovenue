import { SignJWT, importPKCS8 } from "jose";
import { decimalToMinorUnits } from "@rovenue/shared";
import { logger } from "../../lib/logger";
import { isoDurationToDays } from "../../lib/iso-duration";

const log = logger.child("app-store-connect");

const BASE_URL = "https://api.appstoreconnect.apple.com";
const AUDIENCE = "appstoreconnect-v1";
const ALG = "ES256";
const TOKEN_LIFETIME_SECONDS = 60 * 5; // ASC tokens may live up to 20m; 5m is plenty.

export interface AppStoreConnectConfig {
  keyId: string;
  issuerId: string;
  /** PKCS8 PEM contents of the .p8 file. */
  privateKey: string;
  bundleId: string;
  /** Numeric App Store app id; resolved from bundleId when absent. */
  appAppleId?: number;
}

export type RawCatalogType = "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE";

export interface RawCatalogItem {
  storeId: string;
  type: RawCatalogType;
  name: string;
}

export class StoreApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "StoreApiError";
  }
}

async function mintToken(config: AppStoreConnectConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(config.privateKey, ALG);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: config.keyId, typ: "JWT" })
    .setIssuer(config.issuerId)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(key);
}

async function ascGet(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body;
    } catch {
      /* keep statusText */
    }
    throw new StoreApiError(
      `App Store Connect API error (${res.status}): ${detail}`,
      res.status,
    );
  }
  return res.json();
}

/** Follow `links.next` across pages, accumulating `data` and `included`. */
async function ascList(
  firstUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: any[]; included: any[] }> {
  const data: any[] = [];
  const included: any[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const page = await ascGet(url, token, fetchImpl);
    if (Array.isArray(page.data)) data.push(...page.data);
    if (Array.isArray(page.included)) included.push(...page.included);
    url = page.links?.next;
  }
  return { data, included };
}

async function resolveAppId(
  config: AppStoreConnectConfig,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.appAppleId) return String(config.appAppleId);
  const url = `${BASE_URL}/v1/apps?filter[bundleId]=${encodeURIComponent(config.bundleId)}&limit=1`;
  const { data } = await ascList(url, token, fetchImpl);
  const id = data[0]?.id;
  if (!id) {
    throw new StoreApiError(`No App Store app found for bundle id ${config.bundleId}`);
  }
  return String(id);
}

function mapIapType(raw: string): RawCatalogType {
  switch (raw) {
    case "CONSUMABLE":
      return "CONSUMABLE";
    case "NON_CONSUMABLE":
    case "NON_RENEWING_SUBSCRIPTION":
      return "NON_CONSUMABLE";
    default:
      log.warn("unknown App Store IAP type", { inAppPurchaseType: raw });
      return "NON_CONSUMABLE";
  }
}

export async function listAppStoreCatalog(
  config: AppStoreConnectConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawCatalogItem[]> {
  const token = await mintToken(config);
  const appId = await resolveAppId(config, token, fetchImpl);

  const iaps = await ascList(
    `${BASE_URL}/v1/apps/${appId}/inAppPurchasesV2?limit=200`,
    token,
    fetchImpl,
  );

  // Step 1: list all subscription groups (paginated).
  const groups = await ascList(
    `${BASE_URL}/v1/apps/${appId}/subscriptionGroups?limit=200`,
    token,
    fetchImpl,
  );

  // Step 2: for each group, list its subscriptions with full pagination.
  // Apple caps the number of included side-loaded resources per response, so
  // relying on `include=subscriptions` silently drops SKUs for large groups.
  const allSubData: any[] = [];
  for (const group of groups.data) {
    const groupId = group.id;
    const groupSubs = await ascList(
      `${BASE_URL}/v1/subscriptionGroups/${groupId}/subscriptions?limit=200`,
      token,
      fetchImpl,
    );
    allSubData.push(...groupSubs.data);
  }

  const items: RawCatalogItem[] = [];

  for (const row of iaps.data) {
    const a = row.attributes ?? {};
    if (!a.productId) continue;
    items.push({
      storeId: a.productId,
      type: mapIapType(a.inAppPurchaseType ?? ""),
      name: a.name ?? a.productId,
    });
  }

  for (const sub of allSubData) {
    const a = sub.attributes ?? {};
    if (!a.productId) continue;
    items.push({ storeId: a.productId, type: "SUBSCRIPTION", name: a.name ?? a.productId });
  }

  log.debug("listed app store catalog", { appId, count: items.length });
  return items;
}

// =============================================================
// Subscription prices, periods and trial durations
// =============================================================

/** Territory used to price subscriptions and detect introductory offers. */
export const APPLE_REFERENCE_TERRITORY = "USA";
/** ISO-4217 currency associated with `APPLE_REFERENCE_TERRITORY`. */
export const APPLE_REFERENCE_CURRENCY = "USD";

/** Maps App Store Connect's `subscriptionPeriod` enum to ISO-8601 durations. */
const APPLE_PERIOD_TO_ISO: Record<string, string> = {
  ONE_WEEK: "P1W",
  ONE_MONTH: "P1M",
  TWO_MONTHS: "P2M",
  THREE_MONTHS: "P3M",
  SIX_MONTHS: "P6M",
  ONE_YEAR: "P1Y",
};

export interface AppleSubscriptionPrice {
  productId: string;
  /** ISO-8601 duration mapped from `subscriptionPeriod`, or null when unrecognized. */
  period: string | null;
  amountMinor: number;
  currency: string;
  trialDays: number | null;
}

function mapSubscriptionPeriod(raw: string | undefined): string | null {
  if (!raw) return null;
  const iso = APPLE_PERIOD_TO_ISO[raw];
  if (!iso) {
    log.warn("unknown App Store subscriptionPeriod", { subscriptionPeriod: raw });
    return null;
  }
  return iso;
}

/** A row from `GET /v1/subscriptions/{id}/prices`. */
interface AscPriceRow {
  id: string;
  attributes?: { startDate?: string | null };
  relationships?: { subscriptionPricePoint?: { data?: { id?: string } } };
}

/** A `subscriptionPricePoint` row side-loaded via `included`. */
interface AscPricePoint {
  id: string;
  attributes?: { customerPrice?: string | number | null };
}

/** Thrown internally when no price point resolves for a subscription's current price row; caught by the per-subscription loop in `listAppStoreSubscriptionPrices` (product omitted + log.warn), same as any other per-subscription lookup failure. Not a StoreApiError — it never reaches an HTTP boundary. */
class MissingPricePointError extends Error {
  constructor(subscriptionAscId: string) {
    super(`No current price point found for App Store subscription ${subscriptionAscId}`);
    this.name = "MissingPricePointError";
  }
}

/** Picks the currently-effective price row: the greatest non-null startDate <= today, else the null-startDate row. */
function pickCurrentPriceRow(rows: AscPriceRow[]): AscPriceRow | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const candidates = rows.filter((row) => {
    const startDate = row.attributes?.startDate;
    return startDate == null || startDate <= today;
  });
  let best: AscPriceRow | undefined;
  for (const row of candidates) {
    const startDate = row.attributes?.startDate;
    if (startDate == null) {
      if (!best) best = row;
      continue;
    }
    const bestStartDate = best?.attributes?.startDate;
    if (bestStartDate == null || startDate > bestStartDate) {
      best = row;
    }
  }
  return best;
}

async function resolveSubscriptionPrice(
  subscriptionAscId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const url =
    `${BASE_URL}/v1/subscriptions/${subscriptionAscId}/prices` +
    `?filter[territory]=${APPLE_REFERENCE_TERRITORY}&include=subscriptionPricePoint&limit=200`;
  const { data, included } = await ascList(url, token, fetchImpl);

  const current = pickCurrentPriceRow(data as AscPriceRow[]);
  const pricePointId = current?.relationships?.subscriptionPricePoint?.data?.id;
  const pricePoint = (included as AscPricePoint[]).find((row) => row.id === pricePointId);
  const customerPrice = pricePoint?.attributes?.customerPrice;
  if (customerPrice == null) {
    throw new MissingPricePointError(subscriptionAscId);
  }
  return decimalToMinorUnits(Number(customerPrice), APPLE_REFERENCE_CURRENCY);
}

async function resolveSubscriptionTrialDays(
  subscriptionAscId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const url =
    `${BASE_URL}/v1/subscriptions/${subscriptionAscId}/introductoryOffers` +
    `?filter[territory]=${APPLE_REFERENCE_TERRITORY}&limit=200`;
  const { data } = await ascList(url, token, fetchImpl);

  const freeTrial = data.find((row) => row.attributes?.offerMode === "FREE_TRIAL");
  if (!freeTrial) return null;
  const days = isoDurationToDays(freeTrial.attributes?.duration ?? "");
  if (days == null) return null;
  return days * (freeTrial.attributes?.numberOfPeriods ?? 1);
}

export async function listAppStoreSubscriptionPrices(
  config: AppStoreConnectConfig,
  wantedProductIds: ReadonlyArray<string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, AppleSubscriptionPrice>> {
  const token = await mintToken(config);
  const appId = await resolveAppId(config, token, fetchImpl);
  const wanted = new Set(wantedProductIds);

  // Step 1: list all subscription groups (paginated), then each group's
  // subscriptions — the same walk `listAppStoreCatalog` performs.
  const groups = await ascList(
    `${BASE_URL}/v1/apps/${appId}/subscriptionGroups?limit=200`,
    token,
    fetchImpl,
  );

  const wantedSubs: Array<{ ascId: string; productId: string; subscriptionPeriod?: string }> = [];
  for (const group of groups.data) {
    const groupId = group.id;
    const groupSubs = await ascList(
      `${BASE_URL}/v1/subscriptionGroups/${groupId}/subscriptions?limit=200`,
      token,
      fetchImpl,
    );
    for (const sub of groupSubs.data) {
      const a = sub.attributes ?? {};
      if (!a.productId || !wanted.has(a.productId)) continue;
      wantedSubs.push({ ascId: sub.id, productId: a.productId, subscriptionPeriod: a.subscriptionPeriod });
    }
  }

  const result = new Map<string, AppleSubscriptionPrice>();

  for (const sub of wantedSubs) {
    try {
      const amountMinor = await resolveSubscriptionPrice(sub.ascId, token, fetchImpl);
      const trialDays = await resolveSubscriptionTrialDays(sub.ascId, token, fetchImpl);
      result.set(sub.productId, {
        productId: sub.productId,
        period: mapSubscriptionPeriod(sub.subscriptionPeriod),
        amountMinor,
        currency: APPLE_REFERENCE_CURRENCY,
        trialDays,
      });
    } catch (err) {
      log.warn("skipping App Store subscription price resolution", {
        productId: sub.productId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.debug("listed app store subscription prices", { appId, wanted: wanted.size, resolved: result.size });
  return result;
}
