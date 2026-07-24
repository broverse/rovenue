# Paywall Save Gate Scope (P2-fix II) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ordinary authoring states from permanently breaking the paywall builder's autosave, and tell the truth when a save really cannot succeed.

**Architecture:** Five validator issue codes move from the `save` tier to the `publish` tier, so the builderConfig PATCH route stops rejecting incomplete drafts while the publish route rejects exactly what it rejected before. The autosave state machine then distinguishes a permanent 4xx from a retryable failure, and the builder flushes on unmount and prompts on unload.

**Tech Stack:** TypeScript (strict), Vitest, Hono + Zod (API), React + `impair` DI (dashboard), `react-i18next`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-paywall-save-gate-scope-design.md`.
- Spans `packages/shared/`, `apps/api/` and `apps/dashboard/` by design — a change to the shared severity model is a cross-consumer change.
- TypeScript strict. Responses `{ data }` / `{ error }`.
- **No magic values** — issue codes and the severity table are structured data; any threshold or timeout gets a named constant.
- Every user-facing string via `t(key, "English fallback")`, and **every new `t()` key must be added to `apps/dashboard/src/i18n/locales/en.json` in the same commit**.
- **The publish gate must reject exactly what it rejected before.** Every task that touches severity must keep `isPublishBlockingIssue` unchanged for every code.
- No DB change, no migration, no SDK/wire change.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`.
- Conventional commits; commit per task.

---

## File Structure

**Modify:**
- `packages/shared/src/paywall/validate.ts` — the `ISSUE_SEVERITY` table.
- `packages/shared/src/paywall/validate.test.ts` — tier tests.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — autosave status machine, unmount flush entry point.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` — autosave tests.
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` — `AutosaveBadge`.
- `apps/dashboard/src/components/paywall-builder/builder-shell.tsx` — unmount flush + `beforeunload`.
- `apps/dashboard/src/i18n/locales/en.json` — new badge strings.

**Create:**
- `apps/api/tests/paywall-save-gate.integration.test.ts` — one case per reachable authoring state, through the real routes.

---

