# Paywall Node Types Wave A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `divider` and `icon` node types across the shared schema and all three renderers, and replace the hardcoded localization-key lists with one extensible table.

**Architecture:** `divider` and `icon` follow the existing seven node types exactly — a TS type, a Zod schema, a union entry, an `OVERRIDABLE_PROP_KEYS` row, and a render case per platform. Icons are a name-mapping table, not geometry: each platform draws with its own native set, so the shared registry maps a semantic name to a lucide export, a Material drawable and an SF Symbol.

**Tech Stack:** TypeScript + Zod, React (`packages/paywall-renderer`, `lucide-react`), SwiftUI (SF Symbols), Android Views (Material VectorDrawables), Vitest, `swift test`, `testDebugUnitTest`.

**Spec:** `docs/superpowers/specs/2026-07-27-paywall-node-types-wave-a-design.md`

## Global Constraints

- **No magic values.** Every default (thickness, size, inset) is a named constant. Structured data tables — the registry, `OVERRIDABLE_PROP_KEYS`, the node-type lists — are not magic values and stay as tables.
- **Never create or switch branches, and never use a worktree.** Commit on whatever HEAD is checked out.
- **`git add` only the files your task touches.** Never `git add -A`, never `git commit -a` — other work is in flight in this tree. After committing, run `git show --stat <sha>` and confirm it holds exactly your files. Report the SHA you verified.
- **Write escape sequences as escape sequences.** A previous phase materialised one into a raw `0x00` byte and made a source file binary and unreviewable.
- `icon.name` is a **free string, not an enum**. An unknown name renders nothing and never throws. The validator raises `UNKNOWN_ICON_NAME`, which is a **`warning`** — it blocks neither save nor publish.
- The twelve registry rows below were each verified against their source. Copy them **verbatim**; do not substitute a name that seems more natural.
- Swift and Kotlin have real local test gates — `swift test` in `packages/sdk-swift`, `./gradlew testDebugUnitTest` in `packages/sdk-kotlin`. Use them. Only `packages/sdk-rn/ios` and `/android` lack gates, and this plan does not touch them.

### The icon registry, verified

| Semantic name | Web (lucide-react export) | Android (Material category/name) | iOS (SF Symbol) |
|---|---|---|---|
| `check` | `Check` | `action/done` | `checkmark` |
| `x` | `X` | `navigation/close` | `xmark` |
| `star` | `Star` | `toggle/star` | `star.fill` |
| `lock` | `Lock` | `action/lock` | `lock.fill` |
| `shield` | `Shield` | `action/verified_user` | `checkmark.shield.fill` |
| `sparkle` | `Sparkles` | `image/auto_awesome` | `sparkles` |
| `bolt` | `Zap` | `image/flash_on` | `bolt.fill` |
| `gift` | `Gift` | `action/card_giftcard` | `gift.fill` |
| `clock` | `Clock` | `action/schedule` | `clock.fill` |
| `infinity` | `Infinity` | `places/all_inclusive` | `infinity` |
| `cloud` | `Cloud` | `file/cloud` | `cloud.fill` |
| `arrow-right` | `ArrowRight` | `navigation/arrow_forward` | `arrow.right` |

---

## File Structure

