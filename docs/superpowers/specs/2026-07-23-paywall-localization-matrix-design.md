# Paywall Builder — Localization Matrix (P2) Design

**Date:** 2026-07-23
**Status:** Approved design. Feeds a writing-plans implementation plan.
**Phase:** P2 of the paywall-builder redesign (`docs/superpowers/specs/2026-07-23-paywall-builder-gap-analysis.md` §7). P0 and P1 shipped; P4a was already done in Phase D.
**Design source:** Claude Design project `008cf05d-86d0-4f88-bf69-3802297259d1` — `Rovenue Paywall Builder.html` (`LocalizationModal`).

---

## 1. Goal & scope

Give the builder a **strings × locales matrix**: every localization key the paywall tree actually uses, against every locale it ships in, with per-locale completion counters, missing cells highlighted and clickable (jump to the owning node), and inline editing.

**In scope:** the matrix modal; a top-bar entry point with a gap indicator; one shared tree-walk primitive; one shared emptiness predicate; and a validator correction so the matrix and the publish gate agree on what "missing" means.

**Explicitly OUT of scope:**
- **Staleness** (gap-analysis §5.5 — a `localizationMeta` sidecar + `LOCALE_STALE`). Touches the wire; needs the four platform decoders verified for unknown-config-field tolerance first. Its own phase.
- **Auto-translate** (§6.10). Needs copilot BYOK integration, quota, prompt design, and a review gate before machine copy reaches a money-facing screen. Its own phase.
- **`GET`/`PUT /localizations` (§6.8, §6.9) — STRUCK.** Verified against the code: the builder view model already holds the entire `BuilderConfig` including `localizations`, `setLocaleText` already mutates it, and autosave already persists it via `PATCH …/paywalls/:id`. A read or write endpoint would duplicate state that is already client-side. The matrix is a pure view over existing state; P2 adds **no API, no DB, no wire change**.

**Success criteria:** opening the matrix on a paywall with an untranslated locale shows exactly which (key, locale) cells are blank; clicking a blank cell's jump affordance selects the owning node; typing in a cell persists through the normal autosave; the per-locale counters agree with the validator's issue list; a paywall whose default-locale string is blank can no longer be published.

---

## 2. Current state (verified, not assumed)

- `packages/shared/src/paywall/validate.ts` exports `collectLocalizationKeys(root: StackNode): string[]` — walks the tree including `fallback` and `packageList.cellTemplate` subtrees and picks up `key`/`labelKey` introduced by `overrides`. Re-exported from the paywall barrel (`export * from "./validate"`), so the dashboard can import it today.
- `UNKNOWN_LOC_KEY` (blocking) fires when a node's key satisfies `!(key in defaultLocaleTable)`.
- `LOCALE_KEY_GAP` (warning — it is in `WARNING_ISSUE_CODES`) fires per (non-default locale, key present in the default table but `!(key in table)`).
- The view model already exposes `locales`, `defaultLocale`, `editLocale`, `setLocaleText(key, locale, value)`, `addLocale`, `removeLocale`, `setDefaultLocale`, and the full `config`.
- `registerFreshLocKeys` stubs **every** locale with `""` when a text/button/purchaseButton node is added.
- The properties panel edits localized text **per keystroke** (`onChange` → `setLocaleText`), and `validationIssues` is a `@derived` whole-tree `validateBuilderConfig` run. That is the established cost profile.

### The defect this exposes

Both validator checks test **presence** (`in`), so `""` counts as translated. Combined with `registerFreshLocKeys` stubbing `""` everywhere, **a paywall whose headline is blank in the default locale passes validation and can be published.** That is not a preference to document — it is a bug, and it is the reason the matrix must not simply be a prettier view of the current rules.

---

## 3. Shared changes (two, both pure, no wire impact)

**3.1 One walk, not two.** The matrix needs each key's *owning node* (to label the row and to jump to it), which `collectLocalizationKeys` discards. Rather than adding a second walk that could drift from the first on the subtle parts (fallback / cellTemplate / override keys), make usages the primitive and keys a projection:

```ts
export interface LocalizationUsage {
  key: string;
  nodeId: string;
  nodeType: PaywallNode["type"];
  /** True when the key came from an `overrides[].props`, not the node's own field. */
  viaOverride: boolean;
}

/** Every (key, owning node) pair in the tree, in document order. */
export function collectLocalizationUsages(root: StackNode): LocalizationUsage[];

/** Deduped keys — now a projection of `collectLocalizationUsages`. */
export function collectLocalizationKeys(root: StackNode): string[];
```

`collectLocalizationKeys` keeps its exact current signature and behaviour (deduped keys, same traversal), so the validator and every existing caller are unaffected.

**3.2 One definition of "missing".**

```ts
/** A localization value is missing when the key is absent OR the value is
 * blank — `registerFreshLocKeys` stubs new keys as "" in every locale, so
 * presence alone says nothing about whether anything was written. */
export function isMissingLocaleValue(value: string | undefined): boolean;
```

Used by **both** the validator and the matrix, so the two can't drift by convention.

