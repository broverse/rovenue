import type { VariantColorToken } from "./types";

/**
 * Maps a variant color token to its CSS color value. The accent token
 * resolves to the dashboard's accent variable so it auto-tints when the
 * accent hue is changed.
 */
export const variantColor = (token: VariantColorToken): string => {
  if (token === "primary") return "var(--color-rv-accent-500)";
  if (token === "violet") return "var(--color-rv-violet)";
  return "var(--color-rv-mute-500)";
};

/** CSS color for each timeline tone. */
export const timelineDotColor = (
  tone: "primary" | "success" | "warning" | "muted",
): string => {
  if (tone === "primary") return "var(--color-rv-accent-500)";
  if (tone === "success") return "var(--color-rv-success)";
  if (tone === "warning") return "var(--color-rv-warning)";
  return "var(--color-rv-mute-400)";
};

/**
 * Maps a signed lift to a -12..+12 percent CI bar geometry. Returns the
 * left offset, width, and zero-line position as percentages so the bar
 * can render as plain `style={{ left, width }}`.
 */
export const ciGeometry = (lo: number, hi: number) => {
  const min = -12;
  const max = 12;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const scale = (v: number) => ((clamp(v) - min) / (max - min)) * 100;
  const left = scale(lo);
  const right = scale(hi);
  return { left, width: right - left, zero: scale(0) };
};
