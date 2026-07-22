import { describe, expect, it } from "vitest";
import {
  addLocale,
  emptyRemoteConfig,
  isValidLocaleCode,
  normalizeLocaleCode,
  parseLocaleJson,
  removeLocale,
  setDefaultLocale,
  setLocaleValue,
} from "../remote-config-utils";

describe("parseLocaleJson", () => {
  it("accepts a JSON object", () => {
    const out = parseLocaleJson('{"title": "Go Pro"}');
    expect(out).toEqual({ ok: true, value: { title: "Go Pro" } });
  });

  it("rejects malformed JSON", () => {
    const out = parseLocaleJson("{not json");
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it("rejects a JSON array", () => {
    const out = parseLocaleJson("[1, 2, 3]");
    expect(out.ok).toBe(false);
  });

  it("rejects a bare JSON string", () => {
    const out = parseLocaleJson('"hello"');
    expect(out.ok).toBe(false);
  });

  it("rejects JSON null", () => {
    const out = parseLocaleJson("null");
    expect(out.ok).toBe(false);
  });

  it("accepts an empty object", () => {
    expect(parseLocaleJson("{}")).toEqual({ ok: true, value: {} });
  });
});

describe("normalizeLocaleCode / isValidLocaleCode", () => {
  it("trims and lowercases", () => {
    expect(normalizeLocaleCode("  EN-US  ")).toBe("en-us");
  });

  it("accepts common BCP-47-ish codes", () => {
    expect(isValidLocaleCode("en")).toBe(true);
    expect(isValidLocaleCode("en-US")).toBe(true);
    expect(isValidLocaleCode("pt-BR")).toBe(true);
    expect(isValidLocaleCode("zh-Hans")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidLocaleCode("")).toBe(false);
    expect(isValidLocaleCode("1")).toBe(false);
    expect(isValidLocaleCode("!!")).toBe(false);
  });
});

describe("addLocale", () => {
  it("adds a new locale with an empty object", () => {
    const cfg = emptyRemoteConfig("en");
    const next = addLocale(cfg, "TR");
    expect(next.locales).toEqual({ en: {}, tr: {} });
    // does not disturb the default
    expect(next.defaultLocale).toBe("en");
  });

  it("is a no-op for a blank code", () => {
    const cfg = emptyRemoteConfig("en");
    expect(addLocale(cfg, "   ")).toBe(cfg);
  });

  it("is a no-op for a duplicate (normalized) code", () => {
    const cfg = emptyRemoteConfig("en");
    expect(addLocale(cfg, "EN")).toBe(cfg);
  });
});

describe("removeLocale", () => {
  it("removes a non-default locale", () => {
    const cfg = addLocale(emptyRemoteConfig("en"), "tr");
    const next = removeLocale(cfg, "tr");
    expect(next.locales).toEqual({ en: {} });
    expect(next.defaultLocale).toBe("en");
  });

  it("falls back the default locale when the default is removed", () => {
    const cfg = addLocale(emptyRemoteConfig("en"), "tr");
    const next = removeLocale(cfg, "en");
    expect(next.locales).toEqual({ tr: {} });
    expect(next.defaultLocale).toBe("tr");
  });

  it("refuses to remove the last remaining locale", () => {
    const cfg = emptyRemoteConfig("en");
    expect(removeLocale(cfg, "en")).toBe(cfg);
  });

  it("is a no-op for an unknown code", () => {
    const cfg = addLocale(emptyRemoteConfig("en"), "tr");
    expect(removeLocale(cfg, "fr")).toBe(cfg);
  });
});

describe("setLocaleValue", () => {
  it("replaces a locale's config object", () => {
    const cfg = emptyRemoteConfig("en");
    const next = setLocaleValue(cfg, "en", { title: "Go Pro" });
    expect(next.locales.en).toEqual({ title: "Go Pro" });
  });

  it("is a no-op for an unknown locale", () => {
    const cfg = emptyRemoteConfig("en");
    expect(setLocaleValue(cfg, "fr", { title: "Go Pro" })).toBe(cfg);
  });
});

describe("setDefaultLocale", () => {
  it("switches the default to a known locale", () => {
    const cfg = addLocale(emptyRemoteConfig("en"), "tr");
    const next = setDefaultLocale(cfg, "tr");
    expect(next.defaultLocale).toBe("tr");
  });

  it("is a no-op for an unknown locale", () => {
    const cfg = emptyRemoteConfig("en");
    expect(setDefaultLocale(cfg, "fr")).toBe(cfg);
  });
});
