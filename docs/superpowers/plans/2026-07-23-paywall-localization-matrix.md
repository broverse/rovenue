# Paywall Localization Matrix (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the paywall builder a strings × locales matrix that shows exactly which localization cells are blank, lets them be edited in place, and jumps to the node that owns a key — with the validator corrected so "missing" means the same thing to the matrix and the publish gate.

**Architecture:** Two pure additions to `@rovenue/shared/paywall` (a `collectLocalizationUsages` walk that `collectLocalizationKeys` becomes a projection of, and an `isMissingLocaleValue` predicate) back both a corrected validator and a new client-side matrix modal. The modal is a pure view over the view model's existing `config.localizations` + `locales`, editing through the existing `setLocaleText`; no API, no DB, no wire-format change.

**Tech Stack:** TypeScript (strict), Vitest, React + `impair` DI (`component`/`useService`), `react-i18next`, `lucide-react`, Tailwind (`rv-*` tokens + `cn`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-paywall-localization-matrix-design.md`.
- Touch only `packages/shared/src/paywall/` and `apps/dashboard/src/components/paywall-builder/`. **No API, no DB, no wire-format change** — `BuilderConfig`'s shape is untouched; the two shared additions are pure functions.
- TypeScript strict.
- Every user-facing string via `t("paywalls.builder.localization.*", "English fallback")`.
- **No magic values** — hoist literals (column widths, badge sizes, severity colours) into named constants with descriptive names. Structured data tables are not magic values.
- Cell editing is per-keystroke `onChange` → `vm.setLocaleText`, matching the existing properties panel. Do NOT invent a commit-on-blur variant.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (packages define no bare `vitest` script). Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`. Dashboard build: `pnpm --filter @rovenue/dashboard build`.
- Conventional commits; commit per task.

---

## File Structure

**Create:**
- `apps/dashboard/src/components/paywall-builder/localization-model.ts` — pure matrix-shaping helpers (rows, per-locale counters) over a `BuilderConfig`.
- `apps/dashboard/src/components/paywall-builder/localization-model.test.ts`
- `apps/dashboard/src/components/paywall-builder/localization-modal.tsx` — the modal.

**Modify:**
- `packages/shared/src/paywall/validate.ts` — add `LocalizationUsage`, `collectLocalizationUsages`, `isMissingLocaleValue`; reimplement `collectLocalizationKeys` as a projection; switch `UNKNOWN_LOC_KEY` + `LOCALE_KEY_GAP` to the predicate.
- `packages/shared/src/paywall/validate.test.ts` — tests for the new exports and the corrected checks.
- `apps/dashboard/src/components/paywall-builder/builder-shell.tsx` — `showLocalization` state + mount.
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` — entry button + gap dot.
- `apps/dashboard/src/components/paywall-builder/index.ts` — export the modal.

---

### Task 1: Shared localization primitives

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: existing private `walkNodes(node, visit, insideCellTemplate?)` and `overrideLocKeys(node): string[]` in the same file; `StackNode`, `PaywallNode` from `./schema`.
- Produces (all re-exported automatically by the barrel's `export * from "./validate"`):
  - `interface LocalizationUsage { key: string; nodeId: string; nodeType: PaywallNode["type"]; viaOverride: boolean }`
  - `function collectLocalizationUsages(root: StackNode): LocalizationUsage[]` — document order, one entry per (key, owning node, source).
  - `function collectLocalizationKeys(root: StackNode): string[]` — unchanged signature/behaviour, now a dedupe projection of the usages.
  - `function isMissingLocaleValue(value: string | undefined): boolean` — true when absent, empty, or whitespace-only.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("collectLocalizationUsages", () => {
  function tree(): StackNode {
    return {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        {
          type: "text",
          id: "t2",
          key: "sub",
          role: "body",
          overrides: [{ when: { kind: "introEligible" }, props: { key: "sub_intro" } }],
        },
        {
          type: "packageList",
          id: "pl",
          packageIds: ["monthly"],
          cellLayout: "row",
          cellTemplate: { type: "text", id: "cell", key: "cell_name", role: "caption" },
        },
        {
          type: "purchaseButton",
          id: "pb",
          labelKey: "cta",
          fallback: { type: "button", id: "fb", labelKey: "cta_fallback", style: "plain", action: { kind: "close" } },
        },
      ],
    };
  }

  it("reports every key with its owning node, in document order", () => {
    expect(collectLocalizationUsages(tree())).toEqual([
      { key: "title", nodeId: "t1", nodeType: "text", viaOverride: false },
      { key: "sub", nodeId: "t2", nodeType: "text", viaOverride: false },
      { key: "sub_intro", nodeId: "t2", nodeType: "text", viaOverride: true },
      { key: "cell_name", nodeId: "cell", nodeType: "text", viaOverride: false },
      { key: "cta", nodeId: "pb", nodeType: "purchaseButton", viaOverride: false },
      { key: "cta_fallback", nodeId: "fb", nodeType: "button", viaOverride: false },
    ]);
  });

  it("collectLocalizationKeys stays a deduped projection in first-seen order", () => {
    const shared: StackNode = {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "a", key: "same", role: "title" },
        { type: "text", id: "b", key: "same", role: "body" },
        { type: "text", id: "c", key: "other", role: "body" },
      ],
    };
    expect(collectLocalizationUsages(shared).map((u) => u.nodeId)).toEqual(["a", "b", "c"]);
    expect(collectLocalizationKeys(shared)).toEqual(["same", "other"]);
  });
});

describe("isMissingLocaleValue", () => {
  it("treats absent, empty and whitespace-only as missing", () => {
    expect(isMissingLocaleValue(undefined)).toBe(true);
    expect(isMissingLocaleValue("")).toBe(true);
    expect(isMissingLocaleValue("   ")).toBe(true);
  });

  it("treats any real text as present", () => {
    expect(isMissingLocaleValue("x")).toBe(false);
    expect(isMissingLocaleValue(" x ")).toBe(false);
  });
});
```

Add `collectLocalizationUsages` and `isMissingLocaleValue` to the file's existing import from `./validate`, and `StackNode` to its `./schema` type import if not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts -t "collectLocalizationUsages"`
Expected: FAIL — `collectLocalizationUsages is not a function`.

- [ ] **Step 3: Implement the primitives**

In `packages/shared/src/paywall/validate.ts`, replace the existing `collectLocalizationKeys` block with:

```ts
/** One (localization key → owning node) pair discovered in the tree. */
export interface LocalizationUsage {
  key: string;
  nodeId: string;
  nodeType: PaywallNode["type"];
  /** True when the key came from `overrides[].props`, not the node's own field. */
  viaOverride: boolean;
}

/**
 * Every (key, owning node) pair in the tree, in document order — including
 * `fallback` and `packageList.cellTemplate` subtrees, and keys introduced by
 * `overrides`. This is the single traversal; `collectLocalizationKeys` is a
 * projection of it, so the two can never disagree about what the tree uses.
 */
export function collectLocalizationUsages(root: StackNode): LocalizationUsage[] {
  const usages: LocalizationUsage[] = [];
  walkNodes(root, (node) => {
    if (node.type === "text") {
      usages.push({ key: node.key, nodeId: node.id, nodeType: node.type, viaOverride: false });
    }
    if (node.type === "button" || node.type === "purchaseButton") {
      usages.push({ key: node.labelKey, nodeId: node.id, nodeType: node.type, viaOverride: false });
    }
    for (const key of overrideLocKeys(node)) {
      usages.push({ key, nodeId: node.id, nodeType: node.type, viaOverride: true });
    }
  });
  return usages;
}

/**
 * Every localization key referenced by a text/button/purchaseButton node
 * anywhere in the tree (including inside `fallback` and `cellTemplate`
 * subtrees), PLUS any `key`/`labelKey` introduced by an override, deduped
 * in first-seen order.
 */
export function collectLocalizationKeys(root: StackNode): string[] {
  const seen = new Set<string>();
  for (const usage of collectLocalizationUsages(root)) seen.add(usage.key);
  return [...seen];
}

/**
 * A localization value is missing when the key is absent OR the value is
 * blank. Presence alone says nothing: the builder stubs every newly-added
 * key as `""` in every locale, so a blank-but-present value is the normal
 * "nobody has written this yet" state. Shared so the validator and the
 * dashboard's localization matrix cannot drift on what "missing" means.
 */
export function isMissingLocaleValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: PASS — the new tests plus every pre-existing validator test (the `collectLocalizationKeys` refactor must be behaviour-preserving).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts
git commit -m "feat(shared): localization usages primitive + isMissingLocaleValue predicate"
```

---

### Task 2: Validator counts blank values as missing

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: `isMissingLocaleValue` (Task 1).
- Produces: `UNKNOWN_LOC_KEY` now fires when a node's key is absent **or blank** in the default locale (blocking); `LOCALE_KEY_GAP` now fires when a non-default locale's value is absent **or blank** (warning). No signature changes.

**Behaviour change, approved in the spec:** a draft whose default-locale string is blank can no longer be published. Published `paywall_versions` snapshots are unaffected — only new publishes re-validate.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("blank localization values count as missing", () => {
  function configWith(localizations: Record<string, Record<string, string>>): BuilderConfig {
    return {
      formatVersion: 2,
      defaultLocale: "en",
      localizations,
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [{ type: "text", id: "t1", key: "title", role: "title" }],
      },
    };
  }

  it("a blank default-locale value is a blocking UNKNOWN_LOC_KEY", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "" } }), {
      offeringPackageIds: [],
    });
    const unknown = issues.filter((i) => i.code === "UNKNOWN_LOC_KEY");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ nodeId: "t1", key: "title" });
    expect(isBlockingIssue(unknown[0]!)).toBe(true);
  });

  it("a whitespace-only default-locale value is also blocking", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "   " } }), {
      offeringPackageIds: [],
    });
    expect(issues.some((i) => i.code === "UNKNOWN_LOC_KEY")).toBe(true);
  });

  it("a filled default-locale value emits no UNKNOWN_LOC_KEY", () => {
    const issues = validateBuilderConfig(configWith({ en: { title: "Hello" } }), {
      offeringPackageIds: [],
    });
    expect(issues.some((i) => i.code === "UNKNOWN_LOC_KEY")).toBe(false);
  });

  it("a blank non-default value is a non-blocking LOCALE_KEY_GAP", () => {
    const issues = validateBuilderConfig(
      configWith({ en: { title: "Hello" }, de: { title: "" } }),
      { offeringPackageIds: [] },
    );
    const gaps = issues.filter((i) => i.code === "LOCALE_KEY_GAP");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ locale: "de", key: "title" });
    expect(isBlockingIssue(gaps[0]!)).toBe(false);
  });

  it("a filled non-default value emits no gap", () => {
    const issues = validateBuilderConfig(
      configWith({ en: { title: "Hello" }, de: { title: "Hallo" } }),
      { offeringPackageIds: [] },
    );
    expect(issues.some((i) => i.code === "LOCALE_KEY_GAP")).toBe(false);
  });
});
```

Ensure the file imports `validateBuilderConfig`, `isBlockingIssue`, and the `BuilderConfig` type (most already are — add what's missing).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts -t "blank localization values"`
Expected: FAIL — the blank-value cases report no issue, because both checks currently test key presence only.

