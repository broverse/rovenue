import { SignJWT, importPKCS8 } from "jose";
import { logger } from "../../lib/logger";

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
