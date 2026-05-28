import type { SubscriberListItem } from "@rovenue/shared";
import { AVATAR_GRADIENTS } from "./mock-data";
import type { CountryCode, Subscriber } from "./types";

const VALID_COUNTRY_CODES = new Set<string>([
  "US", "DE", "TR", "JP", "BR", "GB", "FR", "IN", "CA", "AU", "NL", "KR",
]);

function toCountryCode(value: unknown): CountryCode {
  if (typeof value === "string" && VALID_COUNTRY_CODES.has(value)) {
    return value as CountryCode;
  }
  return "US";
}

/**
 * Maps a `SubscriberListItem` from the API to the richer `Subscriber` shape
 * used by the dashboard table. Fields not returned by the API are filled with
 * safe blanks so the UI stays functional.
 */
export function mapApiSubscriber(item: SubscriberListItem): Subscriber {
  const full = item.appUserId;
  const truncated = full.length > 20 ? `${full.slice(0, 17)}...` : full;
  const alias = full.length > 24 ? `${full.slice(0, 21)}...` : full;
  const status = item.activeAccessIds.length > 0 ? "active" : "churned";
  const country = toCountryCode(item.attributes["country"]);

  return {
    id: truncated,
    full,
    alias,
    country,
    access: item.activeAccessIds,
    product: "—",
    status,
    ltv: 0,
    mrr: 0,
    created: item.firstSeenAt,
    renew: "—",
    platforms: [],
    risk: 0,
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

/** Maps a risk score (0–100) to a CSS color token. */
export function riskColor(score: number): string {
  if (score >= 70) return "var(--color-rv-danger)";
  if (score >= 40) return "var(--color-rv-warning)";
  return "var(--color-rv-success)";
}
