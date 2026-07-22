import { describe, expect, it } from "vitest";
import type { PlacementRow } from "@rovenue/shared";
import {
  addRow,
  canRowBeAllUsers,
  makeEmptyRow,
  moveRow,
  removeRow,
  setRowAudience,
  setRowTarget,
  validatePlacementRows,
} from "../placement-rows-utils";

function row(audienceId: string | null): PlacementRow {
  return { audienceId, target: { type: "none" } };
}

describe("addRow", () => {
  it("appends an empty row at the end when there's no all-users fallback", () => {
    const rows = [row("a1")];
    const next = addRow(rows);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(makeEmptyRow());
    // original untouched
    expect(rows).toHaveLength(1);
  });

  it("inserts before a trailing all-users row so it stays last", () => {
    const rows = [row("a1"), row(null)];
    const next = addRow(rows);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual(row("a1"));
    expect(next[1]).toEqual(makeEmptyRow());
    expect(next[2]).toEqual(row(null));
  });

  it("starts from empty", () => {
    expect(addRow([])).toEqual([makeEmptyRow()]);
  });
});

describe("removeRow", () => {
  it("removes the row at the given index", () => {
    const rows = [row("a1"), row("a2"), row(null)];
    expect(removeRow(rows, 1)).toEqual([row("a1"), row(null)]);
  });

  it("no-ops on an out-of-range index", () => {
    const rows = [row("a1")];
    expect(removeRow(rows, 5)).toEqual(rows);
  });
});

describe("moveRow", () => {
  it("swaps a row with its upper neighbor", () => {
    const rows = [row("a1"), row("a2"), row("a3")];
    expect(moveRow(rows, 1, "up")).toEqual([row("a2"), row("a1"), row("a3")]);
  });

  it("swaps a row with its lower neighbor", () => {
    const rows = [row("a1"), row("a2"), row("a3")];
    expect(moveRow(rows, 1, "down")).toEqual([row("a1"), row("a3"), row("a2")]);
  });

  it("no-ops moving the first row up", () => {
    const rows = [row("a1"), row("a2")];
    expect(moveRow(rows, 0, "up")).toEqual(rows);
  });

  it("no-ops moving the last row down", () => {
    const rows = [row("a1"), row("a2")];
    expect(moveRow(rows, 1, "down")).toEqual(rows);
  });

  it("no-ops on an out-of-range index", () => {
    const rows = [row("a1")];
    expect(moveRow(rows, 3, "up")).toEqual(rows);
  });
});

describe("setRowAudience / setRowTarget", () => {
  it("updates only the targeted row", () => {
    const rows = [row("a1"), row("a2")];
    expect(setRowAudience(rows, 1, null)).toEqual([row("a1"), row(null)]);
    expect(setRowTarget(rows, 0, { type: "paywall", paywallId: "p1" })).toEqual([
      { audienceId: "a1", target: { type: "paywall", paywallId: "p1" } },
      row("a2"),
    ]);
  });
});

describe("canRowBeAllUsers", () => {
  it("is only true for the last index", () => {
    const rows = [row("a1"), row("a2"), row("a3")];
    expect(canRowBeAllUsers(rows, 0)).toBe(false);
    expect(canRowBeAllUsers(rows, 1)).toBe(false);
    expect(canRowBeAllUsers(rows, 2)).toBe(true);
  });
});

describe("validatePlacementRows", () => {
  it("accepts a valid list ending in all-users", () => {
    const rows: PlacementRow[] = [
      { audienceId: "a1", target: { type: "paywall", paywallId: "p1" } },
      { audienceId: null, target: { type: "none" } },
    ];
    expect(validatePlacementRows(rows)).toBeNull();
  });

  it("accepts an empty list", () => {
    expect(validatePlacementRows([])).toBeNull();
  });

  it("flags an unset audience select", () => {
    const rows: PlacementRow[] = [{ audienceId: "", target: { type: "none" } }];
    expect(validatePlacementRows(rows)).toEqual({
      code: "AUDIENCE_UNSET",
      index: 0,
    });
  });

  it("flags an incomplete paywall target", () => {
    const rows: PlacementRow[] = [
      { audienceId: "a1", target: { type: "paywall", paywallId: "" } },
    ];
    expect(validatePlacementRows(rows)).toEqual({
      code: "TARGET_INCOMPLETE",
      index: 0,
    });
  });

  it("flags an incomplete experiment target", () => {
    const rows: PlacementRow[] = [
      { audienceId: "a1", target: { type: "experiment", experimentId: "" } },
    ];
    expect(validatePlacementRows(rows)).toEqual({
      code: "TARGET_INCOMPLETE",
      index: 0,
    });
  });

  it("flags a duplicate all-users row", () => {
    const rows: PlacementRow[] = [row(null), row(null)];
    expect(validatePlacementRows(rows)).toEqual({
      code: "DUPLICATE_ALL_USERS",
      index: 1,
    });
  });

  it("flags an all-users row that isn't last", () => {
    const rows: PlacementRow[] = [row(null), row("a1")];
    expect(validatePlacementRows(rows)).toEqual({
      code: "ALL_USERS_NOT_LAST",
      index: 0,
    });
  });
});
