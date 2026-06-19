import type { SubscriberListItem } from "@rovenue/shared";
import { AVATAR_GRADIENTS } from "./mock-data";
import type { CountryCode, Subscriber, SubscriberStatus } from "./types";

/**
 * Derives the displayed status from access + purchase history.
 * - `active`  — currently holds an active entitlement
 * - `churned` — no active access, but has purchased at least once before
 * - `free`    — never purchased (e.g. SDK first-install with no subscription)
 *
 * Mirrors the backend's "churned" definition, which also requires a prior
 * purchase (see `listSubscribers` in `packages/db`). A never-subscribed user
 * is not churned — they simply haven't converted yet.
 */
export function deriveSubscriberStatus(
  hasActiveAccess: boolean,
  purchaseCount: number,
): SubscriberStatus {
  if (hasActiveAccess) return "active";
  return purchaseCount > 0 ? "churned" : "free";
}

const VALID_COUNTRY_CODES = new Set<string>([
  "US", "DE", "TR", "JP", "BR", "GB", "FR", "IN", "CA", "AU", "NL", "KR",
]);

function toCountryCode(value: unknown): CountryCode {
  if (typeof value === "string" && VALID_COUNTRY_CODES.has(value)) {
    return value as CountryCode;
  }
  return "US";
}

/** Coerces a `$displayName` attribute value to a trimmed string; "" when absent. */
function toName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Maps a `SubscriberListItem` from the API to the richer `Subscriber` shape
 * used by the dashboard table. Fields not returned by the API are filled with
 * safe blanks so the UI stays functional.
 */
export function mapApiSubscriber(item: SubscriberListItem): Subscriber {
  const full = item.appUserId ?? "";
  const truncated = full.length > 20 ? `${full.slice(0, 17)}...` : full;
  const alias = full.length > 24 ? `${full.slice(0, 21)}...` : full;
  const status = deriveSubscriberStatus(
    item.activeAccessIds.length > 0,
    item.purchaseCount,
  );
  const country = toCountryCode(item.attributes["country"]);
  const name = toName(item.attributes["$displayName"]);

  const ltv = Number(item.ltvUsd);

  return {
    id: truncated,
    rovenueId: item.id,
    full,
    name,
    alias,
    country,
    access: item.activeAccessIds,
    product: "—",
    status,
    ltv: Number.isFinite(ltv) ? ltv : 0,
    mrr: 0,
    created: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
    renew: "—",
    platforms: item.platforms,
    risk: item.churnRisk,
    plan: item.activeAccessIds.length > 0 ? item.activeAccessIds[0]! : "—",
  };
}

/**
 * Picks a stable avatar gradient for a user based on a 4-char slice of
 * their full id. Same id → same gradient across renders.
 */
export function avatarFor(fullId: string): string {
  const slice = fullId.slice(5, 9);
  const num = Number.parseInt(slice, 16);
  const idx = Number.isFinite(num) ? num % AVATAR_GRADIENTS.length : 0;
  return AVATAR_GRADIENTS[idx]!;
}

/** First two characters past the `user_` prefix, uppercased — used as avatar initials. */
export function initialsFor(fullId: string): string {
  return fullId.slice(5, 7).toUpperCase();
}

/** Formats a price as `$X.XX`. Dashes when zero. */
export function formatMoney(value: number): string {
  if (value === 0) return "—";
  return `$${value.toFixed(2)}`;
}

/** LTV always shows two decimals, even at zero. */
export function formatLtv(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Relative "time ago" label for a subscriber's last-seen timestamp.
 * Falls back to `—` for an unparseable date.
 */
export function formatLastActivity(iso: string | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Maps a risk score (0–100) to a CSS color token. */
export function riskColor(score: number): string {
  if (score >= 70) return "var(--color-rv-danger)";
  if (score >= 40) return "var(--color-rv-warning)";
  return "var(--color-rv-success)";
}
