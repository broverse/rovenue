# Paywall Phase D — Offline Fallback, Conditions, Variables, Events, Variant Results

Date: 2026-07-22
Status: approved scope (continuation of Phases A/B/C; cut chosen from the
accumulated non-goal pool — conversion- and reliability-critical items only)

## Overview

Phase D hardens the paywall product where it touches production reliability
and conversion mechanics:

- **D1 — Bundled fallback file:** first-launch-offline coverage (disk cache
  can't help when there is no cache yet) — Adapty parity.
- **D2 — Conditions/overrides:** intro-offer-eligibility and selected-state
  styling — the RC conversion levers ("Free trial" badge only for eligible
  users, selected-cell highlighting driven by config, not renderer
  hard-coding).
- **D3 — Variable expansion:** normalized prices (`{{pricePerWeek}}` …),
  intro-offer variables, `{{relativeDiscount}}`.
- **D4 — Event completion:** `paywall_close` + a durable (process-kill-safe)
  impression queue.
- **D5 — Variant conversion in experiment results:** surface the precise
  attribution 0019 already collects.

**Out of scope / owned elsewhere:** everything B3 (web checkout, funnel
payment, wiring server-side Stripe prices into the web renderer's
`priceView`) belongs to the parallel B3 workstream — this spec makes NO
changes to funnel routes, checkout flows, or `priceView` semantics. All
Phase-D wire changes are strictly additive so the B3 branch cannot conflict
on shapes.

### Cross-cutting rules (inherited, binding)

- Platform-decoder contract changes are pinned by
  `packages/shared/src/paywall/render-fixtures.json` and must land on ALL
  FOUR platforms (TS web, Swift, Kotlin, RN) with fixture cases in the same
  change. The fixture is extended ADDITIVELY via the TS generator procedure.
- Forward compatibility over strictness in *renderers*: unknown override
  condition kinds are SKIPPED (that override entry ignored), never a
  whole-config failure — mirroring the unknown-node→fallback rule. The
  AUTHORING schema stays strict (unknown condition kinds rejected at write
  time).
- Any ClickHouse migration that recreates a Kafka-fed MV carries the
  pause-consumer/backfill deploy note (0015/0019 precedent).
- Wire fields are only ever ADDED, never renamed/removed.

---

## D1 — Bundled fallback file

**Problem:** a fresh install with no network gets `null` from
`get_paywall` — no cache exists yet. Adapty solves this with a bundled
per-app fallback JSON.

**File format** (exported from the dashboard, committed into the app bundle
by the customer):

```jsonc
{
  "formatVersion": 1,
  "generatedAt": 1753190000000,          // unix ms, arbitration key
  "projectId": "prj_…",                  // sanity check only, never trusted
  "placements": {
    "onboarding_end": { /* byte-identical /v1/placements envelope `data` */ },
    "settings_upsell": { /* … */ }
  }
}
```

- Each entry is the **anonymous resolution** of that placement (row walk
  executed server-side at export time with empty attributes — exactly what
  an anonymous SDK user would receive). Audience-targeted rows that require
  attributes therefore fall through to the catch-all, which is the honest
  offline approximation.
- Experiment targets are included as the full weighted variant list — the
  client-side deterministic draw means **A/B stickiness survives even when
  serving from the fallback file** (same subscriberId + experiment key ⇒
  same variant), with the exposure beacon fired best-effort as usual.
- Reusing the live envelope shape means the SDK decode path is the existing
  `PlacementsResponse` — no second parser.

**Export:** `GET /dashboard/projects/:projectId/paywalls/fallback-export`
(products:read-level capability) → `Content-Disposition` download
`rovenue-fallback.json`. Includes every ACTIVE placement. Dashboard button
on the placements list page.

**SDK surface:**

- Core: `set_fallback_placements(json: String) -> Result<u32>` (returns the
  number of placements loaded; rejects on formatVersion ≠ 1 or unparseable
  file with a distinct error so integrators see misconfiguration
  immediately — fail-loud at configure time, fail-open at resolve time).
  File **reading** stays platform-side; the core receives the string.
- Resolve ladder becomes: network → disk cache → **fallback file** → None/
  error. Arbitration between cache and fallback: the disk cache, when
  present, always wins (it is by definition newer than a bundled file —
  `generatedAt` is recorded for diagnostics/logging only in v1).
- Façades: Swift `Rovenue.shared.setFallbackPlacements(fileURL:)` (reads +
  forwards), Kotlin `Rovenue.setFallbackPlacements(context, rawRes/asset)`
  overloads + a plain `(json: String)`, RN `setFallbackPlacements(json:
  string)` (JS reads the bundled asset via the host app's own mechanism).
- Events: serving from fallback stamps `presented_context` as usual;
  a `source: "fallback"` boolean rides CorePaywall (`served_from_fallback`)
  for host diagnostics — additive field, façades expose it.

**Testing:** core tests (ladder order incl. cache-beats-fallback, version
mismatch → distinct error, experiment draw determinism from fallback);
export endpoint integration test (anonymous resolution parity with a live
`/v1/placements` call for the same placement); façade pass-through tests.

---

## D2 — Conditions / overrides

**Schema (authoring, strict):** every node gains optional

```jsonc
"overrides": [
  { "when": { "kind": "introEligible" },            // selected/cell package is intro-offer eligible
    "props": { /* sparse subset of the node's own visual props */ } },
  { "when": { "kind": "selected" },                  // valid ONLY inside packageList cell subtrees
    "props": { … } }
]
```

- Phase-D condition kinds: `introEligible`, `selected`. Nothing else (no
  size classes, no arbitrary expressions).
- **Prerequisite — cell templating:** today's `packageList` cells are
  renderer-built (name + price), not config subtrees, so a `selected`
  condition would have nothing to attach to. `packageList` therefore gains
  an optional `cellTemplate: Node` — a subtree rendered once per effective
  package with CELL-SCOPED variables (the plumbing all four renderers
  already have via `cellPackage`); absent → the current built-in cell,
  fully backward compatible. Cells with a template remain selectable as a
  whole (the renderer wraps the template in the pressable cell container).
  `purchaseButton`/`packageList` nodes are invalid inside `cellTemplate`
  (validator: `OVERRIDE_BAD_PROP`-style structural error
  `CELL_TEMPLATE_BAD_NODE`).
- Overridable props: the node's own OPTIONAL visual fields only (`color`,
  `background`, `cornerRadius`, `align`, `spacing`, `style`, and text/button
  `key`/`labelKey` — so badge copy can change per state). Structural fields
  (`type`, `id`, `children`, `packageIds`, `action.kind`) are NOT
  overridable — the strict schema rejects them.
- Application order: base props, then matching overrides in array order
  (later wins), shallow per-field.
- Validator additions: `OVERRIDE_BAD_PROP` (structural field in props),
  `CELL_TEMPLATE_BAD_NODE` (packageList/purchaseButton inside a
  cellTemplate), `OVERRIDE_SELECTED_OUTSIDE_CELL` (a `selected` condition on
  a node outside any `cellTemplate` subtree — warning-severity like
  LOCALE_KEY_GAP, since renderers simply never match it there).
- **Renderer leniency:** unknown `when.kind` → skip that override entry
  (fixture-pinned on all four platforms). Malformed `props` inside a KNOWN
  kind → whole-config decode failure (strict-known rule).

**Eligibility source:** native renderers read
`StoreProduct.isEligibleForIntroOffer` (already on the enriched product,
all platforms). The web renderer gains an optional
`eligibility?: Record<packageIdentifier, boolean>` prop (additive; absent →
`introEligible` never matches). The builder preview gets an
eligible/ineligible toggle in the top bar.

**Builder:** properties panel gains an "Overrides" section per node
(add/remove override, condition picker limited to the two kinds, props
sub-form reusing the node's own editors). Preview honors overrides live
(selected-state visible by clicking cells; introEligible via the toggle).

---

## D3 — Variable expansion

`PackageView` gains OPTIONAL pre-formatted string fields (absent → the
variable stays verbatim, signalling unconfigured — consistent with the
unknown-variable rule):

| variable | source (native) | source (web) |
|---|---|---|
| `{{pricePerDay}}` / `{{pricePerWeek}}` / `{{pricePerMonth}}` / `{{pricePerYear}}` | enriched `StoreProduct.pricePerWeekString` etc.; per-day derived from per-week/7 only when a numeric price exists, else omitted | optional `priceView` fields |
| `{{introPrice}}` / `{{introPeriod}}` | `StoreProduct.introPrice` | optional `priceView` fields |
| `{{relativeDiscount}}` | computed per platform: `round((1 − pricePerYearEquivalent/maxPricePerYearEquivalent) × 100)`% across the offering's packages with numeric prices; omitted when fewer than 2 comparable packages | same, from numeric fields when supplied |

- `resolveVariables` implementations on all four platforms extend their
  variable tables; fixture `variables` vectors extended additively
  (including absent-optional-field → verbatim cases).
- The editor's variable-insert helper (if/when built) is out of scope; the
  docs list the full table.
- Guardrail from RC's design: intro variables are only *meaningful* under an
  `introEligible` override; the validator emits a warning-severity
  `INTRO_VARIABLE_UNGUARDED` when `{{introPrice}}`/`{{introPeriod}}` appear
  in text NOT guarded by an introEligible override (renderers still render —
  verbatim-or-value — this is an authoring lint, not a runtime rule).

---

## D4 — Event completion

**`paywall_close`:**
- Renderers emit it automatically when the close action fires (all four),
  carrying the same `paywallContext`; remote-config integrators get a public
  `logPaywallClosed(paywall)` sibling of `logPaywallShown`.
- Server: `deriveAggregateType` routes any `eventType` starting with
  `paywall_` to `PAYWALL_EVENT`; the envelope superRefine requires
  `paywallContext` for `paywall_close` exactly as for `paywall_view`; the
  paywall_view-only subscriber-resolution branch in `/v1/events` broadens to
  the `paywall_` prefix.
- ClickHouse: `raw_paywall_events` += `kind LowCardinality(String) DEFAULT
  'view'`; the dispatcher maps `paywall_view → 'view'`, `paywall_close →
  'close'`; `mv_paywall_events_to_raw` recreated with the new column and
  `mv_paywall_daily` recreated to filter `kind = 'view'` (views/uniques keep
  their meaning; close-rate is a query-time metric). **Both recreates carry
  the pause-consumer deploy note.** Deterministic event id gains the kind in
  its hash input so a view and a close from the same client eventId don't
  collide.

**Durable impression/close queue (replaces fire-and-forget):**
- Core gains a small persistent envelope queue in the existing cache store
  (bounded at 100 entries, drop-oldest), drained with the session-telemetry
  discipline: peek → POST `/v1/events` → delete on 2xx; 5xx/network keeps
  the entry (at-least-once; server-side CH dedup already keys on the
  deterministic event id, so replays are safe).
- `logPaywallShown`/`logPaywallClosed` (and the renderers' auto-calls)
  enqueue instead of posting inline. Drain triggers: configure, foreground,
  and after each enqueue (single in-flight drain).

---

## D5 — Variant conversion in experiment results

- `experiment_results` gains an `attributed_conversions` column: `uniq
  (subscriberId)` from `raw_revenue_events` where `experimentKey` = the
  experiment's key AND `variantId` = the variant (purchase-class types),
  alongside the existing post-exposure heuristic `conversions` (which
  remains the only signal for non-paywall experiment types — OFFERING/FLAG
  purchases don't carry presentedContext).
- Dashboard experiment results: PAYWALL-type experiments display attributed
  conversions (labeled "attributed"); other types keep the heuristic column
  as today. No MV changes — both are query-time reads.

---

## Testing summary

- Fixture: additive regeneration (overrides accept/reject cases incl.
  unknown-condition-skip and structural-prop rejection; new variable
  vectors) → all four platform suites updated in the same change.
- Core: fallback ladder, queue drain semantics (kill-safe: enqueue survives
  a simulated restart — new store, same DB), close/view id divergence.
- API: export-endpoint parity test, `paywall_close` envelope + routing,
  broadened subscriber resolution.
- CH: round-trip incl. `kind` column via the existing testcontainers
  harness; verify inventory updated.
- Full four-platform gates as usual (vitest / swift test /
  testDebugUnitTest / RN vitest, cargo fmt+clippy).

## Non-goals (Phase D)

- Component-interaction events; segment-hash CDN caching of personalized
  responses; cross-placement A/B; scheduled targeting rows; min-SDK
  targeting rules; size-class/responsive conditions.
- Editor UX polish (undo/redo, drag-drop, template gallery, asset upload,
  AI); authoring per-node `fallback` in the builder.
- Compose wrapper module; npm-publishing the web renderer; RN native
  presentation bridge.
- Anything touching funnel routes, checkout, or `priceView` *wiring*
  (B3 workstream) — D3 only ADDS optional fields the B3 branch may choose
  to populate.
