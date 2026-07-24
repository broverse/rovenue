# SP4 — Runner input capture (core subset) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public funnel runner capture real answers for five input page types, send them with the advance that evaluates them, and hand the collected email to the payment step.

**Architecture:** `POST /advance` gains an optional `answer` so the server records it before it reads the answer map — the ordering that branching depends on becomes impossible to get wrong from the client. `PagePreview` gains an explicit `mode` and a `value`/`onAnswer` pair; in `preview` mode every input keeps today's inert behaviour byte for byte. The runner holds a `questionId → value` map, sends the current page's answer with the advance, gates the CTA on `required`, and passes the email answer to `PaymentStep`.

**Tech Stack:** Hono, Zod, PostgreSQL (Drizzle), React (Vite), Vitest.

Spec: `docs/superpowers/specs/2026-07-24-sp4-runner-input-capture-design.md`

## Global Constraints

- TypeScript strict everywhere. Zod for API input. Responses are `{ data: T }` via `ok()` or `{ error: { code, message } }`.
- Postgres access via Drizzle repositories only (`packages/db/src/drizzle/repositories`). Raw `sql` must qualify columns.
- **No magic values.** A literal carrying meaning — a byte cap, a page type, a session state — gets a named constant next to its siblings. Structured data tables and fixture ids are not magic values.
- All user-facing strings go through i18n. No hardcoded copy in components.
- Conventional commits, one commit per task. **Stay on the current branch (`main`). Do NOT create branches or worktrees.** Another author commits to `main` in parallel — `git add` only the files your task names, never `git add -A`, and run `git status --short` before committing to confirm nothing else is staged (a plain `git commit` commits the whole index).
- Test invocation: packages have no `vitest` script — use `pnpm --filter <pkg> exec vitest run <path>`, never `pnpm --filter <pkg> vitest run <path>`.
- API route tests live in `apps/api/tests/`, a separate directory from `apps/api/src`. Component tests colocate with their source.
- **Every change must be mutation-checked**: after the test passes, revert the production change, confirm the test goes red, then restore. A test that passes on unfixed code proves nothing.
- No new migration anywhere in this plan. Do NOT run `drizzle-kit generate`.
- **`POST /public/funnel-sessions/:id/answers` is not to be changed or removed.** It remains the way to record an answer without advancing.

---

### Task 1: `/advance` accepts an optional answer

**Files:**
- Modify: `apps/api/src/routes/public/funnels.ts:403-455`
- Test: `apps/api/tests/funnel-advance-answer.test.ts` (create)

**Interfaces:**
- Consumes: `funnelAnswerRepo.upsert(db, { sessionId, pageId, questionId, answerJson })`, `evaluateNext({ page, pagesOrder, answers, pagesById })`.
- Produces: `POST /public/funnel-sessions/:sessionId/advance` accepting `{ from_page_id: string, answer?: { question_id: string, answer: unknown } }`.

**Background the implementer needs:**

The handler currently reads the session, loads the version's pages, lists the session's answers into an `AnswerMap`, and calls `evaluateNext`. Branching is evaluated **from the server's own answers table** — `evalClause` does `answers.get(clause.question_id)` (`packages/shared/src/funnel/evaluator.ts:100-101`).

That is why the answer has to arrive with the advance rather than in a separate call before it. A client that advanced before recording would branch on the *previous* answer — silently, and only on the first transition through each page. Writing before the read here removes the ordering entirely: there is no sequence for a caller to get wrong.

The sibling `/answers` endpoint (`funnels.ts:362-399`) applies two protections that must apply here too: a 16 KB cap on the serialised answer, and a rejection when `session.state !== "in_progress"`. A cap enforced on one door and not the other is not a cap. Read that handler and mirror both.

