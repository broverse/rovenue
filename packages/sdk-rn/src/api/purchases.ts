import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { Offerings, Offering, Package, PurchaseResult, StoreProduct } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function getOfferings(): Promise<Offerings> {
  const dto = await call(() => getNative().getOfferings());
  const all: Record<string, Offering> = {};
  let current: Offering | null = null;
  for (const o of dto.offerings) {
    const offering: Offering = {
      identifier: o.identifier,
      isDefault: o.isDefault,
      packages: o.packages.map((p) => ({ identifier: p.identifier, product: p.product as StoreProduct })),
    };
    all[o.identifier] = offering;
    if (o.identifier === dto.current) current = offering;
  }
  return { current, all };
}

export async function purchase(target: Package | StoreProduct): Promise<PurchaseResult> {
  const product = "product" in target ? target.product : target;
  return call(() => getNative().purchase(product.id, product.type));
}

export async function restorePurchases(): Promise<PurchaseResult> {
  return call(() => getNative().restorePurchases());
}