- [ ] **Step 3: Switch both checks to the predicate**

In `packages/shared/src/paywall/validate.ts`, in the `UNKNOWN_LOC_KEY` loop, replace:

```ts
      if (!(key in defaultLocaleTable)) {
```

with:

```ts
      if (isMissingLocaleValue(defaultLocaleTable[key])) {
```

and update that issue's message to cover both cases:

```ts
          message: `Key "${key}" (node "${node.id}") has no text in the default locale ("${config.defaultLocale}").`,
```

Then in the `LOCALE_KEY_GAP` loop, replace:

```ts
      if (!(key in table)) {
```

with:

```ts
      if (isMissingLocaleValue(table[key])) {
```

and its message:

```ts
          message: `Locale "${locale}" has no text for key "${key}", which is set in the default locale.`,
```

Leave the loop that produces `defaultKeys` as it is — it still iterates the default table's keys (see the spec's §4 observation; aligning that key set with tree usage is deliberately out of scope).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/validate.test.ts`
Expected: PASS — the 5 new cases plus every pre-existing validator test. If a pre-existing test asserted that a blank value produced no issue, it encoded the bug: update it to the corrected expectation and say so in your report.

- [ ] **Step 5: Check the wider blast radius**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall && pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS. Dashboard VM tests build configs through `emptyBuilderConfig`/presets; if any now trips the stricter check, fix the fixture (give the key real text) rather than relaxing the validator.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts
git commit -m "fix(shared): a blank localization value is missing, not present"
```

