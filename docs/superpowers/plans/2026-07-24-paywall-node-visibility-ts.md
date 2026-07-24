# Paywall Node Visibility — Stage 1 (TypeScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author hide a paywall node on some platforms or app versions, and have the web renderer and the dashboard canvas honour it — fixing the four-platform contract the native renderers will then be held to.

**Architecture:** `visibility` becomes an optional field on every node. A pure shared evaluator decides whether a node renders, given a platform and an app version that may both be unknown; unknown always means visible. `renderNode` gates on it in one place. The dashboard canvas feeds it the previewed device's platform, so the author sees the effect.

**Tech Stack:** TypeScript (strict), Vitest, React, `impair` DI, `react-i18next`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-paywall-node-visibility-design.md`.
- **Stage 1 is TypeScript only.** No Swift, Kotlin, Rust or RN changes. Stage 2 makes the native decoders meet the contract this stage writes.
- **Wire-additive only.** `visibility` is optional; an older SDK ignores the key and renders the node, identical to absent. No DB change, no migration.
- **Fail open is the load-bearing rule.** Unknown platform, unknown app version, an unparseable version component and an empty platform array all mean *visible*. Each gets its own test, named as such — these are decisions a future tidy-up could silently reverse.
- TypeScript strict. **No magic values.**
- Every user-facing string via `t(key, "English fallback")`, with the key added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- `render-fixtures.json` is the four-platform decoder contract. Adding entries there is a promise stage 2 must keep.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter <pkg> exec tsc --noEmit`.
- Conventional commits; commit per task.

---

## File Structure

**Create:**
- `packages/shared/src/paywall/visibility.ts` — the type, the evaluator, the comparator.
- `packages/shared/src/paywall/visibility.test.ts`
- `apps/dashboard/src/components/paywall-builder/inspector/visibility-tab.tsx`

**Modify:**
- `packages/shared/src/paywall/schema.ts` — `visibility` on all seven node types and their Zod schemas.
- `packages/shared/src/paywall/index.ts` — export the new module.
- `packages/shared/src/paywall/validate.ts` + `validate.test.ts` — `VISIBILITY_NEVER_MATCHES`.
- `packages/shared/src/paywall/render-fixtures.json`
- `packages/paywall-renderer/src/nodes.tsx` — `RenderCtx` gains the two facts; `renderNode` gates.
- `packages/paywall-renderer/src/renderer.tsx` — props thread through to `ctx`.
- `apps/dashboard/src/components/paywall-builder/canvas.tsx` — pass the previewed platform.
- `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts` + `tabs.test.ts` — the fifth tab.
- `apps/dashboard/src/components/paywall-builder/properties-panel.tsx` — register its body.
- `apps/dashboard/src/i18n/locales/en.json`

---

### Task 1: The type and the evaluator

**Files:**
- Create: `packages/shared/src/paywall/visibility.ts`, `visibility.test.ts`
- Modify: `packages/shared/src/paywall/index.ts`

**Interfaces:**
- Produces:
  - `type VisibilityPlatform = "ios" | "android" | "web"`
  - `type NodeVisibility = { platform?: VisibilityPlatform[]; minAppVersion?: string; maxAppVersion?: string }`
  - `function isNodeVisible(v: NodeVisibility | undefined, ctx: { platform?: VisibilityPlatform | null; appVersion?: string | null }): boolean`
  - `function compareVersions(a: string, b: string): number | null` — `null` when either side has a non-numeric component.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/paywall/visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compareVersions, isNodeVisible } from "./visibility";

describe("compareVersions", () => {
  it("compares component-wise, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2", "2.0.0")).toBe(0);
  });

  it("refuses to guess at a non-numeric component", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeNull();
    expect(compareVersions("2024.spring", "2024.1")).toBeNull();
  });
});

