// =============================================================
// Variable interpolation for builder-config text: `{{price}}` etc.
// inside a text/button labelKey's resolved string get swapped for
// the selected package's display values at render time.
//
// Phase D3 adds seven OPTIONAL pre-formatted fields (normalized
// per-period prices, intro-offer price/period, relative discount).
// They're optional because a platform may not have a numeric price
// to derive them from (see spec D3) — a KNOWN variable whose backing
// field is absent/undefined is left VERBATIM, same signal as an
// unconfigured/unknown variable, distinct from the four required
// fields which always substitute.
// =============================================================

export type PackageView = {
  packageName: string;
  price: string;
  pricePerPeriod: string;
  period: string;
  pricePerDay?: string;
  pricePerWeek?: string;
  pricePerMonth?: string;
  pricePerYear?: string;
  introPrice?: string;
  introPeriod?: string;
  relativeDiscount?: string;
};

const VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** Every placeholder name `resolveVariables` knows how to look up on a `PackageView`. */
const KNOWN_VARIABLES: ReadonlySet<keyof PackageView> = new Set([
  "packageName",
  "price",
  "pricePerPeriod",
  "period",
  "pricePerDay",
  "pricePerWeek",
  "pricePerMonth",
  "pricePerYear",
  "introPrice",
  "introPeriod",
  "relativeDiscount",
]);

/**
 * Replaces `{{var}}` placeholders with values from `pkg`. Unknown
 * variable names are left verbatim. A KNOWN variable whose field is
 * absent or `undefined` on `pkg` is also left verbatim — this is the
 * common case for the seven optional Phase D3 fields, which a caller
 * may not always be able to populate. When `pkg` is null, ALL
 * placeholders (known or not) are left verbatim.
 */
export function resolveVariables(text: string, pkg: PackageView | null): string {
  if (pkg === null) return text;
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (!KNOWN_VARIABLES.has(name as keyof PackageView)) return match;
    const value = pkg[name as keyof PackageView];
    return value !== undefined ? value : match;
  });
}

/**
 * Which localization key a `purchaseButton` renders: `trialLabelKey` when
 * the node has one AND the selected package is in a trial/intro period
 * (`selected.introPeriod` a non-empty string, mirroring `PackageView`'s own
 * field); `labelKey` otherwise — including no selection at all (`selected`
 * is `null`), which is never a trial. `selected` is typed structurally
 * (only the one field this needs) rather than as `PackageView` so callers
 * that only have a selection summary, not a full `PackageView`, don't need
 * to fabricate the rest of the shape.
 */
export function resolveCtaLabelKey(
  node: { labelKey: string; trialLabelKey?: string },
  selected: { introPeriod?: string } | null,
): string {
  const hasIntroPeriod = typeof selected?.introPeriod === "string" && selected.introPeriod !== "";
  return node.trialLabelKey && hasIntroPeriod ? node.trialLabelKey : node.labelKey;
}
