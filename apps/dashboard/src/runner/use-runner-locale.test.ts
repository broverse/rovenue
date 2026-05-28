import { describe, expect, it } from "vitest";
import { matchLocale, resolveRunnerLocale } from "./use-runner-locale";

describe("matchLocale", () => {
  it("is case-insensitive against the available list", () => {
    expect(matchLocale("PT-br", ["pt-BR", "en"])).toBe("pt-BR");
    expect(matchLocale("en", ["en"])).toBe("en");
  });
  it("falls back to the primary subtag", () => {
    expect(matchLocale("pt-BR", ["pt"])).toBe("pt");
  });
  it("returns undefined when nothing matches", () => {
    expect(matchLocale("zz", ["en", "tr"])).toBeUndefined();
  });
});

describe("resolveRunnerLocale", () => {
  const funnel = { defaultLocale: "en", locales: ["en", "tr", "pt-BR"] };

  it("prefers ?lng= when present and allowed", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=tr", nav: "en-US" })).toBe("tr");
  });
  it("falls back to navigator.language", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app", nav: "tr-TR" })).toBe("tr");
  });
  it("falls back to defaultLocale when neither matches", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app", nav: "ja-JP" })).toBe("en");
  });
  it("ignores ?lng= values not in the allowlist", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=zz", nav: "tr-TR" })).toBe("tr");
  });
  it("matches pt-BR exactly when URL is lowercased", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=pt-br", nav: "en" })).toBe("pt-BR");
  });
});
