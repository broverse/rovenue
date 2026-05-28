/**
 * UI-side view of an offering (formerly product group). The shape is derived
 * by `rowToUiOffering` from a `DashboardOfferingRow` plus its resolved
 * product members; the raw backend row only carries identifiers and
 * memberships, so derived fields (initials/tint/spark/mrr/subs) live here.
 */
export type GroupDuration =
  | "weekly"
  | "monthly"
  | "yearly"
  | "lifetime"
  | "consumable";

export type GroupProductStatus = "active" | "draft" | "archived";

export interface GroupProduct {
  id: string;
  sku: string;
  name: string;
  duration: GroupDuration;
  /** Pre-formatted price label (e.g. `"USD 9.99"`) or `"—"` when unpriced. */
  price: string;
  /** Active subscriber count; `null` for non-recurring products. */
  subs: number | null;
  /** Monthly recurring revenue contribution. `0` until analytics wires. */
  mrr: number;
  status: GroupProductStatus;
}

export interface Offering {
  id: string;
  /** Stable slug; what we show as the secondary line under the name. */
  key: string;
  name: string;
  /** Two-character display initials for the icon tile. */
  initials: string;
  /** CSS background gradient seeded off the identifier for the icon tile. */
  tint: string;
  description: string;
  isDefault: boolean;
  /** Which access bundle this offering grants. */
  accessId: string;
  products: ReadonlyArray<GroupProduct>;
  /** Aggregate MRR across products; `0` until analytics wires. */
  mrr: number;
  /** Aggregate active subscribers; `null` when all members are non-recurring. */
  subs: number | null;
  /** 28-point deterministic sparkline series for the header. */
  spark: ReadonlyArray<number>;
}
