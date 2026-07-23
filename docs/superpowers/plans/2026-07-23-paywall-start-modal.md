# Paywall Start Modal (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a start gallery when a paywall opens with an empty tree, so a new paywall offers the builder's existing presets instead of a blank screen.

**Architecture:** The presets and `vm.applyPreset` already exist and are tested but are unreachable from the UI. This plan adds gallery metadata to the preset table, a pure helper that derives a silhouette preview from a preset's own node tree, and a modal that auto-opens on an empty tree (with a confirm before replacing a non-empty one). No API, no DB, no wire-format change.

**Tech Stack:** TypeScript (strict), Vitest, React + `impair` DI (`component`/`useService`), `react-i18next`, `lucide-react`, Tailwind (`rv-*` tokens + `cn`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-paywall-start-modal-design.md`.
- Touch only `apps/dashboard/src/components/paywall-builder/`. **No API, no DB, no wire-format change.**
- TypeScript strict.
- Every user-facing string via `t("paywalls.builder.start.*", "English fallback")`.
- **No magic values** — card dimensions, preview bar widths and the like get named constants. The preset table itself is structured data, not a magic value.
- Follow `DiffModal`'s overlay idiom (fixed-inset backdrop, centred panel, `rv-*` tokens, `cn`, `lucide`).
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests: `pnpm --filter @rovenue/dashboard exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`. Build: `pnpm --filter @rovenue/dashboard build`.
- Conventional commits; commit per task.

---

## File Structure

**Create:**
- `apps/dashboard/src/components/paywall-builder/start-model.ts` — pure helpers: `previewBlocks`, `shouldAutoOpenStart`, and the role→width constant.
- `apps/dashboard/src/components/paywall-builder/start-model.test.ts`
- `apps/dashboard/src/components/paywall-builder/start-modal.tsx` — the gallery modal.

**Modify:**
- `apps/dashboard/src/components/paywall-builder/presets.ts` — add `tag`/`description`, make the table `as const`, export `PresetId`.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — `applyPreset(id: PresetId)`.
- `apps/dashboard/src/components/paywall-builder/builder-shell.tsx` — `showStart` state + mount.
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` — entry button.
- `apps/dashboard/src/components/paywall-builder/index.ts` — export the modal.

---

### Task 1: Preset metadata and a derived id type

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/presets.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Create: `apps/dashboard/src/components/paywall-builder/presets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PRESETS` — the same array, now `as const`, each entry gaining `tag: string` and `description: string` alongside the existing `id`, `name`, `build`.
  - `type PresetId = (typeof PRESETS)[number]["id"]` — currently `"hero" | "comparison"`.
  - `PaywallBuilderViewModel.applyPreset(id: PresetId)` — same behaviour, the hand-maintained union replaced by the derived type.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/paywall-builder/presets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets";

describe("PRESETS", () => {
  it("every preset carries the metadata the start gallery renders", () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.tag).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(typeof preset.build).toBe("function");
    }
  });

  it("ids are unique", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset builds a config whose root has children", () => {
    for (const preset of PRESETS) {
      expect(preset.build("en").root.children.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/presets.test.ts`
Expected: FAIL — `preset.tag` is `undefined` (the metadata doesn't exist yet).

- [ ] **Step 3: Add the metadata and derive the id type**

In `apps/dashboard/src/components/paywall-builder/presets.ts`, replace the `PRESETS` declaration with:

```ts
export const PRESETS = [
  {
    id: "hero",
    name: "Hero",
    tag: "Highest converting",
    description: "Full-bleed image, plan list, sticky purchase button.",
    build: buildHeroPreset,
  },
  {
    id: "comparison",
    name: "Comparison",
    tag: "Feature-rich",
    description: "Title, plan list and a caption for the fine print.",
    build: buildComparisonPreset,
  },
] as const;

/** Preset ids derived from the table, so adding a preset needs no type edit. */
export type PresetId = (typeof PRESETS)[number]["id"];
```

(Leave `buildHeroPreset` / `buildComparisonPreset` and the file's header comment untouched.)

- [ ] **Step 4: Point `applyPreset` at the derived type**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, add `PresetId` to the existing import from `../presets`:

```ts
import { PRESETS, type PresetId } from "../presets";
```

and change the method signature (body unchanged):

```ts
  applyPreset(id: PresetId) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS — the 3 new preset tests plus the whole existing paywall-builder suite, including the two `applyPreset('hero'|'comparison') produces a config with zero blocking validation issues` tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: exits 0. (`as const` makes `build` readonly-typed; if a caller trips on that, do NOT drop `as const` — report it instead.)

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/presets.ts \
  apps/dashboard/src/components/paywall-builder/presets.test.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts
git commit -m "feat(dashboard): paywall preset gallery metadata + derived PresetId"
```

---

### Task 2: Pure start-modal helpers

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/start-model.ts`
- Create: `apps/dashboard/src/components/paywall-builder/start-model.test.ts`

**Interfaces:**
- Consumes: the `BuilderConfig` type from `@rovenue/shared/paywall`.
- Produces:
  - `type PreviewBlock = { kind: "media" } | { kind: "line"; width: number } | { kind: "cells" } | { kind: "action" } | { kind: "gap" }`
  - `function previewBlocks(config: BuilderConfig): PreviewBlock[]` — maps the root's DIRECT children to a silhouette; unmapped node types are skipped.
  - `function shouldAutoOpenStart(config: BuilderConfig): boolean` — true when the root has no children.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/paywall-builder/start-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { PRESETS } from "./presets";
import { previewBlocks, shouldAutoOpenStart } from "./start-model";

function preset(id: "hero" | "comparison") {
  return PRESETS.find((p) => p.id === id)!.build("en");
}

describe("previewBlocks", () => {
  it("turns the hero preset into a silhouette in document order", () => {
    expect(previewBlocks(preset("hero"))).toEqual([
      { kind: "media" },
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.65 },
      { kind: "gap" },
      { kind: "cells" },
      { kind: "action" },
      { kind: "action" },
    ]);
  });

  it("turns the comparison preset into a silhouette in document order", () => {
    expect(previewBlocks(preset("comparison"))).toEqual([
      { kind: "line", width: 0.8 },
      { kind: "line", width: 0.7 },
      { kind: "cells" },
      { kind: "line", width: 0.5 },
      { kind: "action" },
      { kind: "action" },
    ]);
  });

  it("yields nothing for an empty config", () => {
    expect(previewBlocks(emptyBuilderConfig("en"))).toEqual([]);
  });

  it("skips node types it has no silhouette for", () => {
    const config = emptyBuilderConfig("en");
    config.root.children.push(
      { type: "stack", id: "nested", axis: "v", children: [] },
      { type: "spacer", id: "sp", size: 8 },
    );
    expect(previewBlocks(config)).toEqual([{ kind: "gap" }]);
  });
});

describe("shouldAutoOpenStart", () => {
  it("is true for an empty tree and false once anything is in it", () => {
    expect(shouldAutoOpenStart(emptyBuilderConfig("en"))).toBe(true);
    expect(shouldAutoOpenStart(preset("hero"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/start-model.test.ts`
Expected: FAIL — `Cannot find module './start-model'`.

- [ ] **Step 3: Implement the helpers**

Create `apps/dashboard/src/components/paywall-builder/start-model.ts`:

```ts
import type { BuilderConfig, PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// Pure helpers behind the start gallery. The card preview is derived
// from a preset's OWN node tree rather than hand-drawn per template,
// so a newly-added preset gets a silhouette for free.
// =============================================================

/** One band in a card's silhouette. */
export type PreviewBlock =
  | { kind: "media" }
  | { kind: "line"; width: number }
  | { kind: "cells" }
  | { kind: "action" }
  | { kind: "gap" };

/**
 * Bar width per text role, as a fraction of the card width — so the
 * silhouette reads like a paywall instead of a stack of identical bars.
 */
const LINE_WIDTH_BY_ROLE: Record<string, number> = {
  title: 0.8,
  subtitle: 0.65,
  body: 0.7,
  caption: 0.5,
};
/** Fallback width for a text node whose role isn't in the table. */
const LINE_WIDTH_DEFAULT = 0.7;

function blockFor(node: PaywallNode): PreviewBlock | null {
  switch (node.type) {
    case "image":
      return { kind: "media" };
    case "text":
      return { kind: "line", width: LINE_WIDTH_BY_ROLE[node.role] ?? LINE_WIDTH_DEFAULT };
    case "packageList":
      return { kind: "cells" };
    case "purchaseButton":
    case "button":
      return { kind: "action" };
    case "spacer":
      return { kind: "gap" };
    default:
      // A silhouette, not a rendering — nested structure is ignored.
      return null;
  }
}

/** The root's DIRECT children as silhouette bands, in document order. */
export function previewBlocks(config: BuilderConfig): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  for (const child of config.root.children) {
    const block = blockFor(child);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** True when there is nothing in the tree yet — the "just created it" moment. */
export function shouldAutoOpenStart(config: BuilderConfig): boolean {
  return config.root.children.length === 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/start-model.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/start-model.ts \
  apps/dashboard/src/components/paywall-builder/start-model.test.ts
git commit -m "feat(dashboard): pure helpers for the paywall start gallery"
```

---

### Task 3: The start modal

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/start-modal.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/index.ts`

**Interfaces:**
- Consumes: `PRESETS`, `PresetId` (Task 1); `previewBlocks`, `shouldAutoOpenStart`, `PreviewBlock` (Task 2); the view model's `config` and `applyPreset(id)`.
- Produces: `StartModal` — `function StartModal(props: { onClose: () => void }): JSX.Element`; `BuilderShell` gains `showStart` state (auto-opened once per mount on an empty tree) and passes `onOpenStart` to `TopBar` (the button lands in Task 4).

- [ ] **Step 1: Write the modal**

Create `apps/dashboard/src/components/paywall-builder/start-modal.tsx`:

```tsx
import { useMemo, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { FilePlus2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { PRESETS, type PresetId } from "./presets";
import { previewBlocks, type PreviewBlock } from "./start-model";

type Props = { onClose: () => void };

/** Card thumbnail height in px. */
const THUMB_HEIGHT = 132;
/** Silhouette band heights in px, by kind. */
const BAND_HEIGHT = { media: 34, line: 6, cells: 26, action: 12, gap: 8 } as const;

function Silhouette({ blocks }: { blocks: PreviewBlock[] }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-rv-c3 p-2.5"
      style={{ height: THUMB_HEIGHT }}
    >
      {blocks.map((block, i) => {
        const key = `${block.kind}-${i}`;
        if (block.kind === "media") {
          return (
            <div key={key} style={{ height: BAND_HEIGHT.media }} className="rounded bg-rv-c4" />
          );
        }
        if (block.kind === "line") {
          return (
            <div
              key={key}
              style={{ height: BAND_HEIGHT.line, width: `${block.width * 100}%` }}
              className="mx-auto rounded-full bg-rv-mute-600/50"
            />
          );
        }
        if (block.kind === "cells") {
          return (
            <div key={key} style={{ height: BAND_HEIGHT.cells }} className="flex flex-col gap-1">
              <div className="flex-1 rounded border border-rv-divider-strong bg-rv-c4" />
              <div className="flex-1 rounded border border-rv-accent-500/50 bg-rv-accent-500/15" />
            </div>
          );
        }
        if (block.kind === "action") {
          return (
            <div
              key={key}
              style={{ height: BAND_HEIGHT.action }}
              className="rounded bg-rv-accent-500/70"
            />
          );
        }
        return <div key={key} style={{ height: BAND_HEIGHT.gap }} />;
      })}
    </div>
  );
}

/**
 * Starting points for a paywall. Applying a preset REPLACES the whole
 * config, so on a non-empty tree a card arms a confirm first — on an
 * empty tree there is nothing to lose and it applies straight away.
 */
export const StartModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [confirmingId, setConfirmingId] = useState<PresetId | null>(null);

  const treeIsEmpty = vm.config.root.children.length === 0;

  // Building a preset's config just to draw its silhouette is pure work —
  // do it once per locale rather than on every re-render.
  const silhouettes = useMemo(() => {
    const locale = vm.defaultLocale || "en";
    return new Map(PRESETS.map((p) => [p.id, previewBlocks(p.build(locale))] as const));
  }, [vm.defaultLocale]);

  const choose = (id: PresetId) => {
    if (!treeIsEmpty && confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    vm.applyPreset(id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(880px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("paywalls.builder.start.title", "Start a paywall")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.start.subtitle",
                "Begin from a layout and edit everything after — or start from a blank canvas.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.start.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-4">
            {PRESETS.map((preset) => {
              const confirming = confirmingId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => choose(preset.id)}
                  className={cn(
                    "cursor-pointer rounded-lg border p-2.5 text-left transition",
                    confirming
                      ? "border-rv-warning bg-rv-warning/10"
                      : "border-rv-divider bg-rv-c2 hover:border-rv-accent-500/50 hover:bg-rv-c3",
                  )}
                >
                  <Silhouette blocks={silhouettes.get(preset.id) ?? []} />
                  <div className="mt-2.5">
                    <span className="rounded bg-rv-accent-500/15 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-accent-500">
                      {preset.tag}
                    </span>
                    <div className="mt-1.5 text-[13px] font-medium text-foreground">
                      {preset.name}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                      {confirming
                        ? t(
                            "paywalls.builder.start.confirmReplace",
                            "Click again to replace your current design.",
                          )
                        : preset.description}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Blank canvas is deliberately last — it changes nothing, so it never confirms. */}
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-rv-divider bg-rv-c2 p-2.5 text-left transition hover:border-rv-accent-500/50 hover:bg-rv-c3"
            >
              <div
                className="flex flex-col items-center justify-center gap-1.5 rounded-md bg-rv-c3 text-rv-mute-500"
                style={{ height: THUMB_HEIGHT }}
              >
                <FilePlus2 size={20} />
                <span className="text-[11px]">
                  {t("paywalls.builder.start.blankThumb", "Empty")}
                </span>
              </div>
              <div className="mt-2.5">
                <span className="rounded bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-600">
                  {t("paywalls.builder.start.blankTag", "Start empty")}
                </span>
                <div className="mt-1.5 text-[13px] font-medium text-foreground">
                  {t("paywalls.builder.start.blankName", "Blank canvas")}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                  {t("paywalls.builder.start.blankDescription", "Build from scratch.")}
                </div>
              </div>
            </button>
          </div>
        </div>

        <div className="flex items-center border-t border-rv-divider px-5 py-3">
          <div className="flex-1 text-[11px] text-rv-mute-500">
            {t("paywalls.builder.start.footerHint", "Everything is editable after you pick one.")}
          </div>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Mount it from `BuilderShell`, auto-opening on an empty tree**

In `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`, widen the React import and add the two new ones:

```tsx
import { useEffect, useRef, useState } from "react";
```

```tsx
import { StartModal } from "./start-modal";
import { shouldAutoOpenStart } from "./start-model";
```

Add the state beside the other overlay flags, plus the latch that decides
whether to auto-open. Two things force this shape, and neither is optional:

- Hooks run **before** the `vm.isLoading` / `vm.error` early returns, and
  the view model's `config` starts as `emptyBuilderConfig()`. A plain
  `useState(() => shouldAutoOpenStart(vm.config))` initialiser would
  therefore read the pre-load empty config and pop the gallery open on
  **every** paywall, not just new ones.
- The decision must be latched. Re-deriving it reactively would re-open the
  gallery the moment the author deletes the last node, or after they
  dismissed it.

```tsx
  const [showStart, setShowStart] = useState(false);
  /** Auto-open is decided exactly once, at the first render after the paywall loads. */
  const startDecided = useRef(false);
  useEffect(() => {
    if (startDecided.current || vm.isLoading || !vm.paywall) return;
    startDecided.current = true;
    if (shouldAutoOpenStart(vm.config)) setShowStart(true);
  }, [vm.isLoading, vm.paywall, vm.config]);
```

Pass the opener to `TopBar` (its button arrives in Task 4):

```tsx
      <TopBar
        projectId={projectId}
        onOpenValidation={() => setShowValidation(true)}
        onOpenDiff={() => setShowDiff(true)}
        onOpenLocalization={() => setShowLocalization(true)}
        onOpenStart={() => setShowStart(true)}
      />
```

and mount the modal beside the others:

```tsx
      {showStart && <StartModal onClose={() => setShowStart(false)} />}
```

Note: the effect depends on `vm.config` only so it re-runs on the render where the load lands; the `startDecided` ref makes every later run a no-op.

- [ ] **Step 3: Add the `onOpenStart` prop to `TopBar`**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`, add to `type Props`:

```tsx
  onOpenStart: () => void;
```

add `onOpenStart` to the destructured parameters, and — so strict TS doesn't flag an unused binding until Task 4 adds the button — add:

```tsx
  // Temporary: Task 4 replaces this with the real start button.
  void onOpenStart;
```

- [ ] **Step 4: Export from the barrel**

In `apps/dashboard/src/components/paywall-builder/index.ts`, add:

```ts
export { StartModal } from "./start-modal";
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
git add apps/dashboard/src/components/paywall-builder/start-modal.tsx \
  apps/dashboard/src/components/paywall-builder/builder-shell.tsx \
  apps/dashboard/src/components/paywall-builder/top-bar.tsx \
  apps/dashboard/src/components/paywall-builder/index.ts
git commit -m "feat(dashboard): paywall start gallery modal"
```

---

### Task 4: Top-bar entry point

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`

**Interfaces:**
- Consumes: `onOpenStart` (Task 3).
- Produces: a button beside the localization button that reopens the start gallery.

- [ ] **Step 1: Replace the placeholder with the real button**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`, add `LayoutTemplate` to the existing `lucide-react` import.

Delete the placeholder added in Task 3:

```tsx
  // Temporary: Task 4 replaces this with the real start button.
  void onOpenStart;
```

Then render the button immediately after the localization-matrix button:

```tsx
        <button
          type="button"
          onClick={onOpenStart}
          title={t("paywalls.builder.topbar.start", "Start from a layout")}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <LayoutTemplate size={13} />
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
git commit -m "feat(dashboard): top-bar entry point for the paywall start gallery"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — preset, start-model and the pre-existing suites green.
2. `pnpm --filter @rovenue/dashboard exec tsc --noEmit` and `pnpm --filter @rovenue/dashboard build` — both clean.
3. Manual (optional, seeded dev dashboard): create a paywall, open the builder — the gallery appears by itself; pick "Hero" and confirm the canvas fills and the publish button is not blocked; reopen from the top bar on the now non-empty tree and confirm a card needs a second click before replacing; pick "Blank canvas" on a fresh paywall and confirm the modal closes leaving an empty tree. Then open an **existing, non-empty** paywall and confirm the gallery does **not** appear — this is what the auto-open latch in Task 3 exists to get right; deleting every node afterwards must not make it reappear.

## Out of scope (deferred)

- `paywall_templates` DB table + `GET /paywall-templates` + `POST /paywalls/from-template` — for remotely-managed or user-saved templates.
- The App Store import and AI tabs (P8).
- Designing additional presets — a `presets.ts` content edit needing no infrastructure.
