# Paywall Builder + Web Renderer — Phase B Design

Date: 2026-07-22
Status: approved (continuation of Phase A, `2026-07-22-paywall-placements-design.md`)

## Overview

Phase B turns the Phase-A paywall entity into a **visually built, web-rendered**
paywall: a platform-neutral component-tree schema stored in the reserved
`paywalls.builderConfig` column, a shared **React renderer** package, and a
**builder editor** in the dashboard modeled on the funnel-builder. The same
renderer serves three consumers: the builder's live preview, the funnel
runner's `paywall` page (B2 convergence), and — later — customers' web apps.
Native (Swift/Kotlin) renderers remain **Phase C**; they will read this same
schema, which is why platform neutrality is a hard constraint here.

### Key decisions

1. **Schema lives in `@rovenue/shared` under a new `./paywall` subpath**
   (types + Zod + pure helpers, no React) — same precedent as `./funnel`.
   Wire style is camelCase (codebase convention; Phase A's snake_case→camelCase
   lesson from the CH pipeline applies).
2. **Renderer is a new workspace package `packages/paywall-renderer`**
   (React 19 peer dep; raw-TS source exports like every other package;
   precedent: `packages/email-templates` ships React). Pure presentational:
   config + offering + locale + callbacks in, DOM out. No network, no SDK.
3. **Layout is nested stacks only** (v/h/z axis) — maps 1:1 to flexbox on web
   and to SwiftUI/Compose stacks in Phase C. No absolute positioning.
4. **Colors are theme pairs `{light, dark}`; text is key-indirection**
   against per-locale localization tables carried inside `builderConfig`
   (all locales ship in the payload — offline-safe, mirrors RC).
5. **Every node reserves an optional `fallback` node** (RC's
   forward-compatibility trick). Renderers render `fallback` when they meet
   an unknown `type`. Cheap now, priceless in Phase C.
6. **`builderConfig` is always included** in the `/v1/placements` paywall
   payload when present (no new query param — a params-gated response would
   re-create the edge-cache-key collision class fixed in f450984a; Rust/native
   serde ignores unknown fields, so Phase-A SDKs are unaffected).
   `configFormatVersion` becomes `2` when a paywall has a builderConfig.
7. **Builder editor clones the funnel-builder architecture**: impair
   `@injectable` VM + `ServiceProvider`, autosave with JSON-snapshot dirty
   tracking and `SaveScope`-sliced PATCHes, canvas with the existing
   zoom/wheel conventions, move-up/down + popover insertion (NO drag-drop
   library — funnel-builder has none either), `localized-input` /
   `locale-switcher` interaction patterns, preview overlay = the real
   renderer (dogfooding).
8. **Funnel convergence (B2-lite):** funnel `paywall` pages gain an optional
   `paywallId`; when set, the runner renders the referenced paywall's
   builderConfig through the shared renderer. Purchase CTA behavior inside
   funnels stays exactly as today (B3 owns on-page payment). Legacy flat
   fields (`headline`/`benefits`/`productId`) remain the fallback path.

## 1. Schema (`packages/shared/src/paywall/`)

```jsonc
// paywalls.builderConfig (jsonb) — validated by builderConfigSchema
{
  "formatVersion": 2,
  "defaultLocale": "en",
  "localizations": { "en": { "title_1": "Go Pro" }, "tr": { "title_1": "Pro'ya geç" } },
  "background": { "light": "#FFFFFF", "dark": "#0B0B0F" },
  "root": { /* StackNode */ }
}
```

Node union (Zod discriminated union on `type`; every node: `id` (unique in
tree), optional `fallback` (a complete alternative node)):

| type | props (beyond shared) |
|---|---|
| `stack` | `axis: "v"\|"h"\|"z"`, `children: Node[]`, `spacing`, `align: "start"\|"center"\|"end"`, `padding {t,r,b,l}`, `size {width,height}` (`fit`\|`fill`\|number), `background?` (theme pair), `cornerRadius?` |
| `text` | `key` (localization key), `role: "title"\|"subtitle"\|"body"\|"caption"`, `color?` (theme pair), `align?` |
| `image` | `url { light, dark? }`, `height?`, `cornerRadius?`, `alt?` (loc key) |
| `button` | `labelKey`, `action: {kind:"close"} \| {kind:"url", url} \| {kind:"restore"}`, `style: "primary"\|"secondary"\|"plain"` |
| `packageList` | `packageIds: string[]` (offering package identifiers; empty = all), `defaultSelected?` (package id), `cellLayout: "row"\|"column"` — renders selectable cells; selection state owned by renderer |
| `purchaseButton` | `labelKey` — purchases the currently selected package |
| `spacer` | `size?` (number; omitted = flexible) |

Pure helpers (shared, no React): `builderConfigSchema`,
`validateBuilderConfig(config, { offeringPackageIds })` → structured issues
(duplicate node ids, unknown localization keys, packageList refs not in the
offering, missing purchaseButton when a packageList exists, key coverage per
locale vs defaultLocale), `resolveText(config, locale, key)`,
`collectLocalizationKeys(root)`, `emptyBuilderConfig(defaultLocale)`.

