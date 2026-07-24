# SP6 — Wire the Ten Unwired Funnel Input Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ten funnel input components that currently hold local `useState` record their answers in the runner, so `required` gates enforce them and branching rules can match them.

**Architecture:** Every change is confined to two leaf render files and two test files in `apps/dashboard/src/components/funnel-builder`. Each of the ten types adopts the `{ live, value, onChange }` contract three sibling components (`YesNoButtons`, `ChoiceListReadOnly`, `TextField`) already use: in live mode render controlled from `value` and report through `onChange`; in preview mode keep today's local state so the builder canvas stays inert. The runner, API, DB, evaluator and rule editor are already correct and are not touched.

**Tech Stack:** React (impair `component()` HOC), Vitest + @testing-library/react + @testing-library/user-event, TypeScript strict.

## Global Constraints

- **Leaf components only.** Do NOT modify `apps/dashboard/src/runner/funnel-runner.tsx`, the API, the DB schema, `packages/shared/src/funnel/evaluator.ts`, or `rule-editor.tsx`. If a task seems to need one of those, stop and escalate — the spec states none is required.
- **`live` is read explicitly, NEVER inferred from `onChange !== undefined`.** Inferring it makes a live page with no handler render as a preview showing a sample answer the visitor never gave. Copy the pattern on `ChoiceListReadOnly` (`page-preview.tsx:515`).
- **Live mode renders controlled from `value`; preview mode keeps the existing local `useState`.** The builder canvas behavior does not change.
- **Numeric types emit real JS `number`, never a numeric string.** `"5"` would recreate the writable-but-dead class SP5 removed (`evalClause` needs `typeof === "number"` for `gt/gte/lt/lte`).
- **Resting position is not an answer.** `NumberCounter`, `SliderInput`, `OpinionScale`, `RatingStars` emit NOTHING on mount — only on interaction. The resting position is display-only and is never sent through `onChange`.
- **`legal`/`checkbox` emit the named constant `LEGAL_CHECKBOX_CHECKED = "checked"` when checked, and `""` (unanswered) when unchecked.** Never the localized `agreementLabel` — copy changes must not change what a rule matches.
- **`date_input` emits an ISO-8601 string (`YYYY-MM-DD`) and keeps `answerKind: "text"`.** No date-comparison operators — that is a deferred follow-up.
- **Each type moves from `NOT_WIRED_YET` into `WIRED` in `answer-kind.sync.test.tsx`.** That table is the drift tripwire; a type is not done until its `WIRED` row (which checks the emitted value's shape against its `answerKind`) is green.
- **No magic values.** Style literals stay as they are (pre-existing); the one new literal, `"checked"`, is the named constant `LEGAL_CHECKBOX_CHECKED`.
- **Mutation-check every wiring:** after the test passes, revert only the component's `onChange` wiring by hand, confirm the test goes red, restore. Do NOT use `git checkout`/`git stash` to revert — hand-edit back and forward.
- **Branch discipline:** stay on `main`; never create/switch branches or worktrees. A parallel author commits to `main` — `git add` only the named files, never `-A`/`.`/`commit -a`; run `git status --short` before each commit.
- **Suites (run in the FOREGROUND, generous timeout — never background then wait):**
  - `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/`
  - `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
  - Known pre-existing red, NOT yours: `FunnelPreviewViewModel > jumps via 'paywall' literal goto`.

---

## Shared reference — the two test harnesses

Both test files already exist. Every task edits both.

**`answer-kind.sync.test.tsx`** — the shape gate. It has a `WIRED` array (each entry renders the page via `PagePreview`, runs `drive`, and asserts `typeof onAnswer.mock.lastCall[0]` matches the type's `answerKind`) and a `NOT_WIRED_YET` set holding exactly the ten types. Wiring a type = deleting it from `NOT_WIRED_YET` and adding a `WIRED` row. Two tasks (slider, date) additionally need `fireEvent` — add `import { fireEvent } from "@testing-library/react";` the first time it is required and reuse it.

The `WIRED` row type is:
```ts
{ type: PageType; drive: (user: ReturnType<typeof userEvent.setup>) => Promise<void>; options?: typeof OPTIONS }
```

**`page-preview.live.test.tsx`** — behavioral truth. Its helper `base(page)` supplies `{ page, theme, pages, locale, defaultLocale }`; tests render `<PagePreview {...base(page)} mode="live" value={null} onAnswer={onAnswer} />` and assert `expect(onAnswer).toHaveBeenLastCalledWith(...)`. This is where exact-value, resting-position, and uncheck-to-unanswered assertions live.

Add a page fixture per task at the top of `page-preview.live.test.tsx`, following the existing `emailPage`/`singleChoicePage` style.

---

### Task 1: NumberCounter (`number_input`) — establishes the numeric pattern

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/page-preview.tsx` — `NumberCounter` (814-848), call site (427-430)
- Test: `apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx`
- Test: `apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx`

**Interfaces:**
- Consumes: `liveProps = { live: mode === "live", value, onChange: onAnswer }` already computed in `PagePreview` (`page-preview.tsx:171`).
- Produces: the numeric wiring shape (`live ? (typeof value === "number" ? value : rest) : local`, emit `number` on interaction, no mount emit) that Tasks 2-4 reuse.

- [ ] **Step 1: Write the failing behavioral tests**

In `page-preview.live.test.tsx`, add a fixture near the other page consts:
```tsx
const numberPage: Page = {
  id: "pg_num",
  type: "number_input",
  question_id: "q_num",
  title: L("How many?"),
  min: 0,
  max: 100,
  step: 1,
} as Page;
```
Add inside `describe("PagePreview — live mode", ...)`:
```tsx
it("number_input emits a real number, not a string, on increment", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(numberPage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.click(screen.getByLabelText("increment"));
  expect(onAnswer).toHaveBeenLastCalledWith(1);
  expect(typeof onAnswer.mock.lastCall![0]).toBe("number");
});

it("number_input records nothing until the visitor interacts (resting position is not an answer)", () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(numberPage)} mode="live" value={null} onAnswer={onAnswer} />);
  expect(onAnswer).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t number_input`
Expected: FAIL — the increment button has no accessible name `"increment"` yet and no `onAnswer` fires.

- [ ] **Step 3: Wire NumberCounter**

Replace `NumberCounter` (`page-preview.tsx:814-848`) with:
```tsx
const NumberCounter = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 0;
    const max = page.max ?? 100;
    const step = page.step ?? 1;
    const [local, setLocal] = useState(min);
    // Live mode shows the recorded answer; before the visitor interacts
    // there is none, so it rests at `min` FOR DISPLAY ONLY — that resting
    // value is never sent.
    const n = live ? (typeof value === "number" ? value : min) : local;
    const commit = (next: number) => {
      const clamped = Math.max(min, Math.min(max, next));
      if (live) onChange?.(clamped);
      else setLocal(clamped);
    };
    return (
      <div className="mt-3 flex items-center justify-center gap-3 px-4 py-3"
        style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}>
        <button
          type="button"
          aria-label="decrement"
          onClick={() => commit(n - step)}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] font-bold transition"
          style={{ background: `${theme.primary}15`, color: theme.primary }}
        >
          −
        </button>
        <div className="min-w-[60px] text-center font-rv-mono text-[28px] font-bold tabular-nums">
          {n}
          {page.suffix && (
            <span className="ml-1 text-[14px] font-normal opacity-60">{page.suffix}</span>
          )}
        </div>
        <button
          type="button"
          aria-label="increment"
          onClick={() => commit(n + step)}
          className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] font-bold transition"
          style={{ background: `${theme.primary}15`, color: theme.primary }}
        >
          +
        </button>
      </div>
    );
  },
);
```
Update the call site (`page-preview.tsx:427-430`) from `<NumberCounter page={resolved} theme={theme} />` to:
```tsx
<NumberCounter page={resolved} theme={theme} {...liveProps} />
```
Confirm `AnswerValue` is already imported in `page-preview.tsx` (it is — `ChoiceListReadOnly` uses it).

- [ ] **Step 4: Run the behavioral tests to verify they pass**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t number_input`
Expected: PASS (both).

- [ ] **Step 5: Move `number_input` into the sync `WIRED` table**

In `answer-kind.sync.test.tsx`: delete `"number_input"` from `NOT_WIRED_YET`, and add to `WIRED`:
```tsx
{ type: "number_input", drive: (u) => u.click(screen.getByLabelText("increment")) },
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS — `number_input` emits a `number`, matching its `answerKind`; coverage and no-overlap assertions stay green.

- [ ] **Step 7: Mutation-check**

By hand, change `commit`'s live branch from `onChange?.(clamped)` to a no-op (`if (live) { /* onChange?.(clamped) */ }`). Re-run the two commands above. Expected: the `number_input` behavioral test and the sync `number_input` row go RED. Restore the line by hand; re-run; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): number_input records its answer in the runner"
```

---

### Task 2: SliderInput (`slider`) — the resting-position invariant

**Files:**
- Modify: `page-preview.tsx` — `SliderInput` (870-902), call site (437-440)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:**
- Consumes: the numeric wiring shape from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

In `page-preview.live.test.tsx` add:
```tsx
const sliderPage: Page = {
  id: "pg_slider",
  type: "slider",
  question_id: "q_slider",
  title: L("Pick a level"),
  min: 0,
  max: 100,
  step: 1,
} as Page;
```
```tsx
it("slider emits a number on change and nothing at rest", async () => {
  const onAnswer = vi.fn();
  const { container } = render(
    <PagePreview {...base(sliderPage)} mode="live" value={null} onAnswer={onAnswer} />,
  );
  expect(onAnswer).not.toHaveBeenCalled(); // resting midpoint is not an answer
  const range = container.querySelector('input[type="range"]')!;
  await userEvent.click(range); // ensure it is interactable
  (range as HTMLInputElement).value = "42";
  range.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onAnswer).toHaveBeenLastCalledWith(42);
});
```
> Note on driving a range input: jsdom + user-event cannot drag a slider, so set `.value` and dispatch an `input` event directly. React's `onChange` listens on the `input` event.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t slider`
Expected: FAIL — no `onAnswer` fires.

