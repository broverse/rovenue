# SP4 — Funnel runner input capture (Phase 2, core subset)

Date: 2026-07-24
Status: approved (design)
Surfaces: `apps/api`, `apps/dashboard`

## Context

`apps/dashboard/src/runner/funnel-runner.tsx:11-12` states its own scope: "Phase 1
scope: click-through. The CTA fires `advance` with no answer; default-next routing
carries the user forward. Real input capture (text, choice, slider, etc.) lands in
Phase 2."

The follow-up ledger recorded this as blocking a smaller goal — the funnel-collected
email never reaches `PaymentStep`.

Investigation found the gap is **entirely client-side**. Everything server-side is
built and unused:

| Piece | State |
|---|---|
| `POST /public/funnel-sessions/:id/answers` — rate-limited, 16 KB payload cap, session-state gated, upsert semantics | shipped (`apps/api/src/routes/public/funnels.ts:362-399`) |
| `funnel_answers` table + `funnelAnswerRepo.upsert` / `listBySession` | shipped |
| `evaluateNext` branching on an answer map | shipped (`packages/shared/src/funnel/evaluator.ts`) |
| `POST /advance` reading answers and evaluating rules | shipped (`funnels.ts:403-455`) |
| `submitAnswer` client function | shipped (`apps/dashboard/src/runner/runner-api.ts:189`) — **no callers**; referenced only in test mocks |
| 26 page types, 17 of which capture input | shipped (`apps/dashboard/src/components/funnel-builder/types.ts:32-65`) |
| `PaymentStep`'s `collectedEmail` prop with ask-if-absent fallback | shipped (`payment-step.tsx:68-72`) |

So conditional branching already works the moment answers start being recorded —
`evalClause` looks up `answers.get(clause.question_id)`
(`evaluator.ts:100-101`). It is not separate work.

**Scope (owner decision): a core subset of five input types**, not all seventeen.
`email`, `text_input`/`short_text`, `single_choice`, `multi_choice`, `yes_no`. These
build the capture machinery and cover the most common funnel shapes; the remaining
twelve become independent follow-ups that reuse the same seam.

## Item 1 — `/advance` accepts the answer

The obvious client design — `POST /answers`, then `POST /advance` — was rejected
after review. It has two problems:

- **The ordering invariant is enforced by convention.** The server evaluates
  branching from its own answers table, so a client that advances before recording
  branches on the *previous* answer, silently and only on the first transition
  through each page. Nothing in the system prevents it.
- Two sequential round-trips double the delay between the CTA and the next page.

So `POST /public/funnel-sessions/:sessionId/advance` takes an optional answer:

```ts
z.object({
  from_page_id: z.string(),
  answer: z
    .object({ question_id: z.string(), answer: answerValueSchema })
    .optional(),
})
```

When present, the handler upserts it **before** reading the answer map, so the
evaluation always sees it. There is no order for the client to get wrong.

The existing `POST /answers` endpoint is left exactly as it is. It remains the way
to record an answer without advancing, and removing it would break a contract this
sub-project has no reason to touch.

The 16 KB payload cap and the session-state gate that `/answers` applies are applied
to the combined path too — same rule, same reason, and a cap enforced on one door
but not the other is not a cap.

**Not wrapped in a transaction.** The write and the subsequent read are sequential
awaits on the same pool, so the read sees the write. A transaction would additionally
make a *concurrent* advance for the same session atomic — a double-clicked CTA. That
race resolves benignly today (`evaluateNext` is deterministic given the same answers
and `setCurrentPage` is last-write-wins), so it is recorded here rather than fixed.

## Item 2 — `PagePreview` gains an explicit mode

`PagePreview` (`apps/dashboard/src/components/funnel-builder/page-preview.tsx`, 1006
lines) already serves two contexts through `editable` and `onAdvance`. It gains
`value` and `onAnswer`.

**Mode is an explicit parameter, not an inference.** An earlier draft said "inputs go
live when `onAnswer` is provided". That makes the builder canvas's inertness a side
effect of a callback being absent — if someone later passes `onAnswer` for an
unrelated reason, the builder's preview silently becomes interactive. A named
`mode: "preview" | "live"` states the intent where it can be read.