describe("isNodeVisible", () => {
  const ios = { platform: "ios" as const, appVersion: "2.0.0" };

  it("shows a node with no visibility rules at all", () => {
    expect(isNodeVisible(undefined, ios)).toBe(true);
    expect(isNodeVisible({}, ios)).toBe(true);
  });

  it("honours a platform list", () => {
    expect(isNodeVisible({ platform: ["ios"] }, ios)).toBe(true);
    expect(isNodeVisible({ platform: ["android", "web"] }, ios)).toBe(false);
  });

  it("FAILS OPEN on an empty platform list — it means 'no constraint', not 'nowhere'", () => {
    expect(isNodeVisible({ platform: [] }, ios)).toBe(true);
  });

  it("FAILS OPEN when the renderer does not know its platform", () => {
    expect(isNodeVisible({ platform: ["android"] }, { platform: null, appVersion: "2.0.0" })).toBe(true);
  });

  it("honours both version bounds inclusively", () => {
    expect(isNodeVisible({ minAppVersion: "2.0.0" }, ios)).toBe(true);
    expect(isNodeVisible({ minAppVersion: "2.0.1" }, ios)).toBe(false);
    expect(isNodeVisible({ maxAppVersion: "2.0.0" }, ios)).toBe(true);
    expect(isNodeVisible({ maxAppVersion: "1.9.9" }, ios)).toBe(false);
    expect(isNodeVisible({ minAppVersion: "1.0.0", maxAppVersion: "3.0.0" }, ios)).toBe(true);
  });

  it("FAILS OPEN when the app version is unknown", () => {
    const noVersion = { platform: "ios" as const, appVersion: null };
    expect(isNodeVisible({ minAppVersion: "99.0.0" }, noVersion)).toBe(true);
    expect(isNodeVisible({ maxAppVersion: "0.0.1" }, noVersion)).toBe(true);
  });

  it("FAILS OPEN when a version cannot be compared", () => {
    const beta = { platform: "ios" as const, appVersion: "1.0.0-beta" };
    expect(isNodeVisible({ minAppVersion: "99.0.0" }, beta)).toBe(true);
  });

  it("hides only when every rule that CAN be evaluated says hide", () => {
    expect(isNodeVisible({ platform: ["ios"], minAppVersion: "3.0.0" }, ios)).toBe(false);
    expect(isNodeVisible({ platform: ["android"], minAppVersion: "1.0.0" }, ios)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/visibility.test.ts`
Expected: FAIL — `Cannot find module './visibility'`.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/paywall/visibility.ts`:

```ts
// =============================================================
// Node-level visibility: which platforms and app versions a node
// renders on. Evaluated CLIENT-SIDE by every renderer — the server
// ships the published snapshot whole.
//
// The governing rule is FAIL OPEN. Every unknown resolves to visible:
// an unknown platform, an unknown app version, a version we cannot
// parse, an empty platform list. Hiding content because we could not
// tell would silently break paywalls on any facade that has not
// supplied these facts yet, and the web renderer never will.
// =============================================================

export type VisibilityPlatform = "ios" | "android" | "web";

export type NodeVisibility = {
  /** Platforms this node renders on. Absent OR EMPTY means all of them. */
  platform?: VisibilityPlatform[];
  /** Inclusive bounds on the host app's version. */
  minAppVersion?: string;
  maxAppVersion?: string;
};

export type VisibilityContext = {
  platform?: VisibilityPlatform | null;
  appVersion?: string | null;
};

const VERSION_SEPARATOR = ".";
const NUMERIC_COMPONENT = /^\d+$/;

/**
 * Component-wise numeric comparison. Missing components read as 0, so
 * "1.2" equals "1.2.0" and "1.10" beats "1.9".
 *
 * Returns `null` — inconclusive — when either side has a component that
 * is not a run of digits. Deliberately NOT semver: a real implementation
 * would have to be written four times over and agree exactly, and
 * pre-release ordering is not a rule anyone authoring a paywall bound is
 * thinking about. Refusing to guess is the honest answer, and an
 * inconclusive comparison fails open at the call site.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = a.split(VERSION_SEPARATOR);
  const right = b.split(VERSION_SEPARATOR);
  if (![...left, ...right].every((part) => NUMERIC_COMPONENT.test(part))) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = Number(left[i] ?? 0);
    const r = Number(right[i] ?? 0);
    if (l !== r) return l - r;
  }
  return 0;
}

/** True when the node should render in this context. */
export function isNodeVisible(
  visibility: NodeVisibility | undefined,
  ctx: VisibilityContext,
): boolean {
  if (!visibility) return true;

  const { platform } = visibility;
  // An empty array is what the builder produces the moment an author
  // unticks the last box. Reading it as "nowhere" would let a stray click
  // delete content from every device.
  if (platform && platform.length > 0 && ctx.platform && !platform.includes(ctx.platform)) {
    return false;
  }

  const version = ctx.appVersion;
  if (!version) return true;

  const { minAppVersion, maxAppVersion } = visibility;
  if (minAppVersion) {
    const cmp = compareVersions(version, minAppVersion);
    if (cmp !== null && cmp < 0) return false;
  }
  if (maxAppVersion) {
    const cmp = compareVersions(version, maxAppVersion);
    if (cmp !== null && cmp > 0) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @rovenue/shared exec vitest run src/paywall/visibility.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Export from the barrel**

In `packages/shared/src/paywall/index.ts`, add `export * from "./visibility";` beside the existing exports.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @rovenue/shared exec tsc --noEmit` — exits 0.

```bash
git add packages/shared/src/paywall/visibility.ts packages/shared/src/paywall/visibility.test.ts \
  packages/shared/src/paywall/index.ts
git commit -m "feat(shared): node visibility model — platform and app-version bounds, fail open"
```

---

### Task 2: Put it on the nodes, and warn when it can never match

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`, `validate.ts`, `validate.test.ts`, `render-fixtures.json`

**Interfaces:**
- Consumes: `NodeVisibility` (Task 1).
- Produces: `visibility?: NodeVisibility` on all seven node types and their Zod schemas; a `VISIBILITY_NEVER_MATCHES` issue at the **warning** tier.

- [ ] **Step 1: Add the field to the types**

In `packages/shared/src/paywall/schema.ts`, add to each of `StackNode`, `TextNode`, `ImageNode`, `ButtonNode`, `PackageListNode`, `PurchaseButtonNode`, `SpacerNode`, beside the existing `overrides?` / `fallback?`:

```ts
  visibility?: NodeVisibility;
```

Import the type from `./visibility`.

**Do NOT add `visibility` to `OVERRIDABLE_PROP_KEYS`.** An override that changed whether a node renders would make existence conditional on a condition evaluated against the node itself; overrides are for conditional *appearance*.

- [ ] **Step 2: Add it to the Zod schemas**

Define once, above the node schemas:

```ts
const nodeVisibilitySchema = z.object({
  platform: z.array(z.enum(["ios", "android", "web"])).optional(),
  minAppVersion: z.string().optional(),
  maxAppVersion: z.string().optional(),
});
```

and add `visibility: nodeVisibilitySchema.optional(),` to all seven node schemas, next to their `fallback:` line.

- [ ] **Step 3: Write the failing validator test**

Add to `packages/shared/src/paywall/validate.test.ts`:

```ts
describe("VISIBILITY_NEVER_MATCHES", () => {
  function withVisibility(visibility: Record<string, unknown>) {
    const config = baseConfig();
    (config.root.children[0] as { visibility?: unknown }).visibility = visibility;
    return config;
  }

  it("warns when the version bounds cross, so the node can never render", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "3.0.0", maxAppVersion: "2.0.0" }),
      { offeringPackageIds },
    );
    const issue = issues.find((i) => i.code === "VISIBILITY_NEVER_MATCHES");
    expect(issue).toBeDefined();
    expect(isBlockingIssue(issue!)).toBe(false);
    expect(isPublishBlockingIssue(issue!)).toBe(false);
  });

  it("does not warn about an empty platform list, which means 'all'", () => {
    const issues = validateBuilderConfig(withVisibility({ platform: [] }), { offeringPackageIds });
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });

  it("does not warn on bounds that can be satisfied", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "1.0.0", maxAppVersion: "3.0.0" }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });

  it("does not warn when the bounds cannot be compared", () => {
    const issues = validateBuilderConfig(
      withVisibility({ minAppVersion: "1.0.0-beta", maxAppVersion: "2.0.0" }),
      { offeringPackageIds },
    );
    expect(issues.some((i) => i.code === "VISIBILITY_NEVER_MATCHES")).toBe(false);
  });
});
```

- [ ] **Step 4: Emit it**

In `validate.ts`, import `compareVersions` from `./visibility`, add `"VISIBILITY_NEVER_MATCHES"` to the `BuilderIssue["code"]` union and `VISIBILITY_NEVER_MATCHES: "warning"` to `ISSUE_SEVERITY`. Then, inside the existing `for (const node of allNodes)` walk, add:

```ts
    const { minAppVersion, maxAppVersion } = node.visibility ?? {};
    if (minAppVersion && maxAppVersion) {
      const cmp = compareVersions(minAppVersion, maxAppVersion);
      // `null` means we could not compare them, which is not the same as
      // knowing they cross — say nothing rather than guess.
      if (cmp !== null && cmp > 0) {
        issues.push({
          code: "VISIBILITY_NEVER_MATCHES",
          nodeId: node.id,
          message: `Node "${node.id}" has minAppVersion "${minAppVersion}" above maxAppVersion "${maxAppVersion}", so it can never render.`,
        });
      }
    }
