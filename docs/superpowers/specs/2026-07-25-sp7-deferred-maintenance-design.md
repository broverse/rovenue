# SP7 — Deferred maintenance: closing SP5/SP6's carried-forward items

Date: 2026-07-25
Status: approved (design)
Surfaces: `packages/db`, `packages/shared`, `apps/api` (tests), `apps/dashboard`

## Context

SP5 (branching semantics) and SP6 (wiring the ten input types) each closed with a short
list of items deferred by decision rather than by oversight. This sub-project finishes
them.

Every item below was **re-verified against source before planning**, and three of the four
turned out materially different from how the ledger recorded them. That is the pattern this
whole programme runs on, so the corrections are recorded inline rather than smoothed over.

| # | Item | As recorded | As verified |
|---|---|---|---|
| 1 | stored `contains` operands (M-8) | "unknown, needs a DB query" | **misdirected** — the real breakage is the *numeric* guard, and it blocks publish |
| 2 | legacy `Operator`/`RuleClause`/`Rule` | "still consumed, schedule properly" | **fully dead**; the two apparent consumers are unrelated same-named local types |
| 3 | `funnel-advance-answer` flake | "root cause not diagnosed" | **diagnosed** — per-request re-import of the whole app graph |
| 4 | `duplicatePage` has no caller | accurate | accurate, **and `removePage` has none either** |

---

## Item 1 — Pre-SP5 numeric operands block publish

### The inversion

The carried item asked whether any stored funnel holds a non-string `contains` operand.
Checking it surfaced that the question points at the wrong guard.

SP5's fix wave (`9d4a9d2f`) added two operand guards to `branching-schema.ts`:

- `contains` / `not_contains` must be a **string**. The rule editor's operand input has
  only ever produced strings, so for editor-authored data this guard is a **no-op** — it
  cannot reject anything the editor wrote. M-8 as framed is a non-issue for that data.
- `gt` / `gte` / `lt` / `lte` must be a **number**. But the defect SP5 existed to fix was
  precisely that **the editor always wrote these operands as strings** (spec defect B). So
  *every* numeric comparison rule authored before SP5 holds a string.

`pagesArraySchema.safeParse(funnel.draftPagesJson)` runs on the **publish** path over the
**stored** draft (`apps/api/src/routes/dashboard/funnels.ts:338`) — not over a request
body. Therefore any funnel authored before SP5 that contains a numeric comparison rule now
**fails to publish**, with an opaque `FUNNEL_VALIDATION` payload of raw Zod issues.

Those rules never fired (a string operand could never satisfy `typeof value === "number"`),
so the funnel's routing was already wrong. SP5 made it additionally unpublishable. That is
a regression the whole-branch review did not consider, because it only asked about
`contains`.

`between` is a narrower case: the old editor already coerced its bounds with `Number(...)`,
so stored values are usually numbers. The fix wave additionally required **both elements**
to be numbers, so a stored `[null, null]` — what a `NaN` bound serialises to — now fails.
Real but rare.

One caveat that keeps the audit honest: pages can also be written straight through the
draft-PATCH endpoint as JSON, not only by the editor. So a non-string `contains` operand is
possible in principle even though the editor cannot produce one. The audit therefore checks
**every** operand class, not just the numeric ones.

### Why a local check cannot answer this

Run against the local dev database, the audit returns zero rows — out of **2 funnels, 4
pages and 0 clauses**. A zero over an empty denominator is not evidence. This is a
production data question, so the deliverable is a **repeatable script an operator can point
at any environment**, not a one-off answer pasted into a ledger.

### Deliverables

**1. An audit script** — `packages/db/scripts/audit-funnel-clause-operands.ts`, registered
as `db:audit:funnel-operands`, following the existing operational-script pattern
(`db:verify:clickhouse`, `db:partition:migrate`). Read-only. It flattens every clause from
**both** rule stores (`funnels.draft_pages_json` and `funnel_versions.pages_json`), groups
offenders by `(source, op, json type)`, and — critically — **always prints the denominator**
(total funnels, pages, clauses). A run that reports "0 offenders out of 0 clauses" must be
visibly different from "0 offenders out of 4 000 clauses"; the first says nothing.

