# Paywall Localization Severity Split (P2-fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a blank default-locale string from blocking the builder's autosave, while still blocking publish — by splitting "absent" from "blank" into two issue codes on two severity tiers.

**Architecture:** `packages/shared`'s validator gains a single severity table (`save` ⊃ `publish` ⊃ `warning`) and a second predicate. The API's publish route and the dashboard's `errorIssues` move onto the publish predicate; the API's PATCH save route keeps `isBlockingIssue`, which is narrowed. A new `EMPTY_LOC_VALUE` code carries the blank case at the publish-only tier. The `LOCALE_KEY_GAP` loop is scoped to keys the tree actually uses.

**Tech Stack:** TypeScript (strict), Vitest, Hono + Zod (API), React + `impair` DI (dashboard), `react-i18next`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-paywall-loc-severity-split-design.md`.
- **The fence that caused the original bug is deliberately lifted:** this change spans `packages/shared/`, `apps/api/` and `apps/dashboard/`. A change to the shared validator's severity model is a cross-consumer change.
- TypeScript strict. Responses `{ data }` / `{ error }`.
- **No magic values** — issue codes and the severity table are structured data, not magic values.
- Every user-facing string via `t(key, "English fallback")`, and **every new `t()` key must be added to `apps/dashboard/src/i18n/locales/en.json` in the same commit** — that file was just backfilled from 52 missing keys to zero for this directory (`a7e64cc3`).
- No DB change, no migration, no SDK/wire change.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`.
- Conventional commits; commit per task.

## Task ordering is load-bearing

The tasks are ordered so **no intermediate commit weakens the publish gate**:

1. The severity model is refactored with no code classified `publish` yet — a pure refactor, behaviour identical.
2. The publish consumers are swapped onto `isPublishBlockingIssue` while the two predicates still agree — again behaviour identical, but the call sites are now correct.
3. The new code is declared (union + severity entry) and the drawer learns its label — inert, because nothing emits it. The declaration must live here, not with the emission: a `switch` case for a code outside the union is a TypeScript error.
4. Only now is `EMPTY_LOC_VALUE` emitted. Every consumer is already in the right place, so the behaviour change lands atomically and correctly.
5. The dashboard consumer is pinned by tests.
6. The gap loop is scoped last, independent of the above.

Do not reorder. Introducing `EMPTY_LOC_VALUE` before step 2 would make blank block neither save nor publish.

---

## File Structure

**Modify:**
- `packages/shared/src/paywall/validate.ts` — severity table, both predicates, the new code, the absent/blank split, the gap-loop scoping.
- `packages/shared/src/paywall/validate.test.ts` — tests for each.
- `apps/api/src/routes/dashboard/paywalls.ts` — publish gate onto `isPublishBlockingIssue`.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — `errorIssues` / `warningIssues`.
- `apps/dashboard/src/components/paywall-builder/validation-drawer.tsx` — `issueTitle()` cases.
- `apps/dashboard/src/i18n/locales/en.json` — the two new/changed label keys.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` — the dashboard-side gate tests.

**Create:**
- `apps/api/tests/paywall-builder-severity.integration.test.ts` — the gate tests whose absence let the bug ship.

---

### Task 1: Severity table replaces the two-set model

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type IssueSeverity = "save" | "publish" | "warning"`
  - `export function issueSeverity(issue: { code: string }): IssueSeverity`
  - `export function isBlockingIssue(issue: { code: string }): boolean` — unchanged signature, now `issueSeverity(issue) === "save"`
  - `export function isPublishBlockingIssue(issue: { code: string }): boolean` — `issueSeverity(issue) !== "warning"`
  - `WARNING_ISSUE_CODES` is **removed**.