```

Warning tier, deliberately: it is dead content, not a broken config, and this project has already had to walk back four gates that rejected a legitimate work-in-progress.

- [ ] **Step 5: Add the contract entries**

In `render-fixtures.json`, add to `accept`: a node with `visibility: { platform: ["ios"] }`, one with both version bounds, and one with `visibility: {}`. These say "every decoder must parse this". Do not add a `reject` entry for an unknown platform string — the native decoders are lenient by design, and stage 2 will decide how they degrade.

- [ ] **Step 6: Verify and commit**

Run:
```bash
pnpm --filter @rovenue/shared exec vitest run src/paywall
pnpm --filter @rovenue/shared exec tsc --noEmit
pnpm --filter @rovenue/api exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: green and clean. Existing validator tests must not change — if one does, report it.

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/validate.ts \
  packages/shared/src/paywall/validate.test.ts packages/shared/src/paywall/render-fixtures.json
git commit -m "feat(shared): visibility on every node, and a warning when its bounds cross"
```

---

### Task 3: The web renderer and the canvas honour it

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx`, `renderer.tsx`, and their tests
- Modify: `apps/dashboard/src/components/paywall-builder/canvas.tsx`

**Interfaces:**
- Consumes: `isNodeVisible` (Task 1).
- Produces: `RenderCtx` gains `platform?: VisibilityPlatform | null` and `appVersion?: string | null`; `PaywallRendererProps` gains the same two optional props.

