# SP9 — `contact_info`: make the page work, and record what it collects

Date: 2026-07-25
Status: approved (design)
Surfaces: `packages/shared`, `apps/dashboard`

## Context, and a correction to how this was recorded

SP6 wired ten input types and deferred `contact_info` with the reason: "it collects
name/email/phone as one page, so its answer is composite and does not fit `AnswerValue`. It
needs a new answer shape, a new `AnswerKind`, and evaluator support for addressing
sub-fields." That framing treats it as a **branching** feature.

Reading the code says otherwise. `ContactInfoFields` renders three bare `TextField`s and
passes them **no live props at all** — no `live`, no `value`, no `onChange`. `TextField`
defaults `live = false` and renders `readOnly={!live}`, so in the runner every field is
read-only.

Verified rather than reasoned: rendering a `contact_info` page with
`mode="live"` produces **three fields, all three carrying `readonly`**.

So this is not a missing branching capability. **A published `contact_info` page shows a
visitor three fields they cannot type into.** That is a broken page, and it is a worse defect
than the class SP6 fixed: SP6's unwired inputs at least responded to interaction through
local state, so the visitor believed they had answered. These do not accept input at all.

A second consequence, currently masked: the runner's `collectedEmail` — which pre-fills the
payment step — deliberately skips `contact_info` with the comment "contact_info also collects
an email but is not among the wired types". A funnel that collects email *only* through a
contact page therefore reaches checkout with an empty email field.

SP9's job is to make the page work. Branching is a deliberately small part of it.

## Decisions taken

- **Capture plus `is_answered`.** The page becomes editable, records its value, honours
  `required`, and offers exactly `is_answered` / `is_not_answered`. No sub-field addressing,
  no dotted `question_id`s. Ordered or equality comparison on a name is rarely useful, and
  dotted ids would risk colliding with a real question id containing a dot.
- **`collectedEmail` starts using the contact page's email.** The comment excluding it names
  the wiring gap as the reason, and that reason disappears here. This is a live behaviour
  change, stated plainly: a funnel collecting email only via `contact_info` will now arrive
  at checkout pre-filled where it previously arrived empty. That is the intent of the field.

## Item 1 — the answer shape

`AnswerValue` gains one object member:

```ts
/** A `contact_info` page's answer. A key is present for each field the page
 *  ASKS for, so the key set records what was requested and the values record
 *  what was given. That is what lets one definition of "answered" serve both
 *  the runner and the evaluator — see Item 2. */
export type ContactAnswer = {
  name?: string;
  email?: string;
  phone?: string;
};

export type AnswerValue = string | number | boolean | string[] | null | ContactAnswer;
```

`AnswerValue` has only three consumers (`evaluator.ts`, `funnel-runner.tsx`,
`page-preview.tsx`), so the widening is contained.

Two layers need **no change at all**, which is why this item is small:

- **The API already accepts it.** `apps/api/src/routes/public/funnels.ts`'s
  `answerValueSchema` is a bounded recursive schema that already permits records
  (`z.record(z.string().max(100), answerValueSchema)`). An object answer validates today.
- **Storage already fits.** `funnel_answers.answer_json` is `jsonb`, so an object round-trips
  natively. **No migration.**

## Item 2 — one definition of "answered", not two

This is the part that needs care, because the obvious implementation recreates a defect SP5
spent effort removing.

The evaluator computes `answered` inline in `evalClause`; the runner computes its own gate in
`funnel-runner.tsx`. SP5 aligned the two by hand so both treat `undefined`, `null`, `""` and
`[]` as unanswered. A composite answer breaks that alignment in a new way: an object with
all fields blank is neither `null` nor `""` nor an empty array, so **both** current
implementations would call it answered.

The asymmetry that makes this hard: the **runner** knows which fields the page asked for
(`collectName` / `collectEmail` / `collectPhone`), while the **evaluator** sees only the
value. Defining "answered" in terms of the page's flags would therefore give the two layers
different definitions again — exactly SP5's "two definitions one hop apart".

**Resolution: let the value carry the question.** The component emits a key for **each field
the page asks for** and only those, with the empty string as its blank value. Then

> a composite is answered when it has at least one key and **every** key holds a non-empty
> value

is computable from the value alone. No page flags reach the evaluator, and both layers can
agree by construction.

To make that agreement structural rather than a coincidence maintained by hand,
**`isAnswered(value: AnswerValue): boolean` is extracted into `@rovenue/shared/funnel` and
both callers use it** — the evaluator replaces its inline `answered` const, and the runner
replaces its duplicated four-way test. The scalar behaviour is preserved exactly as SP5
defined it; the composite branch is added in the one place that now exists.