- [ ] **Step 3: Wire SliderInput**

Replace `SliderInput` (`page-preview.tsx:870-902`) with:
```tsx
const SliderInput = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 0;
    const max = page.max ?? 100;
    const step = page.step ?? 1;
    const rest = min + Math.round((max - min) / 2);
    const [local, setLocal] = useState(rest);
    const v = live ? (typeof value === "number" ? value : rest) : local;
    const onRange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = Number(e.currentTarget.value);
      if (live) onChange?.(next);
      else setLocal(next);
    };
    return (
      <div
        className="mt-3 px-4 py-4"
        style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
      >
        <div className="mb-2 text-center font-rv-mono text-[24px] font-bold tabular-nums">
          {v}
          {page.suffix && (
            <span className="ml-1 text-[12px] font-normal opacity-60">{page.suffix}</span>
          )}
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          onChange={onRange}
          className="w-full"
          style={{ accentColor: theme.primary }}
        />
        <div className="mt-1 flex justify-between font-rv-mono text-[10px] opacity-50">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>
    );
  },
);
```
Update the call site (`page-preview.tsx:437-440`) to `<SliderInput page={resolved} theme={theme} {...liveProps} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t slider`
Expected: PASS.

- [ ] **Step 5: Move `slider` into the sync `WIRED` table**

