import { useMemo } from "react";
import type { LocaleCode } from "@rovenue/shared/i18n";

interface FunnelLocaleConfig {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
}

/** Pure resolver — extracted for unit-testing without DOM. */
export function resolveRunnerLocale(
  funnel: FunnelLocaleConfig,
  src: { url: string; nav: string | undefined },
): LocaleCode {
  const fromUrl = new URL(src.url).searchParams.get("lng") ?? undefined;
  const candidates = [fromUrl, src.nav].filter(Boolean) as string[];
  for (const c of candidates) {
    const hit = matchLocale(c, funnel.locales);
    if (hit) return hit;
  }
  return funnel.defaultLocale;
}

/** Case-insensitive BCP47 match. Falls back to the primary subtag before giving up. */
export function matchLocale(
  input: string,
  available: readonly LocaleCode[],
): LocaleCode | undefined {
  const lower = input.toLowerCase();
  const byCanonical = new Map(available.map((c) => [c.toLowerCase(), c]));
  if (byCanonical.has(lower)) return byCanonical.get(lower)!;
  const primary = lower.split("-")[0];
  if (byCanonical.has(primary)) return byCanonical.get(primary)!;
  return undefined;
}

/** React-facing wrapper. Stable per (locale-config, href). */
export function useRunnerLocale(funnel: FunnelLocaleConfig): LocaleCode {
  return useMemo(
    () =>
      resolveRunnerLocale(funnel, {
        url: typeof window !== "undefined" ? window.location.href : "https://localhost",
        nav: typeof navigator !== "undefined" ? navigator.language : undefined,
      }),
    [
      funnel.defaultLocale,
      funnel.locales.join(","),
      typeof window !== "undefined" ? window.location.search : "",
    ],
  );
}