This task is a pure refactor: no code is classified `publish` yet, so both predicates agree on every existing code and no behaviour changes.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("issue severity", () => {
  it("classifies every currently-emitted code", () => {
    expect(issueSeverity({ code: "DUPLICATE_NODE_ID" })).toBe("save");
    expect(issueSeverity({ code: "UNKNOWN_LOC_KEY" })).toBe("save");
    expect(issueSeverity({ code: "FOREIGN_PACKAGE_ID" })).toBe("save");
    expect(issueSeverity({ code: "MISSING_PURCHASE_BUTTON" })).toBe("save");
    expect(issueSeverity({ code: "SCHEMA_INVALID" })).toBe("save");
    expect(issueSeverity({ code: "CELL_TEMPLATE_BAD_NODE" })).toBe("save");
    expect(issueSeverity({ code: "OVERRIDE_BAD_PROP" })).toBe("save");
    expect(issueSeverity({ code: "LOCALE_KEY_GAP" })).toBe("warning");
    expect(issueSeverity({ code: "OVERRIDE_SELECTED_OUTSIDE_CELL" })).toBe("warning");
    expect(issueSeverity({ code: "INTRO_VARIABLE_UNGUARDED" })).toBe("warning");
  });

  it("defaults an unclassified code to the strictest tier", () => {
    expect(issueSeverity({ code: "SOME_CODE_ADDED_LATER" })).toBe("save");
    expect(isBlockingIssue({ code: "SOME_CODE_ADDED_LATER" })).toBe(true);
  });

  it("keeps the tiers ordered: everything that blocks a save blocks a publish", () => {
    for (const code of [
      "DUPLICATE_NODE_ID",
      "UNKNOWN_LOC_KEY",
      "FOREIGN_PACKAGE_ID",
      "MISSING_PURCHASE_BUTTON",
      "SCHEMA_INVALID",
      "CELL_TEMPLATE_BAD_NODE",
      "OVERRIDE_BAD_PROP",
      "LOCALE_KEY_GAP",
      "OVERRIDE_SELECTED_OUTSIDE_CELL",
      "INTRO_VARIABLE_UNGUARDED",
      "SOME_CODE_ADDED_LATER",
    ]) {
      if (isBlockingIssue({ code })) expect(isPublishBlockingIssue({ code })).toBe(true);
    }
  });

  it("warnings block neither gate", () => {
    expect(isBlockingIssue({ code: "LOCALE_KEY_GAP" })).toBe(false);
    expect(isPublishBlockingIssue({ code: "LOCALE_KEY_GAP" })).toBe(false);
  });
});
```

Add `issueSeverity` and `isPublishBlockingIssue` to the file's existing import from `./validate`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: FAIL — `issueSeverity is not a function` (it does not exist yet).

- [ ] **Step 3: Replace the set with the table**

In `packages/shared/src/paywall/validate.ts`, delete this whole block:

```ts
/**
 * Issue codes that do NOT block a save: the builderConfig still persists
 * (the API answers 200) and the dashboard renders them as warnings rather
 * than errors. Shared so the API gate and the builder view-model can never
 * drift apart — they used to keep hand-synced copies.
 *
 * Deliberately `ReadonlySet<string>` rather than
 * `ReadonlySet<BuilderIssue["code"]>`: `INTRO_VARIABLE_UNGUARDED` is spec'd
 * (Phase D3's intro-variable lint) but not yet emitted by
 * `validateBuilderConfig`, so membership stays forward-tolerant instead of
 * becoming a type error the day the validator starts emitting it.
 */
export const WARNING_ISSUE_CODES: ReadonlySet<string> = new Set([
  "LOCALE_KEY_GAP",
  "OVERRIDE_SELECTED_OUTSIDE_CELL",
  "INTRO_VARIABLE_UNGUARDED",
]);

/** True when an issue must block the save (i.e. it isn't a warning). */
export function isBlockingIssue(issue: { code: string }): boolean {
  return !WARNING_ISSUE_CODES.has(issue.code);
}
```

and put this in its place:

```ts
/**
 * How far an issue stops the author:
 * - `save`    — the builderConfig cannot even persist. A broken config.
 * - `publish` — persists fine, but must not ship to devices. A legitimate
 *               work-in-progress, e.g. copy nobody has written yet.
 * - `warning` — blocks nothing.
 *
 * The tiers are ordered: everything that blocks a save also blocks a publish.
 */
export type IssueSeverity = "save" | "publish" | "warning";

/**
 * The single severity table. A code appears at most once, so the tiers cannot
 * overlap — the earlier shape (a warning set plus a publish set, each predicate
 * a negation over them) let a code land in both and silently degrade to a
 * warning, i.e. the strictest-looking mistake produced the loosest behaviour.
 *
 * Deliberately keyed `string` rather than `BuilderIssue["code"]`:
 * `INTRO_VARIABLE_UNGUARDED` is spec'd (Phase D3's intro-variable lint) but not
 * yet emitted by `validateBuilderConfig`, so membership stays forward-tolerant
 * instead of becoming a type error the day the validator starts emitting it.
 */
