# Paywall Save Gate Scope (P2-fix II) Design

**Date:** 2026-07-24
**Status:** Proposed. Feeds a writing-plans implementation plan.
**Trigger:** The P2-fix final review logged an "observation": switching the default locale to a fresh, empty locale makes every autosave 400 — the same lost-work failure as C1, different trigger. Probing that observation showed it is not one stray case.

---

## 1. The defect

The builderConfig PATCH route — the endpoint the builder autosaves through — rejects any config carrying a `save`-tier validator issue. That gate is running **publish-grade validation**. Several ordinary authoring actions produce a `save`-tier issue, and from that moment every autosave returns 400 until the author happens to undo it.

Measured against the real `validateBuilderConfig` (each row is a config a person can reach from the builder UI):

| What the author did | Issue | Blocks save today | Reachable in |
|---|---|---|---|
| Added a package list; hasn't added the purchase button yet | `MISSING_PURCHASE_BUTTON` | **yes** | **one click** |
| Deleted the purchase button to replace it | `MISSING_PURCHASE_BUTTON` | **yes** | one click |
| Switched the paywall's offering; the old package ids are now foreign | `FOREIGN_PACKAGE_ID` | **yes** | one click |
| Switched the default locale to a locale they just added | `UNKNOWN_LOC_KEY` | **yes** | two clicks |
| Added a package list inside a `cellTemplate` subtree | `CELL_TEMPLATE_BAD_NODE` | **yes** | two clicks |

The add-node palette (`add-node-popover.tsx`) is a flat list of all seven node types, so `packageList` can be added alone. `layer-tree-flatten.ts` includes `cellTemplate` subtrees, so nodes can be added inside one.

### Why this is worse than it looks

`autosave()` has no pre-flight check: it PATCHes unconditionally and, on the throw, only sets `autosaveStatus = "error"`. `lastSavedSnapshot` never advances. There is no `beforeunload` and no unmount flush. So the author keeps working — laying out nodes, moving things, writing copy — while nothing is being persisted, and closing the tab discards all of it.

`AutosaveBadge` reports this as **"Save failed — retrying"**, which is false for a permanent 400, and `clearAutosaveError` flips the badge back to "saving" on the next mutation, so the red state is easy to miss.

### This is the same bug C1 was

C1 (a blank default-locale string blocking the save) was fixed by moving that one condition to a publish-only tier. That fix was correct but treated the symptom. The cause is that the save gate and the publish gate were never given different jobs: `prepareBuilderConfigPatch` and the publish route both ask "is this config good?", when they should be asking two different questions.

---

## 2. The principle

> **The save gate protects what the system needs to store and address a draft. The publish gate protects what a device needs to render and transact. Completeness and coherence are publish concerns.**

A draft is work in progress by definition. Refusing to persist it because it is incomplete inverts the purpose of a draft. And nothing incomplete can leak to a device: `/v1/placements` and the fallback export both resolve through `paywallVersions` by `publishedVersionId` and never read the draft — verified in the P2-fix final review.

### Tier assignment

**Stays `save` — the draft would be unstorable or unaddressable:**

| Code | Why it must still block |
|---|---|
| `SCHEMA_INVALID` | Not a valid config at all; emitted by the Zod parse before `validateBuilderConfig` runs. |
| `DUPLICATE_NODE_ID` | `tree-ops` addresses nodes by id. With a duplicate, `findNode`/`updateNode`/`removeNode` are ambiguous, so the builder's own next edit would corrupt the tree. This one is also not reachable from the UI — the builder generates ids — so blocking it costs an author nothing and guards against a corrupt payload. |

**Moves to `publish`:**

`UNKNOWN_LOC_KEY`, `FOREIGN_PACKAGE_ID`, `MISSING_PURCHASE_BUTTON`, `CELL_TEMPLATE_BAD_NODE`, `OVERRIDE_BAD_PROP`
(joining `EMPTY_LOC_VALUE`, already there.)

Notes on the two less obvious ones:
- `CELL_TEMPLATE_BAD_NODE` — a `packageList` nested inside a cell template would be nonsense to render, but it is never rendered until published, and the four renderers decode leniently. Storing it is harmless; shipping it is not.
- `OVERRIDE_BAD_PROP` — the strict authoring schema already rejects a non-whitelisted override prop at parse time, so the PATCH path answers `SCHEMA_INVALID` before this code is ever reached. Moving it changes nothing on the save path and keeps the tier table consistent with the principle rather than carving out an exception nobody can observe.

**Warnings are unchanged:** `LOCALE_KEY_GAP`, `OVERRIDE_SELECTED_OUTSIDE_CELL`, `INTRO_VARIABLE_UNGUARDED`.

### The UI does not change

