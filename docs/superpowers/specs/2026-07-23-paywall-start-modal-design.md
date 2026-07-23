# Paywall Builder — Start Modal (P3) Design

**Date:** 2026-07-23
**Status:** Approved design. Feeds a writing-plans implementation plan.
**Phase:** P3 of the paywall-builder redesign (`docs/superpowers/specs/2026-07-23-paywall-builder-gap-analysis.md` §7). P0, P1 and P2 shipped; P4a was already done in Phase D.
**Design source:** Claude Design project `008cf05d-86d0-4f88-bf69-3802297259d1` — `Rovenue Paywall Builder.html` (`StartModal`, Templates tab).

---

## 1. Goal & scope

Give the builder a **start modal**: when a paywall opens with an empty tree, offer a gallery of starting points — the existing presets plus a blank canvas — so a new paywall doesn't drop the author onto a blank screen.

**In scope:** the modal and its gallery cards; preset metadata (`description`, `tag`) and a derived `PresetId` type; a data-driven mini preview per card; auto-open on an empty tree; a top-bar button to reopen it, with a confirm when the tree is not empty.

### The finding that shapes this phase

`apps/dashboard/src/components/paywall-builder/presets.ts` already exports two working presets (`hero`, `comparison`), the view model already implements `applyPreset(id)`, and both are covered by tests asserting the resulting config has zero blocking validation issues. **But nothing in the dashboard ever calls `applyPreset`** — verified by searching the whole `apps/dashboard/src` tree; the only hits are an unrelated date-range popover. The capability is written, tested, and unreachable.

So most of the design mock's Templates tab is already built. P3 surfaces it rather than rebuilding it.

**Explicitly OUT of scope:**
- **A `paywall_templates` DB table + `GET /paywall-templates` + `POST /paywalls/from-template` (gap-analysis §6.12, §6.13) — DEFERRED.** Mirroring `funnel_templates` would add a migration, seeds, a repository and two endpoints. Its value over local presets is remotely-managed templates (add one without a deploy) and user-saved templates — neither of which is needed to close the "blank screen on a new paywall" gap. Revisit when there is demand for either.
- **The mock's other two Start tabs** — "From App Store link" and "AI assist" — belong to P8.
- **Designing additional presets.** Adding a third or fourth preset is a `presets.ts` edit needing no new infrastructure; it is a content decision, not this phase's.
- **No API, no DB, no wire-format change.** Every change is in `apps/dashboard/src/components/paywall-builder/`.

**Success criteria:** creating a paywall and opening the builder shows the gallery; picking "Hero" produces the hero config with zero blocking issues; picking "Blank canvas" closes the modal and leaves the tree empty; the top-bar button reopens the gallery, and on a non-empty tree a card requires a second, explicit confirmation before replacing the design.

---

## 2. Current state (verified)

- `presets.ts` exports `PRESETS: Array<{ id: "hero" | "comparison"; name: string; build: (defaultLocale: string) => BuilderConfig }>` with `buildHeroPreset` and `buildComparisonPreset`. Both build a full tree (image/title/subtitle/packageList/purchaseButton/restore-button for hero; title/subtitle/packageList/caption/purchaseButton for comparison) and register real default-locale strings, which is why they pass the blocking-issue tests.
- The view model's `applyPreset(id: "hero" | "comparison")` replaces `config` wholesale, resets `locales`/`defaultLocale`/`editLocale`, and clears `selectedNodeId`.
- Paywall creation is a plain form (`paywall-form-dialog.tsx` → `POST …/paywalls` via `useProjectPaywalls`) taking identifier, name and offering. The builder then opens on an empty config.
- `BuilderShell` already owns `showValidation`, `showDiff` and `showLocalization` state and mounts the matching overlays; `DiffModal` is the established overlay idiom.

---

## 3. Preset metadata and type

Each preset gains the two fields a gallery card needs, and the id union stops being hand-maintained in two places:

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