const ISSUE_SEVERITY: Readonly<Record<string, IssueSeverity>> = {
  LOCALE_KEY_GAP: "warning",
  OVERRIDE_SELECTED_OUTSIDE_CELL: "warning",
  INTRO_VARIABLE_UNGUARDED: "warning",
};

/** Anything unlisted blocks the save — the strictest tier, so a code added
 * later fails closed until it is deliberately classified. */
export function issueSeverity(issue: { code: string }): IssueSeverity {
  return ISSUE_SEVERITY[issue.code] ?? "save";
}

/** True when an issue must block the SAVE (the API's builderConfig PATCH). */
export function isBlockingIssue(issue: { code: string }): boolean {
  return issueSeverity(issue) === "save";
}

/** True when an issue must block a PUBLISH — every save-blocker, plus the
 * publish-only tier. */
export function isPublishBlockingIssue(issue: { code: string }): boolean {
  return issueSeverity(issue) !== "warning";
}
```

- [ ] **Step 4: Run the shared suite to verify it passes**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall`
Expected: PASS — the 4 new severity tests plus every pre-existing validator test unchanged. If any pre-existing test now fails, STOP: this task is a pure refactor and a failure means the tiers were transcribed wrong.

- [ ] **Step 5: Typecheck the consumers**

Run:
```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: all exit 0. `WARNING_ISSUE_CODES` was removed — a repo-wide grep found it referenced only inside `validate.ts` itself, so nothing should break. If something does, report it rather than re-adding the export.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts
git commit -m "refactor(shared): one severity table for builder issues, plus a publish-only tier"
```

---

