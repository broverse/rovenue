# Paywall Builder + Web Renderer (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platform-neutral paywall component-tree schema + shared React renderer + funnel-builder-style visual editor + serving through /v1/placements and the funnel runner.

**Architecture:** Schema/Zod/pure-helpers in `@rovenue/shared` `./paywall` subpath; new workspace package `packages/paywall-renderer` (React 19 peer, raw-TS source exports); dashboard builder cloned from the funnel-builder impair-MVVM architecture with the renderer as the live canvas; `paywalls.builderConfig` jsonb (already exists, null) becomes live with `configFormatVersion: 2`.

**Tech Stack:** Zod, React 19, impair (dashboard MVVM), @base-ui-components, Hono, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-22-paywall-builder-phase-b-design.md` (the node-type table, validator issue list, and renderer prop contract there are normative — copy values from it verbatim).

## Global Constraints

- Stay on the current branch (main). NEVER create branches or worktrees.
- Wire style camelCase everywhere. Colors are theme pairs `{ light: string, dark?: string }`. Layout = nested stacks only. Every node has `id` + optional `fallback` node.
- Renderer is pure presentational: NO network, NO SDK imports, NO css framework — inline styles only; unknown node `type` → render its `fallback` else nothing, NEVER throw.
- `builderConfig` is ALWAYS included in placement paywall payloads when non-null (no query-param gating — a params-gated response re-creates the edge-cache collision class fixed in f450984a).
- Non-null builderConfig ⇔ `configFormatVersion: 2` (server-enforced, not client-supplied).
- Dashboard hooks use the typed rpc/unwrap client; builder VM follows funnel-builder's impair patterns (autosave JSON-snapshot dirty tracking, ZOOM_STEPS/WHEEL_THRESHOLD conventions from `funnel-draft.vm.ts`).
- TS strict; Zod on every API input; `ok()`/error envelopes; conventional commits; commit per task.
- apps/api tests in `apps/api/tests/`; env via vi.hoisted/setup pattern.
- Baseline noise: api suite carries ~41 pre-existing failures from stale shared test-DB rows (reproduced on clean main) — only NEW tests must be newly green.

---

### Task 1: Shared — paywall builder schema + validators + variable resolution

**Files:**
- Create: `packages/shared/src/paywall/{schema.ts,validate.ts,variables.ts,index.ts}`
- Modify: `packages/shared/package.json` (add `./paywall` subpath export, mirroring `./funnel`), `packages/shared/src/index.ts` if the top-level barrel re-exports subpackages (check `./funnel` precedent — mirror it exactly)
- Test: `packages/shared/src/paywall/{schema.test.ts,validate.test.ts,variables.test.ts}`

**Interfaces (Produces):**
```ts
// schema.ts — discriminated union on "type"; every node has id: string, fallback?: PaywallNode
export type ThemeColor = { light: string; dark?: string };
export type NodeSize = "fit" | "fill" | number;
export type StackNode = { type: "stack"; id: string; axis: "v" | "h" | "z"; children: PaywallNode[];
  spacing?: number; align?: "start" | "center" | "end"; padding?: { t?: number; r?: number; b?: number; l?: number };
  size?: { width?: NodeSize; height?: NodeSize }; background?: ThemeColor; cornerRadius?: number; fallback?: PaywallNode };
export type TextNode = { type: "text"; id: string; key: string; role: "title" | "subtitle" | "body" | "caption";
  color?: ThemeColor; align?: "start" | "center" | "end"; fallback?: PaywallNode };
export type ImageNode = { type: "image"; id: string; url: { light: string; dark?: string };
  height?: number; cornerRadius?: number; alt?: string; fallback?: PaywallNode };
export type ButtonNode = { type: "button"; id: string; labelKey: string; style: "primary" | "secondary" | "plain";
  action: { kind: "close" } | { kind: "url"; url: string } | { kind: "restore" }; fallback?: PaywallNode };
export type PackageListNode = { type: "packageList"; id: string; packageIds: string[];
  defaultSelected?: string; cellLayout: "row" | "column"; fallback?: PaywallNode };
