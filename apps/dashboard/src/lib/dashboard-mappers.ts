import type {
  DashboardProductGroupRow,
  DashboardProductRow,
} from "@rovenue/shared";
import type {
  Currency,
  DurationCode,
  Product,
  ProductStatus,
  StoreId,
} from "../components/products/types";
import type {
  EntitlementGrant,
  GroupDuration,
  GroupProduct,
  GroupProductStatus,
  ProductGroup,
} from "../components/product-groups/types";

// Backend rows only carry identity + state. Pricing, MRR, and subscriber
// counts come from the analytics path (not wired yet), so the mappers
// keep those fields zero/null until those endpoints exist. tint/initials/
// spark are pure visual derivations seeded off the identifier so a given
// product or group looks stable across reloads.

const TINTS: ReadonlyArray<string> = [
  "linear-gradient(135deg,#8B5CF6 0%,#6366F1 100%)",
  "linear-gradient(135deg,#EC4899 0%,#BE185D 100%)",
  "linear-gradient(135deg,#06B6D4 0%,#0EA5E9 100%)",
  "linear-gradient(135deg,#10B981 0%,#059669 100%)",
  "linear-gradient(135deg,#F59E0B 0%,#D97706 100%)",
  "linear-gradient(135deg,#6366F1 0%,#4F46E5 100%)",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function pickTint(seed: string): string {
  return TINTS[hashStr(seed) % TINTS.length]!;
}

function initialsOf(seed: string): string {
  const parts = seed.split(/[\s_\-/]+/).filter(Boolean);
  const chars =
    parts.length >= 2
      ? parts[0]![0]! + parts[1]![0]!
      : (seed.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "??");
  return chars.toUpperCase();
}

function deterministicSpark(seed: string, len = 28): number[] {
  let a = hashStr(seed) || 1;
  const out: number[] = [];
  for (let i = 0; i < len; i += 1) {
    a = (a * 9301 + 49297) % 233280;
    out.push((a / 233280) * 100);
  }
  return out;
}

const VALID_STORES: ReadonlySet<string> = new Set(["ios", "android", "web"]);

function durationFromRow(row: DashboardProductRow): DurationCode {
  if (row.type === "CONSUMABLE") return "consumable";
  if (row.type === "NON_CONSUMABLE") return "lifetime";
  const period = row.metadata?.period;
  if (period === "P1W" || period === "P1M" || period === "P1Y") {
    return period;
  }
  return "P1M";
}

function statusFromRow(row: DashboardProductRow): ProductStatus {
  return row.isActive ? "active" : "archived";
}

function storesFromRow(row: DashboardProductRow): ReadonlyArray<StoreId> {
  return Object.keys(row.storeIds).filter((k) =>
    VALID_STORES.has(k),
  ) as StoreId[];
}

function priceFromRow(row: DashboardProductRow): {
  price: number;
  currency: Currency;
} {
  const meta = row.metadata ?? {};
  const price = typeof meta.price === "number" ? meta.price : 0;
  const currency =
    typeof meta.currency === "string"
      ? (meta.currency as Currency)
      : "USD";
  return { price, currency };
}

function groupLabelFromRow(row: DashboardProductRow): string {
  const tag = row.metadata?.group;
  if (typeof tag === "string" && tag.trim()) return tag.trim();
  return "Default";
}

export function rowToUiProduct(row: DashboardProductRow): Product {
  const { price, currency } = priceFromRow(row);
  const isSubscription = row.type === "SUBSCRIPTION";
  const trialMeta = row.metadata?.trial;
  return {
    id: row.id,
    sku: row.identifier,
    name: row.displayName || row.identifier,
    group: groupLabelFromRow(row),
    entitlements: row.entitlementKeys,
    duration: durationFromRow(row),
    price,
    currency,
    trial: typeof trialMeta === "string" ? trialMeta : null,
    subs: isSubscription ? 0 : null,
    mrr: 0,
    status: statusFromRow(row),
    stores: storesFromRow(row),
    created: row.createdAt,
    updated: row.updatedAt,
  };
}

const DURATION_TO_GROUP: Record<DurationCode, GroupDuration> = {
  P1W: "weekly",
  P1M: "monthly",
  P1Y: "yearly",
  lifetime: "lifetime",
  consumable: "consumable",
};

function rowToGroupProduct(row: DashboardProductRow): GroupProduct {
  const ui = rowToUiProduct(row);
  const { price, currency } = priceFromRow(row);
  return {
    sku: row.identifier,
    duration: DURATION_TO_GROUP[ui.duration],
    price: price ? `${currency} ${price.toFixed(2)}` : "—",
    subs: ui.subs,
    mrr: ui.mrr,
    status: ui.status as GroupProductStatus,
    grants: row.entitlementKeys,
  };
}

export function rowToUiProductGroup(
  row: DashboardProductGroupRow,
  productById: ReadonlyMap<string, DashboardProductRow>,
): ProductGroup {
  const members = row.products
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((m) => productById.get(m.productId))
    .filter((r): r is DashboardProductRow => Boolean(r));

  const entitlementKeys = Array.from(
    new Set(members.flatMap((r) => r.entitlementKeys)),
  );
  const entitlements: EntitlementGrant[] = entitlementKeys.map((key) => ({
    key,
    description: "",
  }));

  const groupProducts = members.map(rowToGroupProduct);
  const meta = row.metadata ?? {};
  const metaName = typeof meta.name === "string" ? meta.name : undefined;
  const description =
    typeof meta.description === "string" ? meta.description : "";

  return {
    id: row.id,
    key: row.identifier,
    name: metaName || row.identifier,
    initials: initialsOf(metaName || row.identifier),
    tint: pickTint(row.identifier),
    description,
    entitlements,
    products: groupProducts,
    offerings: [],
    mrr: 0,
    subs: groupProducts.some((p) => p.subs !== null) ? 0 : null,
    spark: deterministicSpark(row.identifier),
  };
}
