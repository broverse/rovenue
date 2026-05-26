import { describe, expect, it } from "vitest";
import type { CohortFilter } from "@rovenue/shared";
import {
  allowedOps,
  defaultFilter,
  defaultValueForOp,
  isFilterValid,
  sanitiseRule,
} from "../../src/components/cohorts/rule-codec";

describe("rule-codec", () => {
  it("returns allowed operators for each field", () => {
    expect(allowedOps("country")).toEqual(["eq", "in"]);
    expect(allowedOps("store")).toEqual(["eq", "in"]);
    expect(allowedOps("productId")).toEqual(["eq", "in"]);
    expect(allowedOps("purchaseType")).toEqual(["eq", "in"]);
    expect(allowedOps("firstSeenAfter")).toEqual(["gte"]);
    expect(allowedOps("firstSeenBefore")).toEqual(["lte"]);
  });

  it("defaultFilter('country') is a country/in/[] fragment", () => {
    expect(defaultFilter("country")).toEqual({
      field: "country",
      op: "in",
      value: [],
    });
  });

  it("defaultFilter('firstSeenAfter') uses gte and empty string", () => {
    expect(defaultFilter("firstSeenAfter")).toEqual({
      field: "firstSeenAfter",
      op: "gte",
      value: "",
    });
  });

  it("defaultValueForOp returns [] for in, '' for eq, '' for gte/lte", () => {
    expect(defaultValueForOp("in")).toEqual([]);
    expect(defaultValueForOp("eq")).toEqual("");
    expect(defaultValueForOp("gte")).toEqual("");
    expect(defaultValueForOp("lte")).toEqual("");
  });

  it("isFilterValid rejects empty `in` arrays and empty scalars", () => {
    expect(
      isFilterValid({ field: "country", op: "in", value: [] }),
    ).toBe(false);
    expect(
      isFilterValid({ field: "country", op: "in", value: ["US"] }),
    ).toBe(true);
    expect(
      isFilterValid({ field: "country", op: "eq", value: "" }),
    ).toBe(false);
    expect(
      isFilterValid({ field: "country", op: "eq", value: "US" }),
    ).toBe(true);
  });

  it("sanitiseRule drops invalid filters and preserves order", () => {
    const f1: CohortFilter = { field: "country", op: "in", value: ["US"] };
    const f2: CohortFilter = { field: "store", op: "eq", value: "" }; // invalid
    const f3: CohortFilter = { field: "productId", op: "eq", value: "p_1" };
    expect(
      sanitiseRule({ match: "all", filters: [f1, f2, f3] }),
    ).toEqual({ match: "all", filters: [f1, f3] });
  });
});
