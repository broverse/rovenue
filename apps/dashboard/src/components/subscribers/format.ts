import { AVATAR_GRADIENTS } from "./mock-data";

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
