import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { STORE_LOCALES, localeLabel, localeSuggestions } from "@rovenue/shared/i18n";

// =============================================================
// The picker's logic, tested as the pure filter it is: which store
// locales are OFFERED given what the paywall already carries and what
// the author has typed. Mounting the whole top bar to assert this would
// test the dropdown's chrome, not the rule that matters.
//
// `localeSuggestions` is imported from `@rovenue/shared/i18n` — the SAME
// function `top-bar.tsx`'s `LocaleSwitcher` calls — rather than a
// test-local reimplementation. A prior version of this file hand-rolled
// its own `suggestionsFor` helper: it happened to assert the right rule,
// but a regression in the component's actual filter (e.g. comparing raw
// strings instead of case-insensitively) would never have failed it,
// because the component under test was never exercised.
//
// The rule that matters is the case-insensitive exclusion: `addLocale`
// lowercases what it stores, while the store list keeps `zh-Hans` as the
// stores write it. Comparing raw would offer a locale that is already on
// the config.
// =============================================================

describe("locale picker suggestions", () => {
  it("offers the whole store set when the paywall carries nothing yet", () => {
    expect(localeSuggestions([], "")).toEqual([...STORE_LOCALES]);
  });

  it("never offers a locale the paywall already carries", () => {
    const suggestions = localeSuggestions(["pt-BR", "de-DE"], "");
    expect(suggestions).not.toContain("pt-BR");
    expect(suggestions).not.toContain("de-DE");
    expect(suggestions).toContain("pt-PT");
  });

  it("excludes case-insensitively — the builder lowercases what it stores", () => {
    // This is the assertion that fails if the exclusion compares raw
    // strings: the config says `zh-hans`, the store list says `zh-Hans`.
    expect(localeSuggestions(["zh-hans"], "")).not.toContain("zh-Hans");
    expect(localeSuggestions(["PT-br"], "")).not.toContain("pt-BR");
  });

  it("narrows by language name as the author types", () => {
    const suggestions = localeSuggestions([], "portug");
    expect(suggestions).toEqual(expect.arrayContaining(["pt-BR", "pt-PT"]));
    expect(suggestions).not.toContain("de-DE");
  });

  it("narrows by code too", () => {
    expect(localeSuggestions([], "zh")).toEqual(["zh-Hans", "zh-Hant"]);
  });

  it("returns nothing for a code the store set does not carry, which is what opens the custom-code path", () => {
    // The picker shows "Use custom code" exactly when this is empty and the
    // author has typed something — so a project shipping somewhere the
    // stores do not localize is never blocked.
    expect(localeSuggestions([], "xx-YY")).toEqual([]);
  });

  it("labels every offered locale with a real language name", () => {
    for (const code of localeSuggestions([], "")) {
      expect(`${code}:${localeLabel(code) === code}`).toBe(`${code}:false`);
    }
  });
});
