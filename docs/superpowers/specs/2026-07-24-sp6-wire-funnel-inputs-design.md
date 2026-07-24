# SP6 — Wire the ten unwired funnel input types

Date: 2026-07-24
Status: approved (design)
Surfaces: `apps/dashboard` (funnel builder + runner)

## Context

SP4 made the funnel runner record answers. SP5 made branching rules mean what they
say. Both assumed the input components actually emit an answer. Ten of the sixteen
input types do not.

`apps/dashboard/src/components/funnel-builder/page-preview.tsx` renders every funnel
page. Three input components (`YesNoButtons`, `ChoiceListReadOnly`, `TextField`) accept a
`{ live, value, onChange }` contract and, in live mode, render controlled from `value`
and report through `onChange`. The other ten do not: they take only `{ page, theme }` and
hold their own `useState`. In the builder canvas that is correct — the canvas is inert by
design. In the **runner**, where `mode === "live"`, it is a user-facing defect.

The sharp edge is the three that *look* interactive: `NumberCounter`, `SliderInput` and
`RatingStars` carry local state and respond to input, so a visitor drags the slider, taps
a star, increments the counter — sees the control move — and **nothing is recorded**. This
is worse than an obviously-dead control: the visitor believes they answered. `required`
gates cannot enforce them, and no rule can branch on them.

## The runner is already correct — scope is the leaf components only

This is the load-bearing finding of the design. `apps/dashboard/src/runner/funnel-runner.tsx`
already does everything right:

- `:452` renders `<PagePreview mode="live" value={currentAnswer} onAnswer={setter} />`;
- `:259-264` computes `answered` from the recorded value (treating `undefined`, `null`,
  `""` and `[]` as unanswered — the same four-way gate SP5 aligned the evaluator to);
- `:280` gates the CTA on `required && !answered`;
- `handleAdvance` ships `{ question_id, answer: currentAnswer }` to `advanceSession`.

No runner change is needed, and none is in scope. `AnswerValue` is already
`string | number | boolean | string[] | null` (`packages/shared/src/funnel/evaluator.ts:3`),
and `funnel_answers.answer_json` is `jsonb` (`packages/db/src/drizzle/schema.ts:2404`), so a
recorded number round-trips natively. **No migration, no schema change, no API change.** SP6
is exactly: make ten leaf components honor the contract three of their siblings already honor.

## The wiring contract

Every wired component follows the shape `ChoiceListReadOnly` and `YesNoButtons` already
use:

```ts
const Comp = ({ page, theme, live = false, value, onChange }: {
  page: ResolvedPage; theme: Theme;
  live?: boolean;               // read explicitly, NEVER inferred from onChange presence
  value?: AnswerValue;          // narrowed per component
  onChange?: (next: AnswerValue) => void;
}) => { … }
```

Two invariants, both already established in the file and both load-bearing:

1. **`live` is passed explicitly, never inferred.** The existing comment on
   `ChoiceListReadOnly` states why: inferring `live` from `onChange !== undefined`
   reproduces one level down the exact anti-pattern the `mode` prop exists to prevent — a
   live page with no handler would silently render as a preview and highlight a sample
   answer the visitor never gave. New components read `live` the same way.
2. **In live mode, render controlled from `value`; in preview mode, keep today's local
   state.** The builder canvas behavior does not change. `PagePreview` already computes
   `liveProps = { live: mode === "live", value, onChange: onAnswer }` (`:171`) and
   `textLiveProps` for the string narrowing (`:176`); wiring a component is spreading the
   right one of those two at its call site.

## The ten types and their exact emit shapes

SP5 classified each type's `answerKind`, and SP5's sync test enforces that a component's
emitted value matches its kind (`multi` → array, `number` → number, everything else →
string). So these emit shapes are not open choices — they are obligations the sync test
already checks:

| Type | Component | `answerKind` | Emits | Source of the value |
|---|---|---|---|---|
| `number_input` | `NumberCounter` | number | JS `number` | the counter's current `n` |
| `slider` | `SliderInput` | number | JS `number` | the range value |
| `opinion_scale` | `OpinionScale` | number | JS `number` | the picked cell `n` |
| `rating` | `RatingStars` | number | JS `number` | the picked star count |
| `picture_choice` | `PictureChoiceList` | choice | option value `string` | the clicked option's `value` |
| `long_text` | `TextArea` | text | `string` | the textarea text |
| `phone` | `TextField` | text | `string` | the input text |
| `date_input` | `DatePicker` | text | ISO-8601 `string` | the native `<input type="date">` value (already `YYYY-MM-DD`) |
| `legal` | `LegalCheckbox` | choice | `LEGAL_CHECKBOX_CHECKED` when checked, nothing when not | see below |
| `checkbox` | `LegalCheckbox` | choice | same | see below |

The four `number` types emit **real JS numbers**, not numeric strings — `AnswerValue`
carries `number`, `jsonb` stores it, and SP5's evaluator requires `typeof === "number"` for
`gt/gte/lt/lte`. Emitting `"5"` would recreate exactly the writable-but-dead class SP5
removed.

### `phone` and `TextField`

`TextField` is **already wired** (`:1025` — it accepts `live/value/onChange`). The `short_text`,
`text_input` and `email` call sites spread `{...textLiveProps}`; the `phone` call site
(`:414`) does not. Wiring `phone` is adding `{...textLiveProps}` to that one call site — no
component change.

### `legal` / `checkbox` — a single checkbox, no options