In `answer-kind.sync.test.tsx`: add `import { fireEvent } from "@testing-library/react";` (top, once). Delete `"slider"` from `NOT_WIRED_YET`, add to `WIRED`:
```tsx
{
  type: "slider",
  drive: async () => {
    fireEvent.change(screen.getByRole("slider"), { target: { value: "42" } });
  },
},
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

By hand, change `onRange`'s live branch to a no-op. Re-run Steps 4 and 6 — the slider behavioral test and the sync `slider` row go RED. Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): slider records its answer; resting position stays unanswered"
```

---

### Task 3: OpinionScale (`opinion_scale`)

**Files:**
- Modify: `page-preview.tsx` — `OpinionScale` (956-980), call site (383-386)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:** Consumes the numeric wiring shape. Produces nothing new.

- [ ] **Step 1: Write the failing test**

Add fixture and test to `page-preview.live.test.tsx`:
```tsx
const opinionPage: Page = {
  id: "pg_op",
  type: "opinion_scale",
  question_id: "q_op",
  title: L("Rate this"),
  min: 1,
  max: 5,
} as Page;
```
```tsx
it("opinion_scale emits the picked cell as a number", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(opinionPage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.click(screen.getByRole("button", { name: "3" }));
  expect(onAnswer).toHaveBeenLastCalledWith(3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t opinion_scale`