`answerValueSchema` already exists at `funnels.ts:54`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/funnel-advance-answer.test.ts`. Read a sibling in `apps/api/tests/` first and follow its app-construction and mocking idiom — that directory has an established harness and inventing a second one is a defect.

The assertions the test must make:

```ts
  it("records the answer before evaluating, so a rule keyed on it matches", async () => {
    // Seed a page whose next_rules route to "pg_yes" when question "q1"
    // equals "yes", and whose default_next is "pg_no".
    // POST /advance with { from_page_id: "pg_1", answer: { question_id: "q1", answer: "yes" } }
    expect(res.status).toBe(200);
    const body = await res.json();
    // The whole point: the answer sent WITH this call steered this call.
    expect(body.data.page_id).toBe("pg_yes");
  });

  it("still advances with no answer, exactly as before", async () => {
    // POST /advance with { from_page_id: "pg_1" } and no answer key
    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects an answer payload over 16 KB", async () => {
    // answer: "x".repeat(17_000)
    expect(res.status).toBe(413);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects an answer when the session is closed", async () => {
    // session.state = "completed"
    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
  });
```

Each case asserts on `upsertMock` as well as the status, so a handler that returns the right code while still writing (or vice versa) fails. A status-only assertion here would pass on broken code — that has happened twice already on this project.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts
```

Expected: the branching case FAILS — the request body's `answer` key is stripped by the current schema, so nothing is recorded and evaluation falls to `default_next` (`pg_no`).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/public/funnels.ts`, replace the advance handler's validator and add the write.

The validator becomes:

```ts
    validate(
      "json",
      z.object({
        from_page_id: z.string(),
        // Optional so the Phase-1 click-through shape keeps working. When
        // present it is written BEFORE the answer map is read below, so a
        // rule keyed on this answer sees it on this very call. That
        // ordering is the reason the answer rides along instead of going
        // through /answers first: a client that advanced before recording
        // would branch on the PREVIOUS answer, silently, and only on the
        // first pass through each page.
        answer: z
          .object({ question_id: z.string(), answer: answerValueSchema })
          .optional(),
      }),
    ),
```

Inside the handler, after the `if (!session)` guard and **before** `listBySession`:

```ts
      if (body.answer) {
        // Same two protections the sibling /answers endpoint applies. A
        // cap enforced on one door and not the other is not a cap.
        if (JSON.stringify(body.answer.answer).length > ANSWER_MAX_BYTES) {
          throw new HTTPException(413, { message: "Answer payload too large" });
        }
        if (session.state !== "in_progress") {
          throw new HTTPException(409, { message: "Session is closed" });
        }
        await drizzle.funnelAnswerRepo.upsert(drizzle.db, {
          sessionId: sid,
          pageId: body.from_page_id,
          questionId: body.answer.question_id,
          answerJson: { value: body.answer.answer },
        });
      }
```

Hoist the byte cap into a named constant beside the existing handlers and use it in **both** places — the `/answers` handler currently inlines `16_384`:

```ts
/** Hard cap on a serialised answer payload (F16). */
const ANSWER_MAX_BYTES = 16_384;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Mutation-check the ordering**

Move the `if (body.answer) { … }` block to **after** the `listBySession` call, re-run Step 4, and confirm the branching case goes red (it will route to `pg_no`, the default) while the other three stay green. Restore and confirm 4/4.

This is the mutation that matters: it proves the test pins *when* the write happens, not merely that it happens. Record both observed outcomes verbatim.

- [ ] **Step 6: Confirm `/answers` still works**

```bash
pnpm --filter @rovenue/api exec vitest run tests/ --reporter=basic 2>&1 | tail -20
```

Report the result. If a pre-existing test fails, say whether your change caused it. The `/answers` endpoint must be untouched — a diff that modifies or removes it is out of scope.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/public/funnels.ts apps/api/tests/funnel-advance-answer.test.ts
git status --short
git commit -m "feat(api): /advance accepts the answer it will evaluate"
```

---

