# Paywall Inspector Tabs (P5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the paywall builder's 914-line properties panel into a tabbed inspector, without changing what any field does.

**Architecture:** A pure tab table declares each tab's applicable node types and the issue codes whose field it holds; `InspectorTabId` derives from the table. The panel's shared field primitives and the overrides section move verbatim into their own modules, then the per-node-type editors are transposed into per-tab modules and `properties-panel.tsx` becomes a shell that renders the strip.

**Tech Stack:** TypeScript (strict), Vitest, React + `impair` DI, `react-i18next`, Tailwind (`rv-*` tokens + `cn`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-paywall-inspector-tabs-design.md`.
- Dashboard only — **no schema, API, DB, wire or renderer change.**
- TypeScript strict.
- **No magic values** — the tab table is structured data, not a magic value; any size or z-layer gets a named constant.
- Every user-facing string via `t(key, "English fallback")`, and **every new key must be added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.**
- **Field semantics are frozen.** Moved code is moved, not rewritten — same `t()` keys, same `set()` calls, same value coercion. If a move seems to require a behaviour change, that is a finding to report, not a change to make.
- Follow the existing idiom: `rv-*` tokens, `cn()`, `lucide-react`, `component()` + `useService`.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter @rovenue/dashboard exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`.
- Conventional commits; commit per task.

## The field inventory this plan is built on

Read out of `properties-panel.tsx` before writing the plan. Task 3 must land every one of these on the stated tab, and nothing else:

| Node type | Layout | Style | Content | Binding |
|---|---|---|---|---|
| `stack` | axis, spacing, align, padding, size.width, size.height | background, cornerRadius | — | — |
| `text` | — | role, align, color | text (localized `key`) | — |
| `image` | height | cornerRadius | url.light, url.dark, alt | — |
| `button` | — | style | label (localized `labelKey`) | action (kind, url) |
| `packageList` | cellLayout, cellTemplate | — | — | packageIds, defaultSelected |
| `purchaseButton` | — | — | label (localized `labelKey`) | — |
| `spacer` | size | — | — | — |

Note `align` appears under Layout for `stack` and under Style for `text`. That is not an inconsistency: on a stack it aligns children (layout), on text it aligns glyphs (typography). Same component, different meaning.

---

## File Structure

**Create:**
- `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts` — the table, `InspectorTabId`, `tabsForNode`, `tabIssues`, `resolveActiveTab`.
- `apps/dashboard/src/components/paywall-builder/inspector/tabs.test.ts`
- `apps/dashboard/src/components/paywall-builder/inspector/fields.tsx` — the shared primitives, moved verbatim.
- `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx` — the overrides section, moved verbatim.
- `apps/dashboard/src/components/paywall-builder/inspector/layout-tab.tsx`
- `apps/dashboard/src/components/paywall-builder/inspector/style-tab.tsx`
- `apps/dashboard/src/components/paywall-builder/inspector/content-tab.tsx`
- `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.tsx`

**Modify:**
- `apps/dashboard/src/components/paywall-builder/properties-panel.tsx` — becomes the shell.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — `inspectorTab` state + setter.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
- `apps/dashboard/src/i18n/locales/en.json`

---

### Task 1: The tab model

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts`
- Create: `apps/dashboard/src/components/paywall-builder/inspector/tabs.test.ts`

**Interfaces:**
- Consumes: `PaywallNode`, `BuilderIssue`, `isPublishBlockingIssue` from `@rovenue/shared/paywall`.
- Produces:
  - `INSPECTOR_TABS`, `type InspectorTabId`
  - `tabsForNode(type: PaywallNode["type"]): readonly InspectorTab[]`
  - `tabIssues(issues: BuilderIssue[], nodeId: string): Map<InspectorTabId, "error" | "warning">`
  - `resolveActiveTab(current: InspectorTabId | null, type: PaywallNode["type"]): InspectorTabId | null`

Pure module — no React, no view model. That is what makes it testable.

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/components/paywall-builder/inspector/tabs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BuilderIssue } from "@rovenue/shared/paywall";
import { INSPECTOR_TABS, resolveActiveTab, tabIssues, tabsForNode } from "./tabs";

describe("tabsForNode", () => {
  it("gives every node type at least one tab", () => {
    for (const type of ["stack", "text", "image", "button", "packageList", "purchaseButton", "spacer"] as const) {
      expect(tabsForNode(type).length).toBeGreaterThan(0);
    }
  });

  it("returns tabs in table order, not selection order", () => {
    const ids = tabsForNode("button").map((t) => t.id);
    const tableOrder = INSPECTOR_TABS.filter((t) => ids.includes(t.id)).map((t) => t.id);
    expect(ids).toEqual(tableOrder);
  });

  it("filters out tabs a node type has nothing on", () => {
    expect(tabsForNode("spacer").map((t) => t.id)).toEqual(["layout"]);
    expect(tabsForNode("purchaseButton").map((t) => t.id)).toEqual(["content"]);
    expect(tabsForNode("packageList").map((t) => t.id)).toEqual(["layout", "binding"]);
  });
});

describe("tabIssues", () => {
  const issues: BuilderIssue[] = [
    { code: "EMPTY_LOC_VALUE", nodeId: "n1", key: "k", message: "" },
    { code: "FOREIGN_PACKAGE_ID", nodeId: "n1", message: "" },
    { code: "DUPLICATE_NODE_ID", nodeId: "n1", message: "" },
    { code: "EMPTY_LOC_VALUE", nodeId: "other", key: "k", message: "" },
  ];

  it("groups a node's issues onto the tab holding the offending field", () => {
    const map = tabIssues(issues, "n1");
    expect(map.get("content")).toBe("error");
    expect(map.get("binding")).toBe("error");
  });

  it("ignores issues belonging to other nodes", () => {
    expect(tabIssues(issues, "nobody").size).toBe(0);
  });

  it("gives no dot to a code that maps to no tab", () => {
    const map = tabIssues([{ code: "DUPLICATE_NODE_ID", nodeId: "n1", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  it("gives no dot for a per-locale code, which is not a node's field", () => {
    const map = tabIssues([{ code: "LOCALE_KEY_GAP", nodeId: "n1", locale: "de", key: "k", message: "" }], "n1");
    expect(map.size).toBe(0);
  });

  // Every code currently mapped to a tab is publish-blocking, so the
  // "warning" severity is unreachable today. Assert that rather than
  // writing a test that pretends to exercise it: this documents the fact
  // and will start failing the day a warning-tier code is mapped, which is
  // exactly when someone should look at the branch again.
  it("only ever reports errors today, because no warning-tier code maps to a tab", () => {
    const everyMappedCode = INSPECTOR_TABS.flatMap((t) => [...t.issueCodes]);
    const map = tabIssues(
      everyMappedCode.map((code) => ({ code, nodeId: "n1", message: "" })),
      "n1",
    );
    expect([...map.values()].every((s) => s === "error")).toBe(true);
  });
});

describe("resolveActiveTab", () => {
  it("keeps the current tab when the new node also has it", () => {
    expect(resolveActiveTab("style", "text")).toBe("style");
  });

  it("falls back to the node's first applicable tab, not a fixed default", () => {
    expect(resolveActiveTab("style", "spacer")).toBe("layout");
    expect(resolveActiveTab("layout", "purchaseButton")).toBe("content");
  });

  it("picks the first applicable tab when there is no current one", () => {
    expect(resolveActiveTab(null, "text")).toBe("style");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/inspector/tabs.test.ts`
Expected: FAIL — `Cannot find module './tabs'`.

- [ ] **Step 3: Write the module**

Create `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts`:

```ts
import { isPublishBlockingIssue, type BuilderIssue, type PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// The inspector's tab table. Each tab declares everything about
// itself — which node types it applies to, and which validator issue
// codes have their offending field on it — so there is no second
// place to keep in step when a tab is added.
// =============================================================

export interface InspectorTab {
  id: "layout" | "style" | "content" | "binding";
  /** English fallback; the label is t(`paywalls.builder.inspector.tab.${id}`, fallbackLabel). */
  fallbackLabel: string;
  appliesTo: ReadonlySet<PaywallNode["type"]>;
  /**
   * Issue codes whose offending field lives on this tab. A code absent
   * from every tab gets no dot on purpose: DUPLICATE_NODE_ID is not a
   * field, MISSING_PURCHASE_BUTTON is a property of the tree rather than
   * of a node, LOCALE_KEY_GAP is per-locale, and the OVERRIDE_* codes
   * belong to the overrides section, which sits outside the strip. The
   * validation drawer remains the complete list; this is a pointer.
   */
  issueCodes: ReadonlySet<string>;
}

/** Declaration order IS display order. */
export const INSPECTOR_TABS: readonly InspectorTab[] = [
  {
    id: "layout",
    fallbackLabel: "Layout",
    appliesTo: new Set(["stack", "image", "packageList", "spacer"]),
    issueCodes: new Set(["CELL_TEMPLATE_BAD_NODE"]),
  },
  {
    id: "style",
    fallbackLabel: "Style",
    appliesTo: new Set(["stack", "text", "image", "button"]),
    issueCodes: new Set<string>(),
  },
  {
    id: "content",
    fallbackLabel: "Content",
    appliesTo: new Set(["text", "image", "button", "purchaseButton"]),
    issueCodes: new Set(["UNKNOWN_LOC_KEY", "EMPTY_LOC_VALUE"]),
  },
  {
    id: "binding",
    fallbackLabel: "Binding",
    appliesTo: new Set(["button", "packageList"]),
    issueCodes: new Set(["FOREIGN_PACKAGE_ID"]),
  },
];

export type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

/** The tabs a node type has anything to configure on, in table order. */
export function tabsForNode(type: PaywallNode["type"]): readonly InspectorTab[] {
  return INSPECTOR_TABS.filter((tab) => tab.appliesTo.has(type));
}

/**
 * Severity per tab for one node: "error" when any of that tab's issues
 * blocks publishing, "warning" otherwise. Severity is read from the shared
 * model rather than restated here.
 *
 * NOTE: every code currently mapped to a tab is publish-blocking, so the
 * "warning" result is unreachable as things stand. It is kept because the
 * severity question belongs here rather than at the call site, and because
 * mapping a warning-tier code later should not need this function changed
 * — but do not read the branch as evidence that warning dots exist.
 */
export function tabIssues(
  issues: BuilderIssue[],
  nodeId: string,
): Map<InspectorTabId, "error" | "warning"> {
  const out = new Map<InspectorTabId, "error" | "warning">();
  for (const issue of issues) {
    if (issue.nodeId !== nodeId) continue;
    for (const tab of INSPECTOR_TABS) {
      if (!tab.issueCodes.has(issue.code)) continue;
      const severity = isPublishBlockingIssue(issue) ? "error" : "warning";
      if (severity === "error" || !out.has(tab.id)) out.set(tab.id, severity);
    }
  }
  return out;
}

/**
 * Keep the author's current tab across a selection change when it still
 * applies; otherwise fall back to the new node's FIRST applicable tab
 * rather than a fixed default, so the fallback is always meaningful.
 */
export function resolveActiveTab(
  current: InspectorTabId | null,
  type: PaywallNode["type"],
): InspectorTabId | null {
  const applicable = tabsForNode(type);
  if (current && applicable.some((tab) => tab.id === current)) return current;
  return applicable[0]?.id ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/inspector/tabs.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit` — exits 0.

```bash
git add apps/dashboard/src/components/paywall-builder/inspector/tabs.ts \
  apps/dashboard/src/components/paywall-builder/inspector/tabs.test.ts
git commit -m "feat(dashboard): the paywall inspector's tab table and its pure model"
```

---

### Task 2: Move the shared parts out, verbatim

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/inspector/fields.tsx`
- Create: `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/properties-panel.tsx`

**Interfaces:**
- Produces: `fields.tsx` exports `Section`, `Field`, `Segmented`, `NumberField`, `MiniNumber`, `SizeField`, `PaddingField`, `AlignField`, `ThemeColorField`, `LocalizedTextField` and the `INPUT_CLASS` constant. `overrides.tsx` exports `OverridesSection`.

A pure move. The panel keeps working and looking identical; it just imports what it used to declare. Doing this before the transpose means the risky part (Task 3) starts from a much smaller file.

- [ ] **Step 1: Move the field primitives**

Cut these from `properties-panel.tsx` into `inspector/fields.tsx`, **unchanged**: `INPUT_CLASS`, `LocalizedTextField`, `ThemeColorField`, `AlignField`, `PaddingField`, `MiniNumber`, `SizeField`, `NumberField`, `Section`, `Field`, `Segmented`. Export each. Move their imports with them; leave `properties-panel.tsx` importing from `./inspector/fields`.

Do not rename, re-type, reorder props, or "tidy" anything. Byte-identical bodies.

- [ ] **Step 2: Move the overrides section**

Cut `OVERRIDE_PROP_LABEL`, `OverridesSection`, `overrideConditionLabel`, `OverrideRow` and `OverridePropField` into `inspector/overrides.tsx`, unchanged, exporting `OverridesSection`. It imports its field primitives from `./fields`.

- [ ] **Step 3: Verify nothing moved changed**

Run:
```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
pnpm --filter @rovenue/dashboard build
```
Expected: all clean/green, with no test edited. A test that needs editing here means something was rewritten rather than moved — stop and report it.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/inspector/fields.tsx \
  apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx \
  apps/dashboard/src/components/paywall-builder/properties-panel.tsx
git commit -m "refactor(dashboard): extract the paywall inspector's field library and overrides"
```

---

### Task 3: Transpose the editors into tabs and build the strip

**Files:**
- Create: `inspector/layout-tab.tsx`, `inspector/style-tab.tsx`, `inspector/content-tab.tsx`, `inspector/binding-tab.tsx`
- Modify: `properties-panel.tsx`, `vm/paywall-builder.vm.ts`, `vm/paywall-builder.vm.test.ts`, `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: Task 1's model, Task 2's `fields.tsx` / `overrides.tsx`.
- Produces: each tab module exports one component taking `{ node }: { node: PaywallNode }` and rendering only the sections that apply to that node's type; `PaywallBuilderViewModel` gains `inspectorTab: InspectorTabId | null` and `setInspectorTab(id)`.

- [ ] **Step 1: Add the view-model state and its test**

Add to `vm/paywall-builder.vm.ts`:

```ts
  /** Which inspector tab is open. Survives selecting another node so an
   * author styling several nodes in a row is not thrown back to Layout on
   * every click; `resolveActiveTab` re-points it when the new node has no
   * such tab. */
  @state private inspectorTabRaw: InspectorTabId | null = null;

  @derived get inspectorTab(): InspectorTabId | null {
    const node = this.selectedNode;
    if (!node) return null;
    return resolveActiveTab(this.inspectorTabRaw, node.type);
  }

  setInspectorTab(id: InspectorTabId) {
    this.inspectorTabRaw = id;
  }
```

Deriving rather than reacting to selection is what keeps this correct: there is no effect to fire, no ordering to get wrong, and the value cannot go stale between a selection change and a re-render.

Add to `vm/paywall-builder.vm.test.ts`, using the file's existing `makeVm` / `fakeDetail` helpers:

```ts
describe("inspector tab", () => {
  it("keeps the chosen tab while it applies to the selected node", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");

    vm.setInspectorTab("content");

    expect(vm.inspectorTab).toBe("content");
  });

  it("re-points to the first applicable tab when the new node has no such tab", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});
    vm.selectNode("t1");
    vm.setInspectorTab("content");

    const spacerId = vm.addNode("spacer", "root");
    vm.selectNode(spacerId!);

    expect(vm.inspectorTab).toBe("layout");
  });

  it("is null when nothing is selected", async () => {
    const get = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({ get, patchBuilderConfig: vi.fn() });
    await vm.load(() => {});

    expect(vm.inspectorTab).toBeNull();
  });
});
```

Run it and confirm it fails before implementing.

- [ ] **Step 2: Write the four tab modules**

Each is a `component()` taking `{ node }` and switching on `node.type`, rendering the `<Section>` blocks that the inventory table assigns to it. **Move the JSX out of the existing editors unchanged** — same `t()` keys, same `set()` calls, same props on every field. The only new code is the outer `switch`.

This plan deliberately does not paste that JSX. It is ~400 lines that already exist in `properties-panel.tsx`, and a copy embedded here would be a second source of truth that silently drifts from the file being moved. The inventory table above is the specification — it says exactly which field goes on which tab — and the source is the authority on how each field is written. Move, do not retype.

Split by the inventory table in this plan's header:
- `layout-tab.tsx` — `stack` (axis, spacing, align, padding, size), `image` (height), `packageList` (cellLayout, cellTemplate), `spacer` (size).
- `style-tab.tsx` — `stack` (background, cornerRadius), `text` (role, align, color), `image` (cornerRadius), `button` (style).
- `content-tab.tsx` — `text` (text), `image` (url.light, url.dark, alt), `button` (label), `purchaseButton` (label).
- `binding-tab.tsx` — `button` (action), `packageList` (packageIds, defaultSelected).

Keep the existing `<Section>` groupings inside a tab where they exist; a tab with one section still uses one.

- [ ] **Step 3: Rewrite `properties-panel.tsx` as the shell**

It renders, for a selected node: the tab strip from `tabsForNode(node.type)`, the active tab's module, and `<OverridesSection node={node} />` below the strip — persistent, outside the tabs, per the spec.

Strip requirements:
- Label via `t(\`paywalls.builder.inspector.tab.${tab.id}\`, tab.fallbackLabel)`.
- The active tab is visually distinct; use the existing `Segmented`-style idiom from `fields.tsx` if it fits, otherwise match the top bar's button treatment.
- A tab carrying issues shows a dot: `bg-rv-danger` for `"error"`, `bg-rv-warning` for `"warning"`, from `tabIssues(vm.validationIssues, node.id)`.
- Give the dot a `title` naming the count, so it is not a mystery mark. Note `title` on a **disabled** element may not render in Chrome/Safari — these tabs are not disabled, so it is fine here.

Keep the panel's existing empty state (nothing selected) exactly as it is.

- [ ] **Step 4: Add the four labels to `en.json`**

Under `paywalls.builder`, add an `inspector.tab` object with `layout`, `style`, `content`, `binding`, plus whatever key the dot's title uses. Match the file's indentation; do not reorder or reformat anything else.

- [ ] **Step 5: Verify**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('valid json')"
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
pnpm --filter @rovenue/dashboard build
wc -l apps/dashboard/src/components/paywall-builder/properties-panel.tsx \
      apps/dashboard/src/components/paywall-builder/inspector/*.tsx
```
Expected: valid json; tsc 0; suite green; build ✓; and no file over ~250 lines. If one is, say which and why rather than splitting further on the spot.

- [ ] **Step 6: Walk the inventory**

Before committing, go through this plan's inventory table row by row against the shipped tab modules and confirm every listed field is present exactly once, with the same `t()` key and the same `set()` call as before the split. There is no machine-readable list to diff against, so this check is manual by design — report the result field by field, not as "all good".

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/inspector \
  apps/dashboard/src/components/paywall-builder/properties-panel.tsx \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts \
  apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): tabbed paywall inspector"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — green.
2. `tsc --noEmit` and `pnpm --filter @rovenue/dashboard build` — clean.
3. Manual (seeded dev dashboard): select each of the seven node types in turn and confirm the tab strip matches the inventory table, that every field is where the table says, and that editing each one still updates the canvas as before.
4. Manual: select a text node whose default-locale string is blank — the Content tab must show a danger dot, and the validation drawer must still list the same issue.
5. Manual: with Style open on a text node, select a spacer — the strip must fall back to Layout, not to a blank panel.

## Out of scope (deferred)

- `visibility` and the fifth tab — P5b.
- Per-element font — P10.
- The Binding tab's resolved-catalog readout — blocked on an endpoint that cannot exist server-side.