---

## 4. Validator correction (a real behaviour change — approved)

`UNKNOWN_LOC_KEY` and `LOCALE_KEY_GAP` both switch from `key in table` to `isMissingLocaleValue(table[key])`:

- **Default locale blank → `UNKNOWN_LOC_KEY` (blocking).** A paywall with a blank headline can no longer be published. This is the point of the change.
- **Non-default locale blank or absent → `LOCALE_KEY_GAP` (warning).** Still a warning, because the renderer genuinely falls back to the default locale at runtime — the string resolves, it just resolves in the wrong language. The design mock treats a missing `ja` as blocking; Rovenue's runtime semantics say otherwise, and the runtime wins.

**Consequence to accept knowingly:** a draft that publishes today can start being blocked once a blank default-locale string is present. Published `paywall_versions` snapshots are unaffected — only new publishes re-validate. This is the correct direction (a blank paywall must not ship), and it is why the matrix and the publish gate will agree.

**Observation, deliberately NOT changed:** `LOCALE_KEY_GAP` iterates the keys of the *default table* rather than the keys the tree actually uses, so an orphaned key left in the table still produces warnings. The matrix, by contrast, shows rows from tree usage. Aligning them would reduce warnings for orphaned keys — a defensible cleanup, but scope creep here. Noted for a later pass.

---

## 5. The matrix modal

New `apps/dashboard/src/components/paywall-builder/localization-modal.tsx`, mounted from `builder-shell.tsx` alongside `ValidationDrawer` and `DiffModal`, and following `DiffModal`'s overlay idiom (fixed-inset backdrop, centred panel, `rv-*` tokens, `cn`, `lucide`).

**Rows** — one per distinct key from `collectLocalizationUsages(vm.config.root)`, in document order. Each row shows the key plus its owning node's type and id. A key can legitimately be shared by several nodes; in that case the row shows the **first** owner (document order) plus a non-interactive `+N` badge whose `title` lists the other owning node ids. Jump always targets that first owner — one deterministic destination, no disambiguation UI (YAGNI).

**Columns** — `vm.locales`, with `vm.defaultLocale` marked `base`. A per-locale header counter reads `done/total`, computed with `isMissingLocaleValue` so blank stubs count as not-done. The base column's counter drives the blocking signal; the others drive warnings.

**Cells** — an inline `<input>` bound to `vm.config.localizations[locale][key]`, `onChange` → `vm.setLocaleText(key, locale, value)`. Per-keystroke, exactly as the properties panel already does: only one cell is focused at a time, so the cost profile is unchanged, and inventing a commit-on-blur variant here would be the inconsistency. Missing cells get a distinct treatment (accent border + placeholder) and a jump affordance that closes the modal, selects the owning node, and leaves the properties panel on that node.

**Footer** — the blocking / warning counts, and a Done button. No "Auto-translate gaps" button: that phase does not exist yet, and a dead control is worse than an absent one.

**Scale** — a paywall carries on the order of 5–20 keys and 1–6 locales, so the table renders directly. No virtualization (YAGNI).

---

## 6. Entry point

A button beside the existing `LocaleSwitcher` in `top-bar.tsx` (a `Languages`/table icon, `t(…)`-labelled) that opens the modal, carrying a dot when any cell is missing — severity-coloured: danger when the default locale has a gap (blocking), warning otherwise. `BuilderShell` owns the `showLocalization` state, mirroring how it owns `showValidation` and `showDiff`.

---

## 7. Testing

- **`collectLocalizationUsages`** — unit-test that it reports owners for text / button / purchaseButton nodes, descends into `fallback` and `cellTemplate`, picks up override-introduced keys with `viaOverride: true`, and preserves document order. Plus a test that `collectLocalizationKeys` still returns the same deduped set it does today (the refactor must be behaviour-preserving).
- **`isMissingLocaleValue`** — unit-test `undefined`, `""`, `"   "` → missing; `"x"` → present.
- **Validator** — unit-test that a blank default-locale value now emits `UNKNOWN_LOC_KEY` (blocking) and that a blank non-default value emits `LOCALE_KEY_GAP` (warning), guarding the behaviour change in both directions.
- **Matrix modal** — presentational; verified by `tsc --noEmit`, `build`, and the existing paywall-builder suite staying green.

---

## 8. Global constraints

- Dashboard + `packages/shared/src/paywall` only. **No API, no DB, no wire-format change** (the two shared additions are pure functions; `BuilderConfig`'s shape is untouched).
- TypeScript strict. Every user-facing string via `t("paywalls.builder.localization.*", "English fallback")`.
- **No magic values** — literals (column widths, dot sizes, severity thresholds) get named constants; structured data is not a magic value.
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 9. Follow-ons (explicitly deferred)

- Staleness sidecar + `LOCALE_STALE` (§5.5) — needs four-platform decoder tolerance verified first.
- Auto-translate via copilot BYOK (§6.10) — needs a review gate before machine copy ships.
- Aligning `LOCALE_KEY_GAP`'s key set with tree usage (§4 observation).