### Task 2: `PagePreview` gains an explicit mode and five live inputs

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/page-preview.tsx`
- Test: `apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PagePreview` accepting `mode?: "preview" | "live"` (default `"preview"`), `value?: AnswerValue`, `onAnswer?: (value: AnswerValue) => void`, where `AnswerValue = string | number | boolean | string[] | null`.

`AnswerValue` is declared in `packages/shared/src/funnel/evaluator.ts:3` and
re-exported by `packages/shared/src/funnel/index.ts:4` (`export * from "./evaluator"`).
Import it from the funnel subpath. Confirm the exact specifier the dashboard already
uses for `@rovenue/shared` funnel types before writing the import, and say in your
report if it differs from what you expected.

**Background the implementer needs:**

`page-preview.tsx` is 1006 lines and serves two contexts already, through `editable` (builder edit affordances) and `onAdvance` (a live CTA). It gains a third axis: whether its **inputs** are live.

**Mode is an explicit parameter, not an inference.** Do not make the inputs live merely because `onAnswer` was passed. The builder canvas's inertness must be stated, not a side effect of a callback being absent — otherwise someone passing `onAnswer` for an unrelated reason silently makes the builder's preview interactive. Default `mode` to `"preview"` so every existing call site is unchanged.

The five types render through three leaf components:

| Page type | Leaf | Line |
|---|---|---|
| `single_choice`, `multi_choice` | `ChoiceListReadOnly` | ~331 |
| `yes_no` | `YesNoButtons` | ~337 |
| `email` | `TextField` | ~370 |
| `short_text` | `TextField` | ~360 |
| `text_input` | `TextField` | ~390 |

Give each leaf an optional `value` + `onChange`, and pass them from `PagePreview` only when `mode === "live"`. Answer shapes: `single_choice` → the chosen `option.value` (`types.ts:211`), `multi_choice` → `string[]` of values, `yes_no` → `boolean`, the three text types → `string`.

`TextField` is currently `readOnly` (line ~921). In `preview` mode it stays `readOnly`; in `live` mode it becomes a controlled input.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx`. Read a sibling component test in this directory first and follow its render harness. The assertions:

```tsx
  it("captures a text answer in live mode", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base} page={emailPage} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.type(screen.getByRole("textbox"), "a@b.com");
    expect(onAnswer).toHaveBeenLastCalledWith("a@b.com");
  });

  it("keeps text inputs read-only in preview mode", () => {
    const onAnswer = vi.fn();
    // onAnswer is passed DELIBERATELY: mode, not the callback's presence,
    // is what decides. If this ever goes live the builder canvas has
    // become interactive.
    render(<PagePreview {...base} page={emailPage} mode="preview" onAnswer={onAnswer} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });

  it("captures a single choice as the option's value", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base} page={singleChoicePage} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).toHaveBeenLastCalledWith("opt_b");
  });

  it("accumulates multi-choice selections and removes on re-click", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base} page={multiChoicePage} mode="live" value={["opt_a"]} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).toHaveBeenLastCalledWith(["opt_a", "opt_b"]);
  });

  it("captures yes/no as a boolean", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base} page={yesNoPage} mode="live" value={null} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Yes"));
    expect(onAnswer).toHaveBeenLastCalledWith("yes");
  });

  it("does not fire onAnswer from a preview-mode choice click", async () => {
    const onAnswer = vi.fn();
    render(<PagePreview {...base} page={singleChoicePage} mode="preview" onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Option B"));
    expect(onAnswer).not.toHaveBeenCalled();
  });
```

Build `base` from the props `PagePreview` already requires (`page`, `theme`, `pages`, `locale`, `defaultLocale`) using the shapes in `types.ts`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx
```

Expected: FAIL — `mode` is not a prop and no input reports a value.

- [ ] **Step 3: Add the props and thread them to the three leaves**

Add to the `Props` type (after `chrome`, ~line 118):

```ts
  // Whether this preview's INPUTS are live. Deliberately explicit rather
  // than inferred from `onAnswer` being present: the builder canvas's
  // inertness is a requirement, not a side effect of a callback being
  // absent, and inferring it means anyone who passes `onAnswer` for an
  // unrelated reason silently makes the canvas interactive.
  mode?: "preview" | "live";
  // The current answer for this page, when `mode` is "live".
  value?: AnswerValue;
  onAnswer?: (value: AnswerValue) => void;
```

Destructure with `mode = "preview"`. Give `ChoiceListReadOnly`, `YesNoButtons` and `TextField` optional `value`/`onChange` parameters, and at each of the five call sites pass them only when `mode === "live"`.

`multi_choice` toggles: clicking an option adds its value when absent and removes it when present, preserving the existing order of the rest.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/page-preview.live.test.tsx
```

Expected: PASS, 6/6.

