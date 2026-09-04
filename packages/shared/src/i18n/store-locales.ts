import type { LocaleCode } from "./types";

// =============================================================
// The locale codes a paywall is worth translating into: the
// localization set App Store Connect accepts for an app listing, which
// Google Play's own list is very nearly a subset of.
//
// A structured reference table, not a set of magic values — and NOT a
// hard limit. The builder still accepts a free-typed code for anything
// this list does not carry, because a project may ship somewhere the
// stores do not localize their own listings.
//
// Region tags are kept as the stores write them (`pt-BR`, not `pt`).
// That is the whole reason `resolveText` matches by language and not by
// exact tag: an author picking `pt-BR` here and a device reporting
// `pt-BR` agree, and one picking `pt` still answers a `pt-BR` device.
// =============================================================

export const STORE_LOCALES: readonly LocaleCode[] = [
  "ar-SA",
  "ca",
  "cs",
  "da",
  "de-DE",
  "el",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-US",
  "es-ES",
  "es-MX",
  "fi",
  "fr-CA",
  "fr-FR",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "ms",
  "nl-NL",
  "no",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "sk",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
  "zh-Hans",
  "zh-Hant",
];

/**
 * Lazily-constructed, process-wide `Intl.DisplayNames` instance. Building
 * one is not free, and `searchLocales` calls `localeLabel` once per store
 * locale (~39) on every keystroke — a fresh instance per call turned every
 * keystroke into ~39 constructions. `undefined` = not yet attempted;
 * `null` = attempted and unavailable (see below), so a construction
 * failure is cached too rather than retried on every call.
 */
let displayNames: Intl.DisplayNames | null | undefined;

/**
 * `Intl.DisplayNames` itself can throw at CONSTRUCTION time in an engine
 * that lacks it, not just at `.of()` time for a bad tag — this is the
 * hoisted construction's own guard, separate from the per-call `try` in
 * `localeLabel` below.
 */
function getDisplayNames(): Intl.DisplayNames | null {
  if (displayNames !== undefined) return displayNames;
  try {
    displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  } catch {
    displayNames = null;
  }
  return displayNames;
}

/**
 * An English display name for `code`, falling back to the code itself.
 *
 * `Intl.DisplayNames` rather than a hand-maintained name table: a table of
 * forty names is forty things to get wrong, and the funnel builder's locale
 * switcher already names languages this way.
 *
 * `fallback: "none"` is load-bearing. The default ("code") does not return
 * `undefined` for a tag it cannot name — it SYNTHESISES one, so `qq-ZZ`
 * comes back as `"qq (Unknown Region)"`, which reads like a real language to
 * an author who simply mistyped. With `"none"` an unnameable tag returns
 * `undefined` and the author sees exactly what they typed.
 *
 * The `try` is not defensive decoration: `Intl.DisplayNames.prototype.of`
 * THROWS on a structurally invalid tag, and this is called with whatever
 * was typed.
 */
export function localeLabel(code: LocaleCode): string {
  const display = getDisplayNames();
  if (!display) return code;
  try {
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Store locales matching `query` by code or by English name,
 * case-insensitively. An empty query returns the whole list.
 */
export function searchLocales(query: string): LocaleCode[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...STORE_LOCALES];
  return STORE_LOCALES.filter(
    (code) =>
      code.toLowerCase().includes(needle) || localeLabel(code).toLowerCase().includes(needle),
  );
}

/**
 * `searchLocales(query)`, minus whatever `present` already carries.
 *
 * Matched case-insensitively: the builder's `addLocale` lowercases what it
 * stores (`vm.locales` says `zh-hans`), while this table keeps the case the
 * stores write (`zh-Hans`). Comparing raw would offer a locale that is
 * already on the paywall.
 */
export function localeSuggestions(present: readonly string[], query: string): LocaleCode[] {
  const taken = new Set(present.map((l) => l.toLowerCase()));
  return searchLocales(query).filter((code) => !taken.has(code.toLowerCase()));
}
