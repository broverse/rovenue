import { describe, expect, it } from "vitest";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { buildMatrixRows, isCellMissing, localeCompletion } from "./localization-model";

function config(): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: { title: "Hello", cta: "Buy" },
      de: { title: "Hallo", cta: "" },
    },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        { type: "text", id: "t2", key: "title", role: "body" },
        { type: "purchaseButton", id: "pb", labelKey: "cta" },
      ],
    },
  };
}

describe("buildMatrixRows", () => {
  it("gives one row per distinct key, first owner wins", () => {
    expect(buildMatrixRows(config())).toEqual([
      { key: "title", nodeId: "t1", nodeType: "text", viaOverride: false, otherNodeIds: ["t2"] },
      { key: "cta", nodeId: "pb", nodeType: "purchaseButton", viaOverride: false, otherNodeIds: [] },
    ]);
  });
});

describe("isCellMissing", () => {
  it("is true for blank and absent values, false for real text", () => {
    const c = config();
    expect(isCellMissing(c, "cta", "de")).toBe(true);
    expect(isCellMissing(c, "title", "fr")).toBe(true);
    expect(isCellMissing(c, "title", "de")).toBe(false);
  });
});

describe("localeCompletion", () => {
  it("counts filled cells against the row set and lists the gaps", () => {
    const c = config();
    const rows = buildMatrixRows(c);
    expect(localeCompletion(c, rows, "en")).toEqual({
      locale: "en",
      done: 2,
      total: 2,
      missingKeys: [],
    });
    expect(localeCompletion(c, rows, "de")).toEqual({
      locale: "de",
      done: 1,
      total: 2,
      missingKeys: ["cta"],
    });
  });
});