Expected: FAIL.

- [ ] **Step 3: Wire OpinionScale**

Replace `OpinionScale` (`page-preview.tsx:956-980`) with:
```tsx
const OpinionScale = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const min = page.min ?? 1;
    const max = page.max ?? 5;
    const items = [] as number[];
    for (let i = min; i <= max; i++) items.push(i);
    const selected = live && typeof value === "number" ? value : null;
    return (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {items.map((n) => {
          const on = selected === n;
          return (
            <button
              key={n}
              type="button"
              onClick={live ? () => onChange?.(n) : undefined}
              className="flex h-9 min-w-9 items-center justify-center rounded-md text-[13px] font-medium"
              style={{
                border: `1px solid ${theme.primary}`,
                color: on ? "white" : theme.primary,
                background: on ? theme.primary : "white",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
    );
  },
);
```
Update the call site (`page-preview.tsx:383-386`) to `<OpinionScale page={resolved} theme={theme} {...liveProps} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t opinion_scale`
Expected: PASS.

- [ ] **Step 5: Move `opinion_scale` into the sync `WIRED` table**

Delete `"opinion_scale"` from `NOT_WIRED_YET`, add:
```tsx
{ type: "opinion_scale", drive: (u) => u.click(screen.getByRole("button", { name: "3" })) },
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

By hand, change `onClick` to `undefined` unconditionally. Re-run Steps 4 and 6 — RED. Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): opinion_scale records the picked cell"
```

---

### Task 4: RatingStars (`rating`)

**Files:**
- Modify: `page-preview.tsx` — `RatingStars` (983-1023), call site (388-391)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:** Consumes the numeric wiring shape. Preserves the existing local hover highlight (visual only, both modes).

- [ ] **Step 1: Write the failing test**

Add fixture and test to `page-preview.live.test.tsx`:
```tsx
const ratingPage: Page = {
  id: "pg_rate",
  type: "rating",
  question_id: "q_rate",
  title: L("Rate your experience"),
  max: 5,
} as Page;
```
```tsx
it("rating emits the picked star count as a number", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(ratingPage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.click(screen.getByLabelText("rate 4"));
  expect(onAnswer).toHaveBeenLastCalledWith(4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t rating`
Expected: FAIL — no `aria-label` `"rate 4"`, no emit.

- [ ] **Step 3: Wire RatingStars**

Replace `RatingStars` (`page-preview.tsx:983-1023`) with:
```tsx
const RatingStars = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const max = page.max ?? 5;
    const [localPicked, setLocalPicked] = useState(0);
    const [hover, setHover] = useState(0);
    // The recorded rating in live mode; the local preview pick otherwise.
    const picked = live ? (typeof value === "number" ? value : 0) : localPicked;
    const filledThrough = hover || picked;
    return (
      <div className="mt-3 flex items-center gap-1.5" onMouseLeave={() => setHover(0)}>
        {Array.from({ length: max }, (_, i) => {
          const n = i + 1;
          const on = n <= filledThrough;
          return (
            <button
              key={i}
              type="button"
              aria-label={`rate ${n}`}
              onClick={() => (live ? onChange?.(n) : setLocalPicked(n))}
              onMouseEnter={() => setHover(n)}
              className="cursor-pointer p-0.5 transition hover:scale-110"
            >
              <Star
                size={30}
                strokeWidth={1.5}
                style={{
                  color: theme.primary,
                  fill: on ? theme.primary : "transparent",
                }}
              />
            </button>
          );
        })}
        {picked > 0 && (
          <span className="ml-2 font-rv-mono text-[11px] opacity-60">
            {picked} / {max}
          </span>
        )}
      </div>
    );
  },
);
```
Update the call site (`page-preview.tsx:388-391`) to `<RatingStars page={resolved} theme={theme} {...liveProps} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t rating`
Expected: PASS.

- [ ] **Step 5: Move `rating` into the sync `WIRED` table**

