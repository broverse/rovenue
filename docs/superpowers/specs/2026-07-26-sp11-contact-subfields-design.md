# SP11 — Branching on a `contact_info` sub-field

Date: 2026-07-26
Status: approved (design)
Surfaces: `packages/shared`, `apps/dashboard`

## Context

SP9 made `contact_info` capture its answer as a `ContactAnswer` object and gave it
`answerKind: "composite"`, offering only `is_answered` / `is_not_answered`. Sub-field
branching was deferred with two reasons: marginal value, and that dotted `question_id`s
"risk colliding with a real question id containing a dot".

**The collision risk is measurable, and it is gone.** `qid()` is
`` `${prefix}_${createId().slice(0, 6)}` `` — a cuid2 slice, which is base36 alphanumeric.
No generated question id can contain a dot, and no prefix in `blank-page.ts` contains one
either. So `.` can be reserved as the sub-field separator, and the one remaining way a dot
could appear in a real id — hand- or API-authored JSON — is closed by validating it at the
schema boundary.

That leaves the value question, on which the earlier judgement stands only partly: branching
on a *name* is rarely useful, but "is the email a gmail address", "did they give a phone
number at all" are ordinary funnel questions. The data is already stored; this exposes it.

## Item 1 — addressing, and the reservation that makes it unambiguous

A clause may address a sub-field as `<question_id>.<field>`:

```
q_c.email    → the ContactAnswer stored under q_c, its `email` key
q_c.name
q_c.phone
```

`evalClause` resolves a clause's `question_id` by: if it contains a dot, split on the **first**
dot, look the base up in the answer map, require the value to be a `ContactAnswer`, and take
the named field. The field name must be one of `name` / `email` / `phone`; anything else
resolves to `undefined`, i.e. unanswered.

Splitting on the **first** dot, not the last, is deliberate and testable: it means a base id
can never be silently reinterpreted, because base ids cannot contain dots at all.

**The reservation is enforced, not assumed.** `pages-schema.ts` gains a rule that a page's own
`question_id` must not contain a dot. Without it the reservation is a convention that stored
JSON can violate, and a page id of `q.c` would make `q.c.email` ambiguous. With it, the grammar
is unambiguous by construction — which is the difference between a design and a hope.

## Item 2 — a sub-field answers like text

A resolved sub-field is a plain string, so it behaves exactly as an `email` or `phone` page's
answer does: `eq`, `neq`, `in`, `not_in`, `is_answered`, `is_not_answered`. No new operator, no
new kind at the evaluator level — the existing text operators simply receive a string.

`is_answered` on a sub-field means *that field* is non-empty, which is narrower than
`is_answered` on the composite (every asked-for field filled). Both are useful and both are
now expressible, which is the point. The distinction is documented at `isAnswered`'s call
site rather than left for someone to discover.

## Item 3 — the editor offers sub-fields as their own questions

The rule editor's question list currently offers one entry per page with a `question_id`. A
`contact_info` page instead contributes **one entry per field it asks for**, labelled so an
author can tell them apart, plus the composite itself for the "gave their details" question.

The list is derived from the page's `collect*` flags — the same `asksFor` logic the renderer
uses, so the editor cannot offer a field the page does not collect. That helper moves to a
shared module rather than being reimplemented, because two definitions of "which fields does
this page ask for" is the drift class this programme keeps paying for.

Each sub-field entry reports `answerKind: "text"`, so `OPERATORS_BY_KIND` needs no new row and
the operand renders as a normal text input.

## Item 4 — what this does not change

- **The stored answer shape is unchanged.** A `ContactAnswer` object under one question id, as
  SP9 defined. Sub-fields are an *addressing* feature over existing data, so **no migration**
  and nothing to backfill.
- **`is_answered` on the composite keeps its meaning** — every asked-for field filled. This
  adds a narrower question; it does not redefine the existing one.
- **No API change.** The clause's `question_id` is already a string.

## Testing

Every behaviour mutation-checked: after the test passes, revert by hand, confirm red, restore.

- **Resolution:** `q_c.email` against a stored `{name, email}` returns the email; a field the
  page did not ask for resolves unanswered; an unknown field name (`q_c.nope`) resolves
  unanswered rather than throwing.
- **The base is not a composite:** `q_text.email`, where `q_text` holds a plain string, must
  resolve unanswered — not crash, and not silently index into a string.
- **First-dot splitting:** a clause id with two dots (`q_c.email.x`) resolves unanswered rather
  than being reinterpreted; this is the assertion that pins *first* over *last*.
- **The reservation is enforced:** `pages-schema` rejects a page whose `question_id` contains a
  dot, two-sided. This is the guard that makes the grammar unambiguous, so it gets its own
  test rather than being implied by the resolution tests.
- **Text operators fire on a sub-field:** `eq`, `neq`, `in`, `not_in` against a resolved
  string, and `is_answered` distinguishing a filled field from a blank one.
- **The composite's `is_answered` still means all-asked-for-fields** — a regression guard, since
  the narrower sub-field version arriving alongside it is exactly when the two could be
  conflated.
- **The editor offers exactly the fields the page asks for** — driven by the shared `asksFor`,
  with a case proving a page that does not collect phone offers no `phone` sub-field.

## Out of scope

- **Sub-fields on any other page type.** `contact_info` is the only composite answer.
- **Format validation** of an email or phone operand — SP9 declined it for the answer and the
  same reasoning holds for the operand.
- **Nested addressing beyond one level.** There is nothing nested to reach.
- **Changing what any existing operator means.**