### Task 1: Retier the five codes, and prove it at both gates

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`
- Create: `apps/api/tests/paywall-save-gate.integration.test.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` (Step 7 only)

**Interfaces:**
- Consumes: the existing `ISSUE_SEVERITY` / `issueSeverity` / `isBlockingIssue` / `isPublishBlockingIssue` from the previous phase.
- Produces: `UNKNOWN_LOC_KEY`, `FOREIGN_PACKAGE_ID`, `MISSING_PURCHASE_BUTTON`, `CELL_TEMPLATE_BAD_NODE` and `OVERRIDE_BAD_PROP` are `"publish"`; only `DUPLICATE_NODE_ID` (and unclassified codes) remain `"save"`.

- [ ] **Step 1: Write the failing shared tests**

Add to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("save gate scope", () => {
  const MOVED = [
    "UNKNOWN_LOC_KEY",
    "EMPTY_LOC_VALUE",
    "FOREIGN_PACKAGE_ID",
    "MISSING_PURCHASE_BUTTON",
    "CELL_TEMPLATE_BAD_NODE",
    "OVERRIDE_BAD_PROP",
  ];

  it("lets an incomplete draft save while still blocking its publish", () => {
    for (const code of MOVED) {
      expect(issueSeverity({ code })).toBe("publish");
      expect(isBlockingIssue({ code })).toBe(false);
      expect(isPublishBlockingIssue({ code })).toBe(true);
    }
  });

  it("still blocks the save on a config the builder could not address", () => {
    expect(issueSeverity({ code: "DUPLICATE_NODE_ID" })).toBe("save");
    expect(isBlockingIssue({ code: "DUPLICATE_NODE_ID" })).toBe(true);
  });

  it("leaves an unclassified code at the strictest tier", () => {
    expect(isBlockingIssue({ code: "SOME_CODE_ADDED_LATER" })).toBe(true);
  });

  it("does not change what a publish rejects", () => {
    // The invariant this whole phase must not break: retiering moves codes
    // between save and publish, never in or out of the warning tier.
    const WARNINGS = ["LOCALE_KEY_GAP", "OVERRIDE_SELECTED_OUTSIDE_CELL", "INTRO_VARIABLE_UNGUARDED"];
    for (const code of WARNINGS) expect(isPublishBlockingIssue({ code })).toBe(false);
    for (const code of [...MOVED, "DUPLICATE_NODE_ID", "SCHEMA_INVALID", "SOME_CODE_ADDED_LATER"]) {
      expect(isPublishBlockingIssue({ code })).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: FAIL — the moved codes are still `"save"`, so `issueSeverity` returns `"save"` and `isBlockingIssue` returns `true`.

- [ ] **Step 3: Retier the table**

In `packages/shared/src/paywall/validate.ts`, replace the `ISSUE_SEVERITY` body:

```ts
const ISSUE_SEVERITY: Readonly<Record<string, IssueSeverity>> = {
  // Warnings — block nothing.
  LOCALE_KEY_GAP: "warning",
  OVERRIDE_SELECTED_OUTSIDE_CELL: "warning",
  INTRO_VARIABLE_UNGUARDED: "warning",

  // Publish-only — a draft in this state is ordinary work in progress and
  // MUST still persist. Each of these is reachable from the builder UI in
  // one or two clicks (add a package list before its purchase button;
  // switch the offering; switch the default locale to a new empty one; add
  // a node inside a cellTemplate), and blocking the save on them meant the
  // author kept working while nothing was written.
  UNKNOWN_LOC_KEY: "publish",
  EMPTY_LOC_VALUE: "publish",
  FOREIGN_PACKAGE_ID: "publish",
  MISSING_PURCHASE_BUTTON: "publish",
  CELL_TEMPLATE_BAD_NODE: "publish",
  OVERRIDE_BAD_PROP: "publish",

  // Anything unlisted stays "save" — see issueSeverity. Only DUPLICATE_NODE_ID
  // relies on that today: tree-ops addresses nodes by id, so a duplicate makes
  // the builder's own next edit ambiguous. It is not reachable from the UI
  // (the builder generates ids), so blocking it costs an author nothing.
};
```

- [ ] **Step 4: Run the shared suite**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall`
Expected: PASS. Pre-existing tests that assert `isBlockingIssue` is `true` for a moved code are asserting the old scope — update them and report each one. A test asserting `isPublishBlockingIssue` for any code must NOT need changing; if one does, stop and report it, because publish strength is the invariant this phase must not touch.

- [ ] **Step 5: Write the API gate tests**

Create `apps/api/tests/paywall-save-gate.integration.test.ts`. Mirror the bootstrap in `apps/api/tests/paywall-builder-severity.integration.test.ts` (module-level `RUN_ID`, `buildApp()` with `app.onError(errorHandler)` and the real paywalls route, Better Auth sign-up/sign-in cookie helper, `seedProject()`). Real Postgres via testcontainers — do not stub the database.

One case per reachable authoring state. Each asserts **both** halves, because a config that saves but also publishes would be a worse bug than the one being fixed. These are the exact `root.children` payloads — the rest of each config is `{ formatVersion: 2, defaultLocale: "en", localizations: { en: { k: "Buy" } }, root: { type: "stack", id: "root", axis: "v", children } }` unless the case says otherwise:

1. **Package list with no purchase button** — PATCH → 200; publish → 400 `PAYWALL_NOT_PUBLISHABLE` with `MISSING_PURCHASE_BUTTON`.
   ```ts
   [{ type: "packageList", id: "pl", packageIds: [], cellLayout: "row" }]
   ```
2. **Package ids outside the offering** — PATCH → 200; publish → 400 with `FOREIGN_PACKAGE_ID`. Use an id that is genuinely not in the seeded offering.
   ```ts
   [{ type: "packageList", id: "pl", packageIds: ["pkg_not_in_offering"], cellLayout: "row" },
    { type: "purchaseButton", id: "pb", labelKey: "k" }]
   ```
