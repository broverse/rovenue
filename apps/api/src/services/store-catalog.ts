import { drizzle } from "@rovenue/db";
import type { StoreCatalogItem } from "@rovenue/shared";
import {
  loadAppleCredentials,
  loadGoogleCredentials,
} from "../lib/project-credentials";
import {
  listAppStoreCatalog,
  StoreApiError,
  type RawCatalogItem,
} from "./apple/app-store-connect";
import { listGooglePlayCatalog } from "./google/google-play-catalog";

export type StoreCatalogErrorCode = "STORE_NOT_CONFIGURED" | "STORE_API_ERROR";

export class StoreCatalogError extends Error {
  constructor(
    public readonly code: StoreCatalogErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "StoreCatalogError";
  }
}

interface Overrides {
  loadApple?: typeof loadAppleCredentials;
  loadGoogle?: typeof loadGoogleCredentials;
  listAppStore?: (config: {
    keyId: string;
    issuerId: string;
    privateKey: string;
    bundleId: string;
    appAppleId?: number;
  }) => Promise<RawCatalogItem[]>;
  listGooglePlay?: (input: {
    packageName: string;
    serviceAccount: { client_email: string; private_key: string };
  }) => Promise<RawCatalogItem[]>;
  listProducts?: (projectId: string, store: string) => Promise<Array<{ storeIds: unknown }>>;
}

async function fetchRaw(
  projectId: string,
  store: "ios" | "android",
  o: Overrides,
): Promise<RawCatalogItem[]> {
  try {
    if (store === "ios") {
      const creds = await (o.loadApple ?? loadAppleCredentials)(projectId);
      if (!creds || !creds.keyId || !creds.issuerId || !creds.privateKey) {
        throw new StoreCatalogError(
          "STORE_NOT_CONFIGURED",
          "Apple App Store Connect credentials are not configured for this project.",
          400,
        );
      }
      const list = o.listAppStore ?? listAppStoreCatalog;
      return await list({
        keyId: creds.keyId,
        issuerId: creds.issuerId,
        privateKey: creds.privateKey,
        bundleId: creds.bundleId,
        appAppleId: creds.appAppleId,
      });
    }
    const creds = await (o.loadGoogle ?? loadGoogleCredentials)(projectId);
    if (!creds) {
      throw new StoreCatalogError(
        "STORE_NOT_CONFIGURED",
        "Google Play credentials are not configured for this project.",
        400,
      );
    }
    const list = o.listGooglePlay ?? listGooglePlayCatalog;
    return await list({
      packageName: creds.packageName,
      serviceAccount: creds.serviceAccount,
    });
  } catch (err) {
    if (err instanceof StoreCatalogError) throw err;
    if (err instanceof StoreApiError) {
      throw new StoreCatalogError("STORE_API_ERROR", err.message, 502);
    }
    throw err;
  }
}

export async function getStoreCatalog(
  projectId: string,
  store: "ios" | "android",
  overrides: Overrides = {},
): Promise<StoreCatalogItem[]> {
  const raw = await fetchRaw(projectId, store, overrides);

  const listProducts =
    overrides.listProducts ??
    ((pid: string, s: string) =>
      drizzle.productRepo.listProducts(drizzle.db, {
        projectId: pid,
        stores: [s as "ios" | "android"],
        limit: 1000,
      }));
  const existing = await listProducts(projectId, store);
  const imported = new Set<string>();
  const canonical = drizzle.productRepo.canonicalStoreKey(store);
  for (const row of existing) {
    const map = row.storeIds as Record<string, string> | null;
    const sku = map?.[canonical];
    if (sku) imported.add(sku);
  }

  const seen = new Set<string>();
  const items: StoreCatalogItem[] = [];
  for (const r of raw) {
    if (seen.has(r.storeId)) continue;
    seen.add(r.storeId);
    items.push({
      storeId: r.storeId,
      type: r.type,
      name: r.name,
      alreadyImported: imported.has(r.storeId),
    });
  }
  return items;
}
