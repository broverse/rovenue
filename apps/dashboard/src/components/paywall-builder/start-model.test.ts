import { describe, expect, it } from "vitest";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { TEMPLATES } from "./templates";
import { filterTemplates, shouldAutoOpenStart } from "./start-model";

function template(id: "hero" | "comparison") {
  return TEMPLATES.find((t) => t.id === id)!.build("en");
}

describe("shouldAutoOpenStart", () => {
  it("is true for an empty tree and false once anything is in it", () => {
    expect(shouldAutoOpenStart(emptyBuilderConfig("en"))).toBe(true);
    expect(shouldAutoOpenStart(template("hero"))).toBe(false);
  });
});

describe("filterTemplates", () => {
  const list = [
    {
      id: "hero",
      name: "Hero",
      tag: "Highest converting",
      description: "Full-bleed image, plan list, one clear purchase button.",
      category: "minimal",
    },
    {
      id: "planGrid",
      name: "Plan grid",
      tag: "Side by side",
      description: "Plans in a row, with what every plan shares underneath.",
      category: "comparison",
    },
    {
      id: "trialSteps",
      name: "Trial timeline",
      tag: "Removes trial anxiety",
      description: "A day-by-day timeline of what the free trial does.",
      category: "trialLed",
    },
  ];

  it("returns everything for no category and an empty query", () => {
    expect(filterTemplates(list, { category: null, query: "" })).toHaveLength(3);
  });

  it("filters by category", () => {
    expect(filterTemplates(list, { category: "comparison", query: "" }).map((t) => t.id)).toEqual([
      "planGrid",
    ]);
  });

  it("matches the name, case-insensitively", () => {
    expect(filterTemplates(list, { category: null, query: "HERO" }).map((t) => t.id)).toEqual([
      "hero",
    ]);
  });

  it("matches a word that appears only in the description", () => {
    // "underneath" is in no name, tag or category -- this is the assertion
    // that would fail if the haystack were narrowed back to the name.
    expect(filterTemplates(list, { category: null, query: "underneath" }).map((t) => t.id)).toEqual([
      "planGrid",
    ]);
  });

  it("matches a word that appears only in the tag", () => {
    expect(filterTemplates(list, { category: null, query: "anxiety" }).map((t) => t.id)).toEqual([
      "trialSteps",
    ]);
  });

  it("matches the category name itself", () => {
    expect(filterTemplates(list, { category: null, query: "comparison" }).map((t) => t.id)).toEqual([
      "planGrid",
    ]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterTemplates(list, { category: null, query: "  hero  " }).map((t) => t.id)).toEqual([
      "hero",
    ]);
  });

  it("combines category and query, returning nothing when they disagree", () => {
    expect(filterTemplates(list, { category: "minimal", query: "grid" })).toEqual([]);
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    expect(filterTemplates(list, { category: null, query: "zzz" })).toEqual([]);
  });
});
