export type GroupDuration = "weekly" | "monthly" | "yearly" | "lifetime" | "consumable";

export type GroupProductStatus = "active" | "draft" | "archived";

export type GroupProduct = {
  /** Stable backend id — used when removing the product from the group. */
  id: string;
  sku: string;
  name: string;
  duration: GroupDuration;
  price: string;
  /** `null` for non-recurring products (consumables, lifetime). */
  subs: number | null;
  mrr: number;
  status: GroupProductStatus;
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
  isDefault: boolean;
  products: ReadonlyArray<GroupProduct>;
  mrr: number;
  /** `null` when the group has no recurring subscribers (consumable-only). */
  subs: number | null;
  /** Mock 28-day MRR sparkline data. */
  spark: ReadonlyArray<number>;
};
