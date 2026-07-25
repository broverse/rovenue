# SP8 — Date comparison operators

Date: 2026-07-25
Status: approved (design)
Surfaces: `packages/shared`, `apps/dashboard`

## Context

SP6 wired `date_input`, so a funnel can finally record a date. It classified the answer
`answerKind: "text"` and deliberately stopped there: inventing ordered date comparison
before a date answer existed would have been speculative, and SP6 was a wiring project, not
a semantics one. The answer is an ISO-8601 calendar date (`YYYY-MM-DD`), taken straight from
the native `<input type="date">` value.

The consequence today is that a date question offers only `eq`, `neq`, `in`, `not_in`,
`is_answered` and `is_not_answered`. An author can ask "was the date exactly 2026-03-01?"
but not "was it before 2026-03-01?" — the obvious question to ask of a date. The numeric
comparisons cannot fill the gap: `evalClause` requires `typeof === "number"` on **both**
sides for `gt`/`gte`/`lt`/`lte`, so pointing them at a date string produces the
writable-but-dead rule SP5 spent a whole sub-project removing.

## The observation the whole design rests on

`YYYY-MM-DD` is fixed-width and zero-padded, so **lexicographic string order is
chronological order**. `"2026-03-01" < "2026-03-02"` is both true as text and true as dates.

That means the four ordered operators need no date parsing, no library, and no `Date`
object. It is not merely simpler — it is **more correct**. Parsing to a `Date` would attach
a time and a zone to a value that has neither; `new Date("2026-03-01")` is midnight UTC,
which is the previous day in every timezone west of Greenwich. Comparing calendar dates as
text is timezone-free by construction, and a calendar date is exactly what the input
produced.

**The load-bearing consequence:** the equivalence holds *only* for well-formed, zero-padded
input. `"2026-1-5"` sorts after `"2026-01-10"` as text (`"1"` > `"0"` at the fifth
character) and before it as a date. So validating both operands against
`^\d{4}-\d{2}-\d{2}$` is not defensive tidiness — it is the precondition that makes the
comparison mean anything. An operator that cannot compare returns `false`, never `true`,
exactly as SP5 established.

## Item 1 — four ordered operators

`CLAUSE_OPS` gains `before`, `after`, `on_or_before`, `on_or_after`.

They are dedicated operators rather than an extension of `gt`/`gte`/`lt`/`lte` to strings.
Two reasons:

- **The editor has to read right.** An author looking at a date question should see "is
  before", not "greater than". A comparison operator labelled `>` next to a date field reads
  as a bug even when it works.
- **No operator gets a second, type-dependent meaning.** SP5's spec refused exactly this
  when it declined to make `eq "a"` mean "contains a" for arrays: one operator with two
  meanings is the shape of the next silent surprise. Teaching `gt` to switch between numeric
  and lexicographic comparison based on what it was handed is the same trade.

Each returns `true` only when the answer and the operand are both well-formed ISO dates and
the comparison holds; `false` in every other case, including when either side is malformed,
absent, a number, or an array.

## Item 2 — no date `between`

A date range is expressed as two clauses under the existing `all` combinator:

```
on_or_after  2026-01-01
on_or_before 2026-03-31
```

The rule editor already supports multiple clauses per rule, so a range needs no new
operator. Adding one would mean either a fifth date operator or teaching `between` a second
operand type — the overloading Item 1 exists to avoid — to express something already
expressible. YAGNI.

## Item 3 — `date` becomes its own answer kind

`AnswerKind` gains `"date"`, and `PAGE_TYPES.date_input.answerKind` moves from `"text"` to
`"date"`.

```
date: eq, neq, in, not_in, before, after, on_or_before, on_or_after,
      is_answered, is_not_answered
```

**This list is purely additive against what `date_input` offers today.** `eq`, `neq`, `in`
and `not_in` are all kept deliberately, even though "is one of these three dates" is a
narrower use than ordered comparison. Dropping them would silently invalidate any rule
already authored against a date question since SP6 wired it: the rule editor clamps a clause
whose operator its question no longer offers, so an authored `in` rule would quietly become
something else. SP7 has just finished repairing one round of stored rules that a tightened
guard broke; there is no reason to create another.

`in`/`not_in` operands stay unvalidated as dates — they are a set-membership test over
strings, and `eq`-style equality does not depend on the lexicographic property. Only the four
ordered operators require the ISO shape, because only they compare.

## Item 4 — the operand input

