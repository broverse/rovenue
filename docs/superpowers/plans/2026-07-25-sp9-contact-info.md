# SP9 — `contact_info` Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `contact_info` page usable — its three fields are read-only in the live runner today, so a visitor cannot type their name, email or phone — and record what they enter.

**Architecture:** Task 1 extracts one shared `isAnswered()` so the runner and evaluator cannot drift on what "answered" means, and teaches it a composite answer. Task 2 makes the fields editable and emits the composite value. Task 3 exposes the `composite` answer kind and lets the payment step's email pre-fill use a contact page.

**Tech Stack:** TypeScript strict, Zod, Vitest, React.

## Global Constraints

- **Stay on branch `main`. Never create, switch, or delete branches or worktrees.**
- A parallel author commits to `main` and has in-flight work under `packages/sdk-rn/`. Run `git status --short` before every commit and `git add` **only** the files that task names, **always with an explicit pathspec**. Never `git add -A`, `git add .`, or `git commit -a` — an earlier task in this programme swept two of that author's files into a commit.
- `.superpowers/` is gitignored — never force-add it.
- TypeScript strict. Zod for API input.
- **No API change and no migration.** The API's `answerValueSchema` is bounded-recursive and already permits records (`apps/api/src/routes/public/funnels.ts`), and `funnel_answers.answer_json` is `jsonb`, so an object answer already validates and already round-trips. If you find yourself writing either, stop — it is not needed.
- **No magic values** — the composite field names live in one place, not restated per layer.
- **Mutation-check every behavioural change:** after the test passes, revert the production change **by hand-editing it back**, confirm the test goes red, then hand-edit it forward. Never `git checkout` or `git stash` to revert — that has destroyed uncommitted work on this project.
- Run all suites in the **FOREGROUND** with a generous timeout. Never background a suite and then wait on it.
- Known pre-existing red, **not** this work's fault: `FunnelPreviewViewModel > jumps via 'paywall' literal goto`.
- Line numbers may have drifted. **Locate code by content**, and say so in your report if it moved.

---

### Task 1: One shared `isAnswered()`, taught about composites

**Why this exists:** the evaluator computes `answered` inline and the runner duplicates the same four-way test. SP5 aligned those two by hand. A composite answer breaks that alignment in a new way — an object with every field blank is neither `null` nor `""` nor an empty array, so **both** current implementations would call it answered. Aligning a third copy by hand is how the divergence returns; this task removes the duplication instead.

**The rule, and why it is computable from the value alone:** the component (Task 2) emits a key for **each field the page asks for** and only those. So the key set records what was requested and the values record what was given, which makes

> answered = at least one key, and **every** key holds a non-empty value

decidable without the page's `collectName`/`collectEmail`/`collectPhone` flags. That is what lets the runner (which knows the flags) and the evaluator (which does not) agree by construction.

**Files:**
- Modify: `packages/shared/src/funnel/evaluator.ts` (export `ContactAnswer`, widen `AnswerValue`, export `isAnswered`, use it in `evalClause`)
- Test: `packages/shared/src/funnel/is-answered.test.ts` (create)

**Interfaces:**
- Produces: `export type ContactAnswer = { name?: string; email?: string; phone?: string }`, a widened `AnswerValue`, and `export function isAnswered(value: AnswerValue | undefined): boolean`. Tasks 2 and 3 consume all three.
- Consumes: the existing `answered` semantics, which must be preserved byte-for-byte for scalars.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/funnel/is-answered.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAnswered, type AnswerValue } from "./evaluator";

// =============================================================
// isAnswered — ONE definition, shared by the evaluator and the runner
// =============================================================
//
// These two used to compute the same four-way test in two places, aligned
// by hand. A composite answer breaks that alignment in a new way: an
// object with every field blank is neither null nor "" nor an empty array,
// so both copies would have called it answered. This is the single
// definition both now call.

describe("isAnswered — scalars behave exactly as before", () => {
  it.each<[string, AnswerValue | undefined, boolean]>([
    ["undefined", undefined, false],
    ["null", null, false],
    ["empty string", "", false],
    ["empty array", [], false],
    ["a string", "a", true],
    ["a selection", ["a"], true],
    // 0 and false are ANSWERS. A truthiness check would drop both, which is
    // why the original test is spelled out rather than shortened.
    ["zero", 0, true],
    ["false", false, true],
  ])("%s -> %s", (_label, value, expected) => {
    expect(isAnswered(value)).toBe(expected);
  });
});