`errorIssues` is `validationIssues.filter(isPublishBlockingIssue)`, and every code moving here is already non-warning. So the drawer's error list, the top bar's red count and `canPublish` behave exactly as they do today. Only the save gate loosens. That is the whole point: the author still sees "3 errors — fix these before publishing", but their work keeps being saved while they fix them.

---

## 3. What a permanent save failure means afterwards

After the retier, the only issues that can 400 the PATCH are `SCHEMA_INVALID` and `DUPLICATE_NODE_ID` — both of which mean **the builder produced something invalid**, i.e. a bug in our code, not a state the author chose. That makes the badge honestly reportable for the first time:

- **Retryable** — network failure, 5xx, an aborted request. "Save failed — retrying" is true.
- **Permanent** — a 4xx from the write path. Retrying cannot help. The badge must say so and stop implying a retry is in flight.

`clearAutosaveError` must stop laundering a permanent failure into "saving" on the next keystroke. A permanent failure stays visible until a save actually succeeds.

## 4. Not losing the last edits

Even with permanent 400s gone, autosave is throttled at 30s, so a tab closed mid-window loses whatever changed since the last successful save. Two additions:

- **Unmount flush** — when the builder unmounts (closing the builder, navigating away), fire a final save if `isDirty`.
- **`beforeunload` guard** — if `isDirty` when the tab/window is closing, prompt the browser's "leave site?" dialog (`preventDefault()` + `returnValue`). **No save is attempted here**, and that is deliberate: `navigator.sendBeacon` was the obvious candidate and does not work in this architecture. The API is a separate origin (`API_BASE_URL` comes from `VITE_API_URL`), and a JSON body makes the beacon a non-simple cross-origin request, so it needs a CORS preflight — which browsers drop unreliably during unload. A beacon that silently fails is worse than an honest prompt.

  The unmount flush is what actually saves work, and it covers the common case (closing the builder, navigating within the app). The `beforeunload` prompt covers the rest by handing the decision to the person, which is the only guarantee available. Do not claim a guarantee the browser does not give — the requirement is "flush on unmount, prompt on unload", not "never loses data".

---

## 5. Scope

**In scope:** the tier reassignment and its tests; the API regression tests for each reachable authoring state; the badge's permanent-vs-retryable distinction; the unmount flush and `beforeunload` guard.

**Out of scope:**
- Pruning orphaned localization keys, and an "unused strings" matrix section.
- M5 (`viaOverride` is first-usage-wins) and M6 (the layer tree excludes `fallback` subtrees a matrix jump can select).
- Any change to what the publish gate rejects. Publish strength must be **identical** before and after.
- No DB change, no migration, no SDK/wire change.

**Success criteria**
1. From a blank paywall, adding only a package list autosaves successfully and shows a publish-blocking error.
2. Switching the offering so existing package ids become foreign autosaves successfully; publish is blocked.
3. Switching the default locale to a freshly added empty locale autosaves successfully; publish is blocked.
4. Publishing any of those three is rejected with `PAYWALL_NOT_PUBLISHABLE`.
5. A config with a duplicate node id is still rejected by the PATCH route.
6. Closing the builder with unsaved changes persists them.
7. A permanent 400 is reported as permanent, and does not revert to "saving" on the next edit.

---

## 6. Testing

The lesson from C1 is that validator-level assertions miss gate bugs, because the gate is where the two severities are read. So:

- **`packages/shared`** — the tier table: each moved code is `publish`; `DUPLICATE_NODE_ID` and an unclassified code are `save`. Assert `isPublishBlockingIssue` is unchanged for **every** code — that is the invariant protecting publish strength.
- **`apps/api`, through the real routes** — one case per row of the §1 table: PATCH the config, assert **200**; then publish it, assert **400 `PAYWALL_NOT_PUBLISHABLE`** naming the same code. Plus the negative: a duplicate-node-id config still 400s on PATCH.
- **`apps/dashboard`** — `canPublish` stays false for each of those configs (the author is still told they cannot publish); the autosave state machine reports a 4xx as permanent and a 5xx/network failure as retryable, and a permanent failure survives a subsequent edit.

The dashboard autosave tests must drive the view model's real error path with a rejecting `patchBuilderConfig`, not assert on a hand-set `autosaveStatus`.

---

## 7. Global constraints

- TypeScript strict. Responses `{ data }` / `{ error }`.
- Spans `packages/shared/`, `apps/api/` and `apps/dashboard/` by design — a change to the shared severity model is a cross-consumer change.
- **No magic values** — issue codes and the severity table are structured data; timeouts and thresholds get named constants.
- Every user-facing string via `t(key, "English fallback")`, with the key also added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- No DB change, no migration, no SDK/wire change.
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 8. Follow-ons (deferred)

- Orphaned localization keys: pruning on node delete, or an "unused strings" section with a delete affordance.
- M5 / M6 from the P2 review.
- A builder-side guard that stops the author reaching `DUPLICATE_NODE_ID` at all (today it is unreachable, but nothing enforces that).
