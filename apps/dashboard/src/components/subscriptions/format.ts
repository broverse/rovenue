import type { Subscription } from "./types";

/**
 * Maps a renewal-progress percentage to a CSS color token. Late-cycle
 * subscriptions (≥90%) trend warning, mid-cycle stay primary, and
 * early-cycle stay success — same scheme used by the renewal countdown.
 */
export function renewalProgressColor(pct: number): string {
  if (pct >= 90) return "var(--color-rv-warning)";
  if (pct >= 50) return "var(--color-rv-accent-500)";
  return "var(--color-rv-success)";
}

export function formatPriceWithCycle(sub: Subscription): {
  price: string;
  cycleSuffix: string;
} {
  return {
    price: `$${sub.price.toFixed(2)}`,
    cycleSuffix: `/${sub.billingCycle[0]}`,
  };
}

/** Total active subscriptions across the lifecycle composition bar. */
export function formatComposition(count: number): string {
  return count.toLocaleString();
}