### Task 2: Move the publish consumers onto `isPublishBlockingIssue`

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`

**Interfaces:**
- Consumes: `isPublishBlockingIssue` (Task 1).
- Produces: the API publish route and the view model's `errorIssues` / `warningIssues` gate on publish severity; the API PATCH route still gates on `isBlockingIssue`.

Still no behaviour change — nothing is classified `publish` yet, so the two predicates agree. This task exists to get the call sites right **before** Task 4 makes them differ.

- [ ] **Step 1: Swap the API publish gate**

In `apps/api/src/routes/dashboard/paywalls.ts`, widen the existing `@rovenue/shared/paywall` import:

```ts
import {
  builderConfigSchema,
  diffBuilderConfigs,
  isBlockingIssue,
  isPublishBlockingIssue,
  validateBuilderConfig,
} from "@rovenue/shared/paywall";
```

Leave the PATCH gate in `prepareBuilderConfigPatch` **exactly as it is** — it must keep using `isBlockingIssue`:

```ts
  const issues = validateBuilderConfig(parsed.data, { offeringPackageIds });
  if (issues.some(isBlockingIssue)) {
```

In the publish route, change only the predicate:

```ts
    const issues = validateBuilderConfig(parsed.data, {
      offeringPackageIds: extractOfferingPackageIds(offering),
    });
    if (issues.some(isPublishBlockingIssue)) {
      throw new HTTPException(400, {
        message: JSON.stringify({ code: "PAYWALL_NOT_PUBLISHABLE", issues }),
      });
    }
```

- [ ] **Step 2: Swap the view model**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, add `isPublishBlockingIssue` to the existing `@rovenue/shared/paywall` import, then change the two derived getters:

```ts
  @derived get errorIssues() {
    return this.validationIssues.filter(isPublishBlockingIssue);
  }
  @derived get warningIssues() {
    return this.validationIssues.filter((i) => !isPublishBlockingIssue(i));
  }
```

`errorIssues` feeds `canPublish`, the drawer's error list and the top-bar's red count — all three are publish-facing, which is why they move together. Note `isBlockingIssue` may now be an unused import in this file; if so, remove it from the import rather than leaving it.

- [ ] **Step 3: Typecheck and run both suites**

Run:
```bash
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: typechecks exit 0; dashboard paywall-builder suite green and unchanged (this task changes no observable behaviour).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts
git commit -m "refactor(paywall): gate publish on publish severity, save on save severity"
```

---

### Task 3: Drawer labels for the split

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/validation-drawer.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `ISSUE_SEVERITY` (Task 1).
- Produces: `EMPTY_LOC_VALUE` exists in the `BuilderIssue["code"]` union and is classified `"publish"`; `issueTitle()` handles it; `UNKNOWN_LOC_KEY`'s label narrows to match its narrowed meaning.

Inert — nothing emits `EMPTY_LOC_VALUE` until Task 4. Done now so the code never renders as a raw machine string in between.

- [ ] **Step 0: Declare the code**

The drawer's `switch` cannot carry a case for a code that is not in the union — TypeScript rejects it with `TS2678: Type '"EMPTY_LOC_VALUE"' is not comparable to type ...`. So the declaration lands here, with the label, rather than with the emission.

In `packages/shared/src/paywall/validate.ts`, add to the `BuilderIssue["code"]` union directly after `"UNKNOWN_LOC_KEY"`:

```ts
    // The key exists in the default locale but its value is blank. A normal
    // in-progress authoring state, so it must NOT block the save — only the
    // publish. See ISSUE_SEVERITY.
    | "EMPTY_LOC_VALUE"
```

and add the entry to `ISSUE_SEVERITY`:

```ts
  EMPTY_LOC_VALUE: "publish",
```

- [ ] **Step 1: Retitle `UNKNOWN_LOC_KEY` and add `EMPTY_LOC_VALUE`**

In `apps/dashboard/src/components/paywall-builder/validation-drawer.tsx`'s `issueTitle()`, replace:

```tsx
    case "UNKNOWN_LOC_KEY":
      return t("paywalls.builder.validation.codeUnknownKey", "Missing default-locale text");
```

with:

```tsx
    case "UNKNOWN_LOC_KEY":
      return t("paywalls.builder.validation.codeUnknownKey", "Unknown localization key");
    case "EMPTY_LOC_VALUE":
      return t("paywalls.builder.validation.codeEmptyLocValue", "Blank default-locale text");
```

The old label — "Missing default-locale text" — described the blank case, which is exactly the conflation this phase is undoing; after the split it belongs to `EMPTY_LOC_VALUE`, and `UNKNOWN_LOC_KEY` means the key has no entry at all.

- [ ] **Step 2: Update `en.json`**

In `apps/dashboard/src/i18n/locales/en.json`, under the existing `paywalls.builder.validation` object:
- change `codeUnknownKey` to `"Unknown localization key"`,
- add `"codeEmptyLocValue": "Blank default-locale text"` beside it.

Match the file's existing indentation and do not reorder or reformat anything else — this file is ~120 KB and shared.

- [ ] **Step 3: Verify**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('valid json')"
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: `valid json`; tsc exits 0; suite green.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/paywall/validate.ts \
  apps/dashboard/src/components/paywall-builder/validation-drawer.tsx \
  apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(paywall): declare EMPTY_LOC_VALUE and label it in the validation drawer"
```

---

### Task 4: `EMPTY_LOC_VALUE` — the actual behaviour change

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`
- Create: `apps/api/tests/paywall-builder-severity.integration.test.ts`

**Interfaces:**
- Consumes: `issueSeverity` / `isPublishBlockingIssue` (Task 1); the swapped consumers (Task 2); the `EMPTY_LOC_VALUE` declaration (Task 3).
- Produces: `EMPTY_LOC_VALUE` is now actually EMITTED (it was declared and classified in Task 3); `UNKNOWN_LOC_KEY` narrowed to "absent"; `isMissingLocaleValue` hardened.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("absent vs blank default-locale values", () => {
  function configWith(localizations: Record<string, Record<string, string>>) {
    return {
      formatVersion: 2 as const,
      defaultLocale: "en",
      localizations,
      root: {
        type: "stack" as const,
        id: "root",
        axis: "v" as const,
        children: [{ type: "text" as const, id: "t1", key: "title", role: "title" as const }],
      },
    };
  }

  it("reports an ABSENT key as UNKNOWN_LOC_KEY, which blocks the save", () => {
    const issues = validateBuilderConfig(configWith({ en: {} }), { offeringPackageIds: [] });
    const issue = issues.find((i) => i.key === "title");
    expect(issue?.code).toBe("UNKNOWN_LOC_KEY");
    expect(isBlockingIssue(issue!)).toBe(true);
  });

  it("reports a BLANK key as EMPTY_LOC_VALUE, which blocks publish but NOT the save", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "" } }), {
      offeringPackageIds: [],
    });
    const issue = issues.find((i) => i.key === "title");
    expect(issue?.code).toBe("EMPTY_LOC_VALUE");
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(true);
  });

  it("treats a whitespace-only value as blank, not as written copy", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "   " } }), {
      offeringPackageIds: [],
    });
    expect(issues.find((i) => i.key === "title")?.code).toBe("EMPTY_LOC_VALUE");
  });

  it("reports nothing once the default-locale value is written", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "Unlock everything" } }), {
      offeringPackageIds: [],
    });
    expect(issues.filter((i) => i.key === "title")).toEqual([]);
  });

  it("does not mistake a prototype-chain property for a present key", () => {
    // `"constructor" in {}` is true — a key named after an Object.prototype
    // member must still be reported as absent, not blank. Built with the key
    // in place rather than mutated afterwards: `root.children[0]` is typed as
    // the PaywallNode union, which has no `.key`.
    const issues = validateBuilderConfig(
      {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: {} },
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [{ type: "text", id: "t1", key: "constructor", role: "title" }],
        },
      },
      { offeringPackageIds: [] },
    );
    expect(issues.find((i) => i.key === "constructor")?.code).toBe("UNKNOWN_LOC_KEY");
  });
});
```

Add `isPublishBlockingIssue` to the test file's imports if Task 1 did not already.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: FAIL — the blank cases still report `UNKNOWN_LOC_KEY`, and the `constructor` case reports `EMPTY_LOC_VALUE`-or-throws rather than `UNKNOWN_LOC_KEY`.

- [ ] **Step 3: Harden `isMissingLocaleValue`**

Replace its body:

```ts
export function isMissingLocaleValue(value: string | undefined): boolean {
  return typeof value !== "string" || value.trim() === "";
}
```

The type says `string | undefined`, but a prototype-chain lookup can hand back a function, and `.trim()` on a function throws — a 500 on the save path from a legal key name. Behaviour for every value the schema can actually produce is identical.

- [ ] **Step 4: Split the loop**

In `validateBuilderConfig`'s `UNKNOWN_LOC_KEY` loop, replace:

```ts
      if (isMissingLocaleValue(defaultLocaleTable[key])) {
        issues.push({
          code: "UNKNOWN_LOC_KEY",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") has no text in the default locale ("${config.defaultLocale}").`,
        });
      }