Delete `"rating"` from `NOT_WIRED_YET`, add:
```tsx
{ type: "rating", drive: (u) => u.click(screen.getByLabelText("rate 4")) },
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

By hand, change the live `onClick` branch from `onChange?.(n)` to nothing (`() => (live ? undefined : setLocalPicked(n))`). Re-run Steps 4 and 6 — RED. Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): rating records the picked star count"
```

---

### Task 5: PictureChoiceList (`picture_choice`)

**Files:**
- Modify: `page-preview.tsx` — `PictureChoiceList` (906-933), call site (371-374)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:** Emits the clicked option's `value` string (choice kind), mirroring `ChoiceListReadOnly`'s single-choice path. Preview mode keeps the `i === 0` sample highlight.

- [ ] **Step 1: Write the failing test**

Add fixture and test to `page-preview.live.test.tsx`:
```tsx
const picturePage: Page = {
  id: "pg_pic",
  type: "picture_choice",
  question_id: "q_pic",
  title: L("Pick the one that fits"),
  options: [
    { label: L("Option A") as never, value: "opt_a", imageUrl: "" },
    { label: L("Option B") as never, value: "opt_b", imageUrl: "" },
  ],
} as Page;
```
```tsx
it("picture_choice emits the clicked option's value", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(picturePage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.click(screen.getByText("Option B"));
  expect(onAnswer).toHaveBeenLastCalledWith("opt_b");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t picture_choice`
Expected: FAIL — option is a `<div>` with no click handler.

- [ ] **Step 3: Wire PictureChoiceList**

Replace `PictureChoiceList` (`page-preview.tsx:906-933`) with:
```tsx
const PictureChoiceList = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const selected = live && typeof value === "string" ? value : null;
    return (
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(page.options ?? []).slice(0, 6).map((o, i) => {
          // Preview highlights the first option as a sample; live highlights
          // only the visitor's pick.
          const active = live ? o.value === selected : i === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={live ? () => onChange?.(o.value) : undefined}
              className="flex flex-col gap-1 overflow-hidden text-left"
              style={{
                borderRadius: theme.radius,
                background: "white",
                border: `1px solid ${active ? theme.primary : "rgba(0,0,0,0.08)"}`,
                boxShadow: active ? `0 0 0 2px ${theme.primary}25` : undefined,
              }}
            >
              <div
                className="flex aspect-square w-full items-center justify-center text-[10px] opacity-50"
                style={{ background: "rgba(0,0,0,0.04)" }}
              >
                {o.imageUrl ? (
                  <img src={o.imageUrl} alt={o.label} className="h-full w-full object-cover" />
                ) : (
                  "no image"
                )}
              </div>
              <div className="px-2 py-1.5 text-[11px]">{o.label}</div>
            </button>
          );
        })}
      </div>
    );
  },
);
```
> The wrapping `<div>` becomes a `<button>` so the option is keyboard-focusable and testable by its label text. Layout classes are unchanged aside from `text-left` to keep button text alignment.

Update the call site (`page-preview.tsx:371-374`) to `<PictureChoiceList page={resolved} theme={theme} {...liveProps} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t picture_choice`
Expected: PASS.

- [ ] **Step 5: Move `picture_choice` into the sync `WIRED` table**

Delete `"picture_choice"` from `NOT_WIRED_YET`, add (it needs options — the table already supports `options`):
```tsx
{ type: "picture_choice", drive: (u) => u.click(screen.getByText("Option B")), options: OPTIONS },
```
> `OPTIONS` in the sync test is `[{ label, value: "opt_a" }, { label, value: "opt_b" }]`; `imageUrl` is optional and absent here, which renders the "no image" placeholder — fine for the shape check.

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

By hand, change `onClick` to `undefined` unconditionally. Re-run Steps 4 and 6 — RED. Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): picture_choice records the clicked option"
```

---

### Task 6: LegalCheckbox (`legal` + `checkbox`) — the checkbox constant

**Files:**
- Modify: `page-preview.tsx` — `LegalCheckbox` (937-954) and add the `LEGAL_CHECKBOX_CHECKED` export, call site (377-380)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:**
- Produces: `export const LEGAL_CHECKBOX_CHECKED = "checked"` — the choice-kind string a checked consent box emits; imported by the tests.
- One component serves both `legal` and `checkbox`; both move to `WIRED`.

- [ ] **Step 1: Write the failing tests**

In `page-preview.live.test.tsx`, add to the imports:
```tsx
import { PagePreview, LEGAL_CHECKBOX_CHECKED } from "./page-preview";
```
(Replace the existing `import { PagePreview } from "./page-preview";`.)

Add fixture and tests:
```tsx
const legalPage: Page = {
  id: "pg_legal",
  type: "legal",
  question_id: "q_legal",
  title: L("Please review and accept"),
  agreementLabel: L("I agree to the terms"),
} as Page;
```
```tsx
it("legal emits the checked constant when checked", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(legalPage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.click(screen.getByRole("checkbox"));
  expect(onAnswer).toHaveBeenLastCalledWith(LEGAL_CHECKBOX_CHECKED);
});

