# Paywall Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offline fallback file, conditions/overrides (with packageList cellTemplate), expanded variables, paywall_close + durable event queue, attributed variant conversions.

**Architecture:** Contract-first: shared schema/validator/variables + additive fixture regeneration land before the four renderers; then builder UI, API/CH event work, core fallback + durable queue, and the results-UI read. All wire changes additive; B3 workstream files untouched.

**Tech Stack:** as Phases A–C (Zod/TS, React, SwiftUI, Android Views, RN, Rust/uniffi, Hono, ClickHouse).

**Spec:** `docs/superpowers/specs/2026-07-22-paywall-phase-d-design.md` — its D1–D5 sections are normative (condition kinds, overridable-prop lists, PackageView fields, file format, queue semantics, validator codes).

## Global Constraints

- Stay on main; NEVER branch; stage only your own files (parallel B3 agent is active — NEVER touch funnel routes/checkout/`priceView` wiring, apps/api/src/routes/public/funnels.ts, or anything the spec marks B3).
- Fixture (`packages/shared/src/paywall/render-fixtures.json`) is extended ADDITIVELY via the TS generator discipline; every contract change lands with fixture cases and must go green on ALL FOUR platform suites within its wave.
- Renderer leniency rules: unknown override `when.kind` → skip that entry; malformed props in a KNOWN kind → whole-config decode fail; unknown node type → fallback (unchanged). Authoring schema stays strict.
- Wire fields only ADDED. `PackageView` new fields OPTIONAL; absent → variable verbatim.
- Warning-severity validator codes (never block a save): `LOCALE_KEY_GAP`, `OVERRIDE_SELECTED_OUTSIDE_CELL`, `INTRO_VARIABLE_UNGUARDED`. Everything else blocks (`INVALID_BUILDER_CONFIG` 400).
- CH MV recreates carry the pause-consumer/backfill header note (0015/0019 precedent).
- Gates per platform as established: vitest / swift test / testDebugUnitTest / RN vitest+tsup, cargo test+fmt+clippy, no generated bindings committed, conventional commits per task.

---

### Task 1: Shared — overrides + cellTemplate in schema & validator

**Files:** modify `packages/shared/src/paywall/{schema.ts,validate.ts}` (+ their tests).

**Interfaces (Produces):**
```ts
export type OverrideCondition = { kind: "introEligible" } | { kind: "selected" };
export type NodeOverride = { when: OverrideCondition; props: Record<string, unknown> };
// Every node type gains `overrides?: NodeOverride[]`.
// PackageListNode gains `cellTemplate?: PaywallNode`.
// Strict-schema rules: when.kind ∈ the two literals (unknown → reject);
// props keys restricted PER NODE TYPE to its optional visual fields
// (color, background, cornerRadius, align, spacing, style, key, labelKey —
// whichever exist on that type); structural keys (type,id,children,axis,
// packageIds,defaultSelected,cellLayout,action,url,size,padding) rejected.
export function applyOverrides<T extends PaywallNode>(node: T, active: { introEligible: boolean; selected: boolean }): T;
// Pure: base props ⊕ matching overrides in array order (shallow, later wins).
// Unknown kinds in the input (possible when called on lenient-decoded data
// in TS consumers) are skipped. Exported for the web renderer + tests.
```
Validator: `CELL_TEMPLATE_BAD_NODE` (packageList/purchaseButton anywhere inside a cellTemplate subtree — blocking), `OVERRIDE_BAD_PROP` (unreachable via strict schema but validator re-checks parsed configs defensively — blocking), `OVERRIDE_SELECTED_OUTSIDE_CELL` (selected-condition override on nodes NOT inside any cellTemplate — warning), traversal now descends `cellTemplate` (dup-id detection, loc-key collection include it; `findFirstPackageList` semantics unchanged: cellTemplate is NOT primary-children for selection purposes).

- [ ] **Step 1 (TDD):** schema tests (override accept per type; unknown kind rejected; structural prop rejected; cellTemplate accepts nested visual tree; packageList-in-cellTemplate rejected BY VALIDATOR not schema; overrides survive on fallback subtrees) + validator tests (each new code, warning vs blocking, traversal into cellTemplate) + applyOverrides tests (order, shallow merge, unknown-kind skip) → RED.
- [ ] **Step 2:** Implement. **Step 3:** `pnpm --filter @rovenue/shared test` green + tsc. Commit: `feat(shared): paywall overrides, cellTemplate and validator codes`.

---

### Task 2: Shared — variable expansion + fixture regeneration

**Files:** modify `packages/shared/src/paywall/variables.ts` (+test), regenerate `render-fixtures.json` ADDITIVELY (generator script in scratchpad), update `render-fixtures.test.ts` expectations if section counts are asserted.