This removes the duplication that made the divergence possible, rather than aligning a third
copy by hand.

Note what the key-set rule gives for free: a page that asks only for an email is answered as
soon as the email is filled, while a page that also asks for a phone is not — without the
evaluator knowing anything about either page.

## Item 3 — the fields become editable and record their value

`ContactInfoFields` adopts the same `{ live, value, onChange }` contract the other wired
components use, and its three `TextField`s receive per-field live props derived from the
composite value.

- In live mode each field is editable and reports through `onChange`, which emits the **whole
  object** — one `onAnswer` call per keystroke, carrying the other fields unchanged. The
  runner's `onAnswer` signature is unchanged.
- In preview mode the fields stay read-only exactly as today, so the builder canvas does not
  become interactive.
- Keys are present for asked-for fields only, per Item 2. The flag semantics already differ
  per field and must be preserved: `collectName` and `collectEmail` default to **on**
  (`!== false`), while `collectPhone` defaults to **off** (truthy check).

## Item 4 — `answerKind: "composite"`

`AnswerKind` gains `"composite"`; `PAGE_TYPES.contact_info` moves from `"none"` to it.

```
composite: is_answered, is_not_answered
```

Nothing else is offered, because nothing else can fire: every comparison operator refuses a
non-scalar, and adding a sub-field vocabulary is out of scope.

Two existing tripwires will now cover this kind automatically, which is the point of having
built them:

- The derived "every answering kind offers the unary operators" loop in `answer-kind.test.ts`
  reads its kinds off `OPERATORS_BY_KIND`, so `composite` is included the moment it is added.
- The sync test's coverage assertion requires every non-`none` page type to be in `WIRED` or
  `NOT_WIRED_YET`, so reclassifying `contact_info` forces it into the wired table. Its
  kind→shape mapping needs a `composite` branch asserting an object whose values are strings;
  without one it would fall into the "expect a string" default and fail for the right reason
  but with a confusing message.

## Item 5 — `collectedEmail` reads the contact page's email

`funnel-runner.tsx`'s `collectedEmail` currently scans `email`-type pages only. It gains
`contact_info` pages, reading the `email` key from the composite answer.

The existing tie-break is kept and its reasoning still holds: **last in page order**, not
most-recently-answered, because a funnel may legitimately contain more than one email source
and page order is deterministic where answer recency depends on back-navigation. A
`contact_info` page participates in that same ordering rather than getting a separate
precedence rule.

The comment that excludes `contact_info` is removed rather than reworded — leaving a stale
justification in place is how the next reader concludes the exclusion was deliberate.

## Out of scope

- **Sub-field branching** (`q_c.email` and friends). Decided against: marginal value, and
  dotted ids risk colliding with a real question id containing a dot. If it is ever wanted,
  the composite value already holds the data, so it is additive later.
- **Validating the email or phone format.** `contact_info` is a collection page; the payment
  step does its own validation where it matters. Adding format rules here would reject
  visitors on a page whose job is to gather what they type.
- **Splitting `contact_info` into three pages at authoring time.** It exists as one page
  deliberately; this is not a migration project.
- **Changing what any existing operator means.**

## Testing

Every behaviour is mutation-checked: after the test passes, revert the production change by
hand, confirm the test goes red, restore. Hand-edit only — `git checkout`/`git stash` has
destroyed uncommitted work on this project.

- **The defect itself, first.** A test that renders `contact_info` with `mode="live"` and
  asserts the fields are **not** read-only, and that typing emits. Written before the fix so
  it reproduces the broken page rather than describing the repair.
- **`isAnswered`** — a table over every `AnswerValue` shape, asserting the scalar results are
  byte-for-byte what SP5 defined (`undefined`, `null`, `""`, `[]` unanswered; `0` and `false`
  answered) plus the composite rules: `{}` unanswered, `{email:""}` unanswered,
  `{email:"a"}` answered, `{email:"a", phone:""}` unanswered. That last case is the one that
  distinguishes the key-set rule from "any field filled".
- **Both callers use the shared helper.** A test that the runner's gate and the evaluator
  agree on a composite — the divergence this item exists to prevent. Asserting them
  separately would pass even if the two definitions drifted apart again.
- **Preview mode stays inert** — a `contact_info` page in `mode="preview"` keeps its fields
  read-only even when `onAnswer` is passed, matching the existing tests for the other types.
- **`collectedEmail`** picks up a contact page's email, and the last-in-page-order tie-break
  still holds when both an `email` page and a `contact_info` page are present.