```

with:

```ts
      if (!Object.hasOwn(defaultLocaleTable, key)) {
        issues.push({
          code: "UNKNOWN_LOC_KEY",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") has no entry in the default locale ("${config.defaultLocale}").`,
        });
      } else if (isMissingLocaleValue(defaultLocaleTable[key])) {
        issues.push({
          code: "EMPTY_LOC_VALUE",
          nodeId: node.id,
          key,
          message: `Key "${key}" (node "${node.id}") is blank in the default locale ("${config.defaultLocale}") — fill it in before publishing.`,
        });
      }
```

`Object.hasOwn`, not `key in defaultLocaleTable`: localization keys are author-supplied, and `in` walks the prototype chain, so `"constructor"` and `"toString"` would read as present.

- [ ] **Step 5: Run the shared suite**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall`
Expected: PASS. Pre-existing tests that assert `UNKNOWN_LOC_KEY` for a **blank** value will now legitimately fail — that is the behaviour change. For each such failure, update the expectation to `EMPTY_LOC_VALUE` **only if** the fixture's key is present-but-blank; if the fixture's key is genuinely absent it must still be `UNKNOWN_LOC_KEY`, and a failure there is a real regression. Report which tests you changed and why.

- [ ] **Step 6: Write the API gate tests**

Create `apps/api/tests/paywall-builder-severity.integration.test.ts`. These must drive the **real routes** — asserting against `validateBuilderConfig` directly is exactly what missed this bug the first time.

Mirror the bootstrap in `apps/api/tests/dashboard-paywalls.integration.test.ts` verbatim in shape: a module-level `const RUN_ID = Date.now()`, a `buildApp()` that news a `Hono`, registers `app.onError(errorHandler)` and routes the real `paywallsRoute`, a `createUserAndSession(suffix)` helper that goes through `auth.api.signUpEmail` / `signInEmail` and folds the `set-cookie` header into a single cookie string, and a `seedProject()` helper. Real Postgres via testcontainers, real Better Auth session — no mocks. `app.onError(errorHandler)` is not optional: without it a thrown `HTTPException` surfaces as raw text and `res.json()` throws instead of giving you the issue list.