---

### Task 3: Matrix model helpers

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/localization-model.ts`
- Create: `apps/dashboard/src/components/paywall-builder/localization-model.test.ts`

**Interfaces:**
- Consumes: `collectLocalizationUsages`, `isMissingLocaleValue`, and the `BuilderConfig` type from `@rovenue/shared/paywall` (Task 1).
- Produces:
  - `interface MatrixRow { key: string; nodeId: string; nodeType: string; viaOverride: boolean; otherNodeIds: string[] }`
  - `interface LocaleCompletion { locale: string; done: number; total: number; missingKeys: string[] }`
  - `function buildMatrixRows(config: BuilderConfig): MatrixRow[]` — one row per distinct key, first owner wins, `otherNodeIds` lists any further owners.
  - `function localeCompletion(config: BuilderConfig, rows: MatrixRow[], locale: string): LocaleCompletion`
  - `function isCellMissing(config: BuilderConfig, key: string, locale: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/components/paywall-builder/localization-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { buildMatrixRows, isCellMissing, localeCompletion } from "./localization-model";

function config(): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: { title: "Hello", cta: "Buy" },
      de: { title: "Hallo", cta: "" },
    },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        { type: "text", id: "t2", key: "title", role: "body" },
        { type: "purchaseButton", id: "pb", labelKey: "cta" },
      ],
    },
  };
}

