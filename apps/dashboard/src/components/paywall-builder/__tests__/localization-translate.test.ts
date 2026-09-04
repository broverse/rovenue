import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";
import { machineTranslatedId, sourceEntriesFor } from "../localization-model";

// =============================================================
// The pure half of the translation workflow: which source strings get
// sent, and the identity used to mark a cell as unreviewed machine
// output. The VM half (apply / revert / mark-clearing) lives in
// paywall-builder.vm.test.ts alongside the other VM behaviour.
// =============================================================

function configWith(localizations: Record<string, Record<string, string>>): BuilderConfig {
  const config = emptyBuilderConfig("en");
  return { ...config, localizations };
}

describe("machineTranslatedId", () => {
  it("scopes a mark to its locale", () => {
    expect(machineTranslatedId("es", "title")).not.toBe(machineTranslatedId("pt", "title"));
  });

  it("is stable for the same cell", () => {
    expect(machineTranslatedId("es", "title")).toBe(machineTranslatedId("es", "title"));
  });
});

describe("sourceEntriesFor", () => {
  const config = configWith({
    en: { a: "One", b: "Two", blank: "", spaces: "   " },
    es: { a: "Uno" },
  });

  it("returns only the requested keys, with their source-locale text", () => {
    expect(sourceEntriesFor(config, "en", ["a", "b"])).toEqual({ a: "One", b: "Two" });
  });

  it("skips a key the source locale has no text for — there is nothing to translate", () => {
    expect(sourceEntriesFor(config, "en", ["a", "missing"])).toEqual({ a: "One" });
  });

  it("skips a blank source cell rather than paying a model to invent copy", () => {
    expect(sourceEntriesFor(config, "en", ["a", "blank"])).toEqual({ a: "One" });
  });

  it("treats a whitespace-only source cell as blank, like the publish gate does", () => {
    expect(sourceEntriesFor(config, "en", ["spaces"])).toEqual({});
  });

  it("reads the SOURCE locale, not the default one", () => {
    // Translating es -> pt must send the Spanish text, not the English.
    expect(sourceEntriesFor(config, "es", ["a"])).toEqual({ a: "Uno" });
  });

  it("returns an empty object for an unknown source locale rather than throwing", () => {
    expect(sourceEntriesFor(config, "de", ["a"])).toEqual({});
  });

  it("returns an empty object for no keys", () => {
    expect(sourceEntriesFor(config, "en", [])).toEqual({});
  });
});
