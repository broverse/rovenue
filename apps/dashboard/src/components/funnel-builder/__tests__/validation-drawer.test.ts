import { describe, expect, it } from "vitest";
import { collectMissingTranslations } from "../validation-drawer";
import type { Funnel } from "../types";

function f(overrides: Partial<Funnel> = {}): Funnel {
  return {
    id: "f", name: "F", slug: "f", status: "draft", version: 1,
    draftDiffersFromPublished: false, theme: {} as Funnel["theme"],
    settings: {} as Funnel["settings"], pages: [], rules: {}, default_next: {},
    defaultLocale: "en", locales: ["en", "tr"], ...overrides,
  };
}

describe("collectMissingTranslations", () => {
  it("flags fields that have default but not non-default locale", () => {
    const out = collectMissingTranslations(f({
      pages: [{ id: "p1", type: "welcome", title: { en: "Hi" } }],
    }));
    expect(out).toEqual([{ locale: "tr", pageId: "p1", field: "title" }]);
  });

  it("does not flag when only non-default has a value (nothing to translate)", () => {
    const out = collectMissingTranslations(f({
      pages: [{ id: "p1", type: "welcome", title: { tr: "Selam" } }],
    }));
    expect(out).toEqual([]);
  });

  it("flags missing option labels", () => {
    const out = collectMissingTranslations(f({
      pages: [{
        id: "p1", type: "single_choice",
        options: [{ label: { en: "Yes" }, value: "y" }],
      }],
    }));
    expect(out).toEqual([{ locale: "tr", pageId: "p1", field: "options[0].label" }]);
  });
});