3. **Default locale pointing at an empty table** — PATCH → 200; publish → 400 with `UNKNOWN_LOC_KEY`. Here the whole config differs:
   ```ts
   { formatVersion: 2, defaultLocale: "de",
     localizations: { en: { k: "Buy" }, de: {} },
     root: { type: "stack", id: "root", axis: "v",
       children: [{ type: "purchaseButton", id: "pb", labelKey: "k" }] } }
   ```
4. **A `packageList` inside a `cellTemplate`** — PATCH → 200; publish → 400 with `CELL_TEMPLATE_BAD_NODE`.
   ```ts
   [{ type: "packageList", id: "outer", packageIds: [], cellLayout: "row",
      cellTemplate: { type: "packageList", id: "inner", packageIds: [], cellLayout: "row" } },
    { type: "purchaseButton", id: "pb", labelKey: "k" }]
   ```
5. **The negative** — two nodes sharing one id: PATCH → 400. This is the guard that the retier did not empty the save gate entirely.
   ```ts
   [{ type: "spacer", id: "dup", size: 4 }, { type: "spacer", id: "dup", size: 8 }]
   ```

For case 5 the publish route is not involved; assert only the PATCH rejection. If a case's PATCH unexpectedly 400s, read the returned `issues` array before assuming the retier is wrong — a fixture that also trips `SCHEMA_INVALID` would fail for an unrelated reason.

- [ ] **Step 6: Run the API tests**

Run: `pnpm --filter @rovenue/api exec vitest run tests/paywall-save-gate.integration.test.ts`
Expected: PASS, all five.

Also re-run the sibling suite to confirm the earlier phase still holds:
Run: `pnpm --filter @rovenue/api exec vitest run tests/paywall-builder-severity.integration.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 7: Pin the dashboard gate too**

The retier must not quietly make an incomplete draft publishable in the UI. `canPublish` derives from `errorIssues`, which filters on `isPublishBlockingIssue` — unchanged by this task — so this holds by construction and the test is a regression guard, not a fix.

Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`, using the file's existing `makeVm` / `fakeDetail` / `fakeConfig` helpers:

```ts
describe("an incomplete draft is still unpublishable", () => {
  it("keeps canPublish false when a package list has no purchase button", async () => {
    const config = fakeConfig();
    config.root.children.push({ type: "packageList", id: "pl", packageIds: [], cellLayout: "row" });
    const get = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: config }));
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.errorIssues.map((i) => i.code)).toContain("MISSING_PURCHASE_BUTTON");
    expect(vm.canPublish).toBe(false);
  });
});
```

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS.

- [ ] **Step 8: Typecheck all three packages**

Run:
```bash
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts \
  apps/api/tests/paywall-save-gate.integration.test.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "fix(shared): an incomplete paywall draft saves; only publish is gated on completeness"
```

---

### Task 2: Tell the truth about a failed save

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: `ApiError` from `apps/dashboard/src/lib/api.ts` — it carries `status: number`.
- Produces: `autosaveStatus: "saved" | "saving" | "error" | "permanentError"`. `"error"` means the attempt failed but retrying can help (network, 5xx). `"permanentError"` means it cannot (a 4xx from the write path).

- [ ] **Step 1: Write the failing tests**

Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`, using the file's existing `makeVm` / `fakeDetail` helpers:

```ts
describe("autosave failure kinds", () => {
  it("marks a 4xx from the write path as permanent", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INVALID_BUILDER_CONFIG", "nope", 400));
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "en", "changed");
    await vm.saveNow();

    expect(vm.autosaveStatus).toBe("permanentError");
  });

  it("marks a 5xx as retryable", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INTERNAL", "boom", 500));
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "en", "changed");
    await vm.saveNow();

    expect(vm.autosaveStatus).toBe("error");
  });

  it("does not launder a permanent failure into 'saving' on the next edit", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INVALID_BUILDER_CONFIG", "nope", 400));
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "en", "changed");
    await vm.saveNow();
    expect(vm.autosaveStatus).toBe("permanentError");

    vm.clearAutosaveError();

    expect(vm.autosaveStatus).toBe("permanentError");
  });

  it("still clears a retryable failure so the next attempt reads as in flight", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockRejectedValue(new ApiError("INTERNAL", "boom", 500));
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "en", "changed");
    await vm.saveNow();
    vm.clearAutosaveError();

    expect(vm.autosaveStatus).toBe("saving");
  });
});
```

Add `ApiError` to the test file's imports from `../../../lib/api` — the same depth the file already uses for `../../../lib/services/paywall-builder-api`. If `saveNow()` is not the method that drives a manual save in this view model, follow whatever the file's other save tests use.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: FAIL — `autosaveStatus` is `"error"` for the 4xx case, and `clearAutosaveError` moves it to `"saving"`.

- [ ] **Step 3: Widen the status and classify the failure**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, add `import { ApiError } from "../../../lib/api";` beside the existing service import, and widen the field:

```ts
  @state autosaveStatus: "saved" | "saving" | "error" | "permanentError" = "saved";
