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

describe("resolveVariables — Phase D3 expanded variables", () => {
  const richPkg: PackageView = {
    ...pkg,
    pricePerDay: "$0.11",
    pricePerWeek: "$0.77",
    pricePerMonth: "$3.33",
    pricePerYear: "$39.99",
    introPrice: "$0.99",
    introPeriod: "1 week",
    relativeDiscount: "17%",
  };

  it.each([
    ["pricePerDay", "$0.11"],
    ["pricePerWeek", "$0.77"],
    ["pricePerMonth", "$3.33"],
    ["pricePerYear", "$39.99"],
    ["introPrice", "$0.99"],
    ["introPeriod", "1 week"],
    ["relativeDiscount", "17%"],
  ])("substitutes {{%s}} when present", (name, expected) => {
    expect(resolveVariables(`{{${name}}}`, richPkg)).toBe(expected);
  });

  it("substitutes all seven new variables together in one string", () => {
    const text =
      "{{pricePerDay}}/{{pricePerWeek}}/{{pricePerMonth}}/{{pricePerYear}} intro {{introPrice}} for {{introPeriod}}, save {{relativeDiscount}}";
    expect(resolveVariables(text, richPkg)).toBe(
      "$0.11/$0.77/$3.33/$39.99 intro $0.99 for 1 week, save 17%",
    );
  });

  it.each([
    "pricePerDay",
    "pricePerWeek",
    "pricePerMonth",
    "pricePerYear",
    "introPrice",
    "introPeriod",
    "relativeDiscount",
  ])("leaves {{%s}} verbatim when the field is absent from pkg", (name) => {
    // `pkg` (the module-level fixture) never set these optional fields.
    expect(resolveVariables(`{{${name}}}`, pkg)).toBe(`{{${name}}}`);
  });

  it("leaves a new variable verbatim when explicitly set to undefined", () => {
    const partial: PackageView = { ...pkg, pricePerYear: undefined };
    expect(resolveVariables("{{pricePerYear}}", partial)).toBe("{{pricePerYear}}");
  });

  it("mixes present and absent new variables in the same string", () => {
    const partial: PackageView = { ...pkg, pricePerYear: "$39.99" };
    expect(resolveVariables("{{pricePerYear}} vs {{introPrice}}", partial)).toBe(
      "$39.99 vs {{introPrice}}",
    );
  });

  it("still substitutes the four required variables when new optional fields are absent", () => {
    const text = "{{packageName}} — {{price}} ({{pricePerPeriod}}) / {{period}}";
    expect(resolveVariables(text, pkg)).toBe(
      "Annual — $39.99 ($3.33/mo) / year",
    );
  });
});
