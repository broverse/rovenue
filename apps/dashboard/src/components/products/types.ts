import type { AccessChipEntry } from "./access-chip";

export type ProductStatus = "active" | "draft" | "archived";

export type StoreId = "ios" | "android" | "web";

export type Currency = "USD" | "EUR" | "GBP" | "JPY";

export type DurationCode = "P1W" | "P1M" | "P1Y" | "lifetime" | "consumable";

export type Product = {
  id: string;
  sku: string;
  name: string;
  group: string;
  /** Resolved access chips for the access ids on the backend row.
   *  Empty when the product grants nothing. */
  access: ReadonlyArray<AccessChipEntry>;
  duration: DurationCode;
  price: number;
  currency: Currency;
  trial: string | null;
  /** Active subscriber count, or `null` for non-recurring products. */
  subs: number | null;
  /** Monthly recurring revenue contribution; `0` for non-recurring. */
  mrr: number;
  status: ProductStatus;
  stores: ReadonlyArray<StoreId>;
  /** ISO date — when the product was first created. */
  created: string;
  /** Human-friendly relative timestamp (mock-data convenience). */
  updated: string;
};

export type StatusFilter = ProductStatus | "all";

export type SortKey = "name" | "group" | "price" | "subs" | "mrr" | "updated";

export type SortDir = "asc" | "desc";