it("legal returns to unanswered when unchecked", async () => {
  const onAnswer = vi.fn();
  render(
    <PagePreview
      {...base(legalPage)}
      mode="live"
      value={LEGAL_CHECKBOX_CHECKED}
      onAnswer={onAnswer}
    />,
  );
  await userEvent.click(screen.getByRole("checkbox")); // uncheck
  expect(onAnswer).toHaveBeenLastCalledWith("");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t legal`
Expected: FAIL — `LEGAL_CHECKBOX_CHECKED` is not exported and there is no `role="checkbox"` (the current markup is a styled `<span>`).

- [ ] **Step 3: Wire LegalCheckbox**

Replace `LegalCheckbox` (`page-preview.tsx:937-954`) with:
```tsx
// A checked consent box is `answerKind: "choice"`, so it must emit a
// STRING (a boolean could never match a string operand — the yes_no
// lesson). This is a stable branching key, deliberately NOT the localized
// agreementLabel, so editing consent copy never changes what a rule matches.
export const LEGAL_CHECKBOX_CHECKED = "checked";

const LegalCheckbox = component(
  ({
    page,
    theme,
    live = false,
    value,
    onChange,
  }: {
    page: ResolvedPage;
    theme: Theme;
    live?: boolean;
    value?: AnswerValue;
    onChange?: (next: AnswerValue) => void;
  }) => {
    const checked = live && value === LEGAL_CHECKBOX_CHECKED;
    return (
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12px]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 flex-shrink-0"
          style={{ accentColor: theme.primary }}
          readOnly={!live}
          checked={checked}
          onChange={
            live
              ? (e) => onChange?.(e.currentTarget.checked ? LEGAL_CHECKBOX_CHECKED : "")
              : undefined
          }
        />
        <span className="leading-snug">
          {page.agreementLabel || "I agree"}
          {page.termsUrl && (
            <a className="ml-1 underline" style={{ color: theme.primary }} href={page.termsUrl}>
              Read terms
            </a>
          )}
        </span>
      </label>
    );
  },
);
```
> A controlled checkbox with no `onChange` warns in React; the `readOnly` in preview mode suppresses it while keeping the box inert.

Update the call site (`page-preview.tsx:377-380`) to `<LegalCheckbox page={resolved} theme={theme} {...liveProps} />`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t legal`
Expected: PASS (both).

- [ ] **Step 5: Move `legal` and `checkbox` into the sync `WIRED` table**

Delete BOTH `"legal"` and `"checkbox"` from `NOT_WIRED_YET`, add:
```tsx
{ type: "legal", drive: (u) => u.click(screen.getByRole("checkbox")) },
{ type: "checkbox", drive: (u) => u.click(screen.getByRole("checkbox")) },
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS — both emit the string `"checked"`, matching their `choice` kind.

- [ ] **Step 7: Mutation-check**

By hand, change `onChange` to always emit `""` (`(e) => onChange?.("")`). The "emits the checked constant when checked" test and the two sync rows go RED (they expect `"checked"`). Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): legal and checkbox record consent as a stable choice value"
```

---

### Task 7: TextArea (`long_text`)

**Files:**
- Modify: `page-preview.tsx` — `TextArea` (1063-1075), call site (398-400)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:** Consumes `textLiveProps = { live, value: (string), onChange: (next: string) => onAnswer?.(next) }` already computed in `PagePreview` (`page-preview.tsx:176`), the same props `TextField` uses.

- [ ] **Step 1: Write the failing test**

Add fixture and test to `page-preview.live.test.tsx`:
```tsx
const longTextPage: Page = {
  id: "pg_long",
  type: "long_text",
  question_id: "q_long",
  title: L("Tell us more"),
} as Page;
```
```tsx
it("long_text captures the typed string", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(longTextPage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.type(screen.getByRole("textbox"), "a");
  expect(onAnswer).toHaveBeenLastCalledWith("a");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t long_text`
Expected: FAIL — the textarea is `readOnly` and never calls `onAnswer`.

- [ ] **Step 3: Wire TextArea**

Replace `TextArea` (`page-preview.tsx:1063-1075`) with:
```tsx
function TextArea({
  placeholder,
  theme,
  live = false,
  value,
  onChange,
}: {
  placeholder?: string;
  theme: Theme;
  live?: boolean;
  value?: string;
  onChange?: (next: string) => void;
}) {
  return (
    <textarea
      readOnly={!live}
      rows={3}
      placeholder={placeholder ?? "Type your answer…"}
      className="mt-3 w-full resize-none px-3 py-2 text-[13px] outline-none"
      style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
      {...(live && onChange
        ? { value: value ?? "", onChange: (e) => onChange(e.currentTarget.value) }
        : {})}
    />
  );
}
```
Update the call site (`page-preview.tsx:398-400`) to:
```tsx
<TextArea placeholder={resolved.placeholder} theme={theme} {...textLiveProps} />
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t long_text`
Expected: PASS.

- [ ] **Step 5: Move `long_text` into the sync `WIRED` table**

Delete `"long_text"` from `NOT_WIRED_YET`, add:
```tsx
{ type: "long_text", drive: (u) => u.type(screen.getByRole("textbox"), "a") },
```

- [ ] **Step 6: Run the sync test**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

By hand, remove the `{...(live && onChange ? … : {})}` spread (leave the textarea always read-only). Re-run Steps 4 and 6 — RED. Restore; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): long_text captures the typed answer"
```

---

### Task 8: `phone` call site + DatePicker (`date_input`)

**Files:**
- Modify: `page-preview.tsx` — `phone` call site (414-421), `DatePicker` (852-866) and its call site (432-434)
- Test: `page-preview.live.test.tsx`, `answer-kind.sync.test.tsx`

**Interfaces:** `phone` reuses the already-wired `TextField` via `textLiveProps`; `DatePicker` adopts the same `{ live, value: string, onChange: (next: string) => void }` contract and emits the native date input's `YYYY-MM-DD` value.

- [ ] **Step 1: Write the failing tests**

Add fixtures and tests to `page-preview.live.test.tsx`:
```tsx
const phonePage: Page = {
  id: "pg_phone",
  type: "phone",
  question_id: "q_phone",
  title: L("Your number"),
} as Page;

