# SP5 — Funnel branching semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an authored branching rule mean what it says — no operator matching by accident, no operator that can never match, and no two pages sharing one answer key.

**Architecture:** The evaluator stops letting scalar operators answer `true` for array answers, gains `not_contains` so "did not pick X" is expressible, and aligns `is_answered` with the runner's own definition. The rule editor gains an `answerKind` classification so it offers only operators that can fire for the selected question, and stores numeric operands as numbers. A sync test holds the evaluator's runtime-type dispatch and the editor's page-type dispatch from drifting apart.

**Tech Stack:** TypeScript (strict), Zod, React (Vite), impair view models, Vitest.

Spec: `docs/superpowers/specs/2026-07-24-sp5-branching-semantics-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for schema validation.
- **No magic values.** A literal carrying meaning gets a named constant next to its siblings. Structured data tables (operator lists, page-type maps) are not magic values.
- All user-facing strings go through i18n. No hardcoded copy in components.
- Conventional commits, one commit per task. **Stay on the current branch (`main`). Do NOT create branches or worktrees.** Another author commits to `main` in parallel — `git add` only the files your task names, never `git add -A`, and run `git status --short` before committing to confirm nothing else is staged (a plain `git commit` commits the whole index).
- Test invocation: packages have no `vitest` script — use `pnpm --filter <pkg> exec vitest run <path>`, never `pnpm --filter <pkg> vitest run <path>`.
- **Every change must be mutation-checked**: after the test passes, revert the production change, confirm the test goes red, then restore. A test that passes on unfixed code proves nothing.
- No new migration. Do NOT run `drizzle-kit generate`.
- **Known pre-existing reds, not yours:** `FunnelPreviewViewModel > jumps via 'paywall' literal goto` in the dashboard, and `pnpm --filter @rovenue/dashboard exec tsc --noEmit` failing on `src/components/paywall-builder/inspector/tabs.test.ts` (a parallel author's file). Both proven pre-existing by stashing. Do not try to fix them; do not let them confuse your results.

---

### Task 1: The evaluator stops guessing

**Files:**
- Modify: `packages/shared/src/funnel/branching-schema.ts:3-16` (add `not_contains` to `CLAUSE_OPS`)
- Modify: `packages/shared/src/funnel/evaluator.ts:100-134` (`evalClause`)
- Test: `packages/shared/src/funnel/evaluator.clauses.test.ts` (create)

**Interfaces:**
- Produces: `ClauseOp` gains `"not_contains"`. `evalClause`'s behaviour changes as described below; its signature is unchanged and it stays module-private.

**Background the implementer needs:**

Branching is evaluated by `evalClause` (`packages/shared/src/funnel/evaluator.ts:100`), which looks the answer up by `clause.question_id` and compares it against `clause.value`.

Answers can be strings, numbers, booleans or **string arrays** (a `multi_choice` page emits `string[]`). Today the scalar operators handle arrays by accident:

- `eq` → `["a"] === "a"` is false. Harmless.
- `neq` → `["a"] !== "a"` is **true**. A rule reading "did NOT pick a" fires *even when a was picked*.
- `in` → `clause.value.includes(a)` compares the array by reference, so it never matches.
- `not_in` → therefore **always true**.

`neq` and `not_in` are the dangerous ones: they route the visitor to a page nobody chose, silently. A non-match would instead fall through to `default_next`, which is defined behaviour.

**The rule for this task: an operator that cannot meaningfully compare returns `false` — never `true` by accident.**

**Do not widen that rule to `undefined`.** An unanswered question compared with `neq "x"` returns `true` today, and that stays. It is a meaningful reading ("they did not say x, including by skipping"), unlike an array-versus-scalar comparison, which is a type mismatch rather than a question with an answer. Changing it would also make `is_not_answered` redundant. If you find yourself tempted, stop — the spec says arrays only.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/funnel/evaluator.clauses.test.ts`. Note `evalClause` is not exported; drive it through `evaluateNext`, as the existing `evaluator.test.ts` does — read that file first for the fixture shape.

