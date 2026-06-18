// Standard RevenueCat-style package slot identifiers used across the offerings UI.
export const STANDARD_IDS = [
  "$rov_weekly",
  "$rov_monthly",
  "$rov_annual",
  "$rov_lifetime",
] as const;

export type StandardId = (typeof STANDARD_IDS)[number];

// Custom identifier: lowercase letters, digits, hyphens, underscores; must start with alnum.
export const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const MAX_PACKAGE_IDENTIFIER_LENGTH = 160;

export function isStandardId(id: string): id is StandardId {
  return (STANDARD_IDS as readonly string[]).includes(id);
}
