# SP8 — Date Comparison Operators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author ask whether a recorded date is before or after a given date, which today is impossible because a date answer only offers equality.

**Architecture:** Four new operators (`before`, `after`, `on_or_before`, `on_or_after`) compare two ISO-8601 `YYYY-MM-DD` strings lexicographically — which equals chronological order for a zero-padded fixed-width format, so no date parsing and no timezone exposure. Task 1 adds the operators and the comparison, Task 2 validates their operands at the schema boundary, Task 3 exposes them in the dashboard behind a new `date` answer kind.

**Tech Stack:** TypeScript strict, Zod, Vitest, React.

## Global Constraints

- **Stay on branch `main`. Never create, switch, or delete branches or worktrees.**
- A parallel author commits to `main`. Run `git status --short` before every commit and `git add` **only** the files that task names. Never `git add -A`, `git add .`, or `git commit -a`.
- `.superpowers/` is gitignored — never force-add it.
- TypeScript strict everywhere. Zod for API input.
- **No magic values** — the ISO date pattern is a named exported constant, used by every layer that needs it. Do not inline the regex in more than one place.
- **The comparison is lexicographic on validated strings. Never parse to `Date`.** `new Date("2026-03-01")` is midnight UTC, i.e. the previous day west of Greenwich; a calendar date has no time or zone and must not acquire one.
- **Both sides must be validated ISO dates before comparing.** `"2026-1-5"` sorts *after* `"2026-01-10"` as text and *before* it as a date, so an unvalidated compare silently routes to the wrong branch. An operator that cannot compare returns `false`, never `true`.
- **SP8 only adds.** No existing operator changes meaning, and no stored data needs repair — no funnel can contain a `before` clause before this ships. Do not write a migration.
- **Mutation-check every behavioural change:** after the test passes, revert the production change **by hand-editing it back**, confirm the test goes red, then hand-edit it forward. Never use `git checkout` or `git stash` to revert — that has destroyed uncommitted work on this project.
- Run all suites in the **FOREGROUND** with a generous timeout. Never background a suite and then wait on it.
- Known pre-existing red, **not** this work's fault: `FunnelPreviewViewModel > jumps via 'paywall' literal goto` in the dashboard.
- Line numbers here may have drifted (a parallel author edits these files). **Locate code by content**, and say so in your report if it moved.

---

### Task 1: The four operators and their comparison

**Files:**
- Modify: `packages/shared/src/funnel/branching-schema.ts` (add to `CLAUSE_OPS`, export the ISO pattern)
- Modify: `packages/shared/src/funnel/evaluator.ts` (four `evalClause` cases)
- Test: `packages/shared/src/funnel/evaluator.dates.test.ts` (create)

**Interfaces:**
- Produces: `ISO_DATE_RE` exported from `branching-schema.ts`, and `CLAUSE_OPS` extended with `"before" | "after" | "on_or_before" | "on_or_after"`. Task 2 consumes `ISO_DATE_RE`; Task 3 consumes the four operator names.
- Consumes: `evalClause`'s existing shape — `a` is the answer, `clause.value` the operand, and the switch returns a boolean.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/funnel/evaluator.dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type AnswerValue } from "./evaluator";
import type { ClauseOp } from "./branching-schema";

// =============================================================
// Date comparison operators
// =============================================================
//
// The comparison is lexicographic, which equals chronological order ONLY
// for zero-padded YYYY-MM-DD. That equivalence is the whole design, and
// the malformed cases below are what make it safe: "2026-1-5" sorts AFTER
// "2026-01-10" as text and BEFORE it as a date, so an unvalidated compare
// routes the visitor to the wrong branch. Every one of those cases must
// come back false.

const DATE_OPS = ["before", "after", "on_or_before", "on_or_after"] as const;

/** Routes through the real evaluator so a `false` is an observed
 *  fall-through, not a hand-asserted return value. */
