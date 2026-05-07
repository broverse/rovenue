export type GroupDuration = "weekly" | "monthly" | "yearly" | "lifetime" | "consumable";

export type GroupProductStatus = "active" | "draft" | "archived";

export type EntitlementGrant = {
  key: string;
  description: string;
};

export type GroupProduct = {
  sku: string;
  duration: GroupDuration;
  price: string;
  /** `null` for non-recurring products (consumables, lifetime). */
  subs: number | null;
  mrr: number;
  status: GroupProductStatus;
  /** Entitlement keys this product grants on purchase. Subset of group entitlements. */
  grants: ReadonlyArray<string>;
};

export type Offering = {
  key: string;
  name: string;
  /** SKUs referenced by the paywall, in display order. */
  products: ReadonlyArray<string>;
  isDefault?: boolean;
  views: number;
  /** Conversion percentage (0–100). */
  conv: number;
};

export type ProductGroup = {
  id: string;
  /** Stable, mono-font identifier shown next to the name. */
  key: string;
  name: string;
  /** Two-letter glyph used inside the gradient icon. */
  initials: string;
  /** CSS gradient applied as background of the icon tile. */
  tint: string;
  description: string;
  entitlements: ReadonlyArray<EntitlementGrant>;
  products: ReadonlyArray<GroupProduct>;
  offerings: ReadonlyArray<Offering>;
  mrr: number;
  /** `null` when the group has no recurring subscribers (consumable-only). */
  subs: number | null;
  /** Mock 28-day MRR sparkline data. */
  spark: ReadonlyArray<number>;
};