- [ ] **Step 1: Widen the context**

In `packages/paywall-renderer/src/nodes.tsx`, add to `RenderCtx`:

```ts
  /** Where this render is happening. Absent means unknown, which makes
   * every `visibility` rule fail open — see isNodeVisible. */
  platform?: VisibilityPlatform | null;
  appVersion?: string | null;
```

In `renderer.tsx`, add the same two to `PaywallRendererProps` and pass them into the `ctx` literal.

- [ ] **Step 2: Gate in one place**

`renderNode` (`nodes.tsx`) is the single entry point for every node, so the gate goes at its top, **before** `applyOverrides`:

```ts
export function renderNode(node: PaywallNode, ctx: RenderCtx): ReactElement | null {
  // Hidden means the author said "not here", which is not the same as
  // "could not decode" — so a hidden node does NOT render its `fallback`.
  // Rendering one would put content on exactly the platform it was
  // excluded from. Its children go with it, since we return before
  // descending.
  if (!isNodeVisible(node.visibility, ctx)) return null;
  const resolved = applyOverrides(node, activeOverrideConditions(ctx));
  …
```

Gating before `applyOverrides` matters: an override cannot resurrect a hidden node, which is the same reason `visibility` is not overridable.

- [ ] **Step 3: Test the renderer**

Add to the renderer's existing test file: a config whose only text node is `visibility: { platform: ["android"] }` renders nothing when `ctx.platform` is `"ios"`, renders it when `"android"`, and renders it when platform is absent. Also that a hidden **stack** takes its children with it, and that a hidden node with a `fallback` renders neither.

- [ ] **Step 4: Feed the canvas its device**

In `apps/dashboard/src/components/paywall-builder/canvas.tsx`, pass `platform={vm.canvasPlatform}` to `<PaywallRenderer>`. `DevicePlatform` is `"ios" | "android"`, a subset of `VisibilityPlatform`, so it assigns directly.

Do not pass an `appVersion` — the canvas has no app, and the fail-open rule then makes version bounds preview as visible. That is the honest preview: the builder cannot know which versions are in the field.

- [ ] **Step 5: Verify and commit**

Run:
```bash
pnpm --filter @rovenue/paywall-renderer exec vitest run
pnpm --filter @rovenue/paywall-renderer exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```

```bash
git add packages/paywall-renderer/src apps/dashboard/src/components/paywall-builder/canvas.tsx
git commit -m "feat(paywall-renderer): honour node visibility, and preview it on the canvas device"
```

---

### Task 4: The Visibility tab

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/inspector/visibility-tab.tsx`
- Modify: `inspector/tabs.ts`, `inspector/tabs.test.ts`, `properties-panel.tsx`, `apps/dashboard/src/i18n/locales/en.json`

**Interfaces:**
- Consumes: Task 1's types, P5a's tab table.
- Produces: a fifth tab, applicable to **every** node type, carrying `VISIBILITY_NEVER_MATCHES`.

- [ ] **Step 1: Add the tab to the table**

In `inspector/tabs.ts`, append to `INSPECTOR_TABS`:

```ts
  {
    id: "visibility",
    fallbackLabel: "Visibility",
    appliesTo: new Set<PaywallNode["type"]>([
      "stack",
      "text",
      "image",
      "button",
      "packageList",
      "purchaseButton",
      "spacer",
    ]),
    issueCodes: new Set<BuilderIssue["code"]>(["VISIBILITY_NEVER_MATCHES"]),
  },