function fires(op: ClauseOp, answer: AnswerValue | undefined, value: unknown): boolean {
  const answers: AnswerMap = new Map();
  if (answer !== undefined) answers.set("q_d", answer);
  const res = evaluateNext({
    page: {
      id: "pg_1",
      type: "date_input",
      next_rules: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: "q_d", op, value } as never] },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "date_input" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

describe("date operators compare chronologically", () => {
  it("before fires only for an earlier date", () => {
    expect(fires("before", "2026-03-01", "2026-03-02")).toBe(true);
    expect(fires("before", "2026-03-02", "2026-03-01")).toBe(false);
  });

  it("after fires only for a later date", () => {
    expect(fires("after", "2026-03-02", "2026-03-01")).toBe(true);
    expect(fires("after", "2026-03-01", "2026-03-02")).toBe(false);
  });

  it("crosses year and month boundaries correctly", () => {
    // Naive per-component comparison, or a numeric coercion, gets these wrong.
    expect(fires("before", "2025-12-31", "2026-01-01")).toBe(true);
    expect(fires("after", "2026-01-01", "2025-12-31")).toBe(true);
    expect(fires("before", "2026-01-31", "2026-02-01")).toBe(true);
  });

  // The boundary is where an off-by-one in the comparison operator hides.
  it("treats an equal date per its inclusivity", () => {
    const same = "2026-03-01";
    expect(fires("before", same, same)).toBe(false);
    expect(fires("after", same, same)).toBe(false);
    expect(fires("on_or_before", same, same)).toBe(true);
    expect(fires("on_or_after", same, same)).toBe(true);
  });

  it("on_or_before and on_or_after still order strictly either side", () => {
    expect(fires("on_or_before", "2026-03-01", "2026-03-02")).toBe(true);
    expect(fires("on_or_before", "2026-03-02", "2026-03-01")).toBe(false);
    expect(fires("on_or_after", "2026-03-02", "2026-03-01")).toBe(true);
    expect(fires("on_or_after", "2026-03-01", "2026-03-02")).toBe(false);
  });

  // ---- the cases that justify validating instead of just comparing ----

  it("refuses a malformed OPERAND rather than mis-ordering it", () => {
    // "2026-1-5" > "2026-01-10" as text, but is earlier as a date. A raw
    // lexicographic compare would return true for `before` here.
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-01-10", "2026-1-5"), `${op} accepted a malformed operand`).toBe(false);
    }
  });

  it("refuses a malformed ANSWER rather than mis-ordering it", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-1-5", "2026-01-10"), `${op} accepted a malformed answer`).toBe(false);
    }
  });

  it("refuses every non-date answer shape", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, 20260301, "2026-03-01"), `${op} accepted a number`).toBe(false);
      expect(fires(op, ["2026-03-01"], "2026-03-01"), `${op} accepted an array`).toBe(false);
      expect(fires(op, null, "2026-03-01"), `${op} accepted null`).toBe(false);
      expect(fires(op, undefined, "2026-03-01"), `${op} accepted an unanswered question`).toBe(false);
      expect(fires(op, "", "2026-03-01"), `${op} accepted an empty answer`).toBe(false);
    }
  });

  it("refuses a non-string operand", () => {
    for (const op of DATE_OPS) {
      expect(fires(op, "2026-03-01", 20260301), `${op} accepted a numeric operand`).toBe(false);
      expect(fires(op, "2026-03-01", null), `${op} accepted a null operand`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/evaluator.dates.test.ts
```
Expected: FAIL. The four operators are not in `CLAUSE_OPS` yet, so `evalClause` hits its `default: return false` and every `toBe(true)` assertion fails. The `toBe(false)` ones pass vacuously for now — that is exactly why Step 5's mutation-check matters.

- [ ] **Step 3: Add the operators and the ISO pattern**

In `packages/shared/src/funnel/branching-schema.ts`, extend `CLAUSE_OPS` (append, keeping the existing order so nothing reorders):

```ts
export const CLAUSE_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "is_answered",
  "is_not_answered",
] as const;
```

Add the shared pattern next to it:

```ts
/**
 * An ISO-8601 calendar date, zero-padded: `YYYY-MM-DD`.
 *
 * Load-bearing, not cosmetic. The date operators compare lexicographically
 * because that equals chronological order for THIS format — and only for
 * this format. `"2026-1-5"` sorts after `"2026-01-10"` as text while being
 * earlier as a date, so comparing unvalidated input silently routes to the
 * wrong branch. Both the answer and the operand are checked against this
 * before any date operator compares them.
 *
 * Calendar validity is deliberately not enforced: `2026-02-31` compares
 * consistently and harmlessly, and a regex that also policed month lengths
 * would be a liability for no gain.
 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
```

- [ ] **Step 4: Add the four comparison cases**

In `packages/shared/src/funnel/evaluator.ts`, import the pattern by extending the existing type-only import from `./branching-schema` into a value import (it currently reads `import type { Clause, NextRule } from "./branching-schema";` — add a separate value import line rather than converting it, so the type-only import stays type-only):

```ts
import { ISO_DATE_RE } from "./branching-schema";
```

Then add, immediately after the `not_contains` case and before `default`:

```ts
    // ---- date operators ----
    //
    // Lexicographic comparison IS chronological comparison for zero-padded
    // YYYY-MM-DD, so these need no date parsing — and must not do any.
    // Parsing would attach a time and a zone to a value that has neither
    // (`new Date("2026-03-01")` is midnight UTC, i.e. the previous day west
    // of Greenwich).
    //
    // The guard is what makes that equivalence safe rather than merely
    // convenient: an unpadded "2026-1-5" sorts AFTER "2026-01-10" as text
    // while being EARLIER as a date. Either side failing the pattern means
    // the operator cannot compare, so it returns false rather than
    // answering true by accident.
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      if (
        typeof a !== "string" ||
        typeof clause.value !== "string" ||
        !ISO_DATE_RE.test(a) ||
        !ISO_DATE_RE.test(clause.value)
      ) {
        return false;
      }
      const other = clause.value;
      if (clause.op === "before") return a < other;
      if (clause.op === "after") return a > other;
      if (clause.op === "on_or_before") return a <= other;
      return a >= other;
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/evaluator.dates.test.ts
pnpm --filter @rovenue/shared exec vitest run src/funnel/
pnpm --filter @rovenue/shared exec tsc --noEmit
```
Expected: the new file green; the whole `src/funnel/` suite green (the existing table-driven evaluator test iterates `CLAUSE_OPS`, so extending it exercises the new operators there too — if that test reds, read it before changing it, because it may be telling you the new operators return `true` for an array answer, which they must not); `tsc` clean.

- [ ] **Step 6: Mutation-check, twice**

Both are required and they check different things.

(a) **The comparison does the work.** By hand, change `if (clause.op === "before") return a < other;` to `return false;`. Re-run Step 5's first command.
Expected: RED on "before fires only for an earlier date". Restore by hand; green.

(b) **The guard is load-bearing, not decoration.** By hand, delete the two `ISO_DATE_RE.test(...)` conditions from the guard (keeping the two `typeof` checks). Re-run.
Expected: RED on "refuses a malformed OPERAND rather than mis-ordering it" — `before` now returns `true` for `"2026-01-10"` vs `"2026-1-5"`, which is the wrong branch. This is the assertion the whole design rests on; if it stays green, the test is not pinning what it claims. Restore by hand; green.

- [ ] **Step 7: Commit**

```bash
git status --short
git add packages/shared/src/funnel/branching-schema.ts \
        packages/shared/src/funnel/evaluator.ts \
        packages/shared/src/funnel/evaluator.dates.test.ts
git commit -m "feat(shared): date comparison operators, compared as ISO text not parsed dates"
```

---

### Task 2: Validate the date operands at the schema boundary

**Files:**
- Modify: `packages/shared/src/funnel/branching-schema.ts` (a `superRefine` branch)
- Test: `packages/shared/src/funnel/branching-schema.dates.test.ts` (create)

**Interfaces:**
- Consumes: `ISO_DATE_RE` and the four operator names from Task 1.
- Produces: nothing new; tightens `clauseSchema`.

**Why this is additive and needs no migration:** the four operators do not exist before Task 1, so no stored funnel can hold a `before` clause. That is the difference from the numeric guard SP5 added, which tightened an operator that *already had* stored string operands and so required a repair migration (SP7's `0095`). Do not write one here.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/funnel/branching-schema.dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextRuleSchema } from "./branching-schema";
import type { ClauseOp } from "./branching-schema";

// Two-sided per operator: a guard tested in one direction only is how
// SP5's `not_in` bug survived 45 tests.

const DATE_OPS: ClauseOp[] = ["before", "after", "on_or_before", "on_or_after"];

function parse(op: ClauseOp, value: unknown) {
  return nextRuleSchema.safeParse({
    id: "r_1",
    condition: { op: "all", clauses: [{ question_id: "q_d", op, value }] },
    goto: "pg_2",
  });
}

describe("date operands are validated at the boundary", () => {
  it("accepts a zero-padded ISO date", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-03-01").success, `${op} rejected a valid ISO date`).toBe(true);
    }
  });

  it("rejects an unpadded date, which would sort wrongly as text", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-1-5").success, `${op} accepted an unpadded date`).toBe(false);
    }
  });

  it("rejects a non-string operand", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, 20260301).success, `${op} accepted a number`).toBe(false);
      expect(parse(op, ["2026-03-01"]).success, `${op} accepted an array`).toBe(false);
      expect(parse(op, null).success, `${op} accepted null`).toBe(false);
    }
  });

  it("rejects a date-shaped string carrying extra text", () => {
    for (const op of DATE_OPS) {
      expect(parse(op, "2026-03-01T00:00:00Z").success, `${op} accepted a datetime`).toBe(false);
      expect(parse(op, " 2026-03-01").success, `${op} accepted leading space`).toBe(false);
    }
  });

  it("leaves the other operators' operand rules alone", () => {
    // A regression guard: the new branch must not widen or narrow anything
    // else in the same superRefine.
    expect(parse("eq", "anything").success).toBe(true);
    expect(parse("gt", 5).success).toBe(true);
    expect(parse("gt", "5").success).toBe(false);
    expect(parse("in", ["a"]).success).toBe(true);
    expect(parse("contains", "a").success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/branching-schema.dates.test.ts
```
Expected: FAIL on "rejects an unpadded date", "rejects a non-string operand" and "rejects a date-shaped string carrying extra text" — with no branch for these operators, `z.unknown()` accepts anything. The "accepts a zero-padded ISO date" case passes already, which is why the failing ones matter.

- [ ] **Step 3: Add the schema branch**

In `branching-schema.ts`'s `superRefine`, after the `between` branch and before the closing `});`:

```ts
    if (
      c.op === "before" ||
      c.op === "after" ||
      c.op === "on_or_before" ||
      c.op === "on_or_after"
    ) {
      // evalClause compares these as TEXT, which equals chronological
      // order only for zero-padded YYYY-MM-DD. An unpadded or otherwise
      // off-format operand would validate here and then compare in the
      // wrong direction — worse than never firing. Reject it at the
      // boundary, the same reasoning as the contains and numeric guards.
      if (typeof c.value !== "string" || !ISO_DATE_RE.test(c.value)) {
        ctx.addIssue({
          code: "custom",
          message: `Op ${c.op} requires an ISO date (YYYY-MM-DD)`,
          path: ["value"],
        });
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/
pnpm --filter @rovenue/shared exec tsc --noEmit
```
Expected: the new file green, the rest of `src/funnel/` unchanged, `tsc` clean.

- [ ] **Step 5: Mutation-check**

By hand, weaken the guard to `if (typeof c.value !== "string")` — dropping only the pattern test. Re-run Step 4.
Expected: RED on "rejects an unpadded date, which would sort wrongly as text" and on the datetime/leading-space case. Restore by hand; green.

- [ ] **Step 6: Commit**

```bash
git status --short
git add packages/shared/src/funnel/branching-schema.ts \
        packages/shared/src/funnel/branching-schema.dates.test.ts
git commit -m "feat(shared): reject a non-ISO date operand at the schema boundary"
```

---

### Task 3: Offer the operators in the builder behind a `date` answer kind

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts` (`AnswerKind`, `OPERATORS_BY_KIND`, `PAGE_TYPES.date_input`)
- Modify: `apps/dashboard/src/components/funnel-builder/rule-editor.tsx` (operator labels, date operand input)
- Modify: `apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx` (pin the ISO shape)
- Test: `apps/dashboard/src/components/funnel-builder/answer-kind.dates.test.ts` (create)

**Interfaces:**
- Consumes: the four operator names and `ISO_DATE_RE` from Task 1; `OPERATORS_BY_KIND` and `RENDERABLE_OPS` as they already exist.
- Produces: `AnswerKind` gains `"date"`.

**Two places that need NO change — do not "fix" them:**
- `coerce-operand.ts`. Its `needsNumber` test is `NUMERIC_COMPARISONS.has(op) || (kind === "number" && (op === "eq" || op === "neq"))`. The new operators are not in `NUMERIC_COMPARISONS` and the kind is `"date"`, so a date operand already passes through as a raw string. Coercing it would give `NaN`, then `null` on serialisation, then a clause that never fires.
- `operandShape` in `rule-editor.tsx`. It returns `"scalar"` for anything not unary/array/range, and `defaultOperand` gives `""` for a scalar. Both are already right for a date field.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/answer-kind.dates.test.ts`:

```ts
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

  it("exports one ISO pattern rather than each layer inventing its own", () => {
    expect(ISO_DATE_RE.test("2026-03-01")).toBe(true);
    expect(ISO_DATE_RE.test("2026-1-5")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.dates.test.ts
```
Expected: FAIL — `answerKind` is still `"text"`, `OPERATORS_BY_KIND.date` is undefined, and the four operators have no labels.

- [ ] **Step 3: Add the `date` kind**

In `types.ts`, extend the union:

```ts
export type AnswerKind = "text" | "choice" | "multi" | "number" | "date" | "none";
```

Add the row to `OPERATORS_BY_KIND` (after `number`, before `none`):

```ts
  // Additive against the `text` classification date_input used to carry:
  // eq/neq/in/not_in are kept, so no rule authored since date_input was
  // wired gets clamped to a different operator. Only the four ordered
  // operators require the ISO shape, because only they compare.
  date: [
    "eq", "neq", "in", "not_in",
    "before", "after", "on_or_before", "on_or_after",
    "is_answered", "is_not_answered",
  ],
```

Reclassify the page type — change `date_input`'s entry from `answerKind: "text"` to `answerKind: "date"`:

```ts
  date_input: { label: "Date", icon: Calendar, tone: "", answerKind: "date" },
```

- [ ] **Step 4: Add the labels and the date operand input**

In `rule-editor.tsx`, add four entries to the `OPERATORS` table, after `not_contains` and before `is_answered` so the dropdown order matches `CLAUSE_OPS`:

```ts
  { v: "before", l: "is before" },
  { v: "after", l: "is after" },
  { v: "on_or_before", l: "is on or before" },
  { v: "on_or_after", l: "is on or after" },
```

Then make the scalar operand render as a date picker for these operators. Locate the scalar operand `<input>` in the clause row (the one whose `onBlur` calls `coerceOperandValue`) and give it a conditional `type`, hoisting the operator set into a named constant beside `NUMERIC_COMPARISONS`:

```ts
/** Operators whose operand is a calendar date, so the row offers a date
 *  picker instead of free text — an author should not have to type a
 *  format they cannot see. */
const DATE_COMPARISONS: ReadonlySet<ClauseOp> = new Set([
  "before",
  "after",
  "on_or_before",
  "on_or_after",
]);
```

and on the input:

```tsx
type={DATE_COMPARISONS.has(c.op) ? "date" : "text"}
```

A native date input already emits `YYYY-MM-DD`, which is exactly what the schema and evaluator require, so no formatting code is needed. Keep the existing `onChange`/`onBlur` wiring untouched — `coerceOperandValue` returns a date string unchanged (see the note above).

- [ ] **Step 5: Pin the ISO shape in the sync test**

`answer-kind.sync.test.tsx` would keep passing untouched, because its kind→shape mapping sends everything that is not `multi` or `number` to "expect a string" — and a date *is* a string. That means the new kind would be verified no more strictly than plain text. Add a branch so the classification is actually pinned.

Extend the shape assertion inside the `it.each` body, alongside the existing `multi` and `number` branches:

```tsx
      } else if (kind === "date") {
        // A `date` kind must emit a value the date operators can compare.
        // Asserting only "it is a string" would verify this kind no more
        // strictly than plain text, and the whole point of the kind is the
        // format.
        expect(typeof emitted, `${wired.type} is date but emitted a non-string`).toBe("string");
        expect(
          ISO_DATE_RE.test(emitted as string),
          `${wired.type} is date but emitted ${String(emitted)}, not YYYY-MM-DD`,
        ).toBe(true);
```

and add the import at the top of that file:

```tsx
import { ISO_DATE_RE } from "@rovenue/shared/funnel";
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: all green except the known `FunnelPreviewViewModel > jumps via 'paywall' literal goto`; `tsc` clean. The sync test's `date_input` row must still pass — it drives the real date input, which emits `2026-07-25`.

- [ ] **Step 7: Mutation-check, twice**

(a) **The reclassification is real.** By hand, set `date_input`'s `answerKind` back to `"text"`. Re-run Step 6.
Expected: RED on "classifies date_input as `date`". Restore by hand; green.

(b) **The sync test's ISO assertion bites.** By hand, make the date input emit something non-ISO — in `page-preview.tsx`, change `DatePicker`'s `onChange` to `onChange(\`x\${e.currentTarget.value}\`)`. Re-run.
Expected: RED on the sync test's `date_input` row with the "not YYYY-MM-DD" message. Restore by hand; green.
This is the check that matters most, because Step 5 exists precisely because the test passed without it.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/types.ts \
        apps/dashboard/src/components/funnel-builder/rule-editor.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.dates.test.ts
git commit -m "feat(dashboard): offer date comparison on a date question"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (four dedicated operators; both-sides ISO validation; false when it cannot compare) → Task 1. ✅
- Item 2 (no date `between`; range = two clauses) → no task adds one; Task 3's operator list omits `between` for `date`. ✅
- Item 3 (`date` kind; additive list keeping `eq`/`neq`/`in`/`not_in`; `date_input` reclassified) → Task 3 Steps 3, plus the list pinned by an equality assertion. ✅
- Item 4 (date operand input; labels; `coerceOperandValue` and `operandShape` untouched) → Task 3 Steps 4 + the "no change" note + the coercion assertion in Step 1's test. ✅
- Item 5 (schema validates the four operands; additive so no migration) → Task 2, including the explicit no-migration rationale. ✅
- Spec's testing section: both directions per operator, malformed operand *and* answer, boundary inclusivity, non-date shapes, two-sided schema, sync ISO assertion → Tasks 1-3. ✅
- Spec's out-of-scope (relative dates, date `between`, datetimes, calendar validation) → no task touches any. ✅

**Placeholder scan:** no TBD/TODO; every code step carries complete code; no "similar to Task N". Task 3 Step 4 says "locate the scalar operand input by content" rather than quoting a line number, which is a deliberate response to the parallel author's drift, and it names the identifying feature (its `onBlur` calls `coerceOperandValue`). ✅

**Type consistency:** `ISO_DATE_RE` is declared once in `branching-schema.ts` (Task 1) and consumed by name in Task 2, Task 3's new test, and the sync test — never redeclared. The four operator names are spelled identically in `CLAUSE_OPS`, `evalClause`, the schema branch, `OPERATORS_BY_KIND.date`, the `OPERATORS` label table, `DATE_COMPARISONS`, and both new test files. `AnswerKind` gains exactly `"date"`, matching `PAGE_TYPES.date_input.answerKind` and the sync test's new branch. `coerceOperandValue(op, raw, kind)`'s three-argument signature matches its declaration in `coerce-operand.ts`. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-sp8-date-operators.md`.