**Variables:** text values support `{{price}}`, `{{pricePerPeriod}}`,
`{{period}}`, `{{packageName}}` resolved at render time against the
*selected* package (inside packageList cells: against the cell's package).
Resolution helper `resolveVariables(text, pkgView)` lives in shared (pure).
Anything richer (per-day normalization, intro offers, countdowns) is a
non-goal.

## 2. Renderer (`packages/paywall-renderer`)

```tsx
<PaywallRenderer
  config={builderConfig}
  offering={hydratedOffering}          // same shape /v1/placements returns
  locale="tr"                           // falls back to defaultLocale chain
  colorScheme="light" | "dark"
  onPurchase={(packageIdentifier) => …} // consumer owns the actual purchase
  onClose={() => …}
  onRestore={() => …}
  onUrl={(url) => …}
/>
```

- One component per node type; unknown `type` → render `fallback` if present,
  else render nothing (never throw).
- Selection state: internal `useState`, initialized from
  `packageList.defaultSelected` else first package; `purchaseButton` fires
  `onPurchase(selected)`.
- Styling: inline styles from the schema (no CSS framework dependency —
  the package must work inside any host app); `colorScheme` picks the side
  of each theme pair.
- Package: `package.json` mirrors `@rovenue/shared` (raw TS source exports,
  `build: tsc`, vitest) + `peerDependencies: react ^19`, devDeps
  `@testing-library/react` + `jsdom` for behavior tests.

## 3. Builder editor (dashboard)

New route `…/$projectId/paywalls/$paywallId.builder.tsx` (list page gains an
"Open builder" action per paywall). Components under
`apps/dashboard/src/components/paywall-builder/`:

- `builder-provider.tsx` — impair `ServiceProvider` with `PaywallBuilderViewModel`
  (+ a thin `PaywallBuilderApi` service wrapping the existing typed
  rpc/unwrap paywall endpoints).
- `vm/paywall-builder.vm.ts` — clone of `FunnelDraftViewModel`'s mechanics:
  `@state config: BuilderConfig`, `selectedNodeId`, `editLocale`/`locales`/
  `defaultLocale`, autosave (debounced PATCH of `builderConfig` with
  JSON-snapshot dirty tracking + beforeunload guard), `canvasDevice`/
  `canvasZoom` (same ZOOM_STEPS/wheel constants), validation drawer state
  fed by `validateBuilderConfig`.
- `builder-shell.tsx` — left: layer tree (`layer-tree.tsx`, node rows with
  select/move-up/move-down/delete, add-node popover per stack); center:
  `canvas.tsx` hosting **`PaywallRenderer` in preview mode** (device frame +
  zoom, click-to-select via a node-id → DOM data-attribute the renderer
  emits (`data-rov-node`), selection outline overlay); right:
  `properties-panel.tsx` (per-node-type prop editors: text key + inline
  localized editing via the `localized-input` pattern, theme-pair color
  inputs reusing `color-swatch-input` conventions, stack axis/spacing/
  padding, packageList package picker from the paywall's offering,
  button action editor); top bar: locale switcher, device toggle,
  light/dark toggle, validation button, autosave status.
- `presets.ts` — exactly 2 starter presets (single-package hero,
  package-list comparison) applied when builderConfig is null.

The renderer emitting `data-rov-node={id}` attributes is a first-class,
documented renderer feature (also useful for e2e tests) — not a builder hack.

## 4. API / serving

- Dashboard paywalls routes: `PATCH /:id` accepts nullable `builderConfig`
  validated by `builderConfigSchema` + `validateBuilderConfig` against the
  paywall's offering (400 with the issue list on failure; `null` clears it).
  Setting a non-null builderConfig forces `configFormatVersion: 2`; clearing
  reverts to 1. GET responses include it.
- `/v1/placements`: `hydratePaywall` adds `builderConfig` (verbatim jsonb)
  and the real `configFormatVersion` to the paywall payload when
  builderConfig is non-null. No locale-slicing of the builder payload —
  localizations ship whole (offline-safe; the `?locale` param continues to
  affect only `remoteConfig`). Rust core: no changes required
  (serde ignores unknown fields) and none are made in Phase B.
- Funnel: `pages-schema.ts` `paywall` page gains optional `paywallId`;
  publish-time validation checks it references an existing project paywall
  **with a builderConfig** (else publish 400 `PAYWALL_NOT_RENDERABLE`);
  the public funnel serve endpoint hydrates the referenced paywall
  (builderConfig + offering) into the funnel payload; the runner renders it
  via `PaywallRenderer`, wiring `onPurchase` to the existing funnel
  advance/stub path and suppressing `onRestore` (not applicable in funnels).

## 5. Testing

- Schema: Zod acceptance/rejection, validator issue coverage (dup ids,
  unknown keys, foreign packageIds, locale coverage), variable resolution.
- Renderer: @testing-library — renders each node type, locale fallback,
  theme-pair switching, selection flow (default → click cell → purchase
  callback carries the selected id), unknown-type fallback behavior,
  `data-rov-node` presence.
- Builder VM: pure logic tests mirroring `funnel-draft.vm.test.ts`
  (node add/move/delete on the tree, dirty snapshot, locale add/remove).
- API: builderConfig PATCH validation (issues surface), placement payload
  includes builderConfig + formatVersion 2, funnel publish gate.
- Full build 8/8 stays green.

## Non-goals (Phase B)

- Native renderers (Phase C), webview rendering.
- Drag-and-drop, undo/redo, keyboard shortcuts, template gallery (>2
  presets), AI-assisted editing.
- Component types beyond the seven listed; conditions/overrides
  (size classes, offer eligibility, selection-state styling); state machines.
- Variable set beyond price/pricePerPeriod/period/packageName; price
  normalization (per-day/week) and intro-offer variables.
- Asset upload pipeline (image URLs are pasted/managed like funnel media).
- Web checkout (B3) — the renderer's `onPurchase` is a callback; funnels
  keep their existing stub.
- A published npm web SDK (renderer stays workspace-internal this phase).
