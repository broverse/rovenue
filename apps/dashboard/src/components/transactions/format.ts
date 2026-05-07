/**
 * Money formatter that preserves a leading "−" sign for negative values
 * (renders as `−$3.87` rather than `-$3.87`). Zero collapses to an em
 * dash to keep the table calm when a row has no amount (e.g. trials).
 */
export function formatSignedMoney(value: number): string {
  if (value === 0) return "—";
  if (value < 0) return `−$${Math.abs(value).toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

/** Same as `formatSignedMoney` but always returns `$0.00` instead of an em dash. */
export function formatExactMoney(value: number): string {
  if (value < 0) return `−$${Math.abs(value).toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

/** Always positive — used for the abs() values in the inspector breakdown. */
export function formatAbsMoney(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

/** Picks a stable accent color for a user id by hashing the trailing two chars. */
const AVATAR_PALETTE: ReadonlyArray<string> = [
  "#3B82F6",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#F97316",
  "#84CC16",
];

export function avatarColorFor(userId: string): string {
  const slice = userId.slice(-2);
  const num = Number.parseInt(slice, 16);
  const idx = Number.isFinite(num) ? num % AVATAR_PALETTE.length : 0;
  return AVATAR_PALETTE[idx]!;
}

/** Two-character avatar initials taken from the chunk after `user_`. */
export function avatarInitialsFor(userId: string): string {
  return userId.slice(5, 7).toUpperCase();
}