/** Ids derived from the table, so adding a preset needs no type edit. */
export type PresetId = (typeof PRESETS)[number]["id"];
```

`applyPreset(id: PresetId)` then tracks the table automatically. This is a small refactor of code the phase is already touching, not speculative generality: today adding a preset means editing the union in two files and forgetting one is a silent bug.

---

## 4. Data-driven mini preview

Each card carries a small abstract preview. Rather than hand-drawing artwork per template, derive it from the preset's own node tree so a newly-added preset gets a preview for free:

```ts
export type PreviewBlock =
  | { kind: "media" }                // image node — a tall block
  | { kind: "line"; width: number }  // text node — a bar, width as a 0–1 fraction
  | { kind: "cells" }                // packageList — two stacked cells
  | { kind: "action" }               // purchaseButton / button — a filled bar
  | { kind: "gap" };                 // spacer

/** Flatten a preset's top-level children into preview blocks. */
export function previewBlocks(config: BuilderConfig): PreviewBlock[];
```

`line.width` is a fraction of the card width, chosen per text `role` so the silhouette reads like a paywall rather than a stack of identical bars: `title` 0.8, `subtitle` 0.65, `body` 0.7, `caption` 0.5. The four values live in one named constant map, not inline.

The card renders the blocks as stacked bars/blocks with `rv-*` tokens. Only the root's direct children are walked — the preview is a silhouette, not a rendering, so nested structure is deliberately ignored. Node types with no mapping (e.g. a nested `stack`) are skipped.

---

## 5. When the modal opens

- **Automatically** when the builder mounts and the tree is empty (`config.root.children.length === 0`) — the moment right after creating a paywall. Auto-open is **latched**: decided exactly once, at the first render after the paywall finishes loading, and never re-derived. The latch is not a stylistic choice — `BuilderShell`'s hooks run before its `isLoading` early return and the view model's `config` starts as `emptyBuilderConfig()`, so deciding at mount would open the gallery on every paywall; and re-deriving reactively would re-open it the moment the author deletes the last node or dismisses it.
- **Manually** from a top-bar button, which opens the same modal at any time.
- **Because `applyPreset` replaces the entire config**, picking a template while the tree is non-empty would silently destroy work. On a non-empty tree a card click therefore arms a confirm state on that card ("Replace your current design?" with a confirm/cancel) instead of applying immediately. On an empty tree it applies directly — there is nothing to lose.
- **"Blank canvas"** is the last card. Choosing it simply closes the modal; it never needs a confirm because it changes nothing.

---

## 6. Testing

- **`previewBlocks`** — pure; unit-test that a hero preset yields media → line → line → gap → cells → action → action in order, and that an empty config yields no blocks.
- **`shouldAutoOpenStart(config)`** — pure predicate (`root.children.length === 0`); unit-test empty vs non-empty.
- **`PresetId` derivation** — a compile-time guarantee; covered by the existing `applyPreset` tests continuing to pass.
- **The modal** — presentational; verified by `tsc --noEmit`, `pnpm --filter @rovenue/dashboard build`, and the existing paywall-builder suite staying green.

---

## 7. Global constraints

- Dashboard only, under `apps/dashboard/src/components/paywall-builder/`. **No API, no DB, no wire-format change.**
- TypeScript strict. Every user-facing string via `t("paywalls.builder.start.*", "English fallback")`.
- **No magic values** — card dimensions, preview bar weights and the like get named constants; the preset table itself is structured data, not a magic value.
- Follow `DiffModal`'s overlay idiom (fixed-inset backdrop, centred panel, `rv-*` tokens, `cn`, `lucide`).
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 8. Follow-ons (deferred)

- `paywall_templates` DB table mirroring `funnel_templates`, with system and project scope, plus the two endpoints — when remotely-managed or user-saved templates are actually wanted.
- "Save this paywall as a template" — depends on the above.
- The App Store import and AI tabs (P8).
- Additional preset designs — a `presets.ts` content edit, no infrastructure.