export type PurchaseButtonNode = { type: "purchaseButton"; id: string; labelKey: string; fallback?: PaywallNode };
export type SpacerNode = { type: "spacer"; id: string; size?: number; fallback?: PaywallNode };
export type PaywallNode = StackNode | TextNode | ImageNode | ButtonNode | PackageListNode | PurchaseButtonNode | SpacerNode;
export type BuilderConfig = { formatVersion: 2; defaultLocale: string;
  localizations: Record<string, Record<string, string>>; background?: ThemeColor; root: StackNode };
export const builderConfigSchema: z.ZodType<BuilderConfig>; // z.lazy for the recursive node union
export function emptyBuilderConfig(defaultLocale?: string): BuilderConfig;

// validate.ts
export type BuilderIssue = { code: "DUPLICATE_NODE_ID" | "UNKNOWN_LOC_KEY" | "FOREIGN_PACKAGE_ID"
  | "MISSING_PURCHASE_BUTTON" | "LOCALE_KEY_GAP"; nodeId?: string; locale?: string; key?: string; message: string };
export function validateBuilderConfig(config: BuilderConfig, opts: { offeringPackageIds: string[] }): BuilderIssue[];
export function collectLocalizationKeys(root: StackNode): string[];
export function resolveText(config: BuilderConfig, locale: string, key: string): string | null; // locale → defaultLocale → null

// variables.ts
export type PackageView = { packageName: string; price: string; pricePerPeriod: string; period: string };
export function resolveVariables(text: string, pkg: PackageView | null): string; // {{price}} etc.; unknown vars left verbatim; null pkg → vars left verbatim
```

Validator semantics (normative): DUPLICATE_NODE_ID across the whole tree; UNKNOWN_LOC_KEY when a text/button/purchaseButton key is missing from the defaultLocale table; FOREIGN_PACKAGE_ID when packageList.packageIds/defaultSelected reference ids not in `offeringPackageIds` (empty packageIds array = "all" = valid); MISSING_PURCHASE_BUTTON when a packageList exists anywhere but no purchaseButton does; LOCALE_KEY_GAP per (non-default locale, key present in defaultLocale but missing there) — gap issues are warnings by convention but returned in the same array (UI decides severity by code).

- [x] **Step 1 (TDD):** Write the three test files first — schema acceptance (a two-level tree with every node type round-trips), rejections (bad axis, missing id, formatVersion !== 2, non-object localization), validator: one test per issue code + clean-config-empty-array, resolveText fallback chain, resolveVariables (all four vars, unknown var untouched, null pkg untouched). Run → FAIL (module missing).
- [x] **Step 2:** Implement schema.ts (z.lazy recursive union), validate.ts, variables.ts, subpath export.
- [x] **Step 3:** `pnpm --filter @rovenue/shared test` green + `pnpm --filter @rovenue/shared build` (tsc) clean.
- [x] **Step 4:** Commit: `feat(shared): paywall builder-config schema, validator and variables`.

---

### Task 2: `packages/paywall-renderer` — package + static node rendering

**Files:**
- Create: `packages/paywall-renderer/package.json` (name `@rovenue/paywall-renderer`, raw-TS source exports like `@rovenue/shared`, `peerDependencies: { react: "^19.0.0" }`, devDeps react/react-dom/@testing-library/react/jsdom/vitest/typescript), `tsconfig.json` (copy a sibling package's, add `"jsx": "react-jsx"`, DOM lib), `vitest.config.ts` (jsdom environment)
- Create: `packages/paywall-renderer/src/{index.ts,renderer.tsx,nodes.tsx,styles.ts,types.ts}`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`
- Modify: root workspace picks it up automatically (`packages/*`); verify `pnpm install` links it

**Interfaces (Produces):**
```tsx
export type RendererOffering = { identifier: string; packages: Array<{ packageIdentifier: string;
  displayName: string; metadata?: unknown; storeIds?: Record<string, string> }> }; // subset of the /v1/placements offering shape — accept extra fields
export type PaywallRendererProps = {
  config: BuilderConfig; offering: RendererOffering | null; locale?: string;
  colorScheme: "light" | "dark";
  onPurchase: (packageIdentifier: string) => void; onClose?: () => void;
  onRestore?: () => void; onUrl?: (url: string) => void;
};
export function PaywallRenderer(props: PaywallRendererProps): JSX.Element;
// Every rendered node's outermost DOM element carries data-rov-node={node.id} — documented feature.
```