```

Every node type, because every node can be hidden. Note this makes the strip two-or-more tabs for every type, which retires P5a's one-button-strip minor.

Update `tabs.test.ts`'s `tabsForNode` expectations — `spacer` becomes `["layout", "visibility"]`, `purchaseButton` becomes `["content", "visibility"]`, `packageList` becomes `["layout", "binding", "visibility"]`. `PREFERRED_INITIAL_TAB` is unchanged, so nothing opens on Visibility.

- [ ] **Step 2: Build the tab**

Create `inspector/visibility-tab.tsx`: a `component()` taking `{ node }`, rendering one `Section` with

- three checkboxes (iOS / Android / Web) writing `visibility.platform`;
- two text inputs for `minAppVersion` / `maxAppVersion` using `INPUT_CLASS`;
- a short note that leaving everything unset shows the node everywhere;
- a line pointing at placement audience rows for segment targeting, since that is deliberately **not** here (gap analysis §8 decision 3). A sentence, not a link component — the placement lives on another page and this phase is not building navigation.

Write through `vm.updateNode<…>(node.id, { visibility: … })`, following how the other tabs call `set`. Both write paths are fiddly enough to get done inconsistently, so use exactly this:

```tsx
/** Collapse an all-defaults visibility back to `undefined`, so a node the
 * author has reset is indistinguishable from one never touched — otherwise
 * the diff, the fixtures and the wire all carry a meaningless `{}`. */
function normalize(v: NodeVisibility): NodeVisibility | undefined {
  const platform = v.platform && v.platform.length > 0 ? v.platform : undefined;
  const min = v.minAppVersion?.trim() || undefined;
  const max = v.maxAppVersion?.trim() || undefined;
  if (!platform && !min && !max) return undefined;
  return { ...(platform && { platform }), ...(min && { minAppVersion: min }), ...(max && { maxAppVersion: max }) };
}

const current = node.visibility ?? {};

const togglePlatform = (p: VisibilityPlatform) => {
  // Absent/empty already means "all", so the first untick has to produce the
  // list of the OTHERS, not an empty array — otherwise unticking one box
  // would read as no constraint and the node would stay everywhere.
  const selected = current.platform && current.platform.length > 0 ? current.platform : ALL_PLATFORMS;
  const next = selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p];
  set({ visibility: normalize({ ...current, platform: next }) });
};

const setBound = (key: "minAppVersion" | "maxAppVersion", value: string) =>
  set({ visibility: normalize({ ...current, [key]: value }) });
```

with `const ALL_PLATFORMS: VisibilityPlatform[] = ["ios", "android", "web"];` as a named constant. Checkbox checked state is `!current.platform?.length || current.platform.includes(p)` — all three read as ticked when there is no constraint, which is what "shows everywhere" looks like.

Note what the first untick does: with no constraint, unticking iOS must write `["android", "web"]`. Writing `[]` would normalize straight back to `undefined` and the box would spring back ticked.

Register it in `properties-panel.tsx`'s `TAB_BODY`.

- [ ] **Step 3: Strings**

Add the tab label under `paywalls.builder.inspector.tab.visibility`, plus keys for the section title, the three platform labels, both version labels, the "shows everywhere" note and the audience sentence. Match `en.json`'s indentation; do not reorder.

- [ ] **Step 4: Verify and commit**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('valid json')"
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```

```bash
git add apps/dashboard/src/components/paywall-builder/inspector \
  apps/dashboard/src/components/paywall-builder/properties-panel.tsx \
  apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): the paywall inspector's Visibility tab"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/shared exec vitest run src/paywall`, `pnpm --filter @rovenue/paywall-renderer exec vitest run`, `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — all green.
2. `tsc --noEmit` on shared, api, paywall-renderer and dashboard.
3. Manual: add a text node, set it to iOS only, and switch the canvas device between an iPhone and a Pixel — it must appear and disappear.
4. Manual: set `minAppVersion` above `maxAppVersion` — the Visibility tab shows a warning dot and the drawer lists it, but Publish stays available.
5. Manual: a node with no visibility set renders exactly as before on both devices.

## Out of scope (deferred)

- **Stage 2:** the three native renderers and the plumbing that gets `platform`/`appVersion` out of `RovenueConfig` into their render contexts.
- Audience-segment visibility — stays at the placement level by decision.
- P5a's deferred minors: override-sourced localization issues dotting Content, and tab-strip a11y.
