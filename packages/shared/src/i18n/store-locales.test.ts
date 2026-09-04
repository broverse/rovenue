import { describe, expect, it, vi } from "vitest";
import { STORE_LOCALES, localeLabel, searchLocales } from "./store-locales";

// The App Store localization set is around forty entries; a list that has
// shrunk below this has lost something rather than been tidied.
const MIN_STORE_LOCALES = 30;

describe("STORE_LOCALES", () => {
  it("carries the store localization set without duplicates", () => {
    expect(new Set(STORE_LOCALES).size).toBe(STORE_LOCALES.length);
    expect(STORE_LOCALES.length).toBeGreaterThanOrEqual(MIN_STORE_LOCALES);
  });

  it("uses well-formed BCP-47 tags", () => {
    const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;
    for (const code of STORE_LOCALES) {
      expect(`${code} ${tag.test(code)}`).toBe(`${code} true`);
    }
  });

  it("keeps region tags as the stores write them", () => {
    // Not normalised to a bare language: `resolveText` matches by language,
    // so a `pt-BR` table still answers a `pt` device, but the reverse
    // (shipping only `pt` when the store lists `pt-BR` and `pt-PT`) loses a
    // distinction the stores make.
    expect(STORE_LOCALES).toContain("pt-BR");
    expect(STORE_LOCALES).toContain("pt-PT");
    expect(STORE_LOCALES).toContain("zh-Hans");
    expect(STORE_LOCALES).toContain("zh-Hant");
  });

  it("every entry gets a real English name, not just the code echoed back", () => {
    const echoed = STORE_LOCALES.filter((code) => localeLabel(code) === code);
    expect(echoed).toEqual([]);
  });
});

describe("localeLabel", () => {
  it("names a locale in English", () => {
    expect(localeLabel("de-DE")).toMatch(/German/i);
    expect(localeLabel("pt-BR")).toMatch(/Portuguese/i);
  });

  it("falls back to the code itself for something Intl cannot name", () => {
    expect(localeLabel("qq-ZZ")).toBe("qq-ZZ");
  });

  it("does not throw on a structurally invalid tag — an author can type anything", () => {
    expect(() => localeLabel("not a tag")).not.toThrow();
    expect(localeLabel("not a tag")).toBe("not a tag");
  });

  it("builds Intl.DisplayNames at most once across many calls — hoisted, not rebuilt per call", async () => {
    // `searchLocales` calls this once per STORE_LOCALES entry (~39) per
    // keystroke; a fresh instance per call means ~39 constructions per
    // keystroke. `vi.resetModules()` + a fresh dynamic import gives a
    // clean module (the singleton hasn't been touched yet by an earlier
    // test in this file) so the count is meaningful.
    vi.resetModules();
    const ctorSpy = vi.spyOn(Intl, "DisplayNames");
    try {
      const mod = await import("./store-locales");
      for (const code of ["de-DE", "pt-BR", "fr-FR", "ja", "ko"]) mod.localeLabel(code);
      expect(ctorSpy).toHaveBeenCalledTimes(1);
    } finally {
      ctorSpy.mockRestore();
    }
  });

  it("still falls back to the code when Intl.DisplayNames cannot be constructed at all", async () => {
    vi.resetModules();
    // Cast the whole namespace object rather than `@ts-expect-error`-ing
    // the assignment: `Intl.DisplayNames` is declared read-only, and a
    // stray `@ts-expect-error` would need repeating on the restore below
    // too, which is easy to forget and leaves the OTHER line unchecked.
    const intl = Intl as unknown as { DisplayNames: typeof Intl.DisplayNames };
    const original = intl.DisplayNames;
    intl.DisplayNames = class {
      constructor() {
        throw new Error("Intl.DisplayNames unsupported");
      }
    } as unknown as typeof Intl.DisplayNames;
    try {
      const mod = await import("./store-locales");
      expect(() => mod.localeLabel("de-DE")).not.toThrow();
      expect(mod.localeLabel("de-DE")).toBe("de-DE");
    } finally {
      intl.DisplayNames = original;
    }
  });
});

describe("searchLocales", () => {
  it("returns everything for an empty or whitespace query", () => {
    expect(searchLocales("")).toEqual([...STORE_LOCALES]);
    expect(searchLocales("   ")).toEqual([...STORE_LOCALES]);
  });

  it("matches by English name, case-insensitively", () => {
    expect(searchLocales("portug")).toContain("pt-BR");
    expect(searchLocales("PORTUG")).toContain("pt-PT");
  });

  it("matches by code", () => {
    expect(searchLocales("pt-")).toEqual(expect.arrayContaining(["pt-BR", "pt-PT"]));
    expect(searchLocales("zh")).toEqual(expect.arrayContaining(["zh-Hans", "zh-Hant"]));
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    expect(searchLocales("zzzzz")).toEqual([]);
  });

  it("never returns a code outside the table", () => {
    for (const code of searchLocales("a")) {
      expect(STORE_LOCALES).toContain(code);
    }
  });
});
