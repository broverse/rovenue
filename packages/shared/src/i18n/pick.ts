import type { Localized, LocaleCode } from "./types";

export function pick<T>(
  value: Localized<T> | T | undefined,
  locale: LocaleCode,
  fallbacks: readonly LocaleCode[] = [],
): T | undefined {
  if (value == null) return undefined;
  if (!isLocalized<T>(value)) return value as T;

  const seen = new Set<string>();
  const chain: LocaleCode[] = [];
  for (const c of [locale, ...expand(locale), ...fallbacks]) {
    if (seen.has(c)) continue;
    seen.add(c);
    chain.push(c);
  }

  for (const code of chain) {
    const v = (value as Localized<T>)[code];
    if (isPresent(v)) return v;
  }
  return undefined;
}

export function expand(code: LocaleCode): LocaleCode[] {
  const parts = code.split("-");
  const out: LocaleCode[] = [];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

export function isLocalized<T>(v: unknown): v is Localized<T> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (keys.length === 0) return false;
  const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;
  return keys.every((k) => tag.test(k));
}

function isPresent<T>(v: T | undefined): v is T {
  if (v == null) return false;
  if (typeof v === "string" && v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
