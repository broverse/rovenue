import type { ChartSeries } from "./stacked-area-chart";
import type { ActivityEvent, ActivityKind } from "./recent-activity-panel";
import type { Experiment } from "./experiments-panel";
import type { HealthService } from "./system-health-panel";
import type { TopProduct } from "./top-products-panel";

// Demo numbers for the design-spec dashboard. Replace with real metrics
// once /dashboard/projects/:id/metrics is wired up.

const DAYS = 28;

const seed = (s: number) => {
  let a = s;
  return () => {
    a = (a * 9301 + 49297) % 233280;
    return a / 233280;
  };
};

const rng = seed(42);

const genSeries = (base: number, variance: number, trend = 0): number[] =>
  Array.from({ length: DAYS }, (_, i) => Math.round(base + trend * i + (rng() - 0.5) * variance));

export const mrrSeries = genSeries(10500, 900, 80);
export const activeSeries = genSeries(2200, 90, 8);
export const trialSeries = genSeries(43, 3, -0.05);
export const churnSeries = genSeries(3.5, 0.8, -0.03);

export const categories: string[] = Array.from({ length: DAYS }, (_, i) => {
  const d = new Date(2026, 3, 20);
  d.setDate(d.getDate() - (DAYS - 1 - i));
  return `${d.toLocaleString("en", { month: "short" })} ${d.getDate()}`;
});

export const revenueMetrics: Record<string, ChartSeries[]> = {
  MRR: [
    { key: "new", label: "New MRR", color: "var(--color-rv-accent-500)", data: genSeries(1800, 400, 20) },
    { key: "expansion", label: "Expansion", color: "var(--color-rv-success)", data: genSeries(720, 200, 8) },
    { key: "contraction", label: "Contraction", color: "var(--color-rv-warning)", data: genSeries(380, 100, -1) },
    { key: "churn", label: "Churn", color: "var(--color-rv-danger)", data: genSeries(420, 140, -2), negative: true },
  ],
  "New subs": [
    { key: "ios", label: "iOS", color: "var(--color-rv-accent-500)", data: genSeries(62, 14, 0.4) },
    { key: "android", label: "Android", color: "var(--color-rv-violet)", data: genSeries(48, 12, 0.3) },
  ],
  Revenue: [
    { key: "rev", label: "Gross revenue", color: "var(--color-rv-accent-500)", data: genSeries(3200, 600, 18) },
    { key: "refund", label: "Refunds", color: "var(--color-rv-danger)", data: genSeries(180, 60, -1), negative: true },
  ],
  Transactions: [
    { key: "purchase", label: "Purchases", color: "var(--color-rv-accent-500)", data: genSeries(140, 30, 1) },
    { key: "renewal", label: "Renewals", color: "var(--color-rv-cyan)", data: genSeries(220, 40, 1) },
  ],
};

export const topProducts: TopProduct[] = [
  { name: "Premium Annual", sku: "premium_yearly", rev: 7240, pct: 58, subs: 612 },
  { name: "Premium Monthly", sku: "premium_monthly", rev: 3180, pct: 25, subs: 981 },
  { name: "Pro Monthly", sku: "pro_monthly", rev: 1420, pct: 11, subs: 428 },
  { name: "Pro Annual", sku: "pro_yearly", rev: 580, pct: 4, subs: 62 },
  { name: "Lifetime", sku: "lifetime_unlock", rev: 427, pct: 2, subs: 18 },
];

type ActivityTemplate = {
  type: string;
  color: string;
  icon: ActivityKind;
  label: string;
  products: string[];
  amounts: Array<number | null>;
};

const activityTemplates: ActivityTemplate[] = [
  { type: "new_subscription", color: "var(--color-rv-accent-500)", icon: "up", label: "new_subscription", products: ["Premium Monthly", "Pro Monthly", "Premium Annual"], amounts: [9.99, 4.99, 79.99] },
  { type: "renewal", color: "var(--color-rv-success)", icon: "renew", label: "renewal", products: ["Pro Annual", "Premium Monthly"], amounts: [79.99, 9.99] },
  { type: "cancellation", color: "var(--color-rv-warning)", icon: "down", label: "cancellation", products: ["Pro Monthly"], amounts: [null] },
  { type: "billing_issue", color: "var(--color-rv-danger)", icon: "alert", label: "billing_issue", products: ["Premium Annual"], amounts: [null] },
  { type: "refund", color: "var(--color-rv-mute-600)", icon: "down", label: "refund", products: ["Premium Monthly"], amounts: [-9.99] },
  { type: "trial_started", color: "var(--color-rv-cyan)", icon: "up", label: "trial_started", products: ["Premium Monthly"], amounts: [null] },
];

const makeUserId = () => {
  const hex = Math.floor(rng() * 0xfffff).toString(16).padStart(5, "0");
  return `user_${hex.slice(0, 4)}a${Math.floor(rng() * 9)}`;
};

const newEventId = () => `evt_${Math.random().toString(36).slice(2, 10)}`;

export function genActivity(count = 8): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  let secondsAgo = 2;
  for (let i = 0; i < count; i++) {
    const t = activityTemplates[Math.floor(rng() * activityTemplates.length)]!;
    const pIdx = Math.floor(rng() * t.products.length);
    out.push({
      id: newEventId(),
      type: t.type,
      color: t.color,
      icon: t.icon,
      label: t.label,
      user: makeUserId(),
      product: t.products[pIdx]!,
      amount: t.amounts[pIdx] ?? null,
      secondsAgo,
    });
    secondsAgo += Math.floor(2 + rng() * 80);
  }
  return out;
}

export const experiments: Experiment[] = [
  { key: "paywall_v2_pricing", status: "running", days: 12, variants: 3, confidence: 64, uplift: null },
  { key: "trial_length_test", status: "running", days: 5, variants: 2, confidence: 23, uplift: null },
  { key: "onboarding_copy", status: "completed", variants: 2, confidence: 97, uplift: 18, winner: "variant_b" },
  { key: "intro_price_discount", status: "running", days: 9, variants: 2, confidence: 48, uplift: null },
];

export const healthServices: HealthService[] = [
  { name: "SDK ingest", status: "operational", metric: "142 req/s" },
  { name: "Webhooks", status: "operational", metric: "99.8% delivery" },
  { name: "App Store Connect", status: "degraded", metric: "Last sync 38m ago" },
  { name: "Google Play", status: "operational", metric: "Last sync 2m ago" },
  { name: "Stripe", status: "operational", metric: "99.9% success" },
  { name: "Credit ledger", status: "operational", metric: "12,847 entries" },
];
