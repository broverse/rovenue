import { isLocalized } from "./pick";
import type { Localized, LocaleCode } from "./types";

// Wraps a bare T under defaultLocale so older data (saved without locale keys) becomes Localized<T>
export function liftToLocalized<T>(
  value: Localized<T> | T | undefined,
  defaultLocale: LocaleCode,
): Localized<T> | undefined {
  if (value == null) return undefined;
  if (isLocalized<T>(value)) return value;
  return { [defaultLocale]: value } as Localized<T>;
}

// Walks obj[fields], applies fn to each Localized value, and returns a shallow-cloned object
export function mapLocalizedFields<T extends object>(
  obj: T,
  fields: readonly (keyof T)[],
  fn: (loc: Localized<unknown>) => Localized<unknown> | undefined,
): T {
  const next: T = { ...obj };
  for (const field of fields) {
    const v = next[field];
    if (!isLocalized<unknown>(v)) continue;
    const out = fn(v);
    if (out === undefined) {
      delete next[field];
    } else {
      next[field] = out as T[typeof field];
    }
  }
  return next;
}