```ts
import { describe, expect, it } from "vitest";
import { evaluateNext, type AnswerMap, type AnswerValue } from "./evaluator";
import type { ClauseOp } from "./branching-schema";

// Does a single clause fire? Routed through evaluateNext because
// evalClause is module-private: a matching rule goes to "pg_hit", a
// non-matching one falls through to default_next ("pg_miss").
function fires(op: ClauseOp, answer: AnswerValue | undefined, value?: unknown): boolean {
  const answers: AnswerMap = new Map();
  if (answer !== undefined) answers.set("q", answer);
  const result = evaluateNext({
    page: {
      id: "pg_1",
      type: "question",
      next_rules: [
        {
          id: "r1",
          condition: {
            op: "all",
            clauses: [{ question_id: "q", op, ...(value === undefined ? {} : { value }) }],
          },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "question" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return result.next === "page" && result.pageId === "pg_hit";
}

describe("evalClause — an array answer never matches a scalar operator", () => {
  const ARRAY: AnswerValue = ["a", "b"];

  // The load-bearing assertion of this whole sub-project. Listing every
  // scalar operator rather than only the two that were broken means the
  // next one added cannot regress quietly.
  it.each<[ClauseOp, unknown]>([
    ["eq", "a"],
    ["neq", "a"],
    ["in", ["a", "z"]],
    ["not_in", ["a", "z"]],
    ["gt", 1],
    ["gte", 1],
    ["lt", 1],
    ["lte", 1],
    ["between", [0, 5]],
  ])("%s does not fire for an array answer", (op, value) => {
    expect(fires(op, ARRAY, value)).toBe(false);
  });

  it("neq was the dangerous one: it fired even when the option WAS picked", () => {
    expect(fires("neq", ["a"], "a")).toBe(false);
  });

  it("not_in was equally dangerous", () => {
    expect(fires("not_in", ["a"], ["a", "z"])).toBe(false);
  });
});

describe("evalClause — arrays have their own operators", () => {
  it("contains fires when the option is among the selections", () => {
    expect(fires("contains", ["a", "b"], "a")).toBe(true);
  });

  it("contains does not fire when it is not", () => {
    expect(fires("contains", ["b"], "a")).toBe(false);
  });

  it("not_contains fires when the option is absent", () => {
    expect(fires("not_contains", ["b"], "a")).toBe(true);
  });

  it("not_contains does NOT fire when the option is present", () => {
    expect(fires("not_contains", ["a", "b"], "a")).toBe(true === false);
  });

  it("not_contains does not fire for a non-array answer — same can't-compare rule", () => {
    expect(fires("not_contains", "a", "z")).toBe(false);
  });
});

describe("evalClause — is_answered agrees with the runner's gate", () => {
  it.each<[string, AnswerValue | undefined]>([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["empty array", []],
  ])("%s is NOT answered", (_label, answer) => {
    expect(fires("is_answered", answer)).toBe(false);
    expect(fires("is_not_answered", answer)).toBe(true);
  });

  it.each<[string, AnswerValue]>([
    ["a string", "a"],
    ["zero", 0],
    ["false", false],
    ["a non-empty array", ["a"]],
  ])("%s IS answered", (_label, answer) => {
    expect(fires("is_answered", answer)).toBe(true);
    expect(fires("is_not_answered", answer)).toBe(false);
  });
});

describe("evalClause — scalar answers are unchanged", () => {
  it("eq still matches a scalar", () => {
    expect(fires("eq", "a", "a")).toBe(true);
  });

  it("neq on an UNANSWERED question still fires — deliberately unchanged", () => {
    // "they did not say x, including by skipping" is a meaningful
    // reading, unlike an array-versus-scalar type mismatch. Narrowing
    // this would also make is_not_answered redundant.
    expect(fires("neq", undefined, "x")).toBe(true);
  });

  it("gt still matches a number", () => {
    expect(fires("gt", 5, 3)).toBe(true);
  });
});
```

