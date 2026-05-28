import { describe, expect, it } from "vitest";
import { liftToLocalized, mapLocalizedFields } from "./normalize";

describe("liftToLocalized", () => {
  it("wraps a bare string under the default locale", () => {
    expect(liftToLocalized("Continue", "en")).toEqual({ en: "Continue" });
  });
  it("wraps a bare array under the default locale", () => {
    expect(liftToLocalized(["a", "b"], "en")).toEqual({ en: ["a", "b"] });
  });
  it("returns undefined for null/undefined", () => {
    expect(liftToLocalized(undefined, "en")).toBeUndefined();
  });
  it("is idempotent on an already-Localized value", () => {
    const v = { en: "Continue", tr: "Devam" };
    expect(liftToLocalized(v, "en")).toBe(v);
  });
});

describe("mapLocalizedFields", () => {
  type Page = { id: string; title?: { en?: string; tr?: string }; subtitle?: { en?: string } };
  const page: Page = { id: "p1", title: { en: "A", tr: "B" }, subtitle: { en: "C" } };

  it("applies fn to every listed Localized field and returns a new object", () => {
    const next = mapLocalizedFields(page, ["title", "subtitle"], (loc) => {
      const { tr, ...rest } = loc as { tr?: unknown };
      void tr;
      return rest as typeof loc;
    });
    expect(next).not.toBe(page);
    expect(next.title).toEqual({ en: "A" });
    expect(next.subtitle).toEqual({ en: "C" });
    expect(next.id).toBe("p1");
  });

  it("leaves bare-value fields untouched", () => {
    const messy: { id: string; title?: string | { en: string } } = { id: "p", title: "bare" };
    const next = mapLocalizedFields(messy, ["title"], (loc) => loc);
    expect(next.title).toBe("bare");
  });

  it("drops a field when fn returns undefined", () => {
    const next = mapLocalizedFields(page, ["title"], () => undefined);
    expect(next.title).toBeUndefined();
  });
});