**2. A data migration** — `0095_coerce_funnel_numeric_operands.sql`. It rewrites
`{op:"gt", value:"5"}` to `{op:"gt", value:5}` in both stores, for
`gt`/`gte`/`lt`/`lte` and for `between`'s elements.

Decision taken: **coerce**, not drop. The rule then does what its author wrote, and publish
unblocks. The consequence is named rather than buried: a rule that never fired **starts
firing**, so a live funnel's routing changes — toward the authored intent.

The migration coerces **only** strings that are finite numbers. A non-numeric operand
(`"abc"`, `null`) is left exactly as it is and **not** dropped — guessing at intent is worse
than leaving a row for the audit to report. Such a funnel still fails publish, which is
correct: nobody can know what it meant.

It is a versioned SQL migration rather than a hand-run script so that it actually executes
in production through the existing `migrate` compose service. Because it rewrites nested
JSONB, it is covered by an integration test on real Postgres (the repo's
`*.integration.test.ts` + testcontainers pattern), not by unit assertions over a mock.

---

## Item 2 — Delete the third operator vocabulary

`apps/dashboard/src/components/funnel-builder/types.ts` still exports a parallel rule
vocabulary that predates the real one:

```ts
export type Operator = "equals" | "not_equals" | ">" | ">=" | "<" | "<="
  | "between" | "is_one_of" | "not_one_of" | "contains" | "is_answered" | "not_answered";
export type RuleClause = { qid: string; op: Operator; value: … };
export type Rule = { id: string; combinator: "all" | "any"; clauses: RuleClause[]; goto: string };
```

Every name differs from the shipping model: `"equals"` vs `ClauseOp`'s `"eq"`,
`"not_answered"` vs `"is_not_answered"`, `qid` vs `question_id`, `combinator` vs
`condition.op`. SP5 spent a CRITICAL finding on exactly this failure — two operator tables
drifting apart — and this is a third one in the same module.

**Verified dead.** The fix wave left these in place believing they were still consumed. They
are not: the only `Operator` reference outside the declaration is a **locally-declared,
unrelated** `Operator` in `components/queries/visual-builder.tsx` (SQL filter operators
`=`, `!=`, `LIKE`), and the only `Rule[]` reference is feature-flags' own `Rule` from
`./types`. `RuleClause` has no references at all.

`Rule` survives only through `Funnel.rules: Record<string, Rule[]>` (`types.ts:346`). Five
sites write `rules: {}` to satisfy that field and **nothing reads it** — the view model
keeps rules separately in `this.rules: Record<string, NextRule[]>`.

**Fix:** delete `Operator`, `RuleClause` and `Rule`; retype `Funnel.rules` to
`Record<string, NextRule[]>`, the type the application actually uses. The five `rules: {}`
sites keep compiling, since `{}` satisfies a `Record`. No behavioural change — the value is
never read — but the drift is gone and the field no longer lies about its own shape.

---

## Item 3 — The `funnel-advance-answer` flake, diagnosed

The ledger recorded this as reproduced-away twice and never diagnosed. The mechanism:

```ts
beforeEach(() => { vi.resetModules(); … })            // drops the module registry
async function advance(body, sessionId) {
  const { createApp } = await import("../src/app");    // …so this re-imports EVERYTHING
  const app = createApp();
  return app.request(…);
}
```

`vi.resetModules()` empties the module registry, and the dynamic `import("../src/app")`
lives **inside the per-request helper** — so the entire Hono app graph (every route, every
service) is re-evaluated on **each request**, not once per file. Under the machine load of a
concurrent suite that import exceeds the default 5 000 ms `testTimeout`.

