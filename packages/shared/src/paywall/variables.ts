// =============================================================
// Variable interpolation for builder-config text: `{{price}}` etc.
// inside a text/button labelKey's resolved string get swapped for
// the selected package's display values at render time.
// =============================================================

export type PackageView = {
  packageName: string;
  price: string;
  pricePerPeriod: string;
  period: string;
};

const VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Replaces `{{var}}` placeholders with values from `pkg`. Unknown
 * variable names are left verbatim. When `pkg` is null, ALL
 * placeholders (known or not) are left verbatim.
 */
export function resolveVariables(text: string, pkg: PackageView | null): string {
  if (pkg === null) return text;
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(pkg, name)
      ? pkg[name as keyof PackageView]
      : match;
  });
}