For the four ordered operators the rule editor renders the operand as
`<input type="date">`, so the author picks a date rather than typing a string that has to
match a pattern they cannot see.

Two pieces of existing machinery need no change, recorded here so nobody "fixes" them:

- **`coerceOperandValue` already does the right thing.** Its `needsNumber` test is
  `NUMERIC_COMPARISONS.has(op) || (kind === "number" && (op === "eq" || op === "neq"))`.
  The new operators are not in `NUMERIC_COMPARISONS`, and the kind is `"date"`, not
  `"number"` — so the raw ISO string passes through untouched. Coercing a date operand to a
  number would produce `NaN`, then `null` on serialisation, then a clause that never fires.
- **`operandShape` already returns `"scalar"`** for anything that is not unary, array or
  range, and `defaultOperand` gives `""` for a scalar. Both are correct for a date field.

What *does* need adding is a label per operator in `rule-editor.tsx`'s `OPERATORS` table.
Omitting one is not a silent bug: `RENDERABLE_OPS` is derived from that table and a test
already proves every operator `OPERATORS_BY_KIND` offers has a renderable label. That test
is the tripwire SP5 built after `not_contains` shipped unselectable, and it will fire here.

## Item 5 — the schema validates the ordered operands

`branching-schema.ts`'s `superRefine` gains a branch: for `before`, `after`, `on_or_before`
and `on_or_after`, the operand must be a string matching `^\d{4}-\d{2}-\d{2}$`.

This is the same reasoning the existing operand guards use — a value that validates at the
boundary and then silently never fires is the defect class this codebase keeps paying for —
with one lesson applied from SP7: the guard is **additive for a brand-new operator**, so it
cannot invalidate stored data. No funnel can contain a `before` clause before this
sub-project ships. That is why the numeric guard needed a repair migration and this one does
not.

Validating the *calendar validity* of the date (rejecting `2026-02-31`) is deliberately not
attempted. The pattern is what the comparison needs; a real-but-impossible date compares
consistently and harmlessly, and a regex that also enforces month lengths is a liability.

## Testing

Every behaviour is mutation-checked: after the test passes, revert the production change by
hand, confirm the test goes red, restore. Hand-edit only — `git checkout`/`git stash` has
destroyed uncommitted work on this project.

**Evaluator** — a table over all four operators asserting **both directions** for each, and
these cases, which are the ones that matter:

- The malformed-operand case, which is the whole reason validation exists: an answer of
  `"2026-01-10"` against `before "2026-1-5"` must be `false`. Naive lexicographic comparison
  would return `true`, and the rule would fire on the wrong side of a date the author
  intended. Both the malformed-**operand** and malformed-**answer** directions get a case.
- Boundary behaviour: for equal dates, `before`/`after` are false and
  `on_or_before`/`on_or_after` are true. This is where an off-by-one in the comparison
  operator hides.
- A number, an array, `null` and `undefined` as the answer all return `false` for all four —
  the SP5 rule that an operator which cannot compare must not answer `true` by accident.

**Schema** — the four operators reject a non-ISO operand and accept an ISO one. Two-sided,
because a guard tested in one direction only is how SP5's `not_in` bug survived 45 tests.

**Editor** — the `date` kind offers exactly the ten operators listed above; every one has a
renderable label (the existing cross-table test covers this once the labels are added); the
operand input for an ordered operator is a date input.

**Sync** — `date_input` moves to the `date` kind. Note that the existing sync test would keep
passing untouched, because its kind→shape mapping sends anything that is not `multi` or
`number` to "expect a string", and a date *is* a string. That is under-testing: the kind
would be verified no more strictly than plain text. The test gains an assertion that a `date`
kind emits a value matching the ISO pattern, so the classification is actually pinned.

## Out of scope

- **Relative dates** ("in the last 30 days", "older than 30 days"). These need a reference
  "now", and that value differs between the client evaluating a rule mid-funnel and the
  server evaluating it on advance — so the same rule could route two ways depending on where
  it ran. Choosing where the reference instant comes from, what timezone bounds a "day", and
  how that interacts with a cached funnel version are real design decisions that deserve their
  own cycle. Recorded here so the next person does not re-derive the problem.
- **A date `between` operator** — see Item 2.
- **Times and datetimes.** `date_input` collects a calendar date; there is no time to compare
  and no input that produces one.
- **Calendar validation** of impossible dates — see Item 5.
- **Changing what any existing operator means.** SP8 only adds.
