import { describe, expect, it } from "vitest";
import { expand, isLocalized, pick } from "./pick";

describe("expand", () => {
  it("walks longest-prefix down BCP47 tags", () => {
    expect(expand("pt-BR")).toEqual(["pt"]);
    expect(expand("zh-Hans-CN")).toEqual(["zh-Hans", "zh"]);
    expect(expand("en")).toEqual([]);
  });
});

describe("isLocalized", () => {
  it("accepts a plain object whose every key is a BCP47 tag", () => {
    expect(isLocalized({ en: "x", tr: "y" })).toBe(true);
    expect(isLocalized({ "pt-BR": "x" })).toBe(true);
  });
  it("rejects bare values and non-locale-keyed objects", () => {
    expect(isLocalized("hello")).toBe(false);
    expect(isLocalized(null)).toBe(false);
    expect(isLocalized(undefined)).toBe(false);
    expect(isLocalized([])).toBe(false);
    expect(isLocalized(["en", "tr"])).toBe(false);
    expect(isLocalized({ name: "x" })).toBe(false);
    expect(isLocalized({ id: "x", name: "y" })).toBe(false);
    expect(isLocalized({})).toBe(false);
  });
});

describe("pick", () => {
  it("returns undefined when value is null/undefined", () => {
    expect(pick(undefined, "en")).toBeUndefined();
    expect(pick(null as unknown as undefined, "en")).toBeUndefined();
  });
  it("returns a bare value unchanged (back-compat)", () => {
    expect(pick("hello", "en")).toBe("hello");
    expect(pick(42 as unknown as never, "en")).toBe(42);
  });
  it("hits an exact locale", () => {
    expect(pick({ en: "Continue", tr: "Devam" }, "tr")).toBe("Devam");
  });
  it("falls back via BCP47 region walk", () => {
    expect(pick({ pt: "Continuar" }, "pt-BR")).toBe("Continuar");
  });
  it("uses explicit fallbacks after the region walk", () => {
    expect(pick({ en: "Continue" }, "zh", ["en"])).toBe("Continue");
  });
  it("skips empty strings and empty arrays", () => {
    expect(pick({ en: "", tr: "Devam" }, "en", ["tr"])).toBe("Devam");
    expect(pick({ en: [], tr: ["a"] }, "en", ["tr"])).toEqual(["a"]);
  });
  it("returns undefined when nothing in the chain matches", () => {
    expect(pick({ en: "x" }, "tr")).toBeUndefined();
  });
  it("dedupes the resolution chain", () => {
    expect(pick({ en: "x" }, "en", ["en"])).toBe("x");
  });
});
