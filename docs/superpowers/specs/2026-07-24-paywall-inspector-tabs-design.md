# Paywall Inspector Tabs (P5a) Design

**Date:** 2026-07-24
**Status:** Proposed. Feeds a writing-plans implementation plan.
**Phase:** P5a of the paywall-builder redesign (`docs/superpowers/specs/2026-07-23-paywall-builder-gap-analysis.md` §4 row D). P0–P3 shipped; P4a was already done in Phase D.
**Design source:** Claude Design project `008cf05d-86d0-4f88-bf69-3802297259d1` — `paywall_inspector.jsx`.

---

## 1. What P5 actually is, after checking

The gap analysis describes row D as: *"Layout / Style / Content / Binding / Visibility; per-tab dot indicators; per-element font; visibility = platform ∪ min/max app version ∪ audience segment"* against *"one 914-line properties panel; no visibility model at all"*.

Verified against the repo before writing this:

- `properties-panel.tsx` is **exactly 914 lines** — the count is current, not stale.
- `visibility`, `minAppVersion` and `maxAppVersion` appear **nowhere**: not in `packages/shared/src/paywall/`, not in any of the four renderers, not in `render-fixtures.json`. This is greenfield, with no partial implementation to reconcile.

Three parts of row D are **not** in this phase, and two of them are not buildable as written:

| Part | Status |
|---|---|
| Binding tab's "Resolved live from catalog" readout (price, per-month, trial) | **Blocked.** It depends on §6.11 `GET /offerings/:id/resolved`, which P1 established cannot exist: products carry no server-side price, period or trial — that data lives only in the store. Same broken dependency as P6. The Binding tab ships with the fields that *do* exist. |
| Audience-segment visibility | **Already decided against** (gap analysis §8 decision 3): segment targeting stays at the placement level, which already walks ordered audience rows server-side. The Visibility tab links out to placement audience rows instead of offering a segment dropdown. Documented divergence from the mock. |
| Per-element font | **P10** (gap analysis row K), which depends on this phase. |

What remains is genuinely large — shared schema + validator + **four renderers** + `render-fixtures.json` + the panel split — so it is two phases:

- **P5a (this spec):** the tab shell and the panel split. Dashboard only. No schema, no wire, no renderer change.
- **P5b:** `visibility { platform, minAppVersion, maxAppVersion }` on every node — shared schema, validator, four renderers, fixtures, and the fifth tab's contents.

P5a first because the Visibility tab needs somewhere to live, and because P5a carries zero cross-platform risk while P5b carries all of it.

---

## 2. Goal & scope

Turn one 914-line panel into a tabbed inspector, so a selected node's configuration is navigable instead of a single scroll.

**In scope:** the tab strip and its model; splitting `properties-panel.tsx` into per-tab modules plus a shared field library; per-tab issue indicators; the selected tab surviving node selection.

**Out of scope:**
- `visibility` in any form — P5b.
- Per-element font — P10.
- The resolved-catalog readout — blocked upstream.
- **Any change to what a field does.** Every input keeps its exact current semantics, key and value handling. This phase moves code and adds navigation; a behavioural change smuggled in during a move is the main risk it carries.
- No schema, API, DB, wire or renderer change.

**Success criteria**
1. Selecting a node shows only the tabs that apply to it, in a stable order.
2. Every field reachable before is still reachable, does the same thing, and writes the same config.
3. A node with a validation issue shows a dot on the tab that holds the offending field.
4. Switching selection keeps the current tab when it applies to the new node, and falls back predictably when it does not.
5. `properties-panel.tsx` is a shell; no module in the inspector exceeds ~250 lines.

---

## 3. The tab model

### Which tabs a node gets

The mock shows five fixed tabs. A `spacer` has no content, no binding and nothing to style — three of five would be empty. **Tabs are therefore filtered to those that apply to the selected node type**, in a fixed order. Deliberate divergence from the mock: an empty tab is a dead end, and the strip already changes with selection because the node changes.

Order is stable (`Layout → Style → Content → Binding`), so muscle memory is about sequence rather than absolute position.

### One table, no second source of truth

The funnel builder's `TABS` array carries a `pip?: boolean` flag while the component hardcodes what actually drives the dot (`Object.keys(vm.rules).length > 0`). That is two places to keep in step, and the tab table ends up describing a capability rather than a rule. This phase does not copy that.

Each tab declares everything about itself:

```ts
export interface InspectorTab {
  id: InspectorTabId;
  /** i18n key suffix; the label is `t(\`paywalls.builder.inspector.tab.${id}\`, fallback)`. */
  fallbackLabel: string;
  /** Node types this tab has anything to say about. */
  appliesTo: ReadonlySet<PaywallNode["type"]>;
  /** Issue codes whose offending field lives on this tab. */
  issueCodes: ReadonlySet<string>;
}