`PackageView` += optional `pricePerDay? pricePerWeek? pricePerMonth? pricePerYear? introPrice? introPeriod? relativeDiscount?` (all pre-formatted strings). `resolveVariables` maps the seven new variables; a KNOWN variable whose field is absent stays VERBATIM (tested). Fixture additions: `accept` cases exercising overrides + cellTemplate (≥2, incl. an unknown-condition entry in an `acceptLenient` config — strict schema rejects unknown kinds so that case goes to acceptLenient with a `_note`), `variables` vectors for all new vars incl. absent-field-verbatim, and a `overridesApplication` section? NO — keep fixture to decode/text/variable semantics; applyOverrides is pinned by per-platform unit tests sharing the Task-1 TS cases (document this in the fixture _comment update).

- [ ] **Step 1 (TDD)** → RED, **Step 2** implement+regenerate, **Step 3** shared suite green. Commit: `feat(shared): expanded paywall variables + fixture cases for overrides`.

---

### Task 3: Web renderer — overrides, cellTemplate, eligibility

**Files:** `packages/paywall-renderer/src/{renderer.tsx,nodes.tsx,types.ts}` (+tests).

Props += `eligibility?: Record<string, boolean>` (packageIdentifier → introEligible; absent → false). Rendering: every node passes through `applyOverrides` (from @rovenue/shared/paywall) with `{ introEligible: eligibilityOf(relevantPackage), selected: <cell is the selected one> }` before styling; `selected` is only ever true inside cellTemplate subtrees. packageList with `cellTemplate` renders the template per effective package inside the existing pressable cell wrapper (cell-scoped variables already plumbed); without → built-in cell (unchanged snapshot). Decoder side: the renderer consumes the strict-schema types from shared — lenient concerns don't apply on web (config arrives server-validated), but `applyOverrides` still skips unknown kinds defensively.

- [ ] TDD (override applied when eligible/selected; not applied otherwise; order; cellTemplate renders per package w/ cell-scoped `{{price}}`; new variables via priceView optional fields; backward-compat: no-override configs render byte-identically) → green + tsc. Commit: `feat(paywall-renderer): overrides, cell templates and eligibility`.

---

### Task 4: Swift — decoder + renderer for overrides/cellTemplate + new variables

**Files:** `packages/sdk-swift/Sources/Rovenue/PaywallUI/*` (+tests).