describe("buildMatrixRows", () => {
  it("gives one row per distinct key, first owner wins", () => {
    expect(buildMatrixRows(config())).toEqual([
      { key: "title", nodeId: "t1", nodeType: "text", viaOverride: false, otherNodeIds: ["t2"] },
      { key: "cta", nodeId: "pb", nodeType: "purchaseButton", viaOverride: false, otherNodeIds: [] },
    ]);
  });
});

describe("isCellMissing", () => {
  it("is true for blank and absent values, false for real text", () => {
    const c = config();
    expect(isCellMissing(c, "cta", "de")).toBe(true);
    expect(isCellMissing(c, "title", "fr")).toBe(true);
    expect(isCellMissing(c, "title", "de")).toBe(false);
  });
});

describe("localeCompletion", () => {
  it("counts filled cells against the row set and lists the gaps", () => {
    const c = config();
    const rows = buildMatrixRows(c);
    expect(localeCompletion(c, rows, "en")).toEqual({
      locale: "en",
      done: 2,
      total: 2,
      missingKeys: [],
    });
    expect(localeCompletion(c, rows, "de")).toEqual({
      locale: "de",
      done: 1,
      total: 2,
      missingKeys: ["cta"],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/localization-model.test.ts`
Expected: FAIL — `Cannot find module './localization-model'`.

- [ ] **Step 3: Implement the model**

Create `apps/dashboard/src/components/paywall-builder/localization-model.ts`:

```ts
import {
  collectLocalizationUsages,
  isMissingLocaleValue,
  type BuilderConfig,
} from "@rovenue/shared/paywall";

// =============================================================
// Pure shaping helpers for the localization matrix. Rows come from what
// the TREE actually uses (not from whatever keys happen to sit in a
// locale table), and "missing" is the shared predicate the validator
// uses — so the matrix and the publish gate agree by construction.
// =============================================================

export interface MatrixRow {
  key: string;
  /** First node (document order) that uses this key — the jump target. */
  nodeId: string;
  nodeType: string;
  viaOverride: boolean;
  /** Further nodes using the same key, if any. */
  otherNodeIds: string[];
}

export interface LocaleCompletion {
  locale: string;
  done: number;
  total: number;
  missingKeys: string[];
}

/** One row per distinct key, in document order; the first owner wins. */
export function buildMatrixRows(config: BuilderConfig): MatrixRow[] {
  const byKey = new Map<string, MatrixRow>();
  for (const usage of collectLocalizationUsages(config.root)) {
    const existing = byKey.get(usage.key);
    if (existing) {
      if (existing.nodeId !== usage.nodeId && !existing.otherNodeIds.includes(usage.nodeId)) {
        existing.otherNodeIds.push(usage.nodeId);
      }
      continue;
    }
    byKey.set(usage.key, {
      key: usage.key,
      nodeId: usage.nodeId,
      nodeType: usage.nodeType,
      viaOverride: usage.viaOverride,
      otherNodeIds: [],
    });
  }
  return [...byKey.values()];
}

/** True when this locale has no real text for the key. */
export function isCellMissing(config: BuilderConfig, key: string, locale: string): boolean {
  return isMissingLocaleValue(config.localizations[locale]?.[key]);
}

/** Filled-cell count for a locale across the matrix's rows. */
export function localeCompletion(
  config: BuilderConfig,
  rows: MatrixRow[],
  locale: string,
): LocaleCompletion {
  const missingKeys = rows.filter((r) => isCellMissing(config, r.key, locale)).map((r) => r.key);
  return {
    locale,
    done: rows.length - missingKeys.length,
    total: rows.length,
    missingKeys,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/localization-model.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/localization-model.ts \
  apps/dashboard/src/components/paywall-builder/localization-model.test.ts
git commit -m "feat(dashboard): pure matrix-shaping helpers for paywall localization"
```

---

### Task 4: Localization matrix modal

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/localization-modal.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/index.ts`

**Interfaces:**
- Consumes: `buildMatrixRows`, `localeCompletion`, `isCellMissing` (Task 3); the view model's `config`, `locales`, `defaultLocale`, `setLocaleText(key, locale, value)`, `selectNode(id)`.
- Produces: `LocalizationModal` component — `function LocalizationModal(props: { onClose: () => void }): JSX.Element`; `BuilderShell` gains `showLocalization` state and passes `onOpenLocalization` to `TopBar` (the button itself lands in Task 5).

- [ ] **Step 1: Write the modal**

Create `apps/dashboard/src/components/paywall-builder/localization-modal.tsx`:

```tsx
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { CornerUpRight, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { buildMatrixRows, isCellMissing, localeCompletion } from "./localization-model";

type Props = { onClose: () => void };

/** Locale column width in px — wide enough for a short sentence without
 * letting one long string stretch the whole table. */
const LOCALE_COL_WIDTH = 220;
/** Key column width in px. */
const KEY_COL_WIDTH = 200;

/**
 * Every localization key the tree uses × every locale it ships in. Blank
 * cells are the point: the builder stubs new keys as "" everywhere, so
 * "present" says nothing — `isCellMissing` uses the same predicate the
 * validator does, so this table and the publish gate agree.
 */
export const LocalizationModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();

  const rows = buildMatrixRows(vm.config);
  const completions = vm.locales.map((l) => localeCompletion(vm.config, rows, l));
  const baseGaps = completions.find((c) => c.locale === vm.defaultLocale)?.missingKeys.length ?? 0;
  const otherGaps = completions
    .filter((c) => c.locale !== vm.defaultLocale)
    .reduce((n, c) => n + c.missingKeys.length, 0);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[min(1000px,96vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("paywalls.builder.localization.title", "Localization")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.localization.subtitle",
                "Every string the paywall uses, in every locale it ships in. Blank cells are untranslated.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.localization.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-rv-mute-500">
              {t(
                "paywalls.builder.localization.empty",
                "This paywall has no text yet. Add a text or button node to translate.",
              )}
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <th
                    style={{ width: KEY_COL_WIDTH }}
                    className="sticky top-0 z-10 bg-rv-c1 pb-2 pr-3 align-bottom font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500"
                  >
                    {t("paywalls.builder.localization.stringCol", "String")}
                  </th>
                  {completions.map((c) => {
                    const isBase = c.locale === vm.defaultLocale;
                    const complete = c.done === c.total;
                    return (
                      <th
                        key={c.locale}
                        style={{ width: LOCALE_COL_WIDTH }}
                        className="sticky top-0 z-10 bg-rv-c1 pb-2 pr-3 align-bottom"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-rv-mono text-[11px] uppercase text-foreground">
                            {c.locale}
                          </span>
                          {isBase && (
                            <span className="rounded bg-rv-accent-500/15 px-1 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-accent-500">
                              {t("paywalls.builder.localization.base", "base")}
                            </span>
                          )}
                        </div>
                        <div
                          className={cn(
                            "mt-0.5 font-rv-mono text-[10px]",
                            complete
                              ? "text-rv-success"
                              : isBase
                                ? "text-rv-danger"
                                : "text-rv-warning",
                          )}
                        >
                          {c.done}/{c.total}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t border-rv-divider">
                    <td className="py-2 pr-3 align-top">
                      <div className="font-rv-mono text-[11px] text-foreground">{row.key}</div>
                      <div className="mt-0.5 flex items-center gap-1 font-rv-mono text-[10px] text-rv-mute-500">
                        <span>
                          {row.nodeType} · {row.nodeId}
                        </span>
                        {row.viaOverride && (
                          <span
                            title={t(
                              "paywalls.builder.localization.viaOverrideHint",
                              "This key is introduced by a conditional override, so it only renders when that condition holds.",
                            )}
                            className="rounded bg-rv-violet/15 px-1 text-rv-violet"
                          >
                            {t("paywalls.builder.localization.viaOverride", "override")}
                          </span>
                        )}
                        {row.otherNodeIds.length > 0 && (
                          <span
                            title={t(
                              "paywalls.builder.localization.alsoUsedBy",
                              "Also used by: {{ids}}",
                              { ids: row.otherNodeIds.join(", ") },
                            )}
                            className="rounded bg-rv-c3 px-1 text-rv-mute-600"
                          >
                            +{row.otherNodeIds.length}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            vm.selectNode(row.nodeId);
                            onClose();
                          }}
                          title={t("paywalls.builder.localization.jump", "Select the node using this string")}
                          className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
                        >
                          <CornerUpRight size={11} />
                        </button>
                      </div>
                    </td>
                    {vm.locales.map((locale) => {
                      const missing = isCellMissing(vm.config, row.key, locale);
                      const isBase = locale === vm.defaultLocale;
                      return (
                        <td key={locale} className="py-2 pr-3 align-top">
                          <input
                            value={vm.config.localizations[locale]?.[row.key] ?? ""}
                            onChange={(e) => vm.setLocaleText(row.key, locale, e.currentTarget.value)}
                            placeholder={t("paywalls.builder.localization.untranslated", "untranslated")}
                            className={cn(
                              "h-7 w-full rounded border bg-rv-c2 px-2 text-[12px] text-foreground outline-none transition focus:border-rv-accent-500",
                              missing
                                ? isBase
                                  ? "border-rv-danger/50"
                                  : "border-rv-warning/50"
                                : "border-rv-divider",
                            )}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-rv-divider px-5 py-3">
          <div className="flex-1 text-[12px]">
            {baseGaps > 0 ? (
              <span className="text-rv-danger">
                {t("paywalls.builder.localization.blocking", {
                  count: baseGaps,
                  defaultValue: "{{count}} blank string in the base locale blocks publishing.",
                  defaultValue_other: "{{count}} blank strings in the base locale block publishing.",
                })}
              </span>
            ) : otherGaps > 0 ? (
              <span className="text-rv-warning">
                {t("paywalls.builder.localization.warnings", {
                  count: otherGaps,
                  defaultValue: "{{count}} untranslated string — it falls back to the base locale.",
                  defaultValue_other:
                    "{{count}} untranslated strings — they fall back to the base locale.",
                })}
              </span>
            ) : (
              <span className="text-rv-success">
                {t("paywalls.builder.localization.complete", "Every string is translated.")}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
          >
            {t("paywalls.builder.localization.done", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Mount it from `BuilderShell`**

In `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`, add the import:

```tsx
import { LocalizationModal } from "./localization-modal";
```

add the state beside `showValidation`/`showDiff`:

```tsx
  const [showLocalization, setShowLocalization] = useState(false);
```

pass the opener to `TopBar` (the button that calls it arrives in Task 5):

```tsx
      <TopBar
        projectId={projectId}
        onOpenValidation={() => setShowValidation(true)}
        onOpenDiff={() => setShowDiff(true)}
        onOpenLocalization={() => setShowLocalization(true)}
      />
```

and mount the modal beside the others:

```tsx
      {showLocalization && <LocalizationModal onClose={() => setShowLocalization(false)} />}
```

- [ ] **Step 3: Add the `onOpenLocalization` prop to `TopBar`**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`, extend `Props` and the destructure so the shell compiles now; the button itself is Task 5. Add to the `type Props`:

```tsx
  onOpenLocalization: () => void;
```

and add `onOpenLocalization` to the component's destructured parameters. Reference it once so strict TS doesn't flag an unused binding — Task 5 replaces this with the real button:

```tsx
  void onOpenLocalization;
```

- [ ] **Step 4: Export from the barrel**

In `apps/dashboard/src/components/paywall-builder/index.ts`, add:

```ts
export { LocalizationModal } from "./localization-modal";
```

- [ ] **Step 5: Typecheck, build and run the suite**

Run:
```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard build
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: all exit 0 / PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/localization-modal.tsx \
  apps/dashboard/src/components/paywall-builder/builder-shell.tsx \
  apps/dashboard/src/components/paywall-builder/top-bar.tsx \
  apps/dashboard/src/components/paywall-builder/index.ts
git commit -m "feat(dashboard): paywall localization matrix modal"
```

---

### Task 5: Top-bar entry point with a gap indicator

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`

**Interfaces:**
- Consumes: `onOpenLocalization` (Task 4); `buildMatrixRows`, `localeCompletion` (Task 3); `vm.config`, `vm.locales`, `vm.defaultLocale`.
- Produces: a button beside `LocaleSwitcher` that opens the matrix and carries a severity-coloured dot when cells are blank.

- [ ] **Step 1: Replace the placeholder with the real button**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`, add the imports:

```tsx
import { Table2 } from "lucide-react";
import { buildMatrixRows, localeCompletion } from "./localization-model";
```

Delete the `void onOpenLocalization;` placeholder line added in Task 4.

Inside the `TopBar` component body, compute the indicator:

```tsx
  const locRows = buildMatrixRows(vm.config);
  const baseGapCount =
    localeCompletion(vm.config, locRows, vm.defaultLocale).missingKeys.length;
  const otherGapCount = vm.locales
    .filter((l) => l !== vm.defaultLocale)
    .reduce((n, l) => n + localeCompletion(vm.config, locRows, l).missingKeys.length, 0);
```

Then render the button immediately after `<LocaleSwitcher />`:

```tsx
        <button
          type="button"
          onClick={onOpenLocalization}
          title={t("paywalls.builder.topbar.localization", "Localization matrix")}
          className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <Table2 size={13} />
          {(baseGapCount > 0 || otherGapCount > 0) && (
            <span
              className={cn(
                "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
                baseGapCount > 0 ? "bg-rv-danger" : "bg-rv-warning",
              )}
            />
          )}
        </button>
```

- [ ] **Step 2: Typecheck, build and run the suite**

Run:
```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard build
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: all exit 0 / PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/top-bar.tsx
git commit -m "feat(dashboard): top-bar entry point for the paywall localization matrix"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/shared exec vitest run src/paywall` — validator + primitives green.
2. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — model + existing builder tests green.
3. `pnpm --filter @rovenue/dashboard exec tsc --noEmit` and `pnpm --filter @rovenue/dashboard build` — both clean.
4. Manual (optional, seeded dev dashboard): open a paywall, add a text node (its key stubs blank in every locale), confirm the top-bar dot turns danger, open the matrix, confirm the base column reads `n-1/n` in red and the publish button is blocked; type text into the base cell and confirm the block clears.

## Out of scope (deferred)

- Staleness (`localizationMeta` sidecar + `LOCALE_STALE`) — needs the four platform decoders verified for unknown-config-field tolerance.
- Auto-translate via copilot BYOK — needs a review gate before machine copy ships.
- Aligning `LOCALE_KEY_GAP`'s key set with tree usage (spec §4 observation).
