import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { Offerings, Offering, Package, PurchaseResult, StoreProduct, PackageType, SubscriptionOption } from "../types";
import type { OfferingDTO } from "../specs/RovenueModule.types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

function packageTypeFromSlot(slot: string): PackageType {
  switch (slot) {
    case '$rov_weekly': return 'weekly';
    case '$rov_monthly': return 'monthly';
    case '$rov_two_month': return 'twoMonth';
    case '$rov_three_month': return 'threeMonth';
    case '$rov_six_month': return 'sixMonth';
    case '$rov_annual': return 'annual';
    case '$rov_lifetime': return 'lifetime';
    default: return 'custom';
  }
}

/** Maps a single native `OfferingDTO` to the public `Offering` domain type.
 *  Shared by `getOfferings` and `paywalls.getPaywall` (a resolved paywall
 *  carries at most one offering). */
export function mapOfferingDTO(o: OfferingDTO): Offering {
  return {
    identifier: o.identifier,
    isDefault: o.isDefault,
    packages: o.packages.map((p) => ({
      identifier: p.identifier,
      packageType: packageTypeFromSlot(p.identifier),
      product: p.product as StoreProduct,
    })),
  };
}

/**
 * Fetch the project's current offerings from the backend and map them into
 * the public `Offerings` shape (`current` + `all`, keyed by identifier).
 * Always a network call from the JS side; the underlying native/Rust layer
 * falls back to its own last-cached response on a connectivity failure, but
 * an auth/server rejection still rejects this promise.
 */
export async function getOfferings(): Promise<Offerings> {
  const dto = await call(() => getNative().getOfferings());
  const all: Record<string, Offering> = {};
  let current: Offering | null = null;
  for (const o of dto.offerings) {
    const offering = mapOfferingDTO(o);
    all[o.identifier] = offering;
    if (o.identifier === dto.current) current = offering;
  }
  return { current, all };
}

/**
 * Buy a `Package` (from `getOfferings()`/`getPaywall()`) or a raw
 * `StoreProduct` directly, driving the platform store UI (StoreKit /
 * Google Play Billing). Resolves with the resulting entitlements + VC
 * balances hydrated straight from the receipt-post response — no
 * follow-up `getOfferings`/`entitlementsAll` call needed. `isDeferred:
 * true` means the purchase is pending external approval (e.g. Ask to Buy)
 * and no entitlement has been granted yet.
 *
 * Rejects with `RovenueError` for store-level outcomes — `kind` may be
 * `PurchaseCanceled`, `AlreadyOwned`, `ProductNotAvailable`,
 * `PaymentDeclined`, `StoreServiceUnavailable`, or `ReceiptInvalid` —
 * as well as network/server failures.
 */
export async function purchase(
  target: Package | StoreProduct,
  options?: { promotionalOfferId?: string; subscriptionOption?: SubscriptionOption },
): Promise<PurchaseResult> {
  const product = "product" in target ? target.product : target;
  const opt = options?.subscriptionOption;
  return call(() =>
    getNative().purchase(
      product.id, product.type, options?.promotionalOfferId,
      opt?.basePlanId ?? undefined, opt?.offerId ?? undefined,
    ),
  );
}

/**
 * Restore the user's previously-purchased entitlements from the store
 * (StoreKit's transaction history / Google Play's owned-purchases query),
 * re-submitting any found receipts so the server can (re-)grant
 * entitlements for this subscriber. Use for the "Restore Purchases" button
 * required by App Store review — not a substitute for automatic
 * entitlement sync, which already happens via `configure()`/receipt
 * posting.
 */
export async function restorePurchases(): Promise<PurchaseResult> {
  return call(() => getNative().restorePurchases());
}