const datePage: Page = {
  id: "pg_date",
  type: "date_input",
  question_id: "q_date",
  title: L("Pick a date"),
} as Page;
```
```tsx
it("phone captures the typed string", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(phonePage)} mode="live" value={null} onAnswer={onAnswer} />);
  await userEvent.type(screen.getByRole("textbox"), "5");
  expect(onAnswer).toHaveBeenLastCalledWith("5");
});

it("date_input captures an ISO-8601 string", async () => {
  const onAnswer = vi.fn();
  render(<PagePreview {...base(datePage)} mode="live" value={null} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByLabelText("date"), { target: { value: "2026-07-25" } });
  expect(onAnswer).toHaveBeenLastCalledWith("2026-07-25");
});
```
Add `fireEvent` to the `@testing-library/react` import at the top of `page-preview.live.test.tsx`:
```tsx
import { render, screen, fireEvent } from "@testing-library/react";
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t "phone|date_input"`
Expected: FAIL — `phone` `TextField` has no live props; `DatePicker` is read-only with no `aria-label`.

- [ ] **Step 3a: Wire the `phone` call site**

The `phone` case (`page-preview.tsx:414-421`) renders `TextField` (already wired) without live props. Add `{...textLiveProps}`:
```tsx
{page.type === "phone" && (
  <Cap>
    <TextField
      placeholder={resolved.placeholder ?? "+1 555 0000"}
      theme={theme}
      type="tel"
      icon={<Phone size={14} />}
      {...textLiveProps}
    />
  </Cap>
)}
```

- [ ] **Step 3b: Wire DatePicker**

Replace `DatePicker` (`page-preview.tsx:852-866`) with:
```tsx
function DatePicker({
  theme,
  live = false,
  value,
  onChange,
}: {
  theme: Theme;
  live?: boolean;
  value?: string;
  onChange?: (next: string) => void;
}) {
  return (
    <div
      className="mt-3 flex h-10 w-full items-center gap-2 px-3"
      style={{ borderRadius: theme.radius, background: "white", border: `1px solid ${theme.primary}40` }}
    >
      <Calendar size={14} style={{ color: theme.primary }} />
      <input
        aria-label="date"
        readOnly={!live}
        type="date"
        className="h-full flex-1 bg-transparent text-[13px] outline-none"
        {...(live && onChange
          ? { value: value ?? "", onChange: (e) => onChange(e.currentTarget.value) }
          : {})}
      />
    </div>
  );
}
```
Update the `date_input` call site (`page-preview.tsx:432-434`) to:
```tsx
<DatePicker theme={theme} {...textLiveProps} />
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t "phone|date_input"`
Expected: PASS (both).

- [ ] **Step 5: Move `phone` and `date_input` into the sync `WIRED` table**

Delete BOTH from `NOT_WIRED_YET`, add:
```tsx
{ type: "phone", drive: (u) => u.type(screen.getByRole("textbox"), "5") },
{
  type: "date_input",
  drive: async () => {
    fireEvent.change(screen.getByLabelText("date"), { target: { value: "2026-07-25" } });
  },
},
```
(The `fireEvent` import was added in Task 2; if Task 2 was skipped for any reason, add it here.)

- [ ] **Step 6: Run the sync test — `NOT_WIRED_YET` is now empty**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/answer-kind.sync.test.tsx`
Expected: PASS. `NOT_WIRED_YET` should now be `new Set([])`; the coverage assertion confirms every non-`none` type is in `WIRED`.