Unlike `picture_choice`, `legal` and `checkbox` carry **no `options` array** — only an
`agreementLabel` (`blank-page.ts:49-65`). There is no option value to emit. A single
consent checkbox is conceptually boolean, but its `answerKind` is `choice`, and SP5 already
proved that emitting a boolean where a choice operator expects a string reproduces the
`yes_no`-boolean defect (a `string` operand can never `eq` a `boolean`).

So the checkbox emits a **named string constant** when checked and reports **unanswered**
(emits nothing / clears to unselected) when not:

```ts
// A stable branching key, deliberately NOT the localized agreementLabel —
// copy changes must not silently change what a rule matches. "choice"-kind,
// so it must be a string, per the answerKind contract (SP5).
export const LEGAL_CHECKBOX_CHECKED = "checked";
```

This makes `required` enforce consent (must check to advance), `is_answered` fire on check,
and `eq "checked"` branch — the primary use is a consent gate, and branching on it works
without special-casing. Unchecking returns the page to unanswered so the visitor can retract
consent before advancing.

## Resting position is not an answer

`NumberCounter`, `SliderInput`, `OpinionScale` and `RatingStars` all have a visual resting
position (the slider mid-track, the counter at `min`, no star lit). In live mode they emit
**nothing until the visitor interacts** — mount does not pre-fill an answer. Three reasons:

- A `required` rating must force a real tap; pre-filling three stars fabricates an answer
  the visitor never gave — the same "shows an answer they never gave" failure the `live`
  invariant exists to prevent, one component down.
- It matches the choice inputs, which already select nothing until clicked.
- The runner's `answered` gate already treats "no recorded value" as unanswered, so this
  needs no runner change.

The deliberate tradeoff: the slider visually rests at its midpoint while `answered` is
`false`. That midpoint is a **starting affordance**, not a recorded value — the same way an
empty text field shows a placeholder without having an answer. The moment the visitor moves
the control, the real value is recorded.

For controlled rendering in live mode, each numeric component reads its displayed position
from `value` when `value` is a number, and falls back to its resting position (for display
only) when `value` is absent — never writing that fallback back through `onChange`.

## The sync test is the enforcement, one type at a time

SP5's fix wave built the exact tripwire this sub-project trips:
`apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx` holds a `WIRED`
table (each entry renders the page, drives a real interaction, and asserts the emitted
value's shape against its `answerKind`) and a `NOT_WIRED_YET` allow-list containing exactly
these ten types. A coverage assertion requires every non-`none` page type to be in one list
or the other, and a second assertion forbids overlap.

Wiring a type means **moving it out of `NOT_WIRED_YET` and into `WIRED`** with a `drive`
function. Until the component actually emits the right shape, that new `WIRED` row is red —
so no type can be marked done by inspection. This is the per-type gate and the reason SP6
decomposes cleanly into one task per type (grouped where a single component serves two
types, e.g. `legal` + `checkbox`).

Each task additionally carries a **mutation-check**: after its sync-test row passes, revert
the component's `onChange` wiring by hand, confirm the row goes red, restore. A row that
stays green with the wiring reverted proves nothing — the failure mode this whole programme
exists to stop.

## Testing

- **Per type**: the type moves from `NOT_WIRED_YET` into `WIRED` with a `drive` function
  that performs the real interaction (drag the range, click a star, type into the textarea,
  check the box, click a picture option, set the date input). The existing assertion then
  checks the emitted value's shape matches the `answerKind` — number for the four numeric
  types, string for the rest.
- **Numeric-value assertion**: for at least one numeric type, additionally assert the
  emitted value *equals* the interacted number (not merely `typeof number`), so a component
  that emits a constant `0` cannot pass.
- **Resting-position assertion**: for one numeric type, assert that rendering live with
  `value={null}` and performing **no** interaction emits nothing — the "resting position is
  not an answer" invariant.
- **Legal/checkbox unanswered-on-uncheck**: check then uncheck emits back to unanswered.
- **Mutation-check every wiring**, per the section above.

## Out of scope

- **`contact_info`** — it collects name/email/phone as one page, so its answer is composite
  and does not fit `AnswerValue`. It needs a new answer shape, a new `AnswerKind`, and
  evaluator support for addressing sub-fields — a materially larger project, deferred whole.
  The `collectedEmail` comment in `funnel-runner.tsx:271` ("contact_info … is not among the
  wired types") stays accurate after SP6 and needs no change.
- **Date comparison operators** (`before` / `after` / `between-dates`) — `date_input`
  records an ISO-8601 string and keeps `answerKind: "text"`, so it gets
  `eq/neq/in/not_in/is_answered`. Ordered date comparison is a known, deliberate follow-up:
  it needs a `date` `AnswerKind`, new operators in the evaluator, schema and editor — the
  semantics work SP5 just finished, not the wiring work SP6 is. Recorded here so the next
  person does not re-derive the gap.
- **Runner, API, DB, evaluator, rule editor** — unchanged. SP6 does not touch what operators
  mean or how answers are transported; it makes the inputs produce the answers those layers
  already expect.

## Follow-ups recorded (not built)

1. Date comparison operators + a `date` `AnswerKind` (above).
2. `contact_info` as a composite-answer type (above).
3. Carried from SP5, unchanged by SP6: the stored-`contains`-operand compatibility check
   (M-8), the `funnel-advance-answer.test.ts` flake, `duplicatePage` having no UI caller,
   and the legacy `Operator`/`RuleClause`/`Rule` types in `types.ts`.
