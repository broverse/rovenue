import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { STORE_LOCALES, localeLabel, searchLocales } from "@rovenue/shared/i18n";

// =============================================================
// The picker's logic, tested as the pure filter it is: which store
// locales are OFFERED given what the paywall already carries and what
// the author has typed. Mounting the whole top bar to assert this would
// test the dropdown's chrome, not the rule that matters.
//
// The rule that matters is the case-insensitive exclusion: `addLocale`
// lowercases what it stores, while the store list keeps `zh-Hans` as the
// stores write it. Comparing raw would offer a locale that is already on
// the config.
// =============================================================

function suggestionsFor(present: readonly string[], query: string): string[] {
  const taken = new Set(present.map((l) => l.toLowerCase()));
  return searchLocales(query).filter((code) => !taken.has(code.toLowerCase()));
}

describe("locale picker suggestions", () => {
  it("offers the whole store set when the paywall carries nothing yet", () => {
    expect(suggestionsFor([], "")).toEqual([...STORE_LOCALES]);
  });

  it("never offers a locale the paywall already carries", () => {
    const suggestions = suggestionsFor(["pt-BR", "de-DE"], "");
    expect(suggestions).not.toContain("pt-BR");
    expect(suggestions).not.toContain("de-DE");
    expect(suggestions).toContain("pt-PT");
  });

  it("excludes case-insensitively — the builder lowercases what it stores", () => {
    // This is the assertion that fails if the exclusion compares raw
    // strings: the config says `zh-hans`, the store list says `zh-Hans`.
    expect(suggestionsFor(["zh-hans"], "")).not.toContain("zh-Hans");
    expect(suggestionsFor(["PT-br"], "")).not.toContain("pt-BR");
  });

  it("narrows by language name as the author types", () => {
    const suggestions = suggestionsFor([], "portug");
    expect(suggestions).toEqual(expect.arrayContaining(["pt-BR", "pt-PT"]));
    expect(suggestions).not.toContain("de-DE");
  });

  it("narrows by code too", () => {
    expect(suggestionsFor([], "zh")).toEqual(["zh-Hans", "zh-Hant"]);
  });

  it("returns nothing for a code the store set does not carry, which is what opens the custom-code path", () => {
    // The picker shows "Use custom code" exactly when this is empty and the
    // author has typed something — so a project shipping somewhere the
    // stores do not localize is never blocked.
    expect(suggestionsFor([], "xx-YY")).toEqual([]);
  });

  it("labels every offered locale with a real language name", () => {
    for (const code of suggestionsFor([], "")) {
      expect(`${code}:${localeLabel(code) === code}`).toBe(`${code}:false`);
    }
  });
});