export const INSPECTOR_TABS: readonly InspectorTab[] = [ /* … */ ];
export type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];
```

`InspectorTabId` is derived from the table, the same way `PresetId` is derived from `PRESETS` — adding a tab needs no type edit and no component edit.

### What the dot means

**A dot means this tab holds a validation issue for the selected node** — not "you changed something here". A dot that routes attention to a problem is actionable; a dot that says "this was customised" is decoration, and the author already sees their own values.

Mapping is explicit, per tab:

| Tab | Issue codes | because the offending field is |
|---|---|---|
| Content | `UNKNOWN_LOC_KEY`, `EMPTY_LOC_VALUE` | the node's localized text key |
| Binding | `FOREIGN_PACKAGE_ID` | `packageIds` / `defaultSelected` |
| Layout | — | |
| Style | — | |

`cellTemplate` and `cellLayout` sit on **Layout**, not Binding: they decide how the list draws each cell. Binding is only "which commerce data does this node point at" — `packageIds` and `defaultSelected`.

**`CELL_TEMPLATE_BAD_NODE` gets no dot, correcting an earlier draft of this table.** It looked like it followed `cellTemplate` onto Layout, but the validator attaches its `nodeId` to the **offending** node — a `packageList` or `purchaseButton` sitting inside the template — not to the `packageList` that owns it. So there is no field on the named node to point at; the fault is where the node sits, which puts it in the same family as `MISSING_PURCHASE_BUTTON`. Mapping it to Layout was also worse than useless: a `purchaseButton` has no Layout tab, so the dot was computed and then silently dropped.

Codes with no tab get no dot: `DUPLICATE_NODE_ID` is not a field, `MISSING_PURCHASE_BUTTON` is a property of the tree rather than of any node, `LOCALE_KEY_GAP` is per-locale rather than per-node, and `OVERRIDE_BAD_PROP` / `OVERRIDE_SELECTED_OUTSIDE_CELL` belong to Overrides, which is deliberately outside the tab strip (§4). Those already surface in the validation drawer, which stays the complete list. The inspector dot is a pointer, not a second issue system — it must never be the only place an issue appears.

Severity follows the existing model: a dot is danger when any of the tab's issues is publish-blocking, warning otherwise. It reuses `isPublishBlockingIssue`; it does not reimplement severity.

### Where the selected tab lives

In the view model, so it survives selecting another node — an author styling several nodes in a row should not be thrown back to Layout on every click. On selection change, if the current tab does not apply to the new node, fall back to that node's **first applicable tab** rather than a fixed default, so the fallback is always meaningful.

---

## 4. File structure

`properties-panel.tsx` becomes a shell that renders the strip and delegates. The split is a **transpose**: today the file is organised per node type (`StackEditor`, `TextEditor`, …); the tabs cut across types. Each tab module owns "what goes in this tab, for whatever node is selected", which is the question the product now asks.

```
paywall-builder/inspector/
  tabs.ts            — INSPECTOR_TABS, InspectorTabId, tabsForNode(), tabIssues()
  tabs.test.ts
  fields.tsx         — Section, Field, Segmented, NumberField, MiniNumber,
                       SizeField, PaddingField, AlignField, ThemeColorField,
                       LocalizedTextField  (moved verbatim)
  layout-tab.tsx     — axis, spacing, padding, size, alignment
  style-tab.tsx      — colors, corner radius, text role, button style
  content-tab.tsx    — localized text keys, image url, labels
  binding-tab.tsx    — packageIds, defaultSelected, cellLayout, cellTemplate, button action
  overrides.tsx      — OverridesSection + OverrideRow + OverridePropField (moved verbatim)
```

**Overrides stays outside the tabs**, as a persistent section below the strip. It applies to every node type, it is not one of the mock's five categories, and burying it in a tab would hide a feature that already ships. This is a decision, not an oversight.

The field primitives move **verbatim**. They are the part most likely to acquire a silent behaviour change during a move, and they are also the least interesting to rewrite.

---

## 5. Testing

The panel is presentational; the testable surface is the pure tab model.

- `tabsForNode(type)` — returns the applicable tabs in table order; a `spacer` gets fewer than a `packageList`; every node type gets at least one.
- **Total coverage** — every field that exists today lands on exactly one tab. A test asserting that the union of the tabs' field sets covers each node type's editable props would be the real guard, but there is no machine-readable list of "editable props per type" to diff against, so this is verified by review against the pre-split file rather than by a test that would merely restate the tab table. Say so rather than writing a tautology.
- `tabIssues(issues, nodeId)` — groups a node's issues by tab; unmapped codes appear on no tab; severity is derived via `isPublishBlockingIssue`, not reimplemented.
- Tab fallback — when the current tab does not apply to a newly selected node, the first applicable tab is chosen.
- The existing paywall-builder suite must stay green, which is what pins "no field changed behaviour".

---

## 6. Global constraints

- TypeScript strict. Dashboard only — no schema, API, DB, wire or renderer change.
- **No magic values.** The tab table is structured data, not a magic value; sizes and z-layers get named constants.
- Every user-facing string via `t(key, "English fallback")`, with the key added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- **Field semantics are frozen.** Moved code is moved, not rewritten. Any behaviour change found necessary during the move is a finding to report, not a change to make.
- Follow the existing dashboard idiom: `rv-*` tokens, `cn()`, `lucide-react`, `component()` + `useService`.
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 7. Follow-ons

- **P5b** — `visibility` on every node: shared schema, validator, four renderers, `render-fixtures.json`, and the Visibility tab, whose audience section is a link out to the placement's audience rows.
- **P10** — per-element font, in the Style tab.
- The Binding tab's resolved-catalog readout, if the store-side data ever becomes reachable server-side.
