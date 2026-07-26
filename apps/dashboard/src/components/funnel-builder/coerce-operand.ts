import type { Clause, ClauseOp } from "@rovenue/shared/funnel";
import type { AnswerKind } from "./types";

// `between`'s two bounds are as numeric as gt/gte/lt/lte's single operand —
// evaluator.ts requires `typeof === "number"` for all five. Grouped here so
// coerceOperandValue treats them identically instead of `between` needing
// its own separate coercion path.
const NUMERIC_COMPARISONS: ReadonlySet<ClauseOp> = new Set([
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  // The relative date operators take a COUNT OF DAYS, not a date. They
  // belong here (the operand must be stored as a number, or evalClause
  // refuses it) and deliberately NOT in rule-editor's DATE_COMPARISONS,
  // which is what renders a date picker. The two sets differ on purpose.
  "within_last_days",
  "more_than_days_ago",
]);

/**
 * Store an operand in the type `evalClause` will compare it with.
 *
 * `gt`/`gte`/`lt`/`lte`/`between` require `typeof value === "number"`. So do
 * `eq`/`neq` when the question answers with a number, because evalClause
 * compares with `===` and `5 === "5"` is false — without this, `eq` on a
 * numeric question is dead and `neq` fires for EVERY visitor.
 *
 * Meant to be applied on BLUR, not on every keystroke. Coercing as the
 * author types makes `1.5` untypeable (`"1."` → `Number` → `1` →
 * re-rendered as `"1"`, so the `.` can never be followed), turns a cleared
 * box into `0`, and turns `"-"` into `NaN` — which JSON-serialises to
 * `null`, passes the schema's value-present check, and then never
 * matches. Leaving the field is the moment the value is finished, so that
 * is when it is typed.
 *
 * A string that is not a number is left alone rather than becoming `NaN`.
 */
export function coerceOperandValue(
  op: ClauseOp,
  raw: string,
  kind: AnswerKind = "text",
): string | number {
  const needsNumber =
    NUMERIC_COMPARISONS.has(op) || (kind === "number" && (op === "eq" || op === "neq"));
  if (!needsNumber) return raw;
  const n = Number(raw);
  return raw.trim() === "" || Number.isNaN(n) ? raw : n;
}

/**
 * Re-run `coerceOperandValue` over a clause that may already hold a
 * partially-typed (still-string) operand. Used at the view model's
 * serialize boundary (autosave / saveNow) as a backstop for
 * `coerceOperandValue`'s on-blur-only application in the editor: the
 * throttled autosave, or a re-render that unmounts the operand input
 * while it still holds focus (React fires no blur on unmount), can ship a
 * raw string the schema now rejects for a numeric operator. Re-coercing
 * here turns a still-parseable "42" into `42` before it leaves the VM;
 * an unparseable value (empty, mid-typing "-", non-numeric text) is left
 * alone, same as coerceOperandValue always does — it is genuinely
 * incomplete, not a focus artifact.
 */
export function coerceClauseValue(clause: Clause, kind: AnswerKind): Clause {
  if (clause.op === "between" && Array.isArray(clause.value) && clause.value.length === 2) {
    const [min, max] = clause.value as [unknown, unknown];
    return {
      ...clause,
      value: [
        typeof min === "string" ? coerceOperandValue("between", min, kind) : min,
        typeof max === "string" ? coerceOperandValue("between", max, kind) : max,
      ],
    } as Clause;
  }
  if (typeof clause.value === "string") {
    return { ...clause, value: coerceOperandValue(clause.op, clause.value, kind) } as Clause;
  }
  return clause;
}