Rendering rules: stack → flex div (axis v=column h=row; z=grid single-cell overlay), theme pair resolution via `colorScheme`; text/button labels via `resolveText` then `resolveVariables`; image picks `url[colorScheme] ?? url.light`; unknown type → `fallback` else null (spec constraint). This task renders everything EXCEPT interactivity (Task 3): packageList renders static cells (first/defaultSelected marked via aria-pressed), buttons render but only onClose/onUrl/onRestore wiring may be stubbed as inert.

- [x] **Step 1 (TDD):** renderer.test.tsx — renders every node type from a fixture config, asserts data-rov-node on each, locale fallback (tr missing key → en text), dark scheme picks dark colors (assert style), unknown-type node with fallback renders fallback / without renders nothing. Run → FAIL.
- [x] **Step 2:** Implement package + components. **Step 3:** `pnpm --filter @rovenue/paywall-renderer test` green + tsc clean + `pnpm build --force` still 8/8 (new package joins the graph). **Step 4:** Commit: `feat(paywall-renderer): shared React renderer for builder paywalls`.

---

### Task 3: Renderer interactivity — selection, purchase, actions, variables

**Files:**
- Modify: `packages/paywall-renderer/src/{renderer.tsx,nodes.tsx}`
- Test: extend `renderer.test.tsx`

Selection state: `useState<string | null>` initialized `defaultSelected ?? packageIds[0] ?? offering.packages[0]?.packageIdentifier ?? null`; packageList cells are buttons (click selects, `aria-pressed`); `purchaseButton` disabled when selection null, else fires `onPurchase(selected)`. Button actions wire to onClose/onUrl/onRestore (each optional — absent handler renders the button inert but visible, except `restore` which hides when handler absent — the funnel runner suppresses restore per spec). Variables resolve against the SELECTED package inside purchaseButton/free text, and against the CELL's package inside packageList cells. `PackageView` derivation from `RendererOffering` packages: `packageName = displayName`, price fields from `metadata`/`storeIds` are NOT available client-agnostically — derive `price/pricePerPeriod/period` from an optional `priceView?: Record<string, PackageView>` prop (keyed by packageIdentifier) the consumer supplies (dashboard preview will pass placeholder views; web consumers pass real store prices). Add `priceView` to `PaywallRendererProps`.

- [x] **Step 1 (TDD):** tests — default selection, click switches selection, purchase fires with selected id, no-offering → purchaseButton disabled, restore hidden without handler, variable text swaps when selection changes. Run → FAIL. **Step 2:** implement. **Step 3:** green + tsc. **Step 4:** Commit: `feat(paywall-renderer): package selection, purchase flow and variable resolution`.

---

