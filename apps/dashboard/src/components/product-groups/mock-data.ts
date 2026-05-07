import type { ProductGroup } from "./types";

const sparkSeed = (mrr: number, len = 28): ReadonlyArray<number> => {
  const base = mrr ? mrr / len : 4;
  const out: number[] = [];
  let prev = base * 0.85;
  for (let i = 0; i < len; i += 1) {
    const drift = (Math.sin(i * 0.7) + 1) * 0.18 * base;
    const noise = ((i * 9301 + 49297) % 233280) / 233280;
    prev = base * 0.7 + drift + noise * base * 0.5 + i * (base / len) * 0.6;
    out.push(prev);
  }
  return out;
};

export const PRODUCT_GROUPS: ReadonlyArray<ProductGroup> = [
  {
    id: "premium",
    key: "premium_group",
    name: "Premium",
    initials: "PR",
    tint: "linear-gradient(135deg, #3B82F6, #1D4ED8)",
    description:
      "Full-access plan. Unlocks unlimited exports, priority support and lifetime badges.",
    entitlements: [
      { key: "premium", description: "Unlocks all core premium features" },
      { key: "unlimited_exports", description: "Removes 30/day export cap" },
      { key: "lifetime_badge", description: "Cosmetic badge for lifetime customers" },
    ],
    products: [
      {
        sku: "premium_yearly",
        duration: "yearly",
        price: "$79.99",
        subs: 612,
        mrr: 5080,
        status: "active",
        grants: ["premium", "unlimited_exports"],
      },
      {
        sku: "premium_monthly",
        duration: "monthly",
        price: "$9.99",
        subs: 981,
        mrr: 9799,
        status: "active",
        grants: ["premium", "unlimited_exports"],
      },
      {
        sku: "premium_weekly",
        duration: "weekly",
        price: "$2.99",
        subs: 142,
        mrr: 1702,
        status: "active",
        grants: ["premium"],
      },
      {
        sku: "premium_eu_yearly",
        duration: "yearly",
        price: "€74.99",
        subs: 188,
        mrr: 1172,
        status: "active",
        grants: ["premium", "unlimited_exports"],
      },
      {
        sku: "lifetime_unlock",
        duration: "lifetime",
        price: "$149.00",
        subs: 18,
        mrr: 0,
        status: "active",
        grants: ["premium", "unlimited_exports", "lifetime_badge"],
      },
    ],
    offerings: [
      {
        key: "default",
        name: "default",
        products: ["premium_yearly", "premium_monthly"],
        isDefault: true,
        views: 41200,
        conv: 8.4,
      },
      {
        key: "paywall_v2",
        name: "paywall_v2",
        products: ["premium_yearly", "premium_monthly", "premium_weekly"],
        views: 12400,
        conv: 11.2,
      },
      {
        key: "win_back",
        name: "win_back",
        products: ["premium_monthly", "lifetime_unlock"],
        views: 3100,
        conv: 6.1,
      },
      {
        key: "eu_default",
        name: "eu_default",
        products: ["premium_eu_yearly"],
        views: 6800,
        conv: 7.2,
      },
    ],
    mrr: 17753,
    subs: 1941,
    spark: sparkSeed(17753),
  },
  {
    id: "pro",
    key: "pro_group",
    name: "Pro",
    initials: "PR",
    tint: "linear-gradient(135deg, #8B5CF6, #6D28D9)",
    description: "Mid-tier plan with the pro entitlement only. No unlimited exports.",
    entitlements: [{ key: "pro", description: "Unlocks pro tools and advanced editor" }],
    products: [
      {
        sku: "pro_monthly",
        duration: "monthly",
        price: "$4.99",
        subs: 428,
        mrr: 2137,
        status: "active",
        grants: ["pro"],
      },
      {
        sku: "pro_yearly",
        duration: "yearly",
        price: "$39.99",
        subs: 62,
        mrr: 206,
        status: "active",
        grants: ["pro"],
      },
      {
        sku: "legacy_pro_annual",
        duration: "yearly",
        price: "$29.99",
        subs: 208,
        mrr: 520,
        status: "archived",
        grants: [],
      },
    ],
    offerings: [
      {
        key: "default",
        name: "default",
        products: ["pro_monthly", "pro_yearly"],
        isDefault: true,
        views: 18400,
        conv: 4.6,
      },
      {
        key: "upgrade_from_starter",
        name: "upgrade_from_starter",
        products: ["pro_monthly"],
        views: 2200,
        conv: 9.1,
      },
    ],
    mrr: 2863,
    subs: 698,
    spark: sparkSeed(2863),
  },
  {
    id: "starter",
    key: "starter_group",
    name: "Starter",
    initials: "ST",
    tint: "linear-gradient(135deg, #10B981, #047857)",
    description: "Entry-level plan on Android only. Grants the basic entitlement.",
    entitlements: [{ key: "basic", description: "Removes ads and 1 paid theme" }],
    products: [
      {
        sku: "starter_monthly",
        duration: "monthly",
        price: "$1.99",
        subs: 304,
        mrr: 605,
        status: "active",
        grants: ["basic"],
      },
    ],
    offerings: [
      {
        key: "default",
        name: "default",
        products: ["starter_monthly"],
        isDefault: true,
        views: 9200,
        conv: 3.3,
      },
    ],
    mrr: 605,
    subs: 304,
    spark: sparkSeed(605),
  },
  {
    id: "team",
    key: "team_group",
    name: "Team",
    initials: "TM",
    tint: "linear-gradient(135deg, #F59E0B, #B45309)",
    description: "Seat-based plan for collaborative workspaces. Grants pro + team_features.",
    entitlements: [
      { key: "pro", description: "Inherits all pro features" },
      { key: "team_features", description: "Roles, shared projects, audit log" },
    ],
    products: [
      {
        sku: "team_seat_monthly",
        duration: "monthly",
        price: "$8.99",
        subs: 54,
        mrr: 485,
        status: "draft",
        grants: ["pro", "team_features"],
      },
    ],
    offerings: [
      {
        key: "default",
        name: "default",
        products: ["team_seat_monthly"],
        isDefault: true,
        views: 420,
        conv: 1.9,
      },
    ],
    mrr: 485,
    subs: 54,
    spark: sparkSeed(485),
  },
  {
    id: "credits",
    key: "credits_group",
    name: "Credits",
    initials: "CR",
    tint: "linear-gradient(135deg, #EC4899, #BE123B)",
    description:
      "Consumable credit packs. No entitlements — credits are debited from the ledger on use.",
    entitlements: [],
    products: [
      {
        sku: "credits_100",
        duration: "consumable",
        price: "$4.99",
        subs: null,
        mrr: 0,
        status: "active",
        grants: [],
      },
      {
        sku: "credits_500",
        duration: "consumable",
        price: "$19.99",
        subs: null,
        mrr: 0,
        status: "active",
        grants: [],
      },
    ],
    offerings: [
      {
        key: "default",
        name: "default",
        products: ["credits_100", "credits_500"],
        isDefault: true,
        views: 14200,
        conv: 12.8,
      },
    ],
    mrr: 0,
    subs: null,
    spark: sparkSeed(0),
  },
];