describe("isAnswered — a composite is answered when every field it ASKS FOR is filled", () => {
  it("an object with no keys is not answered", () => {
    // The page asked for nothing, so there is nothing to have answered.
    expect(isAnswered({})).toBe(false);
  });

  it("a single asked-for field must be filled", () => {
    expect(isAnswered({ email: "" })).toBe(false);
    expect(isAnswered({ email: "a@b.co" })).toBe(true);
  });

  it("EVERY asked-for field must be filled, not merely one", () => {
    // The case that distinguishes the key-set rule from "any field filled".
    // A page asking for email AND phone is not answered by the email alone.
    expect(isAnswered({ email: "a@b.co", phone: "" })).toBe(false);
    expect(isAnswered({ email: "a@b.co", phone: "+15550000" })).toBe(true);
  });

  it("whitespace is not an answer", () => {
    expect(isAnswered({ name: "   " })).toBe(false);
  });

  it("a page asking for less is answered sooner — with no page flags involved", () => {
    // The key set carries the question, so the evaluator needs to know
    // nothing about collectName/collectEmail/collectPhone.
    expect(isAnswered({ email: "a@b.co" })).toBe(true);
    expect(isAnswered({ email: "a@b.co", name: "" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/is-answered.test.ts
```
Expected: FAIL to even import — `isAnswered` is not exported yet.

- [ ] **Step 3: Add the type, widen `AnswerValue`, and export `isAnswered`**

In `packages/shared/src/funnel/evaluator.ts`, replace the `AnswerValue` declaration with:

```ts
/**
 * A `contact_info` page's answer.
 *
 * A key is present for each field the page ASKS for, and only those. So the
 * key set records what was requested while the values record what was
 * given — which is what makes `isAnswered` decidable from the value alone,
 * without the page's collectName/collectEmail/collectPhone flags. The
 * runner knows those flags and the evaluator does not, so any definition
 * that needed them would give the two layers different answers.
 */
export type ContactAnswer = {
  name?: string;
  email?: string;
  phone?: string;
};

export type AnswerValue = string | number | boolean | string[] | null | ContactAnswer;
export type AnswerMap = Map<string, AnswerValue>;

/**
 * The ONE definition of "answered", called by both the evaluator's
 * `is_answered` operator and the runner's `required` gate.
 *
 * It exists as a shared function rather than as the same expression written
 * twice: those two copies were aligned by hand, and a composite answer
 * breaks that alignment in a way neither copy would have caught — an object
 * with every field blank is not `null`, not `""`, and not an empty array.
 *
 * `0` and `false` are answers. A truthiness check would silently drop both.
 */
export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((v) => typeof v === "string" && v.trim() !== "");
  }
  return true;
}
```

Then replace the inline `answered` const inside `evalClause` with a call, keeping the comment's intent but pointing at the shared function:

```ts
  // One definition of "answered", shared with the runner's own gate — see
  // isAnswered. The evaluator and the client each computing it was two
  // definitions one hop apart.
  const answered = isAnswered(a);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @rovenue/shared exec vitest run src/funnel/is-answered.test.ts
pnpm --filter @rovenue/shared exec vitest run src/funnel/
pnpm --filter @rovenue/shared exec tsc --noEmit
```
Expected: the new file green, and **the whole `src/funnel/` suite still green** — the existing `is_answered` / `is_not_answered` cases in `evaluator.clauses.test.ts` are the regression guard that the scalar behaviour did not change. If any of them reds, the extraction changed semantics: fix `isAnswered`, do not adjust those tests.

`tsc` may now report errors in the dashboard for the widened union; those belong to Tasks 2 and 3. Only `@rovenue/shared` must be clean here.

- [ ] **Step 5: Mutation-check, twice**

(a) **The composite rule is real.** By hand, change `entries.every(...)` to `entries.some(...)`. Re-run Step 4's first command.
Expected: RED on "EVERY asked-for field must be filled, not merely one". Restore by hand; green.

(b) **The evaluator actually calls the shared helper.** By hand, revert `evalClause`'s `answered` to the old inline expression:
```ts
  const answered = a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && a.length === 0);
```
Then add a temporary case to `is-answered.test.ts` proving the two disagree — or simpler, run the whole `src/funnel/` suite and confirm nothing catches it, then say so in your report. **This is the honest finding either way:** if no existing test distinguishes the inline copy from the shared helper for a composite, that gap is exactly what Task 3's cross-layer test must close. Record which it is. Restore by hand.

- [ ] **Step 6: Commit**

```bash
git status --short
git add packages/shared/src/funnel/evaluator.ts \
        packages/shared/src/funnel/is-answered.test.ts
git commit -m "refactor(shared): one shared isAnswered, taught about composite answers"
```

---

### Task 2: The fields become editable and report their value

**Why this exists:** `ContactInfoFields` passes its three `TextField`s no live props, so `live` defaults to `false` and each renders `readOnly={!live}`. Verified: a `contact_info` page in `mode="live"` produces three fields, all three carrying `readonly`. A visitor cannot type.

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/page-preview.tsx` (`ContactInfoFields` and its call site)
- Test: `apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx` (extend)

**Interfaces:**
- Consumes: `ContactAnswer` from `@rovenue/shared/funnel` (Task 1); the `liveProps` bag `PagePreview` already computes.
- Produces: `contact_info` emits a `ContactAnswer` through `onAnswer`.

**Field flags differ per field and must be preserved exactly:** `collectName` and `collectEmail` default to **on** (`page.collectName !== false`), while `collectPhone` defaults to **off** (a truthy check). Do not "tidy" them into one form.

- [ ] **Step 1: Write the failing test**

Add to `page-preview.live.test.tsx`. Extend the existing `@rovenue/shared/funnel` import to include `type ContactAnswer`, then add the fixture and tests:

```tsx
const contactPage: Page = {
  id: "pg_c",
  type: "contact_info",
  question_id: "q_c",
  title: L("Your details"),
  collectName: true,
  collectEmail: true,
  collectPhone: false,
} as Page;
```

```tsx
  it("contact_info fields are editable in live mode", () => {
    // The defect this task fixes: every field rendered read-only, so a
    // visitor could not type their details at all.
    const onAnswer = vi.fn();
    render(<PagePreview {...base(contactPage)} mode="live" value={null} onAnswer={onAnswer} />);
    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(2); // name + email; phone is off by default
    for (const box of boxes) {
      expect(box, "a contact field is still read-only in live mode").not.toHaveAttribute("readonly");
    }
  });

  it("contact_info emits a key for every field it asks for", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(contactPage)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.type(screen.getAllByRole("textbox")[1]!, "a");

    const emitted = onAnswer.mock.lastCall![0] as ContactAnswer;
    // The key SET records what the page asked for — that is what lets
    // isAnswered decide without the page's collect* flags. So `name` must be
    // present-but-empty, and `phone` must be absent.
    expect(Object.keys(emitted).sort()).toEqual(["email", "name"]);
    expect(emitted.email).toBe("a");
    expect(emitted.name).toBe("");
  });

  it("contact_info includes phone only when the page asks for it", async () => {
    const onAnswer = vi.fn();
    const withPhone = { ...contactPage, collectPhone: true } as Page;
    render(<PagePreview {...base(withPhone)} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.type(screen.getAllByRole("textbox")[0]!, "x");
    expect(Object.keys(onAnswer.mock.lastCall![0] as ContactAnswer).sort()).toEqual([
      "email",
      "name",
      "phone",
    ]);
  });

  it("contact_info keeps the other fields when one changes", async () => {
    const onAnswer = vi.fn();
    render(
      <PagePreview
        {...base(contactPage)}
        mode="live"
        value={{ name: "Ada", email: "" }}
        onAnswer={onAnswer}
      />,
    );
    await userEvent.type(screen.getAllByRole("textbox")[1]!, "b");
    const emitted = onAnswer.mock.lastCall![0] as ContactAnswer;
    expect(emitted.name, "typing in one field discarded another").toBe("Ada");
    expect(emitted.email).toBe("b");
  });
```

And in the `describe("PagePreview — preview mode stays inert", …)` block:

```tsx
  it("keeps contact_info read-only in preview even when onAnswer is passed", () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base(contactPage)} mode="preview" onAnswer={onAnswer} />);
    for (const box of screen.getAllByRole("textbox")) {
      expect(box).toHaveAttribute("readonly");
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx -t contact_info
```
Expected: FAIL — the fields carry `readonly` and `onAnswer` is never called. The preview-mode case passes already, which is correct: it is the guard that this task does not make the canvas interactive.

- [ ] **Step 3: Wire `ContactInfoFields`**

Replace `ContactInfoFields` (locate it by content — it is the component rendering "Full name" / "you@example.com" / "+1 555 0000") with:

```tsx
/** The fields a contact page can ask for, and the order they render in.
 *  One list so the component, the emitted key set and the placeholders
 *  cannot drift apart. */
const CONTACT_FIELDS = [
  { key: "name" as const, placeholder: "Full name", type: "text" as const },
  { key: "email" as const, placeholder: "you@example.com", type: "email" as const },
  { key: "phone" as const, placeholder: "+1 555 0000", type: "tel" as const },
];

/** Which fields THIS page asks for. `collectName`/`collectEmail` default ON
 *  (`!== false`); `collectPhone` defaults OFF. That asymmetry is the existing
 *  product behaviour and is preserved deliberately. */
function asksFor(page: ResolvedPage): ReadonlyArray<(typeof CONTACT_FIELDS)[number]> {
  return CONTACT_FIELDS.filter(({ key }) => {
    if (key === "name") return page.collectName !== false;
    if (key === "email") return page.collectEmail !== false;
    return Boolean(page.collectPhone);
  });
}

const ContactInfoFields = component(
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
    const fields = asksFor(page);
    const current: ContactAnswer =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ContactAnswer)
        : {};

    // Emit a key for EVERY field this page asks for, not just the touched
    // one: the key set is what isAnswered reads to decide what was
    // requested, so a missing key would read as "never asked".
    const emit = (key: "name" | "email" | "phone", next: string) => {
      const out: ContactAnswer = {};
      for (const f of fields) out[f.key] = f.key === key ? next : (current[f.key] ?? "");
      onChange?.(out);
    };

    return (
      <div className="mt-3 flex flex-col gap-2">
        {fields.map((f) => (
          <TextField
            key={f.key}
            placeholder={f.placeholder}
            theme={theme}
            type={f.type}
            live={live}
            value={current[f.key] ?? ""}
            onChange={(next) => emit(f.key, next)}
          />
        ))}
      </div>
    );
  },
);
```

Add `ContactAnswer` to the existing `@rovenue/shared/funnel` type import at the top of `page-preview.tsx` (it already imports `AnswerValue` from there — extend that import rather than adding a second).

Update the call site from `<ContactInfoFields page={resolved} theme={theme} />` to:

```tsx
<ContactInfoFields page={resolved} theme={theme} {...liveProps} />
```

> `liveProps` (not `textLiveProps`) is correct here: the value is a `ContactAnswer`, not a string, so it must not be narrowed to a string on the way in.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: the whole file green (including the preview-mode inertness case); `tsc` clean.

- [ ] **Step 5: Mutation-check, twice**

(a) **The fields are genuinely live.** By hand, change the `TextField`'s `live={live}` to `live={false}`. Re-run Step 4's first command.
Expected: RED on "contact_info fields are editable in live mode". Restore by hand; green.

(b) **The full key set is load-bearing.** By hand, change `emit` to send only the touched field:
```tsx
      onChange?.({ [key]: next } as ContactAnswer);
```
Expected: RED on "emits a key for every field it asks for" **and** on "keeps the other fields when one changes". Restore by hand; green.
This is the important one: a single-key emit would make `isAnswered` read the page as having asked for less than it did, so a `required` contact page would advance on one filled field.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx
git commit -m "fix(dashboard): contact_info fields were read-only in the runner"
```

---

### Task 3: The `composite` answer kind, and the email pre-fill

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts` (`AnswerKind`, `OPERATORS_BY_KIND`, `PAGE_TYPES.contact_info`)
- Modify: `apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx` (a `composite` branch, and `contact_info` in `WIRED`)
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx` (`isAnswered` for the gate, `collectedEmail`)
- Test: `apps/dashboard/src/runner/contact-answer.test.tsx` (create)

**Interfaces:** consumes `isAnswered` and `ContactAnswer` from `@rovenue/shared/funnel`.

- [ ] **Step 1: Write the failing cross-layer test**

Create `apps/dashboard/src/runner/contact-answer.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { isAnswered, evaluateNext, type AnswerMap, type ContactAnswer } from "@rovenue/shared/funnel";

// =============================================================
// The runner's gate and the evaluator must agree about a composite
// =============================================================
//
// Asserting each side separately would pass even if the two definitions
// drifted apart — and drifting apart is the whole failure this shares one
// function to prevent. So feed ONE value to BOTH and compare.

function evaluatorSaysAnswered(value: ContactAnswer): boolean {
  const answers: AnswerMap = new Map([["q_c", value]]);
  const res = evaluateNext({
    page: {
      id: "pg_1",
      type: "contact_info",
      next_rules: [
        {
          id: "r_1",
          condition: { op: "all", clauses: [{ question_id: "q_c", op: "is_answered" }] },
          goto: "pg_hit",
        },
      ],
      default_next: "pg_miss",
    },
    pagesOrder: ["pg_1", "pg_hit", "pg_miss"],
    answers,
    pagesById: new Map([
      ["pg_1", { id: "pg_1", type: "contact_info" }],
      ["pg_hit", { id: "pg_hit", type: "info" }],
      ["pg_miss", { id: "pg_miss", type: "info" }],
    ]),
  });
  return res.next === "page" && res.pageId === "pg_hit";
}

describe("the runner gate and the evaluator agree on a composite", () => {
  it.each<[string, ContactAnswer]>([
    ["no keys", {}],
    ["one blank field", { email: "" }],
    ["one filled field", { email: "a@b.co" }],
    ["one filled, one blank", { email: "a@b.co", phone: "" }],
    ["both filled", { email: "a@b.co", phone: "+15550000" }],
    ["whitespace only", { name: "   " }],
  ])("%s — both layers return the same verdict", (_label, value) => {
    // isAnswered is what the runner's `required` gate calls; the evaluator
    // reaches the same function through its `is_answered` operator.
    expect(evaluatorSaysAnswered(value)).toBe(isAnswered(value));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/runner/contact-answer.test.tsx
```
Expected: PASS already for most rows, because Task 1 made the evaluator call `isAnswered`. **That is fine and is the point** — this test is the standing guard against the two drifting apart, not a driver for new code. If any row fails, `evalClause` is not routing through the shared helper and that must be fixed before continuing.

Record the outcome honestly in your report: a test that passes on arrival is still worth keeping when what it pins is an invariant, but say so rather than implying it drove the change.

- [ ] **Step 3: Add the `composite` kind**

In `types.ts`:

```ts
export type AnswerKind = "text" | "choice" | "multi" | "number" | "date" | "composite" | "none";
```

Add to `OPERATORS_BY_KIND`, after `date` and before `none`:

```ts
  // A composite answer is an object, so every comparison operator refuses
  // it — offering one would be a writable dead rule. "Did they give their
  // details?" is the question this page can actually answer.
  composite: ["is_answered", "is_not_answered"],
```

Reclassify the page type:

```ts
  contact_info: { label: "Contact info", icon: Contact, tone: "", answerKind: "composite" },
```

- [ ] **Step 4: Teach the sync test about `composite`**

`contact_info` is no longer `none`, so the sync test's coverage assertion now requires it in `WIRED`. Add the row:

```tsx
  {
    type: "contact_info",
    drive: (u) => u.type(screen.getAllByRole("textbox")[0]!, "a"),
  },
```

and add a branch to the shape assertion, alongside the existing `multi` / `number` / `date` ones:

```tsx
      } else if (kind === "composite") {
        // An object whose values are all strings. Falling through to the
        // string default would fail for the right reason with a confusing
        // message.
        expect(typeof emitted, `${wired.type} is composite but emitted a non-object`).toBe("object");
        expect(Array.isArray(emitted), `${wired.type} is composite but emitted an array`).toBe(false);
        for (const v of Object.values(emitted as Record<string, unknown>)) {
          expect(typeof v, `${wired.type} emitted a non-string field`).toBe("string");
        }
```

- [ ] **Step 5: Use the shared gate and widen the email pre-fill in the runner**

In `apps/dashboard/src/runner/funnel-runner.tsx`, extend the existing `@rovenue/shared/funnel` import to bring in `isAnswered` and `type ContactAnswer`, then replace the inline gate:

```tsx
  const answered = isAnswered(currentAnswer);
```

Replace the `collectedEmail` block. The tie-break comment stays because its reasoning still holds; only the sentence excluding `contact_info` goes, since the wiring gap it named no longer exists:

```tsx
  // The email PaymentStep should pre-fill. Tie-break is deliberate: a
  // funnel may legitimately have more than one email source, and "last in
  // PAGE ORDER" is deterministic where "most recently answered" would
  // depend on back-navigation. A contact_info page is one such source and
  // takes part in the same ordering rather than getting its own precedence.
  const collectedEmail = useMemo(() => {
    const pages = (state?.config.pages ?? []) as Array<{
      type?: string;
      question_id?: string;
    }>;
    let found: string | undefined;
    for (const p of pages) {
      if (!p.question_id) continue;
      const v = answers[p.question_id];
      if (p.type === "email") {
        if (typeof v === "string" && v.trim()) found = v.trim();
      } else if (p.type === "contact_info") {
        const email = (v as ContactAnswer | undefined)?.email;
        if (typeof email === "string" && email.trim()) found = email.trim();
      }
    }
    return found;
  }, [state?.config.pages, answers]);
```

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/ src/runner/
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/shared exec vitest run src/funnel/
```
Expected: all green except the known `FunnelPreviewViewModel > jumps via 'paywall' literal goto`; `tsc` clean.

Two existing tripwires should now cover the new kind without being edited — confirm they do, and say so:
- the derived "every answering kind offers the unary operators" loop in `answer-kind.test.ts` picks `composite` up from `OPERATORS_BY_KIND`;
- the sync test's coverage assertion forced `contact_info` into `WIRED` in Step 4.

- [ ] **Step 7: Mutation-check, twice**

(a) **The email pre-fill really reads a contact page.** By hand, delete the `else if (p.type === "contact_info")` branch. Re-run the runner suite.
Expected: RED on whichever test covers the contact email pre-fill. If **nothing** reds, the pre-fill is untested — add a test for it before continuing and say so in your report. Restore by hand.

(b) **The runner uses the shared gate.** By hand, revert `answered` to the old inline four-way expression. Re-run.
Expected: RED on the cross-layer test's composite rows, because the inline version calls a blank-field object answered while `isAnswered` does not. Restore by hand; green.

- [ ] **Step 8: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/types.ts \
        apps/dashboard/src/components/funnel-builder/answer-kind.sync.test.tsx \
        apps/dashboard/src/runner/funnel-runner.tsx \
        apps/dashboard/src/runner/contact-answer.test.tsx
git commit -m "feat(dashboard): contact_info answers count, and pre-fill checkout email"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (answer shape; `ContactAnswer`; no API change; no migration) → Task 1 Step 3, plus the Global Constraints ban. ✅
- Item 2 (one definition of answered; shared `isAnswered`; key-set rule) → Task 1 entirely, plus Task 3's cross-layer test as the standing guard. ✅
- Item 3 (fields editable, composite emitted, preview stays inert, flag asymmetry preserved) → Task 2. ✅
- Item 4 (`answerKind: "composite"`; only the unary operators; both tripwires cover it) → Task 3 Steps 3, 4, 6. ✅
- Item 5 (`collectedEmail` reads a contact page; tie-break kept; stale comment removed not reworded) → Task 3 Step 5. ✅
- Spec's testing list (the defect first, `isAnswered` table, both callers agree, preview inert, `collectedEmail`) → Tasks 1-3. ✅
- Spec's out-of-scope (sub-field branching, format validation, splitting the page, changing operator meanings) → no task touches any. ✅

**Placeholder scan:** no TBD/TODO; every code step carries complete code. Two steps deliberately branch on a measurement rather than prescribing an outcome — Task 1 Step 5(b) and Task 3 Step 7(a) — and both state the decision rule and require the finding be reported, which is the opposite of a placeholder: they exist because the honest answer is not knowable until run. ✅

**Type consistency:** `ContactAnswer` is declared once in `evaluator.ts` and imported by name in `page-preview.tsx`, the live test, the runner and the cross-layer test. `isAnswered(value: AnswerValue | undefined): boolean` has one signature, called by `evalClause` and the runner gate. `AnswerKind` gains exactly `"composite"`, matching `PAGE_TYPES.contact_info.answerKind`, the `OPERATORS_BY_KIND` row and the sync test's new branch. The field keys `name`/`email`/`phone` appear in `ContactAnswer`, `CONTACT_FIELDS` and `asksFor` and nowhere else. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-sp9-contact-info.md`.