### Task 4: API — builderConfig write path + placement serving

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts` (PATCH/POST accept nullable `builderConfig`; GET list/detail include it)
- Modify: `apps/api/src/routes/v1/placements.ts` (`hydratePaywall` adds `builderConfig` + real `configFormatVersion`)
- Test: extend `apps/api/tests/dashboard-paywalls.integration.test.ts` + `apps/api/tests/placements-resolve.integration.test.ts`

Rules (server-enforced): PATCH with non-null `builderConfig` → validate `builderConfigSchema` then `validateBuilderConfig` against the paywall's offering package identifiers (load offering, extract package slot identifiers) — any issue with code ≠ `LOCALE_KEY_GAP` → 400 `{ code: "INVALID_BUILDER_CONFIG", issues }`; gaps alone are accepted (warnings). Persist sets `configFormatVersion: 2`; `builderConfig: null` clears and reverts `configFormatVersion: 1`. Client-supplied `configFormatVersion` is IGNORED (server derives it). `/v1/placements` payload: `paywall.builderConfig` present (verbatim) only when non-null; `configFormatVersion` reflects the stored value; `?locale` continues to slice ONLY `remoteConfig`.

- [x] **Step 1 (TDD):** tests — PATCH valid config → 200, formatVersion 2 in response; foreign packageId → 400 INVALID_BUILDER_CONFIG with issue list; LOCALE_KEY_GAP-only config → 200; null clears → formatVersion 1; placement resolve includes builderConfig verbatim + formatVersion 2; paywall without builderConfig → field absent, formatVersion 1. Run → FAIL. **Step 2:** implement. **Step 3:** new tests green, tsc clean. **Step 4:** Commit: `feat(api): builderConfig write path and placement serving`.

---

### Task 5: Dashboard — builder VM + API service (logic only, no UI)

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/{vm/paywall-builder.vm.ts,builder-provider.tsx,tree-ops.ts,presets.ts,types.ts}`
- Create: `apps/dashboard/src/lib/services/paywall-builder-api.ts` (thin class over the existing typed paywall rpc endpoints, following `FunnelApi`'s shape so the VM can inject it)
- Test: `apps/dashboard/src/components/paywall-builder/{vm/paywall-builder.vm.test.ts,__tests__/tree-ops.test.ts}`

**Interfaces (Produces):**
```ts
// tree-ops.ts — PURE tree manipulation (unit-tested exhaustively)
export function findNode(root: StackNode, id: string): PaywallNode | null;
export function findParent(root: StackNode, id: string): { parent: StackNode; index: number } | null;
export function insertNode(root: StackNode, parentId: string, node: PaywallNode, index?: number): StackNode; // immutable copies
export function removeNode(root: StackNode, id: string): StackNode;   // root itself is irremovable
export function moveNode(root: StackNode, id: string, dir: 1 | -1): StackNode; // clamp at edges
export function updateNode<T extends PaywallNode>(root: StackNode, id: string, patch: Partial<T>): StackNode;
export function newNode(type: PaywallNode["type"], idGen: () => string): PaywallNode; // sensible defaults, text/button get fresh loc keys
// presets.ts
export const PRESETS: Array<{ id: "hero" | "comparison"; name: string; build: (defaultLocale: string) => BuilderConfig }>;
```

VM (`@injectable`, mirrors FunnelDraftViewModel mechanics — read that file first): state = `config`, `paywall` (loaded detail incl. offering package ids for validation), `selectedNodeId`, `editLocale/defaultLocale/locales`, `colorScheme`, `canvasDevice/canvasZoom` (copy ZOOM_STEPS/WHEEL_THRESHOLD/handleCanvasWheel verbatim), `autosaveStatus/lastSavedSnapshot` dirty tracking, `validationIssues` derived via `validateBuilderConfig`. Actions: node CRUD delegating to tree-ops, `setLocaleText(key, locale, value)`, locale add/remove (remove reassigns like the paywalls remote-config helper), `applyPreset(id)`, debounced `saveNow()` PATCHing only `builderConfig`.

- [x] **Step 1 (TDD):** tree-ops tests (insert/remove/move/update/clamps/immutability — original tree unchanged) + VM tests for dirty-snapshot, preset application, locale ops (mirror funnel-draft.vm.test.ts's harness). Run → FAIL. **Step 2:** implement. **Step 3:** dashboard vitest green + tsc. **Step 4:** Commit: `feat(dashboard): paywall builder view-model and tree operations`.

---

### Task 6: Dashboard — builder UI shell

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/{builder-shell.tsx,layer-tree.tsx,canvas.tsx,properties-panel.tsx,top-bar.tsx,add-node-popover.tsx,validation-drawer.tsx,index.ts}`
- Create: route `apps/dashboard/src/routes/_authed/projects/$projectId/paywalls.$paywallId.builder.tsx` (check the exact file-route naming convention against the funnel builder's route file and mirror it)
- Modify: `apps/dashboard/src/components/paywalls/paywall-list.tsx` (row action "Open builder")
- i18n keys for all new strings (fallback-value style like Phase A components)

Layout mirrors funnel-builder's shell: left `layer-tree` (indented node rows, type icon, select/move/delete, add-node popover on stacks), center `canvas` (device frame + zoom controls; hosts `<PaywallRenderer>` with `config`, the paywall's hydrated offering (fetch via existing placement/paywall detail hooks or a small offering hydration call — check what the paywall detail endpoint already returns and reuse), `priceView` = placeholder views (`$9.99`-style constants labeled "preview"), `colorScheme` from VM; click-to-select: canvas listens for clicks, walks `event.target.closest('[data-rov-node]')`, sets selectedNodeId; selection outline = absolutely-positioned ring over the selected element's bounding rect), right `properties-panel` (per-type editors; text/button label editing writes localizations[editLocale] via `setLocaleText`; theme-pair color inputs = two swatch inputs light/dark; packageList package multi-select from offering package ids), `top-bar` (locale switcher, device toggle, light/dark, validation count → drawer, autosave status), `validation-drawer` listing `BuilderIssue`s (LOCALE_KEY_GAP styled as warning).

- [x] **Step 1:** Implement components + route + list action + i18n. **Step 2:** `pnpm --filter @rovenue/dashboard build` green; pure-helper tests where extractable (e.g. bounding-rect/selection helper if any pure logic emerges). **Step 3:** Commit: `feat(dashboard): visual paywall builder shell with live renderer canvas`.

---

### Task 7: Funnel — paywallId reference + serve hydration + runner rendering

**Files:**
- Modify: `packages/shared/src/funnel/pages-schema.ts` (paywall page: `paywallId: z.string().optional()`)
- Modify: funnel publish route (`apps/api/src/routes/dashboard/funnels.ts` publish handler): when a paywall page carries `paywallId`, verify it references a project paywall WITH non-null builderConfig → else 400 `{ code: "PAYWALL_NOT_RENDERABLE" }` (JSON-in-message convention like STRIPE_NOT_CONNECTED)
- Modify: public funnel serve endpoint (`apps/api/src/routes/public/funnels.ts` GET /funnels/:slug): hydrate referenced paywalls into the response as `paywalls: { [paywallId]: { builderConfig, configFormatVersion, offering: hydrated } }` (reuse `hydrateOffering`; one map for the whole funnel, deduped)
- Modify: `apps/dashboard/src/components/funnel-builder/runner/funnel-runner.tsx` (paywall page: when `page.paywallId` and the hydrated map has it → `<PaywallRenderer config offering colorScheme="light" locale={funnel locale} onPurchase={existing advance/purchase-stub path} />`, restore suppressed; else legacy flat rendering unchanged), and `properties-panel.tsx` funnel paywall section gains an optional paywall picker (project paywalls with builderConfig)
- Test: extend `apps/api/tests/funnels-publish-gate.test.ts` (or sibling) for PAYWALL_NOT_RENDERABLE; serve-endpoint test for the hydrated `paywalls` map; runner covered by dashboard build + any existing runner test harness (mirror if present, else state so)

- [x] **Step 1 (TDD where API-side):** publish-gate + serve-hydration tests → FAIL. **Step 2:** implement API side. **Step 3:** runner + picker; dashboard build green. **Step 4:** all new tests green, tsc both packages. **Step 5:** Commit: `feat(funnel): paywall pages can render a builder paywall via the shared renderer`.

---

### Task 8: Docs + checkoff

**Files:**
- Modify: `apps/docs/content/docs/guides/placements-and-paywalls.mdx` — new "Builder paywalls (web)" section: builderConfig appears in the placement payload with `configFormatVersion: 2`, web apps render it with `@rovenue/paywall-renderer` (workspace-internal this phase — document the props contract), native SDKs ignore it in Phase B
- Modify: `CLAUDE.md` — extend the placements Architecture line: builder paywalls = platform-neutral component tree (`@rovenue/shared/paywall`) rendered by `packages/paywall-renderer` (web) — native renderers are Phase C
- Modify: this plan — check off tasks; leave a Verification section
- [x] **Step 1:** Write + `pnpm --filter docs build` green. **Step 2:** Commit: `docs: builder paywalls guide section`.

---

## Verification (after all tasks)

- [x] `pnpm build --force` — 9/9 green incl. the new renderer package (2026-07-22)
- [x] `pnpm --filter @rovenue/shared test` (238/238) + `--filter @rovenue/paywall-renderer test` (22/22) + dashboard paywall-builder suites (139 across VM/tree-ops/UI helpers) + api new suites (publish gate 9/9, public funnels 14/14, paywalls/placements 27/27)
- [x] `cargo test -p librovenue` unchanged-green — core untouched, placement wire additions are serde-tolerated
- [ ] Builder smoke: headless-blocked (no browser in this environment) — manual pass recommended: create paywall → Open builder → apply preset → edit text in two locales → save → placement resolve returns builderConfig