```

Add the classifier next to it:

```ts
  /**
   * A 4xx from the write path cannot be fixed by trying again — the payload
   * is what the server rejected. Anything else (network, 5xx, abort) can.
   * After the save-gate retier the only 4xx the builder can provoke are
   * SCHEMA_INVALID and DUPLICATE_NODE_ID, both of which mean the builder
   * itself produced something invalid, so surfacing them loudly is right.
   */
  private autosaveFailureStatus(err: unknown): "error" | "permanentError" {
    return err instanceof ApiError && err.status >= 400 && err.status < 500
      ? "permanentError"
      : "error";
  }
```

In `autosave()`'s `catch`, replace `this.autosaveStatus = "error";` with:

```ts
      this.autosaveStatus = this.autosaveFailureStatus(err);
```

Do the same in `saveNow()`'s `catch`. Leave both `AbortError` early-returns and the `saveController` identity checks exactly as they are — an aborted save must not be reported as a failure at all.

- [ ] **Step 4: Stop laundering a permanent failure**

Change `clearAutosaveError`:

```ts
  clearAutosaveError() {
    void this.config;
    // Only a retryable failure clears on the next edit. A permanent one stays
    // visible until a save actually succeeds — otherwise the red state
    // disappears on the very next keystroke and nobody sees it.
    if (this.autosaveStatus === "error") this.autosaveStatus = "saving";
  }
```

(The body is unchanged — the widened union is what makes it correct. Keep the comment; it records why `permanentError` is deliberately absent from the condition.)

- [ ] **Step 5: Make the badge say it**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`'s `AutosaveBadge`, replace the `saving`/`err` pair and the two ternaries so the four states are distinct:

```tsx
  const saving = vm.autosaveStatus === "saving";
  const retrying = vm.autosaveStatus === "error";
  const failed = vm.autosaveStatus === "permanentError";
```

Title:

```tsx
      title={
        failed
          ? t(
              "paywalls.builder.topbar.autosaveFailedHint",
              "This change was rejected and will not save on its own. Reload the builder; if it persists, report it.",
            )
          : retrying
            ? t("paywalls.builder.topbar.autosaveErrorHint", "Save failed — will retry on your next change")
            : t("paywalls.builder.topbar.autosaveHint", "Autosaved on every change")
      }
```

Dot:

```tsx
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          saving
            ? "animate-pulse bg-rv-warning"
            : failed
              ? "bg-rv-danger"
              : retrying
                ? "bg-rv-warning"
                : "bg-rv-success",
        )}
```

Label:

```tsx
      {saving
        ? t("paywalls.builder.topbar.autosaveSaving", "saving")
        : failed
          ? t("paywalls.builder.topbar.autosaveFailed", "not saved")
          : retrying
            ? t("paywalls.builder.topbar.autosaveError", "retrying")
            : t("paywalls.builder.topbar.autosaveSaved", "saved")}
```

The retryable hint changes from "Save failed — retrying" to "will retry on your next change", because that is what actually happens: the throttle re-fires on a config mutation, not on a timer of its own.

- [ ] **Step 6: Add the new keys to `en.json`**

Under the existing `paywalls.builder.topbar` object add `autosaveFailed` and `autosaveFailedHint`, and update `autosaveErrorHint` to the new wording. Match the file's indentation; do not reorder or reformat anything else.