Decoder: `NodeOverride`/`OverrideCondition` (unknown kind → decodes to `.unknown` CONDITION retained-but-never-matching — NOT a config failure; malformed props in known kind → whole-config nil), `cellTemplate` on PackageListProps (recursive). `applyOverrides` Swift port (pure, tested against the SAME case matrix as Task 1's TS tests — copy the table). PackageView += the seven optional fields; `packageView(from:)` fills them from enriched StoreProduct (pricePerWeekString/introPrice; relativeDiscount per the spec formula); resolveVariables extended (absent → verbatim). Renderer: overrides applied with introEligible from `StoreProduct.isEligibleForIntroOffer ?? false`, selected inside cellTemplate cells; cellTemplate rendered per package inside the existing cell Button wrapper.

- [ ] TDD (fixture sections still green incl. new cases; override matrix; PackageView derivation; cellTemplate render via helper-level tests) → `swift test` green. Commit: `feat(sdk-swift): paywall overrides, cell templates and expanded variables`.

---

### Task 5: Kotlin — same as Task 4 for Android

**Files:** `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/*` (+tests). Mirror Task 4 exactly (JsonElement decoder gains overrides/cellTemplate with identical leniency; applyOverrides port; PackageViewMapping fills new fields from enriched StoreProduct; NodeViewFactory applies overrides + renders cellTemplate per cell). `./gradlew testDebugUnitTest` + `assembleRelease` green. Commit: `feat(sdk-kotlin): paywall overrides, cell templates and expanded variables`.

---

### Task 6: RN — same for React Native

**Files:** `packages/sdk-rn/src/paywall-ui/*` (+tests). Decoder + applyOverrides (may re-export shared's applyOverrides — sdk-rn bundles shared; the lenient model's unknown nodes never carry overrides so types align via a narrow adapter, else local port with the shared case table). Renderer: `eligibility` derived NATIVELY from `product.isEligibleForIntroOffer` on the offering (RN has enriched products — no prop needed; add optional prop override anyway for parity: `eligibilityOverride?`). cellTemplate per cell inside the existing Pressable. RN suite + tsc + tsup green. Commit: `feat(sdk-rn): paywall overrides, cell templates and expanded variables`.

---

### Task 7: Builder UI + API warning-code gate

**Files:** dashboard `components/paywall-builder/*` (properties-panel overrides section, layer-tree shows `cellTemplate` as a nested branch under packageList, add-node into cellTemplate, top-bar introEligible preview toggle, canvas passes eligibility/selected preview state); `apps/api/src/routes/dashboard/paywalls.ts` gate: blocking check becomes `issues.some(i => !WARNING_CODES.has(i.code))` with `WARNING_CODES = {LOCALE_KEY_GAP, OVERRIDE_SELECTED_OUTSIDE_CELL, INTRO_VARIABLE_UNGUARDED}` (+ test). tree-ops extended for cellTemplate paths (insert/remove/move inside it; pure tests).

- [ ] TDD tree-ops/gate; UI build green + pure-helper tests. Commit: `feat(dashboard): overrides and cell-template editing in the paywall builder`.

---

### Task 8: API — paywall_close + fallback export

**Files:** `apps/api/src/routes/v1/events.ts` (aggregate routing by `paywall_` prefix; superRefine requires paywallContext for `paywall_close` too; subscriber-resolution branch broadened to the prefix), extract the placements row-walk into `apps/api/src/lib/placement-resolution.ts` (`resolvePlacement(projectId, placement, attributes, locale)` returning the envelope `data`; route delegates — behavior byte-identical, existing 11 tests are the net), new `GET /dashboard/projects/:projectId/paywalls/fallback-export` (all ACTIVE placements resolved with `attributes = {}`, spec's file format, Content-Disposition; products-read capability) + export↔live parity integration test + close-event tests.

- [ ] TDD → green + tsc. Commit: `feat(api): paywall_close routing and fallback-file export`.

---

### Task 9: ClickHouse — event kind

**Files:** `packages/db/clickhouse/migrations/0020_paywall_event_kind.sql` (ALTER raw_paywall_events ADD COLUMN kind LowCardinality(String) DEFAULT 'view'; recreate `mv_paywall_events_to_raw` extracting kind from the shaped message; recreate `mv_paywall_daily` filtering `kind = 'view'` — BOTH with the pause-consumer header note), dispatcher `shapePaywallEventMessage`: kind from eventType suffix + kind joins the deterministic-id hash input (documented: in-flight old-format retries across the deploy may double once — acceptable), verify inventory, extend `outbox-dispatcher-paywall-shaping.test.ts` + the CH round-trip test with a `paywall_close` row.

- [ ] TDD → migrate+verify green via testcontainers round-trip (local CH env known-broken; harness is the gate). Commit: `feat(db): paywall event kind column and close-event ingestion`.

---

### Task 10: Core — fallback file + resolve ladder

**Files:** `packages/core-rs/src/placements/{fallback.rs,client.rs,mod.rs}`, UDL (`set_fallback_placements(string json)` throws on bad format/version returning count; `CorePaywall.served_from_fallback boolean`), façades: Swift `setFallbackPlacements(fileURL:)`+`(json:)`, Kotlin `(json:)`+context-asset overload, RN `setFallbackPlacements(json)` through the bridge (+DTO field `servedFromFallback`).

Ladder in `get_paywall`: network → cache → fallback (parse-once at set time, held in memory keyed by placement identifier; entries decode through the EXISTING PlacementsResponse path) → propagate original error / None. Cache always beats fallback. Experiment entries: draw + expose exactly as live (deterministic).

- [x] TDD (format-version reject w/ distinct error; ladder order; cache-beats-fallback; draw determinism from fallback; served_from_fallback flags) → cargo+fmt+clippy, bindings regen, all façade gates. Commit: `feat(sdk): bundled fallback placements file`.

---

### Task 11: Core — durable paywall-event queue

**Files:** `packages/core-rs/src/events/queue.rs` (+cache repo lane), UDL (`enqueue_paywall_event(envelope_json)`, drain wiring on configure/foreground/enqueue — single in-flight, peek→POST→delete-on-2xx, keep on 5xx/network, bound 100 drop-oldest), façades: `logPaywallShown`/NEW `logPaywallClosed` switch from inline `track()` to the queue (all four surfaces; renderers' auto-calls included — Swift/Kotlin/RN renderer close paths emit `paywall_close`).

- [ ] TDD (kill-safety: enqueue → new store instance → drain posts; 5xx retains; 2xx deletes; bound; single-flight) → all gates. Commit: `feat(sdk): durable at-least-once paywall event queue + logPaywallClosed`.

---

### Task 12: D5 — attributed variant conversions

**Files:** `apps/api/src/services/analytics-router.ts` (experiment_results += `attributed_conversions` via raw_revenue_events experimentKey/variantId — query-time only), `computeExperimentResults` passthrough, dashboard experiment results component shows "attributed" column for PAYWALL-type experiments (others unchanged) + i18n.

- [ ] TDD (query-shape/mocked + CH round-trip extension if cheap) → green. Commit: `feat(analytics): attributed variant conversions for paywall experiments`.

---

### Task 13: Docs + checkoff

Docs guide: fallback setup per platform, overrides/cellTemplate authoring, new variables table, paywall_close/logPaywallClosed, attributed conversions note. CLAUDE.md placements line touch-up. Plan checkoffs (leave Verification). `pnpm --filter docs build` green. Commit: `docs: paywall Phase D guide updates`.

---

## Verification (after all tasks)

- [ ] `pnpm build --force` green; shared / renderer / dashboard / api suites
- [ ] cargo test+fmt+clippy; bindings regen clean, none committed
- [ ] swift test; `./gradlew testDebugUnitTest`; RN vitest+tsc+tsup
- [ ] CH testcontainers round-trip (kind column) — local CH env still known-broken, harness is authoritative
- [ ] No B3-owned file touched: `git diff --stat <base>..HEAD` contains no funnel/checkout paths