Three cases:

1. **The C1 regression.** PATCH `…/paywalls/:id` with a `builderConfig` whose default-locale value for a used key is `""`. Assert **200**, and assert the persisted config round-trips with the blank value intact.
2. **Publish is still gated.** POST the publish route for that same paywall. Assert **400** with `code: "PAYWALL_NOT_PUBLISHABLE"` and an `EMPTY_LOC_VALUE` issue in the body.
3. **The publish gate was not weakened.** A config carrying a pre-existing save-blocking code — two nodes sharing one id, i.e. `DUPLICATE_NODE_ID` — must be rejected by the **publish** route with 400. Without this, swapping only one of the two call sites in Task 2 would pass every other test.

- [ ] **Step 7: Run the API tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/paywall-builder-severity.integration.test.ts`
Expected: PASS, all three. If the suite needs Postgres via testcontainers, that is expected — do not stub the database to avoid it; a mocked route proves nothing here.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts \
  apps/api/tests/paywall-builder-severity.integration.test.ts
git commit -m "fix(shared): a blank default-locale value blocks publish, not save"
```

---

### Task 5: The view model agrees with the gates

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`

**Interfaces:**
- Consumes: `EMPTY_LOC_VALUE` (Task 4); the swapped `errorIssues` / `warningIssues` (Task 2).
- Produces: no production code — this task is the dashboard half of the spec's testing section.

Tasks 1–4 proved the shared predicate and the API gates. This proves the third consumer: that a blank default-locale string disables Publish in the builder and shows up as an error the author can see, rather than silently doing nothing.

- [ ] **Step 1: Write the tests**

Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`, using the file's existing `makeVm` / `fakeDetail` / `fakeConfig` helpers (do not invent new ones):

```ts
describe("blank default-locale copy", () => {
  function detailWithBlankTitle() {
    const config = fakeConfig();
    config.localizations.en.t1_key = "";
    return fakeDetail({ builderConfig: config });
  }

  it("surfaces the blank string as an error and blocks publish", async () => {
    const get = vi.fn().mockResolvedValue(detailWithBlankTitle());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load();

    expect(vm.errorIssues.map((i) => i.code)).toContain("EMPTY_LOC_VALUE");
    expect(vm.canPublish).toBe(false);
  });

  it("clears once the string is written", async () => {
    const get = vi.fn().mockResolvedValue(detailWithBlankTitle());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load();

    vm.setLocaleText("t1_key", "en", "Unlock everything");

    expect(vm.errorIssues).toEqual([]);
  });
});
```

If `vm.load()` is not the method name the file's other tests use to drive a load, follow whatever they do — match the file, do not introduce a second idiom. `canPublish` also depends on save/publish bookkeeping (dirty state, an existing published version); if the second assertion cannot be isolated to the localization condition, assert only `errorIssues` and say so in your report rather than contorting the fixture.

