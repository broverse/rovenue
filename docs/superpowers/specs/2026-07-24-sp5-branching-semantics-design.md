# SP5 — Funnel branching semantics

Date: 2026-07-24
Status: approved (design)
Surfaces: `packages/shared`, `apps/dashboard`

## Context

SP4 made the funnel runner record answers, so branching rules evaluate against real
values for the first time. Its final review then asked the question SP4 itself had
only asked of `yes_no`: **can an authored rule actually match what the runner
sends?** For several operators the answer is no, and for two it is worse than no.

| # | Defect | Class |
|---|---|---|
| A | `neq` / `not_in` are unconditionally **true** for any array answer | silent **wrong** branch |
| B | `gt` / `gte` / `lt` / `lte` can never match — the editor's operand is always a string | writable-but-dead |
| C | Every operator is offered for every question type (`contains` on an email, `gt` on a choice) | writable-but-dead |
| D | `duplicatePage` clones `question_id`, so two pages share one answer key | builder defect |
| E | `is_answered` counts `""` and `[]` as answered; the runner's own gate does not | two definitions |

A is the dangerous one. A rule reading "did **not** pick X" fires *even when X was
picked* — the funnel routes somewhere the author did not intend, silently. That is
strictly worse than the fall-through SP4 removed: a wrong page rather than a
default one.

## Why the semantics can be fixed outright

Nothing in this repository ever wrote an answer before SP4. `submitAnswer` had no
callers; the SDK, the Rust core and the API were checked and none of them post to
`/answers`. So every clause has always been evaluated against `undefined`, and **no
funnel can depend on today's array semantics — there have never been array
answers.** The compatibility risk of correcting the evaluator is therefore not
"small"; it is structurally absent.

One related consequence, recorded because it is easy to misattribute later: `neq`
and `is_not_answered` clauses *did* fire against `undefined`, so funnels containing
them already changed behaviour when SP4 started supplying real answers. That was
SP4's intended effect, not something this sub-project introduces.

## Item 1 — an operator that cannot compare returns false

`eq`, `neq`, `in` and `not_in` return **`false` in both directions** when the answer
is an array. Not "true because they are not equal" — false, meaning no match.

The principle is the one the rest of this programme keeps arriving at: **an
operator that cannot meaningfully answer must not answer `true` by accident.** A
non-match falls through to `default_next`, which is defined behaviour. An accidental
match routes the visitor somewhere nobody chose.

This deliberately does **not** overload the scalar operators with set meaning.
Making `eq "a"` mean "contains a" for arrays while meaning equality for scalars gives
one operator two meanings, which is the shape of the next silent surprise. Arrays get
their own operators instead.

## Item 2 — `not_contains`

`contains` already handles arrays. Its negation does not exist, which is precisely
why authors reached for `neq` and `not_in` and got the wrong answer.

`not_contains` is added to `CLAUSE_OPS`, the clause schema, the evaluator and the
editor's label list. It is true when the answer is an array that does **not**
include the operand, and false when the answer is not an array — the same
can't-compare-so-no rule as Item 1.

## Item 3 — `is_answered` agrees with the runner

The evaluator treats anything other than `undefined`/`null` as answered. The runner's
own gate (`funnel-runner.tsx`) additionally treats `""` and `[]` as unanswered.

Two definitions of "answered" one hop apart is a defect regardless of which is
better, and the runner's is the useful one: an empty string is not an answer.
`is_answered` becomes false for `undefined`, `null`, `""` and `[]`;
`is_not_answered` is its exact negation.

## Item 4 — the editor produces correctly-typed operands

`rule-editor.tsx` writes every operand from a free-text input as
`e.currentTarget.value`, i.e. always a string. `evalClause` requires
`typeof clause.value === "number"` for `gt`/`gte`/`lt`/`lte`, so those four can never
match anything. (`between` already coerces with `Number(...)` and is unaffected.)

The fix belongs in the editor: when the operator is numeric, the operand is stored as
a number. The evaluator is not made to guess — a comparison that silently coerces
`"5"` to `5` would hide the next type mismatch instead of surfacing it.

## Item 5 — operators are offered by answer kind, and the two sides are held in sync

`OPERATORS` is a flat list rendered for every question. `PageTypeMeta`
(`apps/dashboard/src/components/funnel-builder/types.ts`) gains an `answerKind`:

| `answerKind` | Page types | Operators offered |
|---|---|---|
| `text` | `email`, `short_text`, `text_input`, `long_text`, `phone` | `eq`, `neq`, `in`, `not_in`, `is_answered`, `is_not_answered` |
| `choice` | `single_choice`, `yes_no`, `picture_choice`, `legal`, `checkbox` | `eq`, `neq`, `in`, `not_in`, `is_answered`, `is_not_answered` |
| `multi` | `multi_choice` | `contains`, `not_contains`, `is_answered`, `is_not_answered` |
| `number` | `number_input`, `slider`, `rating`, `opinion_scale` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `not_in`, `is_answered`, `is_not_answered` |
| `none` | every non-input page (`info`, `paywall`, `welcome`, …) that asks no *single comparable* question | — not offered as a question at all |

`date_input` is classified `text` for now: the runner does not wire it, and inventing
date comparison before there is a date answer to compare would be speculative.
`contains` is not offered for `text` — it requires an array in the evaluator, so
"email contains @" is exactly the writable-but-dead rule this item removes. Substring
matching would be a new operator and is deliberately not in scope.

`in`/`not_in` are offered for `number` alongside `eq`/`neq`: `evalClause` places no
element-type constraint on `in`/`not_in`'s array operand, so `{op:"in", value:[5,10,15]}`
against a numeric answer fires exactly as `eq` does — the omission was
live-but-unoffered, the mirror image of the writable-but-dead class this item removes.

`contact_info` is classified `none` even though it *is* an input page
(`collectName`/`collectEmail`/`collectPhone`): its answer is a composite of up to three
values, not the single comparable value every other kind produces, and the runner does
not currently record it as a branchable answer. It keeps a `question_id` (used for
required-field validation, not branching) — the rule editor's question picker excludes
it explicitly rather than relying on it having no id.

**The seam this item creates, and how it is held closed.** The evaluator dispatches on
the **runtime value's type**; the editor dispatches on the **page type**. Those are
two answers to "what kind of answer is this", and if they drift apart the result is a
writable-but-dead rule — the very class being fixed here.

A comment cannot hold that closed. A test does: for each wired input type, the value
the component actually emits is checked against what its `answerKind` promises. The
day someone wires a new input type, or changes what an existing one emits, that test
goes red instead of the product quietly offering an operator that cannot fire.

## Item 6 — `duplicatePage` regenerates the question id

`vm/funnel-draft.vm.ts` deep-clones a page and regenerates only `id`, so the copy
shares the original's `question_id`. Both the runner's answer map and the server's
upsert key on question id, so the duplicate arrives pre-filled with the original's
answer, satisfies its own `required` gate untouched, and re-sends that value under the
copy's `from_page_id`.

The duplicate gets a fresh `question_id`. Any clause inside the **cloned page's own**
`next_rules` that referenced the old id is rewritten to the new one — without that
the copy's rules silently branch on the original's question.

Rules on *other* pages keep pointing at the original, which is correct: they were
authored against that question.

## Testing

Every behaviour below must be mutation-checked: after the test passes, revert the
production change, confirm the test goes red, restore.

**Evaluator** — a table-driven test over every operator × every answer kind
(`string`, `number`, `boolean`, `string[]`, `""`, `[]`, `null`, `undefined`). The
load-bearing assertion is that **no operator returns `true` for an array answer
except `contains`**, and that `not_contains` returns false rather than true when the
answer is not an array. A test that only checked the fixed operators would leave the
next one free to regress.

**Editor** — the operator list for a selected question matches its `answerKind`; a
numeric operator stores a number, not a string.

**Sync** — the test described in Item 5: what each wired input type emits agrees with
its `answerKind`.

**`duplicatePage`** — the copy has a different `question_id`, and a clause inside its
cloned rules points at the new id, not the old one.

## Out of scope

- Substring matching on text (`matches` / `starts_with`) — a new operator, no demand
  yet.
- Date comparison operators — nothing wires `date_input` yet.
- The twelve input types SP4 left unwired; this sub-project changes what operators
  *mean*, not which types capture.
- Migrating existing published funnels. No stored rule has ever matched a real
  answer, so there is nothing to migrate.
