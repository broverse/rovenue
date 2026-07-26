# SP10 — Relative date operators

Date: 2026-07-26
Status: approved (design)
Surfaces: `packages/shared`, `apps/api`, `apps/dashboard`

## Context, and the premise that turned out wrong

SP8 shipped fixed date comparison (`before` / `after` / `on_or_before` / `on_or_after`) and
deferred relative dates with this reasoning:

> These need a reference "now", and that value differs between the client evaluating a rule
> mid-funnel and the server evaluating it on advance — so the same rule could route two ways
> depending on where it ran.

**That premise is false.** The real runner does not evaluate anything: `funnel-runner.tsx`
contains zero calls to `evaluateNext`. Real routing goes through `/advance` →
`apps/api/src/routes/public/funnels.ts:484`, server-side only. The one client-side caller,
`vm/funnel-preview.vm.ts`, is the **builder's** play-through preview.

So there is no client/server divergence for a real visitor. "Now" is the server's, full stop,
and the hazard that deferred this work does not exist.

## Item 1 — `today` is injected, never read from a clock inside the evaluator

`EvalInput` gains `today?: string`, an ISO `YYYY-MM-DD` calendar date. The server passes its
own UTC date; the builder preview passes the browser's UTC date, which is acceptable *because
it is a preview* and is documented as such at that call site.

The evaluator never calls `new Date()` itself. A pure evaluator is testable without freezing
clocks, and it keeps "which clock decided this route" a property of the caller rather than a
hidden global.

**When `today` is absent, the relative operators return `false`** — the same rule SP8
established: an operator that cannot compare must not answer `true` by accident. That matters
because it is the behaviour any caller that forgets to pass `today` will get, and a silent
`false` routes to `default_next`, which is defined.

## Item 2 — two operators, inclusive, with no overlap and no gap

`CLAUSE_OPS` gains `within_last_days` and `more_than_days_ago`. The operand is a **count of
days**, a non-negative integer — not a date.

With `today = 2026-07-26` and an operand of `30`:

| Operator | Matches | Range |
|---|---|---|
| `within_last_days` | `answer >= today - 30 && answer <= today` | `2026-06-26` … `2026-07-26`, both ends inclusive |
| `more_than_days_ago` | `answer < today - 30` | before `2026-06-26` |

The two are deliberately complementary over past dates: no date is matched by both, and no
past date is matched by neither. `within_last_days 0` means "today only".

**A future date matches neither**, because `within_last_days` caps at `today` and
`more_than_days_ago` requires being older than the cutoff. That is stated rather than left to
be discovered: a funnel asking for a future appointment date will find both operators silent.
Future-facing operators were considered and left out — the request is the past direction, and
four operators with four more boundary cases is not justified by a use nobody has asked for.

## Item 3 — why this parses dates when SP8 forbade it

SP8's rule was: never parse to `Date`, because comparing two zero-padded ISO strings as text
is exact and parsing would attach a time and a zone to a value that has neither.

That rule holds for **comparison**, and it still governs `before`/`after`. But this
sub-project must **compute** a date — `today` minus N days — and arithmetic on calendar dates
cannot be done lexicographically. So `Date.UTC` is used, and it is correct here for the same
reason parsing was wrong there: both inputs are UTC-anchored and no local zone enters the
calculation.

Both directions are worth guarding in comments, because either one "fixed" to match the other
would be a defect: do not make `before` parse, and do not try to subtract days with string
operations.

The subtraction lives in one exported helper so there is a single place to reason about
month-end and leap years, and one place to test them.

## Item 4 — the operand is validated as a day count

`branching-schema.ts` gains a branch: for both operators the operand must be a number that is
a **non-negative integer**. A fractional or negative day count has no meaning, and left
unvalidated it would produce a cutoff date nobody intended rather than an error.

This guard is additive for brand-new operators, so — unlike SP5's numeric guard — **no stored
funnel can hold such a clause and no migration is needed.**

## Item 5 — the editor offers them on a date question, with a number input

`OPERATORS_BY_KIND.date` gains both operators. Additive again: nothing is removed, so no rule
authored since SP8 is silently clamped.

The operand renders as a **number** input, not a date picker. Concretely that means the two
operators join `NUMERIC_COMPARISONS` in `coerce-operand.ts` — so the operand is stored as a
number rather than the string `"30"`, which would never satisfy the evaluator — and must
**not** join `DATE_COMPARISONS` in `rule-editor.tsx`, which is what selects `type="date"`.
Those two sets now differ, and that is the point rather than an oversight.

Labels read as an author would say them: "in the last N days" and "more than N days ago".

## The UTC caveat, stated plainly

"Today" is the server's UTC calendar date. For a visitor in UTC-8 at 18:00 local, UTC has
already rolled over, so a rule reading "today only" (`within_last_days 0`) will not match the
date they would call today. This is a known, accepted cost of the simplest deterministic
option; the alternatives were a client-supplied date (an untrusted input that makes rule
outcomes depend on the visitor's clock) and a per-project timezone setting (a new field, a
migration and dashboard UI).

It is recorded here so that if it ever bites, the next person finds the decision rather than
re-deriving the trade-off.

## Testing

Every behaviour mutation-checked: after the test passes, revert the production change by hand,
confirm red, restore. Hand-edit only.

- **Boundary cases are the whole risk.** For `within_last_days 30` with `today` fixed: the
  cutoff date itself matches, the day before it does not, `today` matches, and tomorrow does
  not. The mirror set for `more_than_days_ago`. `within_last_days 0` matches only `today`.
- **The two are complementary:** a table of dates across the boundary asserting that exactly
  one of the two operators fires for every past date, and neither fires for a future one.
- **Date arithmetic across a month and year boundary and a leap day** — the reason the
  subtraction is one tested helper rather than inline arithmetic.
- **`today` absent → both operators false**, for a filled, well-formed answer. This is the
  forgot-to-pass-it case.
- **A malformed or non-date answer → false**, reusing SP8's `ISO_DATE_RE` guard.
- **The operand guard is two-sided:** a non-negative integer accepted; a fraction, a negative,
  and a non-number rejected.
- **The server passes `today`.** A test at the `/advance` layer that a relative rule actually
  fires there, because the injection is exactly the sort of wiring that is easy to declare and
  forget — this programme has already shipped two "built but unwired" features.

## Out of scope

- **Future-facing operators** — see Item 2.
- **Per-project or visitor timezones** — see the caveat.
- **Times of day.** `date_input` collects a calendar date; there is no time to be relative to.
- **Changing what any existing operator means.**