- [ ] **Step 7: Verify**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('valid json')"
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: `valid json`; tsc exits 0; suite green including the 4 new tests.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts \
  apps/dashboard/src/components/paywall-builder/top-bar.tsx \
  apps/dashboard/src/i18n/locales/en.json
git commit -m "fix(dashboard): distinguish a permanent autosave failure from a retryable one"
```

---

### Task 3: Flush on unmount, prompt on unload

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`

**Interfaces:**
- Consumes: `vm.isDirty` and `vm.saveNow()`.
- Produces: no new public API — two effects in `BuilderShell`.

Autosave is throttled at 30s, so closing the builder mid-window drops everything since the last successful save. The unmount flush is what actually saves that work; the `beforeunload` prompt only hands the decision to the person. Per the spec, **no save is attempted in `beforeunload`** — `sendBeacon` cannot carry a credentialed cross-origin JSON POST without a preflight that browsers drop during unload, and a beacon that silently fails is worse than an honest prompt.

- [ ] **Step 1: Write the view-model test**

The two effects live in a component, but the thing worth pinning is that a flush actually PATCHes pending work. Add to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`:

```ts
describe("flushing pending work", () => {
  it("saveNow() PATCHes when there are unsaved edits", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    vm.setLocaleText("t1_key", "en", "changed");
    expect(vm.isDirty).toBe(true);

    await vm.saveNow();

    expect(patchBuilderConfig).toHaveBeenCalledTimes(1);
  });

  it("saveNow() does not PATCH when nothing changed", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig });
    await vm.load(() => {});

    await vm.saveNow();

    expect(patchBuilderConfig).not.toHaveBeenCalled();
  });
});
```

If `saveNow()` already short-circuits on a clean snapshot the second test passes immediately — that is fine, it is a regression guard for the flush path. If it does NOT short-circuit, do not change `saveNow`; instead make the unmount effect check `vm.isDirty` before calling it, and say so in your report.

- [ ] **Step 2: Run to see where you stand**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: both pass, or the second fails — either outcome is information, not a blocker. Record which in your report.

- [ ] **Step 3: Add the two effects**

In `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`, beside the existing auto-open effect:

```tsx
  // Autosave is throttled, so closing the builder mid-window would drop
  // everything since the last successful save. Flush on the way out.
  useEffect(() => {
    return () => {
      if (vm.isDirty) void vm.saveNow();
    };
  }, [vm]);

  // A full page unload cannot be flushed reliably — a credentialed
  // cross-origin JSON beacon needs a CORS preflight, which browsers drop
  // during unload. So hand the decision to the person instead of pretending.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!vm.isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [vm]);
```

Both effects must sit with the other hooks, above the `vm.isLoading` / `vm.error` early returns — hooks cannot be conditional.

Note the unmount effect reads `vm.isDirty` inside the cleanup, so it sees the value at unmount rather than at mount.

- [ ] **Step 4: Verify**

Run:
```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
pnpm --filter @rovenue/dashboard build
```
Expected: all clean/green.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/builder-shell.tsx \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "fix(dashboard): flush pending builder edits on unmount, warn on unload"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/shared exec vitest run src/paywall` — green.
2. `pnpm --filter @rovenue/api exec vitest run tests/paywall-save-gate.integration.test.ts` and `tests/paywall-builder-severity.integration.test.ts` — both green.
3. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — green.
4. `tsc --noEmit` on all three packages; `pnpm --filter @rovenue/dashboard build`.
5. Manual (seeded dev dashboard), the scenario that motivated the phase: open a paywall, add **only** a package list. The autosave badge must reach "saved" — not "retrying" and not "not saved". The Publish button must be disabled and the drawer must list "Missing purchase button". Then add a purchase button and confirm Publish becomes available. Repeat with the offering switch and with a new empty default locale.
6. Manual: make an edit and immediately close the builder with the X. Reopen it — the edit must be there.

## Out of scope (deferred)

- Pruning orphaned localization keys; an "unused strings" matrix section.
- M5 (`viaOverride` first-usage-wins) and M6 (layer tree excludes `fallback` subtrees).
- A builder-side guard making `DUPLICATE_NODE_ID` structurally unreachable.
