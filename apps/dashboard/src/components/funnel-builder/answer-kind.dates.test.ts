import { describe, expect, it } from "vitest";
import { ISO_DATE_RE } from "@rovenue/shared/funnel";
import { OPERATORS_BY_KIND, PAGE_TYPES } from "./types";
import { RENDERABLE_OPS, operandShape, defaultOperand } from "./rule-editor";
import { coerceOperandValue } from "./coerce-operand";

describe("the date answer kind", () => {
  it("classifies date_input as `date`", () => {
    expect(PAGE_TYPES.date_input.answerKind).toBe("date");
  });

  it("offers ordered comparison alongside equality", () => {
    // Purely additive against the old `text` classification: eq/neq/in/not_in
    // are kept so a rule authored before this sub-project is not silently
    // clamped to a different operator by the editor.
    expect([...OPERATORS_BY_KIND.date]).toEqual([
      "eq",
      "neq",
      "in",
      "not_in",
      "before",
      "after",
      "on_or_before",
      "on_or_after",
      "within_last_days",
      "more_than_days_ago",
      "is_answered",
      "is_not_answered",
    ]);
  });

  it("gives every offered operator a renderable label", () => {
    // The tripwire SP5 built after `not_contains` shipped unselectable:
    // OPERATORS_BY_KIND and the editor's label table drifting apart makes a
    // correct operator unwritable, which is the same defect as a writable
    // dead one, from the other side.
    for (const op of OPERATORS_BY_KIND.date) {
      expect(RENDERABLE_OPS.has(op), `${op} has no label in the rule editor`).toBe(true);
    }
  });

  it("treats a date operand as a scalar string, never a number", () => {
    for (const op of ["before", "after", "on_or_before", "on_or_after"] as const) {
      expect(operandShape(op)).toBe("scalar");
      expect(defaultOperand(op)).toBe("");
      // Coercing a date to a number yields NaN -> null -> a dead clause.
      expect(coerceOperandValue(op, "2026-03-01", "date")).toBe("2026-03-01");
    }
  });

  it("stores a relative operand as a NUMBER of days, not a date string", async () => {
    // The operand is a day COUNT. Left as the string "30" it would never
    // satisfy evalClause, which requires a whole non-negative number — the
    // same writable-but-dead shape the numeric operators once had.
    const { coerceOperandValue: coerce } = await import("./coerce-operand");
    for (const op of ["within_last_days", "more_than_days_ago"] as const) {
      expect(coerce(op, "30", "date")).toBe(30);
      expect(typeof coerce(op, "30", "date")).toBe("number");
    }
  });

  it("does NOT render a date picker for the relative operators", async () => {
    // They take a day count, so DATE_COMPARISONS must not contain them even
    // though they live on the `date` kind. The two sets differ on purpose.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/components/funnel-builder/rule-editor.tsx", "utf8"),
    );
    const dateSet = /DATE_COMPARISONS[^=]*= new Set\(\[(.*?)\]\)/s.exec(src)?.[1] ?? "";
    expect(dateSet).not.toContain("within_last_days");
    expect(dateSet).not.toContain("more_than_days_ago");
    expect(dateSet).toContain("before");
  });

  it("exports one ISO pattern rather than each layer inventing its own", () => {
    expect(ISO_DATE_RE.test("2026-03-01")).toBe(true);
    expect(ISO_DATE_RE.test("2026-1-5")).toBe(false);
  });
});
