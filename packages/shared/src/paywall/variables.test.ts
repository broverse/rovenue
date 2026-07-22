import { describe, expect, it } from "vitest";
import { resolveVariables, type PackageView } from "./variables";

const pkg: PackageView = {
  packageName: "Annual",
  price: "$39.99",
  pricePerPeriod: "$3.33/mo",
  period: "year",
};

describe("resolveVariables", () => {
  it("substitutes all four known variables", () => {
    const text =
      "{{packageName}} — {{price}} ({{pricePerPeriod}}) billed every {{period}}";
    expect(resolveVariables(text, pkg)).toBe(
      "Annual — $39.99 ($3.33/mo) billed every year",
    );
  });

  it("leaves unknown variables untouched", () => {
    expect(resolveVariables("Save {{discount}} today", pkg)).toBe(
      "Save {{discount}} today",
    );
  });

  it("leaves all variables verbatim when pkg is null", () => {
    const text = "{{packageName}} for {{price}}";
    expect(resolveVariables(text, null)).toBe(text);
  });

  it("returns text unchanged when it has no variables", () => {
    expect(resolveVariables("Plain text", pkg)).toBe("Plain text");
  });
});
