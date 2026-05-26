import { describe, expect, it } from "vitest";
import { getT, supportedLocales } from "./i18n";

describe("i18n", () => {
  it("loads en and tr from locales/", () => {
    expect(supportedLocales()).toEqual(expect.arrayContaining(["en", "tr"]));
  });

  it("returns translated strings in tr", () => {
    expect(getT("tr")("footer.unsubscribe")).toBe("Aboneliği iptal et");
  });

  it("returns translated strings in en (default namespace = common)", () => {
    expect(getT("en")("footer.unsubscribe")).toBe("Unsubscribe");
  });

  it("falls back to en for unknown locales", () => {
    expect(getT("de")("footer.unsubscribe")).toBe("Unsubscribe");
  });
});