- [ ] **Step 2: Run the suite**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS — the 2 new tests plus the full pre-existing paywall-builder suite.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "test(dashboard): blank default-locale copy blocks publish in the builder"
```

---

### Task 6: Scope the gap loop to keys the tree uses

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: `collectLocalizationUsages` (already exported from this file), `EMPTY_LOC_VALUE` (Task 4).
- Produces: `LOCALE_KEY_GAP` is emitted only for keys the tree actually references, and only when the default-locale value is genuinely written.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("LOCALE_KEY_GAP scoping", () => {
  const tree = {
    type: "stack" as const,
    id: "root",
    axis: "v" as const,
    children: [{ type: "text" as const, id: "t1", key: "title", role: "title" as const }],
  };

  it("still reports a key that IS written in the default locale and missing elsewhere", () => {
    const issues = validateBuilderConfig(
      { formatVersion: 2, defaultLocale: "en", localizations: { en: { title: "Hi" }, de: {} }, root: tree },
      { offeringPackageIds: [] },
    );
    const gap = issues.find((i) => i.code === "LOCALE_KEY_GAP");
    expect(gap?.locale).toBe("de");
    expect(gap?.key).toBe("title");
  });

  it("says nothing about an ORPHANED key no node references", () => {
    const issues = validateBuilderConfig(
      {
        formatVersion: 2,
        defaultLocale: "en",
        localizations: { en: { title: "Hi", ghost: "Leftover" }, de: { title: "Hallo" } },
        root: tree,
      },
      { offeringPackageIds: [] },
    );
    expect(issues.filter((i) => i.key === "ghost")).toEqual([]);
  });

  it("does not claim a key is 'set in the default locale' when it is blank there", () => {
    const issues = validateBuilderConfig(
      { formatVersion: 2, defaultLocale: "en", localizations: { en: { title: "" }, de: {} }, root: tree },
      { offeringPackageIds: [] },
    );
    expect(issues.filter((i) => i.code === "LOCALE_KEY_GAP")).toEqual([]);
    expect(issues.map((i) => i.code)).toContain("EMPTY_LOC_VALUE");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: FAIL on the orphan case (a `LOCALE_KEY_GAP` for `ghost` is emitted) and on the third case (a gap is emitted alongside `EMPTY_LOC_VALUE`).

- [ ] **Step 3: Rewrite the loop**

In `packages/shared/src/paywall/validate.ts`, replace:

```ts
  // LOCALE_KEY_GAP — per (non-default locale, key present in defaultLocale but missing there).
  const defaultKeys = Object.keys(defaultLocaleTable);
  for (const [locale, table] of Object.entries(config.localizations)) {
    if (locale === config.defaultLocale) continue;
    for (const key of defaultKeys) {
      if (isMissingLocaleValue(table[key])) {
```

with:

```ts
  // LOCALE_KEY_GAP — per (non-default locale, key the TREE uses that is written
  // in the default locale but missing there).
  //
  // Scoped to tree usage, not to the whole default-locale table: `removeNode`
  // never prunes `localizations`, so deleting a node orphans its key forever,
  // and no builder UI can delete a localization key. A table-scoped loop warned
  // about those orphans while the localization matrix — which lists tree usages
  // — had no row for them: an unclearable warning with nothing to act on.
  const usedKeys = [...new Set(collectLocalizationUsages(config.root).map((u) => u.key))];
  for (const [locale, table] of Object.entries(config.localizations)) {
    if (locale === config.defaultLocale) continue;
    for (const key of usedKeys) {
      // Already reported against the default locale by UNKNOWN_LOC_KEY /
      // EMPTY_LOC_VALUE — and the message below would be a lie.
      if (isMissingLocaleValue(defaultLocaleTable[key])) continue;
      if (isMissingLocaleValue(table[key])) {
```

Leave the `issues.push({ code: "LOCALE_KEY_GAP", … })` body and the loop's closing braces exactly as they are.

- [ ] **Step 4: Run the shared suite**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall`
Expected: PASS — the 3 new tests plus every pre-existing test. A pre-existing test that asserted a gap for an orphaned key, or for a key blank in the default locale, is asserting the old buggy behaviour; update it and say so in your report.

- [ ] **Step 5: Typecheck all three packages**

Run:
```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts
git commit -m "fix(shared): scope LOCALE_KEY_GAP to keys the tree actually uses"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/shared exec vitest run src/paywall` — green.
2. `pnpm --filter @rovenue/api exec vitest run tests/paywall-builder-severity.integration.test.ts` — green.
3. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — green.
4. `tsc --noEmit` on all three packages, and `pnpm --filter @rovenue/dashboard build`.
5. Manual (seeded dev dashboard), the scenario that motivated the phase: create a paywall, add three text nodes without writing any copy, rearrange them. The autosave badge must reach "saved" — **not** "Save failed — retrying". The Publish button must be disabled, and the drawer must list one "Blank default-locale text" error per node. Fill the strings; Publish becomes available.

## Out of scope (deferred)

- Pruning orphaned keys from `localizations`, and an "unused strings" section in the matrix.
- M5 — `viaOverride` should be true only when *every* usage of a key is override-introduced.
- M6 — the layer tree excludes `fallback` subtrees that a matrix jump can select.
- A `beforeunload` / unmount flush for `autosave`.
- `AutosaveBadge` distinguishing a retryable failure from a permanent 400.