- [ ] **Step 7: Mutation-check**

Two checks, by hand: (a) remove `{...textLiveProps}` from the `phone` call site → the phone test and sync `phone` row go RED; restore. (b) remove the `{...(live && onChange ? … : {})}` spread from `DatePicker` → the date test and sync `date_input` row go RED; restore.

- [ ] **Step 8: Run the FULL funnel-builder suite and tsc, then commit**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/`
Expected: all green except the known pre-existing `FunnelPreviewViewModel > jumps via 'paywall' literal goto`.
Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: clean.
```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx
git commit -m "feat(dashboard): phone and date_input record their answers; all inputs wired"
```

---

## Self-Review

**Spec coverage:**
- Runner already correct / leaf-only scope → Global Constraints + every task touches only `page-preview.tsx` and the two test files. ✅
- `{ live, value, onChange }` contract, `live` explicit → Global Constraints + each task's component code. ✅
- Ten types wired → Tasks 1-8 (Task 6 = legal+checkbox, Task 8 = phone+date). Count: number_input, slider, opinion_scale, rating, picture_choice, legal, checkbox, long_text, phone, date_input = 10. ✅
- Numeric types emit real numbers → Tasks 1-4, asserted `typeof === "number"` (Task 1) and exact value (Tasks 1,3,4). ✅
- Resting position is not an answer → Tasks 1 and 2 assert no emit at rest. ✅
- legal/checkbox named constant, unanswered-on-uncheck → Task 6. ✅
- date ISO string, answerKind stays text → Task 8; no operator/schema change. ✅
- Sync test is the enforcement, `NOT_WIRED_YET` → empty → each task moves its type; Task 8 Step 6 checks the set is empty. ✅
- Mutation-check every wiring → Step 7 of every task. ✅
- No migration / no runner-API-DB change → Global Constraints forbids it. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "similar to Task N". ✅

**Type consistency:** Every wired component uses the identical prop block `{ page, theme, live = false, value, onChange }` with `value?: AnswerValue` (numeric/choice) or `value?: string` (`TextArea`, `DatePicker`); call sites spread `liveProps` (AnswerValue) for numeric/choice and `textLiveProps` (string) for text/date/phone. `LEGAL_CHECKBOX_CHECKED` is defined once in Task 6 and imported by name in that task's test. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-sp6-wire-funnel-inputs.md`.
