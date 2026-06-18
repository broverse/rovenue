import { logger } from "../../lib/logger";
import { getGoogleAccessToken } from "./google-auth";
import type { GoogleServiceAccountCredentials } from "./google-types";
import { StoreApiError, type RawCatalogItem } from "../apple/app-store-connect";

const log = logger.child("google-play-catalog");

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

interface Deps {
  fetchImpl?: typeof fetch;
  getToken?: typeof getGoogleAccessToken;
}

async function gpGet(url: string, token: string, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body;
    } catch {
      /* keep statusText */
    }
    throw new StoreApiError(`Google Play API error (${res.status}): ${detail}`, res.status);
  }
  return res.json();
}

export async function listGooglePlayCatalog(
  input: { packageName: string; serviceAccount: GoogleServiceAccountCredentials },
  deps: Deps = {},
): Promise<RawCatalogItem[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getToken ?? getGoogleAccessToken;
  const token = await getToken(input.serviceAccount);
  const pkg = encodeURIComponent(input.packageName);
  const items: RawCatalogItem[] = [];

  // Subscriptions (monetization v3).
  let subUrl: string | undefined = `${BASE}/${pkg}/subscriptions?pageSize=100`;
  while (subUrl) {
    const page = await gpGet(subUrl, token, fetchImpl);
    for (const sub of page.subscriptions ?? []) {
      if (!sub.productId) continue;
      items.push({
        storeId: sub.productId,
        type: "SUBSCRIPTION",
        name: sub.listings?.[0]?.title ?? sub.productId,
      });
    }
    subUrl = page.nextPageToken
      ? `${BASE}/${pkg}/subscriptions?pageSize=100&pageToken=${encodeURIComponent(page.nextPageToken)}`
      : undefined;
  }

  // Managed (one-time) products.
  let prodUrl: string | undefined = `${BASE}/${pkg}/inappproducts?maxResults=100`;
  while (prodUrl) {
    const page = await gpGet(prodUrl, token, fetchImpl);
    for (const p of page.inappproduct ?? []) {
      if (!p.sku) continue;
      const lang = p.defaultLanguage as string | undefined;
      const title = (lang && p.listings?.[lang]?.title) || p.sku;
      items.push({ storeId: p.sku, type: "NON_CONSUMABLE", name: title });
    }
    const next = page.tokenPagination?.nextPageToken;
    prodUrl = next
      ? `${BASE}/${pkg}/inappproducts?maxResults=100&token=${encodeURIComponent(next)}`
      : undefined;
  }

  log.debug("listed google play catalog", { packageName: input.packageName, count: items.length });
  return items;
}