- [ ] **Step 5: Prove the builder canvas did not change**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
```

Expected: every pre-existing test in that directory still passes. If one fails, the builder's preview behaviour changed — report it rather than adjusting the test.

- [ ] **Step 6: Mutation-check the mode gate**

Change the live branch's condition from `mode === "live"` to `onAnswer !== undefined`, re-run Step 4, and confirm the two `preview`-mode cases go red (they pass `onAnswer` deliberately). Restore and confirm 6/6. Record both observed outcomes.

This is the mutation that proves the mode parameter is load-bearing rather than decorative.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx \
        apps/dashboard/src/components/funnel-builder/page-preview.live.test.tsx
git status --short
git commit -m "feat(dashboard): PagePreview captures answers in live mode"
```

---

### Task 3: the runner captures, sends, gates and hands off

**Files:**
- Modify: `apps/dashboard/src/runner/runner-api.ts:199-207`
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx`
- Test: `apps/dashboard/src/runner/__tests__/funnel-runner.answers.test.tsx` (create)

**Interfaces:**
- Consumes: `POST /advance` with `{ from_page_id, answer? }` from Task 1; `PagePreview`'s `mode` / `value` / `onAnswer` from Task 2.
- Produces: nothing downstream.

**Background the implementer needs:**

`funnel-runner.tsx` holds session state and renders `<PagePreview>` with `onAdvance`. Its header comment (lines 10-12) declares Phase-1 click-through scope — **update it**, it will otherwise describe code that no longer exists.

Four changes:

1. **Answer state.** A `questionId → AnswerValue` map in the runner. Keyed by question id, not page id, because that is what branching rules use.
2. **Send with the advance.** `advanceSession` gains an optional third argument and forwards it. Submit only when `page.question_id` is present — see below.
3. **Required gate.** When `page.required` is set, the CTA is disabled until an answer exists for that page. This is UX; the server answers an unanswered advance with `default_next`, which is defined behaviour, so a bypass corrupts nothing.
4. **Email to `PaymentStep`.** `PaymentStep` already takes `collectedEmail` (`payment-step.tsx:68-72`) and asks when it is absent. Pass the answer belonging to the **last `email`-typed page in page order** that has been answered. State the tie-break in a comment: a funnel may legitimately have several email pages, and "last in page order" is deterministic where "most recently answered" would depend on back-navigation.

**Do not add a `question_id ?? page.id` fallback.** `blank-page.ts` assigns a `question_id` to every input page type, including the grouped cases. If it is somehow absent — a hand-edited config, or a page type someone forgot to wire — skip the submission rather than inventing a key. A row keyed by page id can never match a branching rule and would show a page id under a column meaning question id in both answer consumers (`funnel-claim.ts:357`, `dashboard/funnels.ts:685`). A misleading row is worse than an absent one.

- [ ] **Step 1: Extend the client function**

In `apps/dashboard/src/runner/runner-api.ts`, replace `advanceSession`:

```ts
export function advanceSession(
  sessionId: string,
  fromPageId: string,
  answer?: { question_id: string; answer: unknown },
): Promise<AdvanceResponse> {
  return request<AdvanceResponse>(
    `/public/funnel-sessions/${encodeURIComponent(sessionId)}/advance`,
    {
      method: "POST",
      body: JSON.stringify({
        from_page_id: fromPageId,
        ...(answer ? { answer } : {}),
      }),
    },
  );
}
```

The spread keeps the key absent rather than sending `answer: undefined`, so the Phase-1 request shape is byte-identical when there is no answer.

`submitAnswer` stays exactly as it is — it is the record-without-advancing path and is not this task's business.

- [ ] **Step 2: Write the failing test**

Create `apps/dashboard/src/runner/__tests__/funnel-runner.answers.test.tsx`. Read the sibling tests in that directory first (`funnel-runner.paid.test.tsx`, `funnel-runner.locale.test.tsx`) and follow their mock setup. The assertions:

```tsx
  it("sends the answer with the advance, not in a separate call", async () => {
    // render a funnel whose first page is an email page with question_id "q_email"
    await userEvent.type(screen.getByRole("textbox"), "a@b.com");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(advanceSessionMock).toHaveBeenCalledWith("sess_1", "pg_1", {
      question_id: "q_email",
      answer: "a@b.com",
    });
    // The ordering invariant lives on the server precisely so the client
    // has no sequence to get wrong — there must be no separate call.
    expect(submitAnswerMock).not.toHaveBeenCalled();
  });

  it("disables the CTA on a required page until it is answered", async () => {
    // first page: required email page
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "a@b.com");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("advances with no answer key when the page has no question_id", async () => {
    // an info page, no question_id
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(advanceSessionMock).toHaveBeenCalledWith("sess_1", "pg_info");
  });

  it("hands the collected email to the payment step", async () => {
    // answer the email page, advance to the paywall page
    expect(paymentStepProps.email).toBe("a@b.com");
  });
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/runner/__tests__/funnel-runner.answers.test.tsx
```

Expected: FAIL — the runner renders `PagePreview` without `mode`, so nothing is typed, and `advanceSession` is called with two arguments.

- [ ] **Step 4: Implement**

In `funnel-runner.tsx`: hold the answer map in state; pass `mode="live"`, `value` and `onAnswer` to `<PagePreview>`; on advance, look up `currentPage.question_id` and send the answer when both it and a recorded value exist; disable the CTA when `currentPage.required` and no answer; pass the email to `PaymentStep`.

Rewrite the header comment (lines 10-12) — it currently declares Phase-1 click-through scope and would be describing code that no longer exists.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/runner/
```

Expected: PASS, including every pre-existing runner test.

- [ ] **Step 6: Mutation-check**

Two parts. First: change the advance call to always omit the answer, re-run Step 5, confirm the first case goes red. Second: remove the `required` gate, re-run, confirm the CTA case goes red. Restore after each and confirm green. Record all four observed outcomes.

- [ ] **Step 7: Typecheck and build**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm build --filter @rovenue/dashboard
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/runner/runner-api.ts \
        apps/dashboard/src/runner/funnel-runner.tsx \
        apps/dashboard/src/runner/__tests__/funnel-runner.answers.test.tsx
git status --short
git commit -m "feat(dashboard): the runner captures answers and sends them with the advance"
```

---

### Task 4: whole-change verification

**Files:** none modified — this task produces a report.

- [ ] **Step 1: Run every changed-area suite on a quiet machine**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts tests/funnel-payment-intent.test.ts
pnpm --filter @rovenue/dashboard exec vitest run src/runner/ src/components/funnel-builder/
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm build --filter @rovenue/dashboard
```

Record pass/fail counts per suite **verbatim**. Do not summarise a red run as green; if something fails, show the output and say whether this work caused it or it is pre-existing.

- [ ] **Step 2: Confirm branching actually works end to end**

The sub-project's real deliverable is that an answer steers the funnel. Verify it at the seam rather than only in unit tests: establish from the code that an answer submitted by the runner reaches `evalClause`'s `answers.get(clause.question_id)` with the same key the builder writes into `next_rules`. State exactly how you established it — which files you read and what you found.

If you find a mismatch, that is a finding. Report it; do not fix it.

- [ ] **Step 3: Confirm `/answers` is untouched**

```bash
git diff ebc4c4d6..HEAD -- apps/api/src/routes/public/funnels.ts
```

Read the diff and confirm the `POST /answers` handler's behaviour is unchanged — the only expected edit near it is the byte cap being hoisted into a shared constant. Report what you found.

- [ ] **Step 4: Append the ledger entry**

Append to `.superpowers/sdd/progress-sp1-sp2.md` — **not** `.superpowers/sdd/progress.md`, which is shared with a parallel workstream and has been clobbered three times. Record the commits, each task's mutation-check outcome, the Step 2 finding, and anything left open.

Note `.superpowers/` is gitignored. If `git add` refuses the path, **do not force-add it** — report that it could not be committed and leave it on disk. That is the correct outcome.

---

## Notes for the reviewer

- Task 1's mutation moves the write after the read. If the branching test still passes with the write moved, the test does not pin the ordering and the task's whole point is unverified.
- Task 2's `mode` must be a parameter, not an inference from `onAnswer`. Reject a diff where passing `onAnswer` alone makes inputs live — two tests pass `onAnswer` in `preview` mode specifically to catch that.
- Task 3 must **not** introduce a `question_id ?? page.id` fallback. Reject one that does.
- `POST /answers` must survive unchanged.
- Every task carries a mutation-check step. A report that omits the mutation-check outcome is incomplete regardless of how many tests pass.