In `preview` mode every input keeps its current `readOnly` / local-state behaviour
byte for byte. The builder canvas must not change at all.

The change is surgical: five page types gain a live branch. This file is large and
shared; restructuring it is not in scope.

## Item 3 — the five types

| Page type | Answer value |
|---|---|
| `email` | `string` |
| `text_input`, `short_text` | `string` |
| `single_choice` | `string` (the chosen option's id) |
| `multi_choice` | `string[]` |
| `yes_no` | `string` (the chosen option's value) |

**Corrected during the final review.** `yes_no` was specified as a `boolean`,
on the reasoning that `"yes"`/`"no"` is presentation. That ignored the other side
of the comparison. `rule-editor.tsx:163-166` builds a clause operand from a
free-text input, so an authored operand is **always a string**, and `evalClause`'s
`eq` is strict equality (`a === clause.value`). A boolean answer could therefore
never match any rule an author is able to write — every yes/no branch would
silently fall through to `default_next`, which is exactly the pre-SP4 behaviour
this sub-project removes, wearing the appearance of working.

The seam was invisible to both per-type tests: one proved the value was captured,
the other proved it was sent. Neither looked at what the rule holds. A round-trip
test now feeds the captured value straight into the real `evaluateNext`.

All are inside what `answerValueSchema` accepts (`funnels.ts:54-61`: a recursive
union of scalars and arrays capped at 100 elements).

## Item 4 — `question_id` is required, not defaulted

`Page.question_id` is optional in the type (`types.ts:216`), but `blank-page.ts`
assigns one to **every** input page type — including the grouped cases
(`single_choice`/`multi_choice`, `short_text`/`text_input`). So a builder-authored
input page always has one.

An earlier draft fell back to `page.id` when it was absent. That is wrong: branching
keys on `question_id`, so such a row could never match a rule, and both answer
consumers (`funnel-claim.ts:357`, `dashboard/funnels.ts:685`) would surface a page id
under a column that means question id. A misleading row is worse than an absent one.

So the runner submits only when `question_id` is present. When it is absent — a
hand-edited config, or a future page type someone forgot to wire — it skips the
submission and logs. This is a defensive branch, not an expected path, and the spec
says so, so nobody later "fixes" it into a fallback.

## Item 5 — required answers gate the CTA

When `page.required` is set, the CTA stays disabled until an answer exists. This is
UX, not a security boundary: the server answers an unanswered `advance` with
`default_next`, which is defined behaviour rather than corruption. It is stated here
so a reviewer does not mistake the client-only check for a gap.

## Item 6 — the email reaches `PaymentStep`

`PaymentStep` already takes `collectedEmail` and asks for an address when it is
absent. The runner passes the answer belonging to the **last `email`-typed page in
page order** that has been answered.

The tie-break is stated because it is a real choice: a funnel may legitimately have
more than one email page, and "the last one in page order" is deterministic where
"the most recently answered" would depend on back-navigation. `contact_info`, which
also collects an email, is not in this subset and is not consulted.

## Testing

Every behaviour below must be mutation-checked: after the test passes, revert the
production change, confirm the test goes red, restore.

**The API** — route tests: an advance carrying an answer records it and evaluates
against it in one call; an advance without an answer behaves exactly as before; the
16 KB cap and the closed-session rejection apply to the combined path. The
branching case is the important one: a rule keyed on the submitted answer must route
to its rule target, and the test must fail if the write is moved after the read.

**The five types** — component tests that each captures its value in `live` mode, and
that each is unchanged in `preview` mode. The preview assertions matter as much as
the live ones: the builder canvas going interactive would be a regression nobody is
looking for.

**The runner** — the CTA sends the answer with the advance; a required page's CTA is
disabled until answered; the collected email reaches `PaymentStep`; and one
end-to-end case where an answer routes the session down a branch.

## Out of scope

- The other twelve input types (`number_input`, `date_input`, `slider`, `rating`,
  `phone`, `contact_info`, `picture_choice`, `legal`, `checkbox`, `opinion_scale`,
  `long_text`, plus any added later). Each reuses this seam.
- Back-navigation and answer editing after advancing.
- Client-side validation beyond required/not-required (email format, min/max).
- Restructuring `page-preview.tsx`.
