import { describe, expect, it } from "vitest";
import { normalizeFunnel, mapFunnelLocales, resolvePage } from "./i18n";
import type { Funnel, Page } from "./types";

function bareFunnel(overrides: Partial<Funnel> = {}): Funnel {
  return {
    id: "f1",
    name: "F",
    slug: "f",
    status: "draft",
    version: 1,
    draftDiffersFromPublished: false,
    theme: {} as Funnel["theme"],
    settings: {} as Funnel["settings"],
    pages: [],
    rules: {},
    default_next: {},
    defaultLocale: "en",
    locales: ["en"],
    ...overrides,
  };
}

describe("normalizeFunnel", () => {
  it("defaults locale config when absent (legacy data)", () => {
    const f = { ...bareFunnel(), defaultLocale: undefined as unknown as string, locales: undefined as unknown as string[] };
    const out = normalizeFunnel(f);
    expect(out.defaultLocale).toBe("en");
    expect(out.locales).toEqual(["en"]);
  });

  it("lifts bare-string page fields into Localized<string>", () => {
    const f = bareFunnel({
      pages: [{ id: "p1", type: "welcome", title: "Hi" as unknown as Page["title"] }],
    });
    const out = normalizeFunnel(f);
    expect(out.pages[0].title).toEqual({ en: "Hi" });
  });

  it("lifts bare-string Option.label", () => {
    const f = bareFunnel({
      pages: [{
        id: "p1", type: "single_choice",
        options: [{ label: "Yes" as unknown as Page["options"][number]["label"], value: "y" }],
      }],
    });
    const out = normalizeFunnel(f);
    expect(out.pages[0].options?.[0].label).toEqual({ en: "Yes" });
  });

  it("is idempotent", () => {
    const f = bareFunnel({
      pages: [{ id: "p1", type: "welcome", title: { en: "Hi" } }],
    });
    expect(normalizeFunnel(normalizeFunnel(f))).toEqual(normalizeFunnel(f));
  });
});

describe("mapFunnelLocales", () => {
  it("applies fn to every Localized<T> field across pages + options", () => {
    const f = bareFunnel({
      pages: [
        { id: "p1", type: "welcome", title: { en: "Hi", tr: "Selam" }, subtitle: { en: "Welcome" } },
        { id: "p2", type: "single_choice",
          options: [{ label: { en: "Yes", tr: "Evet" }, value: "y" }] },
      ],
      locales: ["en", "tr"],
    });
    const stripTr = mapFunnelLocales(f, (loc) => {
      const { tr, ...rest } = loc as { tr?: unknown };
      void tr;
      return rest as typeof loc;
    });
    expect(stripTr.pages[0].title).toEqual({ en: "Hi" });
    expect(stripTr.pages[1].options?.[0].label).toEqual({ en: "Yes" });
  });
});

describe("resolvePage", () => {
  it("flattens Localized fields and Option.label into bare values", () => {
    const page: Page = {
      id: "p1", type: "welcome",
      title: { en: "Hello", tr: "Merhaba" },
      benefits: { en: ["a", "b"] },
      options: [{ label: { en: "Yes", tr: "Evet" }, value: "y" }],
    };
    const en = resolvePage(page, "en", "en");
    expect(en.title).toBe("Hello");
    expect(en.benefits).toEqual(["a", "b"]);
    expect(en.options?.[0].label).toBe("Yes");

    const tr = resolvePage(page, "tr", "en");
    expect(tr.title).toBe("Merhaba");
    expect(tr.options?.[0].label).toBe("Evet");
  });

  it("falls back to defaultLocale when the requested locale is missing", () => {
    const page: Page = { id: "p1", type: "welcome", title: { en: "Hello" } };
    expect(resolvePage(page, "zz", "en").title).toBe("Hello");
  });
});