The second, cascading failure follows from the first: when the timeout fires mid-`await`,
the orphaned `upsertMock` call completes *after* the next test's `beforeEach` has already
cleared `answerRows`, so its write lands in the following test and breaks that test's
"not called" assertion. One slow import, two red tests.

**Fix direction:** remove the per-request re-import. First establish whether
`vi.resetModules()` is load-bearing at all — every mock in this file is already explicitly
`mockReset()` in `beforeEach`, which is the usual reason to reach for it. If it is genuinely
needed (a module-level cache in the app graph, e.g. the frozen-env pattern this repo has
elsewhere), then import once per **test** instead of once per **request**.

**Explicitly not the fix:** raising `testTimeout`. That hides the cost and leaves the
orphaned-write cascade armed. The fix must be proved by measurement — the import count or
the file's wall-clock — not by re-running until green, which is how this item survived two
prior passes.

---

## Item 4 — Wire the duplicate-page action

`duplicatePage` is correct, tested and mutation-checked (SP5 Tasks 3 + the `43fe50be`
follow-up), and unreachable: no caller anywhere in `apps/` or `packages/`.

**New finding:** `removePage` has no caller either. The thumb-rail has **no per-page actions
at all** — each page row is a single `<button>` whose only job is `vm.selectPage(p.id)`. So
this is not "add a button next to delete"; it introduces the first per-page action
affordance in the builder.

**Implementation constraint.** The row is a `<button>`, and a button cannot contain another
button — nesting them is invalid HTML and breaks both keyboard semantics and the click
target. The action must be a **sibling** of the row button, absolutely positioned inside a
shared `relative group` wrapper and revealed on hover/focus. The row already carries
`group relative`, so the pattern is the one the file was written for.

Accessibility: the action button needs its own accessible name (the row's `title` describes
the page, not the action), must be reachable by keyboard rather than hover only, and must
`stopPropagation` so duplicating does not also re-select through the row beneath it.

**Scope: duplicate only.** `removePage` is the natural next occupant of the same affordance,
but deletion is destructive and needs its own confirmation design. It is flagged here, not
built — expanding scope to it silently is how a maintenance batch turns into a redesign.

---

## Testing

Every item is mutation-checked: after the test passes, revert the production change by hand,
confirm the test goes red, restore. Hand-edit only — `git checkout`/`git stash` has
destroyed uncommitted work on this project.

- **Item 1** — an integration test on real Postgres (testcontainers): seed a funnel whose
  draft holds `{op:"gt", value:"5"}`, a `between` with string bounds, a **non-numeric**
  `gt` operand, and a valid clause; run the migration; assert the first two are coerced to
  numbers, the non-numeric one is untouched, and the valid clause is byte-identical.
  Then assert the coerced draft **passes `pagesArraySchema`** and the pre-migration one
  fails — that is the whole point of the item, and it is the assertion that would catch a
  migration that "ran" without fixing publishability.
- **Item 2** — `tsc --noEmit` is the real gate (deleting a still-referenced type fails the
  build). Plus a grep-level check in the plan that the deleted names appear nowhere.
- **Item 3** — the fix is proved by a measurement recorded in the report, and by the file
  passing when run **concurrently with the dashboard suite**, which is the condition that
  produced the original failure. A green solo run is not evidence.
- **Item 4** — a test that renders the thumb-rail, activates the duplicate action, and
  asserts `duplicatePage` ran (page count grew and the copy has its own `question_id`), plus
  an assertion that activating it does **not** leave the row's select handler mis-firing.

## Out of scope

- **Date comparison operators** — needs a `date` `AnswerKind` plus new evaluator, schema and
  editor support. Its own sub-project.
- **`contact_info` composite answers** — needs a new answer shape outside `AnswerValue`. Its
  own sub-project.
- **Wiring `removePage`** — see Item 4.
- Changing what any operator *means*. SP7 repairs data and removes dead code; it does not
  revisit semantics.