**Created:** `packages/shared/src/paywall/icon-registry.json` (the mapping table) and `icon-registry.ts` (typed accessor); `packages/sdk-kotlin/src/main/res/drawable/` (twelve vendored XMLs — the module's first resources).

**Modified:** `packages/shared/src/paywall/{schema.ts,validate.ts,index.ts}`; `packages/paywall-renderer/src/nodes.tsx` + `package.json`; `apps/dashboard/src/components/paywall-builder/{node-meta.ts,tree-ops.ts,inspector/content-tab.tsx,inspector/fields.tsx}` + `apps/dashboard/src/i18n/locales/en.json`; `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel.swift,RovenuePaywallView.swift}`; `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModel.kt,NodeViewFactory.kt}`.

Tasks 1-3 are shared and must land in order. Tasks 4-7 each consume them and are independent of one another.

---

### Task 1: The two node types in the shared schema

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`
- Test: `packages/shared/src/paywall/schema.test.ts`

**Interfaces:**
- Produces: `DividerNode` and `IconNode` TS types; `divider` and `icon` members of the `PaywallNode` union; `OVERRIDABLE_PROP_KEYS.divider` and `.icon`; the constants `DIVIDER_DEFAULT_THICKNESS`, `DIVIDER_DEFAULT_INSET`, `ICON_DEFAULT_SIZE`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/paywall/schema.test.ts`:

```ts
describe("divider and icon node types", () => {
  const wrap = (node: unknown) => ({
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: {} },
    root: { type: "stack", id: "root", axis: "v", children: [node] },
  });

  it("accepts a minimal divider", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "divider", id: "d1" })).success).toBe(true);
  });

  it("accepts a divider with all props", () => {
    const r = builderConfigSchema.safeParse(
      wrap({ type: "divider", id: "d1", color: { light: "#e5e5e5" }, thickness: 2, inset: 16 }),
    );
    expect(r.success).toBe(true);
  });

  it("accepts a minimal icon", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "icon", id: "i1", name: "check" })).success).toBe(true);
  });

  // The name is deliberately NOT an enum: a thirteenth icon must not be a
  // wire change that older SDKs reject wholesale.
  it("accepts an icon name outside the registry", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "icon", id: "i1", name: "not-a-real-icon" })).success).toBe(true);
  });

  it("rejects an icon with no name", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "icon", id: "i1" })).success).toBe(false);
  });

  it("rejects an icon whose name is empty", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "icon", id: "i1", name: "" })).success).toBe(false);
  });

  it("gives both types an OVERRIDABLE_PROP_KEYS row", () => {
    expect(OVERRIDABLE_PROP_KEYS.divider).toEqual(["color", "thickness"]);
    expect(OVERRIDABLE_PROP_KEYS.icon).toEqual(["name", "color"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: FAIL — the minimal-divider case parses `false` because `divider` is not in the union.

- [ ] **Step 3: Add the types**

In `packages/shared/src/paywall/schema.ts`, after the `SpacerNode` type (around line 128), add:

```ts
/** Default hairline thickness, in device-independent pixels. */
export const DIVIDER_DEFAULT_THICKNESS = 1;
/** Default horizontal inset, in device-independent pixels. */
export const DIVIDER_DEFAULT_INSET = 0;
/** Default icon edge length, in device-independent pixels. */
export const ICON_DEFAULT_SIZE = 24;

export type DividerNode = {
  type: "divider";
  id: string;
  color?: ThemeColor;
  /** Defaults to DIVIDER_DEFAULT_THICKNESS. */
  thickness?: number;
  /** Horizontal inset on both sides. Defaults to DIVIDER_DEFAULT_INSET. */
  inset?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type IconNode = {
  type: "icon";
  id: string;
  /** A name from icon-registry.json. Deliberately a free string: unknown
   *  names render nothing and fail open, so adding an icon later is not a
   *  wire change older SDKs reject. */
  name: string;
  /** Defaults to ICON_DEFAULT_SIZE. */
  size?: number;
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add both to the `PaywallNode` union, after `SpacerNode`.

- [ ] **Step 4: Add the schemas and the override rows**

After `spacerNodeSchema`, add:

```ts
const dividerNodeSchema: z.ZodType<DividerNode> = z.object({
  type: z.literal("divider"),
  id: z.string().min(1),
  color: themeColorSchema.optional(),
  thickness: z.number().optional(),
  inset: z.number().optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.divider).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const iconNodeSchema: z.ZodType<IconNode> = z.object({
  type: z.literal("icon"),
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().optional(),
  color: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.icon).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});
```

Add `dividerNodeSchema` and `iconNodeSchema` to the `paywallNodeSchema` union, and add these two rows to `OVERRIDABLE_PROP_KEYS`:

```ts
  divider: ["color", "thickness"],
  icon: ["name", "color"],
```

`OVERRIDABLE_PROP_KEYS` is `Record<PaywallNode["type"], readonly string[]>`, so omitting either row is a compile error — that is the intended safety net, not something to work around.

- [ ] **Step 5: Run the shared suite**

Run: `cd packages/shared && npx vitest run`
Expected: PASS, including every pre-existing test. If an exhaustiveness `switch` elsewhere in `shared` now fails to compile, add the two cases rather than a `default`.

Then: `npx tsc --noEmit -p tsconfig.json` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/schema.test.ts
git commit -m "feat(shared): add the divider and icon paywall node types"
```

---

### Task 2: The icon registry and its validator warning

**Files:**
- Create: `packages/shared/src/paywall/icon-registry.json`
- Create: `packages/shared/src/paywall/icon-registry.ts`
- Modify: `packages/shared/src/paywall/validate.ts`, `packages/shared/src/paywall/index.ts`
- Test: `packages/shared/src/paywall/icon-registry.test.ts`, `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: `IconNode` from Task 1.
- Produces: `ICON_NAMES: readonly string[]`, `iconRegistry: readonly IconRegistryEntry[]`, `isKnownIconName(name: string): boolean`, and the `UNKNOWN_ICON_NAME` issue code.

- [ ] **Step 1: Create the registry**

`packages/shared/src/paywall/icon-registry.json` — every value verified against its source; do not edit them by intuition:

```json
{
  "_comment": "Semantic icon name -> the identifier each platform draws it with. NOT geometry: web uses lucide-react (ISC), Android vendors Material Icons VectorDrawables (Apache-2.0, google/material-design-icons), iOS uses SF Symbols. The same paywall therefore looks different on each platform, which is the accepted cost of native sets. SF Symbols here are iOS 13/14-era names, chosen to clear this SDK's iOS 15 floor. Adding a thirteenth icon is one row plus three per-platform mappings.",
  "icons": [
    { "name": "check",       "web": "Check",      "androidCategory": "action",     "androidIcon": "done",           "ios": "checkmark" },
    { "name": "x",           "web": "X",          "androidCategory": "navigation", "androidIcon": "close",          "ios": "xmark" },
    { "name": "star",        "web": "Star",       "androidCategory": "toggle",     "androidIcon": "star",           "ios": "star.fill" },
    { "name": "lock",        "web": "Lock",       "androidCategory": "action",     "androidIcon": "lock",           "ios": "lock.fill" },
    { "name": "shield",      "web": "Shield",     "androidCategory": "action",     "androidIcon": "verified_user",  "ios": "checkmark.shield.fill" },
    { "name": "sparkle",     "web": "Sparkles",   "androidCategory": "image",      "androidIcon": "auto_awesome",   "ios": "sparkles" },
    { "name": "bolt",        "web": "Zap",        "androidCategory": "image",      "androidIcon": "flash_on",       "ios": "bolt.fill" },
    { "name": "gift",        "web": "Gift",       "androidCategory": "action",     "androidIcon": "card_giftcard",  "ios": "gift.fill" },
    { "name": "clock",       "web": "Clock",      "androidCategory": "action",     "androidIcon": "schedule",       "ios": "clock.fill" },
    { "name": "infinity",    "web": "Infinity",   "androidCategory": "places",     "androidIcon": "all_inclusive",  "ios": "infinity" },
    { "name": "cloud",       "web": "Cloud",      "androidCategory": "file",       "androidIcon": "cloud",          "ios": "cloud.fill" },
    { "name": "arrow-right", "web": "ArrowRight", "androidCategory": "navigation", "androidIcon": "arrow_forward",  "ios": "arrow.right" }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/shared/src/paywall/icon-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ICON_NAMES, iconRegistry, isKnownIconName } from "./icon-registry";

describe("icon registry", () => {
  it("exposes twelve icons", () => {
    expect(iconRegistry).toHaveLength(12);
    expect(ICON_NAMES).toHaveLength(12);
  });

  it("has no duplicate names", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  // Every platform column must be populated for every row — a blank cell is
  // how one platform silently renders nothing.
  it("gives every icon all three platform identifiers", () => {
    for (const entry of iconRegistry) {
      expect(entry.web, `web missing for ${entry.name}`).toBeTruthy();
      expect(entry.androidCategory, `androidCategory missing for ${entry.name}`).toBeTruthy();
      expect(entry.androidIcon, `androidIcon missing for ${entry.name}`).toBeTruthy();
      expect(entry.ios, `ios missing for ${entry.name}`).toBeTruthy();
    }
  });

  it("recognises registry names and rejects others", () => {
    expect(isKnownIconName("check")).toBe(true);
    expect(isKnownIconName("not-a-real-icon")).toBe(false);
  });
});
```

- [ ] **Step 3: Write the accessor**

`packages/shared/src/paywall/icon-registry.ts`:

```ts
import registry from "./icon-registry.json";

export type IconRegistryEntry = {
  name: string;
  /** lucide-react export name. */
  web: string;
  /** Directory in google/material-design-icons: android/<category>/<icon>/… */
  androidCategory: string;
  androidIcon: string;
  /** SF Symbol name. */
  ios: string;
};

export const iconRegistry: readonly IconRegistryEntry[] = registry.icons;

export const ICON_NAMES: readonly string[] = iconRegistry.map((i) => i.name);

const KNOWN = new Set(ICON_NAMES);

/** Registry membership. Rendering must NOT depend on this — an unknown name
 *  renders nothing and fails open. This exists for the authoring warning. */
export function isKnownIconName(name: string): boolean {
  return KNOWN.has(name);
}
```

Export all four from `packages/shared/src/paywall/index.ts`.

- [ ] **Step 4: Run**

Run: `cd packages/shared && npx vitest run src/paywall/icon-registry.test.ts`
Expected: PASS.

If `resolveJsonModule` is not enabled in the shared tsconfig, enable it rather than inlining the table into TypeScript — the JSON file is what the platform coverage tests read.

- [ ] **Step 5: Add the validator warning**

In `packages/shared/src/paywall/validate.ts`, add `"UNKNOWN_ICON_NAME"` to the `BuilderIssue["code"]` union, and this row to `ISSUE_SEVERITY` beside the other warnings:

```ts
  // A typo to surface, not a broken config — it renders nothing and the
  // renderers fail open, so it must block neither save nor publish.
  UNKNOWN_ICON_NAME: "warning",
```

Inside the existing node walk, emit it:

```ts
    if (node.type === "icon" && !isKnownIconName(node.name)) {
      issues.push({
        code: "UNKNOWN_ICON_NAME",
        nodeId: node.id,
        message: `Icon "${node.name}" (node "${node.id}") is not in the icon registry — it will render nothing.`,
      });
    }
```

Add a test to `validate.test.ts` asserting the issue is raised for an unknown name, is absent for `check`, and that `issueSeverity({ code: "UNKNOWN_ICON_NAME" })` is `"warning"` so neither `isBlockingIssue` nor `isPublishBlockingIssue` returns true.

- [ ] **Step 6: Run the shared suite and commit**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean.

```bash
git add packages/shared/src/paywall/icon-registry.json packages/shared/src/paywall/icon-registry.ts packages/shared/src/paywall/icon-registry.test.ts packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts packages/shared/src/paywall/index.ts
git commit -m "feat(shared): add the icon registry and an unknown-name warning"
```

---

### Task 3: Replace the hardcoded localization-key lists

**Files:**
- Modify: `packages/shared/src/paywall/validate.ts`
- Test: `packages/shared/src/paywall/validate.test.ts`

**Interfaces:**
- Consumes: the node types from Task 1.
- Produces: `LOCALIZED_KEYS: Record<PaywallNode["type"], (node: PaywallNode) => string[]>`, exported so the dashboard can derive from it in Task 4.

Which keys a node contributes is currently written out by hand in two places in this file — `collectLocalizationUsages` (around lines 231-234) and the `UNKNOWN_LOC_KEY` check (around lines 331-332) — and both cover only `text.key` and `button`/`purchaseButton`'s `labelKey`. Wave B's row-carrying types cannot be expressed that way. This task changes no behaviour; the existing localization tests are the proof.

- [ ] **Step 1: Add the table**

In `validate.ts`, beside `OVERRIDABLE_PROP_KEYS`'s sibling declarations:

```ts
/**
 * Which localization keys each node type contributes. Same shape as
 * OVERRIDABLE_PROP_KEYS and exhaustive by construction, so a new node type
 * cannot be added without deciding this.
 *
 * A function rather than a list of property names because wave B's
 * featureList/socialProof/timeline carry arrays of localized rows, which a
 * flat name list cannot express.
 */
export const LOCALIZED_KEYS: Record<PaywallNode["type"], (node: PaywallNode) => string[]> = {
  stack: () => [],
  text: (n) => [(n as TextNode).key],
  image: () => [],
  button: (n) => [(n as ButtonNode).labelKey],
  packageList: () => [],
  purchaseButton: (n) => [(n as PurchaseButtonNode).labelKey],
  spacer: () => [],
  divider: () => [],
  icon: () => [],
};

/** Every localization key this node contributes, in declaration order. */
export function localizedKeysOf(node: PaywallNode): string[] {
  return LOCALIZED_KEYS[node.type](node);
}
```

- [ ] **Step 2: Rewire both call sites**

In `collectLocalizationUsages`, replace the two hand-written `usages.push(...)` lines with a loop over `localizedKeysOf(node)`, preserving the existing `{ key, nodeId, nodeType, viaOverride: false }` shape.

In the `UNKNOWN_LOC_KEY` check, replace the two `if (node.type === …) keysToCheck.push(…)` lines with `keysToCheck.push(...localizedKeysOf(node))`.

Change nothing else — not the issue codes, not the ordering, not the dedup.

- [ ] **Step 3: Prove the refactor is behaviour-preserving**

Run: `cd packages/shared && npx vitest run`
Expected: PASS with the **same test count as before this task**. A changed count means you altered behaviour, not just its expression.

- [ ] **Step 4: Prove the table is load-bearing**

Temporarily change `text: (n) => [(n as TextNode).key]` to `text: () => []` and re-run.
Expected: the localization tests FAIL — `UNKNOWN_LOC_KEY` and the orphan-key checks stop seeing text nodes.

Restore, re-run, confirm green. Report both results: a refactor whose table can be emptied without any test noticing would not be pinned by anything.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/paywall/validate.ts packages/shared/src/paywall/validate.test.ts
git commit -m "refactor(shared): collect localization keys from a per-type table"
```

---

### Task 4: The dashboard builder

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/node-meta.ts`, `tree-ops.ts`, `inspector/content-tab.tsx`, `inspector/fields.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/node-meta.test.ts`, `__tests__/tree-ops.test.ts`

**Interfaces:**
- Consumes: Task 1's types and constants; Task 2's `ICON_NAMES`; Task 3's `localizedKeysOf`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/node-meta.test.ts`:

```ts
it("lists divider and icon in the palette", () => {
  expect(NODE_TYPES).toContain("divider");
  expect(NODE_TYPES).toContain("icon");
});

it("gives every node type an icon and a label", () => {
  for (const t of NODE_TYPES) {
    expect(NODE_ICON[t], `no icon for ${t}`).toBeTruthy();
    expect(NODE_TYPE_LABEL[t], `no label for ${t}`).toBeTruthy();
  }
});
```

In `__tests__/tree-ops.test.ts`:

```ts
it("creates a divider with the default thickness", () => {
  const n = createNode("divider", "d1");
  expect(n).toEqual({ type: "divider", id: "d1", thickness: DIVIDER_DEFAULT_THICKNESS });
});

it("creates an icon defaulting to the check glyph", () => {
  const n = createNode("icon", "i1");
  expect(n).toEqual({ type: "icon", id: "i1", name: "check", size: ICON_DEFAULT_SIZE });
});
```

Match `createNode`'s real exported name and signature in `tree-ops.ts` — the switch is around line 218.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder/__tests__/node-meta.test.ts src/components/paywall-builder/__tests__/tree-ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the metadata**

In `node-meta.ts`, add `"divider"` and `"icon"` to `NODE_TYPES`, then to `NODE_ICON` (import `Minus` and `Sparkles` from `lucide-react`) and `NODE_TYPE_LABEL` (`"Divider"`, `"Icon"`).

Then rewrite `nodeLocKey` to stop being a third copy of the same knowledge:

```ts
/**
 * The localization key a node's copy lives under, or null for types that
 * carry none. Derived from the shared LOCALIZED_KEYS table rather than a
 * local list — this used to be a third hand-maintained copy of it.
 * The layer tree shows one key, so this takes the first.
 */
export function nodeLocKey(node: PaywallNode): string | null {
  return localizedKeysOf(node)[0] ?? null;
}
```

- [ ] **Step 4: Add the creation defaults**

In `tree-ops.ts`, before the `default:` exhaustiveness branch:

```ts
    case "divider":
      return { type: "divider", id, thickness: DIVIDER_DEFAULT_THICKNESS };
    case "icon":
      return { type: "icon", id, name: DEFAULT_ICON_NAME, size: ICON_DEFAULT_SIZE };
```

Declare `const DEFAULT_ICON_NAME = "check";` at the top of the file — a new icon starts as a checkmark because the commonest use is a feature-list mark.

- [ ] **Step 5: Add the inspector fields**

In `inspector/content-tab.tsx`, add a branch for each type. `divider` gets a thickness number field and an inset number field; `icon` gets a name picker and a size number field. Use the existing field components in `inspector/fields.tsx` rather than raw inputs — follow how the `spacer` size field is built.

The icon picker is a `<select>` over `ICON_NAMES` from `@rovenue/shared/paywall`. Do not hand-write the option list.

Add the two labels to `apps/dashboard/src/i18n/locales/en.json` under the same `paywalls.builder.nodeTypes.*` path the other seven use, plus labels for the new fields alongside the existing inspector field labels.

- [ ] **Step 6: Run the dashboard suite**

Run: `cd apps/dashboard && npx vitest run`
Expected: the two new tests pass and no previously-passing test breaks.

**This suite has 10 pre-existing failures** unrelated to this work (integrations hooks, refund-shield onboarding, login, subscriber-detail, integration-drawer, funnel-preview). Record the failure count before your change and confirm it is unchanged after. Do not attempt to fix them.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): author divider and icon nodes"
```

---

### Task 5: The web renderer

**Files:**
- Modify: `packages/paywall-renderer/package.json`, `packages/paywall-renderer/src/nodes.tsx`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: Task 1's types and constants; Task 2's `iconRegistry`.

- [ ] **Step 1: Add the dependency**

`lucide-react` becomes this package's first runtime dependency (today it has only `@rovenue/shared`). Add it to `dependencies`, matching the version the dashboard already uses so the workspace resolves one copy:

```bash
cd packages/paywall-renderer && pnpm add lucide-react@^1.14.0
```

- [ ] **Step 2: Write the failing tests**

```tsx
it("renders a divider with its thickness and colour", () => {
  const { container } = render(<PaywallRenderer config={cfg({ type: "divider", id: "d1", thickness: 2 })} {...base} />);
  const el = container.querySelector('[data-rov-node="d1"]') as HTMLElement;
  expect(el).not.toBeNull();
  expect(el.style.height).toBe("2px");
});

it("renders a registry icon", () => {
  const { container } = render(<PaywallRenderer config={cfg({ type: "icon", id: "i1", name: "check" })} {...base} />);
  expect(container.querySelector('[data-rov-node="i1"]')).not.toBeNull();
  expect(container.querySelector('[data-rov-node="i1"] svg')).not.toBeNull();
});

// Fail open: an unknown name must not throw and must not render a glyph.
it("renders nothing for an unknown icon name", () => {
  const { container } = render(<PaywallRenderer config={cfg({ type: "icon", id: "i1", name: "nope" })} {...base} />);
  expect(container.querySelector('[data-rov-node="i1"] svg')).toBeNull();
});
```

Use the file's existing helpers for `cfg` and `base` rather than inventing new ones.

- [ ] **Step 3: Implement**

In `nodes.tsx`, import the twelve components explicitly and build the lookup from the registry:

```tsx
import {
  ArrowRight, Check, Clock, Cloud, Gift, Infinity as InfinityIcon,
  Lock, Shield, Sparkles, Star, X, Zap, type LucideIcon,
} from "lucide-react";
import { iconRegistry } from "@rovenue/shared/paywall";

// Registry web names -> the imported components. Built from the registry so
// a name added there without a component here is a visible undefined rather
// than a silently missing icon.
const LUCIDE_BY_EXPORT: Record<string, LucideIcon> = {
  ArrowRight, Check, Clock, Cloud, Gift, Infinity: InfinityIcon,
  Lock, Shield, Sparkles, Star, X, Zap,
};
const ICON_COMPONENT: Record<string, LucideIcon | undefined> = Object.fromEntries(
  iconRegistry.map((e) => [e.name, LUCIDE_BY_EXPORT[e.web]]),
);
```

`Infinity` is aliased because it shadows the JavaScript global.

```tsx
function renderDivider(node: DividerNode, ctx: RenderCtx): ReactElement {
  const thickness = node.thickness ?? DIVIDER_DEFAULT_THICKNESS;
  const inset = node.inset ?? DIVIDER_DEFAULT_INSET;
  return (
    <div
      data-rov-node={node.id}
      style={{
        height: `${thickness}px`,
        marginLeft: `${inset}px`,
        marginRight: `${inset}px`,
        backgroundColor: resolveTextColor(node.color, ctx.colorScheme),
        flexShrink: 0,
      }}
    />
  );
}

function renderIcon(node: IconNode, ctx: RenderCtx): ReactElement {
  const Cmp = ICON_COMPONENT[node.name];
  const size = node.size ?? ICON_DEFAULT_SIZE;
  return (
    <span data-rov-node={node.id} style={{ display: "inline-flex", flexShrink: 0 }}>
      {Cmp ? <Cmp size={size} color={resolveTextColor(node.color, ctx.colorScheme)} /> : null}
    </span>
  );
}
```

Add `case "divider":` and `case "icon":` to the dispatcher beside `case "spacer":` (around line 443).

- [ ] **Step 4: Run and mutation-check**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: PASS, 44 pre-existing plus the three new.

Then change `ICON_COMPONENT[node.name]` to `Check` unconditionally and re-run: the unknown-name test must FAIL. Restore and confirm green. Report both.

- [ ] **Step 5: Commit**

```bash
git add packages/paywall-renderer/package.json packages/paywall-renderer/src/nodes.tsx packages/paywall-renderer/src/renderer.test.tsx
git commit -m "feat(paywall-renderer): render divider and icon nodes"
```

---

### Task 6: The SwiftUI renderer

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift`, `RovenuePaywallView.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`

**Interfaces:**
- Consumes: the wire shape from Tasks 1-2. Icons draw as SF Symbols using the registry's `ios` column.

This package has a real gate: `swift test` from `packages/sdk-swift`.

- [ ] **Step 1: Write the failing tests**

```swift
func test_decodesDivider() throws {
    let node = try firstChild(#"{"type":"divider","id":"d1","thickness":2,"inset":8}"#)
    guard case .divider(let p) = node else { XCTFail("not a divider"); return }
    XCTAssertEqual(p.thickness, 2)
    XCTAssertEqual(p.inset, 8)
}

func test_decodesIcon() throws {
    let node = try firstChild(#"{"type":"icon","id":"i1","name":"check","size":32}"#)
    guard case .icon(let p) = node else { XCTFail("not an icon"); return }
    XCTAssertEqual(p.name, "check")
    XCTAssertEqual(p.size, 32)
}

// An unknown name must decode — leniency lives in the renderer, not here.
func test_decodesIconWithUnknownName() throws {
    let node = try firstChild(#"{"type":"icon","id":"i1","name":"not-real"}"#)
    guard case .icon(let p) = node else { XCTFail("not an icon"); return }
    XCTAssertEqual(p.name, "not-real")
}

// The registry is the contract: every name must map to a symbol.
func test_everyRegistryIconHasASymbol() throws {
    for name in RenderFixtures.iconRegistryNames() {
        XCTAssertNotNil(sfSymbolName(for: name), "no SF Symbol mapped for \(name)")
    }
}
```

Reuse this test file's existing `firstChild` helper. Add `iconRegistryNames()` to the fixtures helper, reading `name` from `icon-registry.json` the same way the render-fixtures loader reads its file.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk-swift && swift test`
Expected: FAIL to compile — `.divider` and `.icon` do not exist.

- [ ] **Step 3: Add the props and cases**

In `BuilderConfigModel.swift`, beside `SpacerProps` (around line 634), add `DividerProps` (`thickness: Double?`, `inset: Double?`, `color: ThemePair?`) and `IconProps` (`name: String`, `size: Double?`, `color: ThemePair?`), each with the same `visibility`/`overrides`/`fallback` members the other seven carry. The colour type is `ThemePair`, matching `TextProps.color` at line 284 — there is no `ThemeColor` in this module. Add `.divider(DividerProps)` and `.icon(IconProps)` to the node enum and their `"divider"` / `"icon"` arms to the type switch (around line 691).

Add the symbol map, generated from the registry values in this plan's table:

```swift
/// Registry name -> SF Symbol. Unknown names return nil and render nothing:
/// leniency is deliberate so a newer paywall does not break an older app.
func sfSymbolName(for name: String) -> String? {
    switch name {
    case "check": return "checkmark"
    case "x": return "xmark"
    case "star": return "star.fill"
    case "lock": return "lock.fill"
    case "shield": return "checkmark.shield.fill"
    case "sparkle": return "sparkles"
    case "bolt": return "bolt.fill"
    case "gift": return "gift.fill"
    case "clock": return "clock.fill"
    case "infinity": return "infinity"
    case "cloud": return "cloud.fill"
    case "arrow-right": return "arrow.right"
    default: return nil
    }
}
```

- [ ] **Step 4: Render**

In `RovenuePaywallView.swift`, beside `case .spacer` (around line 249):

A `ThemePair` becomes a SwiftUI `Color` through the chain this file already
uses at line 267: `themeValue(pair, dark: ctx.dark)` gives a hex string,
`parseHexColor` gives an optional `RGBAColor`, and `color(_:)` (line 524)
gives the `Color`. There is no single-call helper — do not invent one.

```swift
case .divider(let p):
    let resolved = p.color.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
    Rectangle()
        .fill(resolved.map { color($0) } ?? Color.secondary.opacity(dividerDefaultOpacity))
        .frame(height: CGFloat(p.thickness ?? dividerDefaultThickness))
        .padding(.horizontal, CGFloat(p.inset ?? dividerDefaultInset))
case .icon(let p):
    if let symbol = sfSymbolName(for: p.name) {
        let side = CGFloat(p.size ?? iconDefaultSize)
        Image(systemName: symbol)
            .resizable()
            .scaledToFit()
            .frame(width: side, height: side)
            .foregroundColor(p.color.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }.map { color($0) })
    }
```

Declare these as file-private constants, in Swift's lowerCamelCase convention:
`dividerDefaultThickness = 1.0`, `dividerDefaultInset = 0.0`,
`iconDefaultSize = 24.0`, `dividerDefaultOpacity = 0.3`.

Confirm `ctx.dark` is the right accessor by checking the surrounding `case`
arms — line 267 uses it, but read the enclosing function's parameter name
rather than assuming.

- [ ] **Step 5: Run and mutation-check**

Run: `cd packages/sdk-swift && swift test`
Expected: PASS — 187 pre-existing plus the four new.

Then delete the `"check"` arm from `sfSymbolName` and re-run: `test_everyRegistryIconHasASymbol` must FAIL naming `check`. Restore and confirm green. Report both — that test is the divergence guard, and a guard that cannot fail guards nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/PaywallUI packages/sdk-swift/Tests/RovenueTests
git commit -m "feat(sdk-swift): render divider and icon nodes with SF Symbols"
```

---

### Task 7: The Android renderer

**Files:**
- Create: `packages/sdk-kotlin/src/main/res/drawable/` — twelve vendored XMLs
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt`, `NodeViewFactory.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModelTest.kt`

**Interfaces:**
- Consumes: the wire shape from Tasks 1-2.

This module has **no `res/` directory today** — `src/main/` holds only `AndroidManifest.xml`, `jniLibs` and `kotlin`. You are adding its first Android resources.

- [ ] **Step 1: Vendor the twelve drawables**

Fetch each from `google/material-design-icons` (Apache-2.0) using the category and name from this plan's registry table:

```bash
cd packages/sdk-kotlin/src/main
mkdir -p res/drawable
while IFS='|' read -r sem cat mat; do
  curl -fsSL "https://raw.githubusercontent.com/google/material-design-icons/master/android/${cat}/${mat}/materialicons/black/res/drawable/baseline_${mat}_24.xml" \
    -o "res/drawable/rovenue_ic_${sem//-/_}.xml" || echo "FAILED $sem"
done <<'EOF'
check|action|done
x|navigation|close
star|toggle|star
lock|action|lock
shield|action|verified_user
sparkle|image|auto_awesome
bolt|image|flash_on
gift|action|card_giftcard
clock|action|schedule
infinity|places|all_inclusive
cloud|file|cloud
arrow-right|navigation|arrow_forward
EOF
ls res/drawable | wc -l   # must print 12
```

Then **strip `android:tint="?attr/colorControlNormal"`** from every file — the node supplies its own colour and the theme attribute would override it. Verify none remains:

```bash
grep -l "colorControlNormal" res/drawable/*.xml && echo "STILL TINTED — remove it" || echo "clean"
```

Record the Apache-2.0 attribution in a short `res/drawable/README.md` naming the upstream repository and the fetch path.

- [ ] **Step 2: Write the failing tests**

```kotlin
@Test
fun decodesDivider() {
    val node = firstChild(rootWith("""{"type":"divider","id":"d1","thickness":2,"inset":8}"""))
    assertTrue(node is BuilderNode.Divider)
    assertEquals(2.0, (node as BuilderNode.Divider).thickness)
}

@Test
fun decodesIconIncludingUnknownNames() {
    val known = firstChild(rootWith("""{"type":"icon","id":"i1","name":"check"}"""))
    assertEquals("check", (known as BuilderNode.Icon).name)
    val unknown = firstChild(rootWith("""{"type":"icon","id":"i2","name":"not-real"}"""))
    assertEquals("not-real", (unknown as BuilderNode.Icon).name)
}

@Test
fun everyRegistryIconHasADrawable() {
    val registry = java.io.File("../shared/src/paywall/icon-registry.json")
        .takeIf { it.exists() } ?: java.io.File("../../packages/shared/src/paywall/icon-registry.json")
    val names = kotlinx.serialization.json.Json
        .parseToJsonElement(registry.readText()).jsonObject["icons"]!!.jsonArray
        .map { it.jsonObject["name"]!!.jsonPrimitive.content }
    for (n in names) {
        assertNotNull(drawableNameFor(n), "no drawable mapped for $n")
    }
}
```

Follow the existing test file's `rootWith`/`firstChild` helpers — `VisibilityDecodeTest.kt` shows the pattern for reading a shared JSON file from the test working directory.

- [ ] **Step 3: Model and map**

In `BuilderConfigModel.kt`, add `data class Divider` and `data class Icon` to the `BuilderNode` sealed hierarchy beside `Spacer` (around line 216), with their override-props objects and `"divider"` / `"icon"` arms in the parser (around line 394).

Add the drawable mapping:

```kotlin
/** Registry name -> vendored Material drawable. Unknown names return null
 *  and render nothing, so a newer paywall never breaks an older app. */
internal fun drawableNameFor(name: String): String? = when (name) {
    "check", "x", "star", "lock", "shield", "sparkle",
    "bolt", "gift", "clock", "infinity", "cloud", "arrow-right" ->
        "rovenue_ic_" + name.replace('-', '_')
    else -> null
}
```

- [ ] **Step 4: Render**

In `NodeViewFactory.kt`, beside `is BuilderNode.Spacer` (around line 373), build a thin `View` with the divider's background colour and height, and an `ImageView` with the resolved drawable and tint for the icon. Resolve the drawable id with
`context.resources.getIdentifier(drawableNameFor(node.name), "drawable", context.packageName)`
and render nothing when the name is unknown or the id resolves to `0`.

Add the two types to `childLayout` (around line 235) so the divider gets `MATCH_PARENT` width and its thickness as height, and the icon gets its size in both dimensions.

Declare the defaults as named top-level constants in this file, matching the shared values — the sizes are in density-independent pixels and must be converted with the display density before being used as view dimensions:

```kotlin
private const val DIVIDER_DEFAULT_THICKNESS_DP = 1.0
private const val DIVIDER_DEFAULT_INSET_DP = 0.0
private const val ICON_DEFAULT_SIZE_DP = 24.0
```

Use this file's `themeValue(pair, dark)` helper for colours, and its existing dp-to-pixel conversion for the dimensions rather than a new one — find how `spacerChildLayout` converts `size` and follow it.

- [ ] **Step 5: Run and mutation-check**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL — 224 pre-existing plus the new ones. Count them from `build/test-results/testDebugUnitTest/*.xml`, not from console scrollback.

Then remove `"check"` from `drawableNameFor`'s branch and re-run: `everyRegistryIconHasADrawable` must FAIL. Restore and confirm green. Report both.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src/main/res packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui
git commit -m "feat(sdk-kotlin): render divider and icon nodes with Material drawables"
```

---

## Notes for the executor

- Tasks 1-3 are ordered and shared; 4-7 each consume them and are independent of one another, so a failure in one does not block the others.
- Four tasks carry a mutation check (3, 5, 6 and 7). They are the point, not ceremony: the registry coverage tests are this wave's only defence against one platform silently missing an icon, and a coverage test that cannot fail defends nothing.
- The same paywall will look different on the three platforms — lucide is stroked, Material is filled, SF Symbols are Apple's. That is expected and is not a bug to report.
- Whether each symbol and drawable renders at the right weight and colour is a device question. It belongs in the next smoke session, not in any of these tasks' reports.