One assertion above is deliberately written as `toBe(true === false)`. Replace it with `toBe(false)` when you transcribe the file — it is there so a copy-paste without reading fails review, not the suite.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/evaluator.clauses.test.ts
```

Expected: FAIL. `not_contains` is not a valid `ClauseOp` (a type error, and at runtime `evalClause`'s `default` returns false), `neq`/`not_in` fire for arrays, and `""`/`[]` count as answered.

- [ ] **Step 3: Add `not_contains` to the operator list**

In `packages/shared/src/funnel/branching-schema.ts`, add it to `CLAUSE_OPS` immediately after `"contains"`:

```ts
  "contains",
  "not_contains",
```

The schema's `superRefine` already requires a value for every op except the two unary ones, which is correct for `not_contains` — no other schema change is needed.

- [ ] **Step 4: Rewrite `evalClause`**

Replace the body of `evalClause` in `packages/shared/src/funnel/evaluator.ts`:

```ts
function evalClause(clause: Clause, answers: AnswerMap): boolean {
  const a = answers.get(clause.question_id);

  // One definition of "answered", matching the runner's own gate: an
  // empty string and an empty selection are not answers. The evaluator
  // and the client disagreeing about this was two definitions one hop
  // apart.
  const answered =
    a !== undefined &&
    a !== null &&
    a !== "" &&
    !(Array.isArray(a) && a.length === 0);

  // A multi_choice answer is a string[]. Comparing it with a scalar
  // operator is a type mismatch, not a question with an answer — so the
  // scalar operators below refuse it in BOTH directions rather than
  // letting `neq`/`not_in` come back true by accident and route the
  // visitor somewhere nobody chose. Arrays have `contains` /
  // `not_contains` instead.
  const isArray = Array.isArray(a);

  switch (clause.op) {
    case "is_answered":
      return answered;
    case "is_not_answered":
      return !answered;
    case "eq":
      return !isArray && a === clause.value;
    case "neq":
      // NOTE: an UNANSWERED question still fires here, deliberately.
      // "they did not say x, including by skipping" is meaningful;
      // narrowing it would also make is_not_answered redundant.
      return !isArray && a !== clause.value;
    case "gt":
      return typeof a === "number" && typeof clause.value === "number" && a > clause.value;
    case "gte":
      return typeof a === "number" && typeof clause.value === "number" && a >= clause.value;
    case "lt":
      return typeof a === "number" && typeof clause.value === "number" && a < clause.value;
    case "lte":
      return typeof a === "number" && typeof clause.value === "number" && a <= clause.value;
    case "between": {
      if (typeof a !== "number" || !Array.isArray(clause.value) || clause.value.length !== 2) {
        return false;
      }
      const [min, max] = clause.value as [number, number];
      return a >= min && a <= max;
    }
    case "in":
      return !isArray && Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in":
      return !isArray && Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains":
      return isArray && typeof clause.value === "string" && (a as string[]).includes(clause.value);
    case "not_contains":
      return isArray && typeof clause.value === "string" && !(a as string[]).includes(clause.value);
    default:
      return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/evaluator.clauses.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the pre-existing evaluator suite**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/
```

Expected: PASS, including `evaluator.test.ts` and `branching-schema.test.ts`. If a pre-existing test fails, the cause is your change — report it rather than adjusting the test.

- [ ] **Step 7: Mutation-check, three parts**

1. Remove `!isArray &&` from `neq`. Confirm the "neq was the dangerous one" case goes red.
2. Restore, then change `answered` back to `a !== undefined && a !== null`. Confirm the empty-string and empty-array `is_answered` cases go red.
3. Restore, then make `not_contains` return `isArray && ...` without the negation (i.e. duplicate `contains`). Confirm the `not_contains` fires-when-absent case goes red.

Restore after each and confirm green. Record all six observed outcomes verbatim.

- [ ] **Step 8: Typecheck**

```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors from either. The API imports the evaluator, so its typecheck is what catches a `ClauseOp` union that other code does not handle.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/funnel/branching-schema.ts \
        packages/shared/src/funnel/evaluator.ts \
        packages/shared/src/funnel/evaluator.clauses.test.ts
git status --short
git commit -m "fix(shared): an operator that cannot compare returns false, never true"
```

---

### Task 2: The editor offers only operators that can fire

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts` (`PageTypeMeta`, `PAGE_TYPES`)
- Modify: `apps/dashboard/src/components/funnel-builder/rule-editor.tsx:9-22` and the operand input
- Test: `apps/dashboard/src/components/funnel-builder/answer-kind.test.ts` (create)

**Interfaces:**
- Consumes: `ClauseOp` including `"not_contains"` from Task 1.
- Produces: `AnswerKind = "text" | "choice" | "multi" | "number" | "none"`, `PageTypeMeta.answerKind`, and `OPERATORS_BY_KIND: Record<AnswerKind, ReadonlyArray<ClauseOp>>` exported from `types.ts`.

**Background the implementer needs:**

`rule-editor.tsx:9-22` holds a flat `OPERATORS` list rendered for every question, so `gt` is offered on a choice page and `contains` on an email page. Both are writable and dead — `gt` needs a number, `contains` needs an array.

Two separate defects are being fixed here:

1. **The operand is always a string.** The input at `rule-editor.tsx:161-171` writes `e.currentTarget.value` unchanged, and `evalClause` requires `typeof clause.value === "number"` for `gt`/`gte`/`lt`/`lte`. Those four can therefore never match. (`between` already coerces with `Number(...)` at lines 172-195 and is fine.) The editor is where this belongs: an evaluator that coerced `"5"` to `5` would hide the next type mismatch instead of surfacing it.

2. **Every operator is offered for every question.** The fix is a classification on the page type.

**The seam you are creating.** The evaluator dispatches on the **runtime value's type**; this classification dispatches on the **page type**. If they drift, the editor offers an operator that cannot fire — the exact defect being removed. Step 6 pins them together with a test; do not skip it and do not replace it with a comment.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/answer-kind.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OPERATORS_BY_KIND, PAGE_TYPES, type AnswerKind } from "./types";

describe("OPERATORS_BY_KIND", () => {
  it("offers array operators only to multi", () => {
    expect(OPERATORS_BY_KIND.multi).toContain("contains");
    expect(OPERATORS_BY_KIND.multi).toContain("not_contains");
    for (const kind of ["text", "choice", "number"] as AnswerKind[]) {
      expect(OPERATORS_BY_KIND[kind]).not.toContain("contains");
      expect(OPERATORS_BY_KIND[kind]).not.toContain("not_contains");
    }
  });

  it("offers numeric operators only to number", () => {
    for (const op of ["gt", "gte", "lt", "lte", "between"] as const) {
      expect(OPERATORS_BY_KIND.number).toContain(op);
      for (const kind of ["text", "choice", "multi"] as AnswerKind[]) {
        expect(OPERATORS_BY_KIND[kind]).not.toContain(op);
      }
    }
  });

  it("never offers a scalar equality operator to multi", () => {
    // These are the ones that used to fire by accident on an array.
    for (const op of ["eq", "neq", "in", "not_in"] as const) {
      expect(OPERATORS_BY_KIND.multi).not.toContain(op);
    }
  });

  it("offers the unary operators to every answering kind", () => {
    for (const kind of ["text", "choice", "multi", "number"] as AnswerKind[]) {
      expect(OPERATORS_BY_KIND[kind]).toContain("is_answered");
      expect(OPERATORS_BY_KIND[kind]).toContain("is_not_answered");
    }
  });

  it("offers nothing to a page that asks no question", () => {
    expect(OPERATORS_BY_KIND.none).toEqual([]);
  });

  it("classifies every page type", () => {
    // A new page type added without an answerKind would otherwise be
    // silently unbranchable.
    for (const [type, meta] of Object.entries(PAGE_TYPES)) {
      expect(meta.answerKind, `${type} has no answerKind`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.test.ts
```

Expected: FAIL — `OPERATORS_BY_KIND` and `answerKind` do not exist.

- [ ] **Step 3: Add the classification**

In `apps/dashboard/src/components/funnel-builder/types.ts`, above `PageTypeMeta`:

```ts
/**
 * What shape of answer a page type produces, and therefore which
 * branching operators can actually fire against it.
 *
 * `none` is every page that asks nothing — it is not offered as a
 * question in the rule editor at all.
 */
export type AnswerKind = "text" | "choice" | "multi" | "number" | "none";

/**
 * Operators the rule editor offers for each answer kind.
 *
 * Only operators that CAN fire. `contains` needs an array, the numeric
 * comparisons need a number, and `eq`/`neq`/`in`/`not_in` refuse arrays
 * outright (see evalClause) — offering any of them against the wrong
 * kind produces a rule that is writable and dead.
 */
export const OPERATORS_BY_KIND: Record<AnswerKind, ReadonlyArray<ClauseOp>> = {
  text: ["eq", "neq", "in", "not_in", "is_answered", "is_not_answered"],
  choice: ["eq", "neq", "in", "not_in", "is_answered", "is_not_answered"],
  multi: ["contains", "not_contains", "is_answered", "is_not_answered"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_answered", "is_not_answered"],
  none: [],
};
```

Import `ClauseOp` from `@rovenue/shared/funnel`. Add `answerKind: AnswerKind` to `PageTypeMeta`, then give every entry in `PAGE_TYPES` one:

- `text` — `email`, `short_text`, `text_input`, `long_text`, `phone`, `date_input`
- `choice` — `single_choice`, `yes_no`, `picture_choice`, `legal`, `checkbox`
- `multi` — `multi_choice`
- `number` — `number_input`, `slider`, `rating`, `opinion_scale`
- `none` — every remaining type (`info`, `loading`, `result`, `paywall`, `success`, `contact_info`, `welcome`, `statement`, `feature`, `end_screen`)

`date_input` is `text` on purpose: the runner does not wire it, and inventing date comparison before there is a date answer to compare would be speculative. `contact_info` is `none` because it collects several fields and has no single answer shape — it is not among the wired types.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.test.ts
```

Expected: PASS, 6/6.

- [ ] **Step 5: Wire the editor**

In `rule-editor.tsx`, keep `OPERATORS` as the label lookup but filter what is rendered by the selected question's kind, and store numeric operands as numbers.

The operator `<select>` at lines 148-159 renders `OPERATORS_BY_KIND[kind]` where `kind` is the `answerKind` of the page owning the clause's `question_id`. The operand `<input>` at lines 161-171 stores `Number(e.currentTarget.value)` when the operator is one of `gt`/`gte`/`lt`/`lte`, and the raw string otherwise.

Read the surrounding code before editing — the clause's question is chosen from a `<select>` of earlier questions, so you need the page behind the chosen `question_id` to read its type.

- [ ] **Step 6: Write the sync test**

This is the test that keeps the evaluator's runtime dispatch and the editor's page-type dispatch from drifting apart. Add to `answer-kind.test.ts`:

```ts
describe("answerKind agrees with what the wired inputs actually emit", () => {
  // PagePreview captures answers for exactly these types today (SP4).
  // The value each one emits must match what its answerKind promises,
  // or the editor offers an operator the evaluator cannot fire.
  //
  // If you wire a new input type and this test does not mention it, that
  // is the gap — add it here.
  it.each<[string, "string" | "array"]>([
    ["email", "string"],
    ["short_text", "string"],
    ["text_input", "string"],
    ["single_choice", "string"],
    ["yes_no", "string"],
    ["multi_choice", "array"],
  ])("%s emits a %s", (pageType, shape) => {
    const kind = PAGE_TYPES[pageType as keyof typeof PAGE_TYPES].answerKind;
    expect(shape === "array" ? kind === "multi" : kind !== "multi").toBe(true);
  });
});
```

The emitted shapes are the ones asserted by `page-preview.live.test.tsx` — read that file and make sure this table agrees with it. If it does not, one of the two is wrong and that is a finding: report it rather than editing whichever is easier.

- [ ] **Step 7: Run both suites**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
```

Expected: PASS apart from the known pre-existing `FunnelPreviewViewModel` failure.

- [ ] **Step 8: Mutation-check, two parts**

1. Add `"contains"` to `OPERATORS_BY_KIND.choice`. Confirm the "array operators only to multi" case goes red.
2. Restore, then make the operand input store the raw string for numeric operators. Confirm your numeric-operand assertion goes red. If it does not, that assertion does not discriminate — strengthen it and say so in your report.

Restore after each and confirm green. Record all four observed outcomes.

- [ ] **Step 9: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: no new errors. The pre-existing `paywall-builder/inspector/tabs.test.ts` failure is not yours — confirm nothing else appears.

- [ ] **Step 10: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/types.ts \
        apps/dashboard/src/components/funnel-builder/rule-editor.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.test.ts
git status --short
git commit -m "fix(dashboard): offer only operators that can fire, and type numeric operands"
```

---

### Task 3: A duplicated page gets its own question

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts:280-287` (`duplicatePage`)
- Test: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.duplicate.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `duplicatePage(id: string)` — signature unchanged.

**Background the implementer needs:**

`duplicatePage` deep-clones a page and regenerates only `id`:

```ts
const copy: Page = JSON.parse(JSON.stringify(this.pages[i]));
copy.id = `${id}_copy_${Date.now().toString(36)}`;
```

So the copy shares the original's `question_id`. Both the runner's answer map and the server's answer table key on question id, so the duplicate arrives **pre-filled with the original's answer**, satisfies its own `required` gate untouched, and re-sends that value under the copy's own `from_page_id`.

The copy needs a fresh `question_id`. It also needs any clause inside its **own** cloned `next_rules` rewritten to the new id — otherwise the copy's rules branch on the original's question, which is not what duplicating a page means.

Rules on *other* pages keep pointing at the original. That is correct: they were authored against that question.

`blank-page.ts:5-7` has the id helper this file should match:

```ts
function qid(prefix = "q"): string {
  return `${prefix}_${createId().slice(0, 6)}`;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.duplicate.test.ts`. Read a sibling test in that directory first for how the view model is constructed — `funnel-preview.vm` has one, and inventing a second construction idiom is a defect.

The assertions:

```ts
  it("gives the copy its own question_id", () => {
    // vm has one page: { id: "pg_1", type: "single_choice", question_id: "q_a" }
    vm.duplicatePage("pg_1");
    const [original, copy] = vm.pages;
    expect(copy.question_id).toBeDefined();
    expect(copy.question_id).not.toBe(original.question_id);
    // The original is untouched — other pages' rules still point at it.
    expect(original.question_id).toBe("q_a");
  });

  it("rewrites the copy's OWN rules to the new question_id", () => {
    // pg_1 additionally carries next_rules with a clause on "q_a"
    vm.duplicatePage("pg_1");
    const copy = vm.pages[1]!;
    const clause = copy.next_rules![0]!.condition.clauses[0]!;
    expect(clause.question_id).toBe(copy.question_id);
    expect(clause.question_id).not.toBe("q_a");
  });

  it("leaves another page's rules pointing at the original", () => {
    // pg_2 carries a rule with a clause on "q_a"
    vm.duplicatePage("pg_1");
    const other = vm.pages.find((p) => p.id === "pg_2")!;
    const clause = other.next_rules![0]!.condition.clauses[0]!;
    expect(clause.question_id).toBe("q_a");
  });

  it("leaves a page with no question_id alone", () => {
    // an info page
    vm.duplicatePage("pg_info");
    const copy = vm.pages[1]!;
    expect(copy.question_id).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/vm/funnel-draft.duplicate.test.ts
```

Expected: FAIL — the copy carries the original's `question_id`.

- [ ] **Step 3: Implement**

Replace `duplicatePage`:

```ts
  duplicatePage(id: string) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    const copy: Page = JSON.parse(JSON.stringify(this.pages[i]));
    copy.id = `${id}_copy_${Date.now().toString(36)}`;

    // A question id is an ANSWER KEY: the runner's answer map and the
    // server's answer table both key on it. Sharing one between two pages
    // means the copy arrives pre-filled with the original's answer,
    // satisfies its own `required` gate untouched, and re-sends that value
    // under its own page id.
    const previousQuestionId = copy.question_id;
    if (previousQuestionId) {
      copy.question_id = qid();
      // Only the copy's OWN rules are rewritten. Rules on other pages
      // keep pointing at the original — they were authored against that
      // question and duplicating a page does not re-target them.
      for (const rule of copy.next_rules ?? []) {
        for (const clause of rule.condition.clauses) {
          if (clause.question_id === previousQuestionId) {
            clause.question_id = copy.question_id;
          }
        }
      }
    }

    this.pages.splice(i + 1, 0, copy);
    this.selectedPageId = copy.id;
  }
```

`qid` lives in `blank-page.ts` and is not exported. Export it there and import it here rather than writing a second generator — two id formats for the same concept is how they drift.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/vm/funnel-draft.duplicate.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Mutation-check, two parts**

1. Remove the `copy.question_id = qid()` line. Confirm the "own question_id" case goes red.
2. Restore, then remove the rule-rewriting loop. Confirm the "rewrites the copy's OWN rules" case goes red while "leaves another page's rules" stays green.

Restore after each and confirm green. Record all four observed outcomes.

- [ ] **Step 6: Run the whole funnel-builder directory**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
```

Expected: PASS apart from the known pre-existing `FunnelPreviewViewModel` failure.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: no new errors beyond the known `paywall-builder/inspector` one.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts \
        apps/dashboard/src/components/funnel-builder/blank-page.ts \
        apps/dashboard/src/components/funnel-builder/vm/funnel-draft.duplicate.test.ts
git status --short
git commit -m "fix(dashboard): a duplicated page gets its own answer key"
```

---

### Task 4: Whole-change verification

**Files:** none modified — this task produces a report.

- [ ] **Step 1: Run every changed-area suite on a quiet machine**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/ src/runner/
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Record pass/fail counts per suite **verbatim**. For anything red, say whether this work caused it or it is one of the two known pre-existing failures.

- [ ] **Step 2: Confirm no operator can still match by accident**

The sub-project's deliverable is that a rule means what it says. Verify it at the seam rather than only in unit tests: read `evalClause` in its final form and, for **every** operator in `CLAUSE_OPS`, state what it returns for an array answer. The expected answer is `false` for all of them except `contains` and `not_contains`.

If you find one that can still return `true`, that is a finding — report it, do not fix it.

- [ ] **Step 3: Confirm the editor cannot offer a dead operator**

For each `AnswerKind`, cross-check `OPERATORS_BY_KIND[kind]` against what `evalClause` can return `true` for given that kind's runtime value. Report any operator that is offered but can never fire, or that can fire but is not offered.

- [ ] **Step 4: Append the ledger entry**

Append to `.superpowers/sdd/progress-sp1-sp2.md` — **not** `.superpowers/sdd/progress.md`, which is shared with a parallel workstream and has been clobbered three times. Record the commits, each task's mutation-check outcome, the Step 2 and Step 3 findings, and anything left open.

`.superpowers/` is gitignored. If `git add` refuses the path, **do not force-add it** — report that it could not be committed and leave it on disk. That is the correct outcome.

---

## Notes for the reviewer

- Task 1's rule is "cannot compare → `false`". A diff that makes `neq` return `true` for an array, in any form, defeats the sub-project.
- Task 1 deliberately does **not** change how `undefined` is handled by `neq`. Reject a diff that widens the array rule to unanswered questions — it would make `is_not_answered` redundant and change a meaningful reading.
- Task 2's sync test is the only thing holding the evaluator's runtime dispatch and the editor's page-type dispatch together. Reject a diff that replaces it with a comment.
- Task 3 must rewrite only the **copy's own** rules. A diff that re-targets other pages' rules is wrong.
- One assertion in Task 1's test file is written as `toBe(true === false)` on purpose. If it reaches review unchanged, the test file was transcribed without being read.
- Every task carries a mutation-check step. A report that omits the mutation-check outcome is incomplete regardless of how many tests pass.
