# Paywall Localization Severity Split (P2-fix) Design

**Date:** 2026-07-23
**Status:** Approved approach ("split the code: absent vs blank"). Feeds a writing-plans implementation plan.
**Phase:** Corrective phase for P2 (`docs/superpowers/specs/2026-07-23-paywall-localization-matrix-design.md`).
**Trigger:** P2's independent final review (run late, after P3) — findings C1 (Critical), I2 and I3.

---

## 1. The defect

P2's commit `4eb68dde` changed the localization predicate so that a **blank** string counts as
missing, not just an **absent** one:

```ts
export function isMissingLocaleValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}
```

The spec and the plan both reasoned about this as a **publish** gate. It is not. `isBlockingIssue`
is consulted in two places in the API, and the first is the **PATCH write path the builder
autosaves through**:

| `apps/api/src/routes/dashboard/paywalls.ts` | gate |
|---|---|
| `:207` — `prepareBuilderConfigPatch` | **save** (every autosave) |
| `:494` — the publish route | publish |

`isBlockingIssue`'s own doc comment has always said *"True when an issue must block the save"*, and
`UNKNOWN_LOC_KEY` has always been in the blocking set. That was correct while the code meant "the
key is absent from the default locale" — a genuinely broken config. P2 widened it to also mean
"the key is present but blank", which is a **normal in-progress authoring state**.

Confirmed by running the real validator (`{ en: { title: "Hi", fresh: "" }, de: {…} }`, two text
nodes): `UNKNOWN_LOC_KEY` + `LOCALE_KEY_GAP`, `issues.some(isBlockingIssue) === true`. The same
config produced **no issues at all** before `4eb68dde`.

### Why it matters

`registerFreshLocKeys` stubs a new key as `""` in *every* locale the moment a text/button node is
added. So from the first text node onward every autosave 400s. `autosave()` has no pre-flight
check — it PATCHes unconditionally and only sets `autosaveStatus = "error"` on the throw.
`lastSavedSnapshot` never advances, and there is no `beforeunload` or unmount flush.

An author who lays out the tree first and writes copy second — an ordinary workflow — loses every
structural change since their last successful save when the tab closes. Separately, an existing
paywall carrying one deliberately-blank default string can no longer be saved *at all*, even for
an unrelated colour change.

The badge compounds it: `AutosaveBadge` renders "Save failed — retrying" for what is a permanent
400, and `clearAutosaveError` flips it back to "saving" on the next mutation.

### Why the earlier reviews missed it

The P2 plan's Global Constraints fenced the implementer to `packages/shared/` and
`apps/dashboard/`. The API consumer of the shared validator was outside that fence, so it was
outside the field of view of both the implementer and the task-scoped reviews. And every one of
the eleven `localizations` fixtures across `apps/api/tests` and `packages/db` fills its
default-locale strings, so no test exercises the PATCH path with a blank default value.

---

## 2. Goal & scope

Make the severity model say what it means: **absent** and **blank** are different situations and
must hit different gates.

**In scope**
- A third severity tier and the predicate for it.
- A new `EMPTY_LOC_VALUE` issue code; `UNKNOWN_LOC_KEY` narrowed back to "absent".
- Swapping the publish gate (API + dashboard) onto the publish-blocking predicate.
- Scoping the `LOCALE_KEY_GAP` loop to keys the tree actually uses, and only to keys whose default
  value is genuinely non-blank (closes I2 and I3).
- The regression test whose absence let C1 ship.

**Out of scope**
- M5 (`viaOverride` is first-usage-wins) and M6 (jump into a `fallback` subtree) — unrelated to the
  predicate, logged in the ledger, deferred.
- Pruning orphaned keys from `localizations` on `removeNode`, and any "delete a localization key"
  UI. After this change orphans stop *warning*, so the dead-end is gone; reclaiming the dead data
  is a separate, optional cleanup.
- P2b staleness sidecar and P2c auto-translate.
- No DB change, no migration, no SDK/wire change.

**Success criteria**
1. Adding a text node to a paywall and rearranging the tree autosaves successfully with the key
   still blank.
2. Publishing that paywall is blocked, with the blank string named in the validation drawer.
3. Filling the string in the default locale unblocks publish.
4. An orphaned key (present in `localizations`, referenced by no node) produces no issue at all.
5. A key that IS set in the default locale and missing in another still produces
   `LOCALE_KEY_GAP`, and its message is true.

---

## 3. The severity model

Today there is one axis — `WARNING_ISSUE_CODES` and `isBlockingIssue` — and both the save gate and
the publish gate read it. That is the whole bug: two gates that need different answers share one
predicate.

Three tiers:

| Tier | Blocks save | Blocks publish | Codes |
|---|---|---|---|
| Warning | no | no | `LOCALE_KEY_GAP`, `OVERRIDE_SELECTED_OUTSIDE_CELL`, `INTRO_VARIABLE_UNGUARDED` |
| Publish-only | **no** | yes | `EMPTY_LOC_VALUE` |
| Blocking | yes | yes | everything else (`DUPLICATE_NODE_ID`, `UNKNOWN_LOC_KEY`, `FOREIGN_PACKAGE_ID`, `MISSING_PURCHASE_BUTTON`, `SCHEMA_INVALID`, `CELL_TEMPLATE_BAD_NODE`, `OVERRIDE_BAD_PROP`) |

```ts
/**
 * Issue codes that must not block a SAVE but must block a PUBLISH: the
 * config is a legitimate work-in-progress that persists fine, but shipping
 * it to devices would be wrong.
 */
export const PUBLISH_BLOCKING_ISSUE_CODES: ReadonlySet<string> = new Set(["EMPTY_LOC_VALUE"]);

/** True when an issue must block the save. */
export function isBlockingIssue(issue: { code: string }): boolean {
  return !WARNING_ISSUE_CODES.has(issue.code) && !PUBLISH_BLOCKING_ISSUE_CODES.has(issue.code);
}

/** True when an issue must block a publish (every blocking issue, plus the publish-only tier). */
export function isPublishBlockingIssue(issue: { code: string }): boolean {
  return !WARNING_ISSUE_CODES.has(issue.code);
}
```

`isBlockingIssue` keeps its name and its documented meaning — "blocks the save" — and only loses
the codes that never should have been in it. `isPublishBlockingIssue` is exactly today's
`isBlockingIssue` body, so the publish gate's behaviour is unchanged for every pre-existing code.

**This is the dangerous part of the change.** `isBlockingIssue` is called at the publish gate
today; narrowing it without swapping that call site would silently weaken the publish gate. Both
call sites — `paywalls.ts:494` and the dashboard's `errorIssues` — must move to
`isPublishBlockingIssue` in the same change.

Keeping both sets `ReadonlySet<string>` rather than `ReadonlySet<BuilderIssue["code"]>` follows the
existing file's deliberate choice, so a code that is spec'd before it is emitted stays forward-
tolerant.

---

## 4. Absent vs blank

The `UNKNOWN_LOC_KEY` loop splits by whether the key is in the table at all:

```ts
if (!(key in defaultLocaleTable)) {
  issues.push({
    code: "UNKNOWN_LOC_KEY",
    nodeId: node.id,
    key,
    message: `Key "${key}" (node "${node.id}") has no entry in the default locale ("${config.defaultLocale}").`,
  });
} else if (isMissingLocaleValue(defaultLocaleTable[key])) {
  issues.push({
    code: "EMPTY_LOC_VALUE",
    nodeId: node.id,
    key,
    message: `Key "${key}" (node "${node.id}") is blank in the default locale ("${config.defaultLocale}") — fill it in before publishing.`,
  });
}
```

`in` rather than `!== undefined`: a key explicitly set to `undefined` is not a shape the schema can
produce, and `in` states the intent — presence, not value.

`isMissingLocaleValue` itself is unchanged. It stays the single predicate the matrix modal shares
with the validator, which is what keeps the matrix and the gates in agreement.

---

## 5. The gap loop

Two changes, one line each in effect:

```ts
// LOCALE_KEY_GAP — per (non-default locale, key the TREE uses that is set in
// the default locale but missing there).
const usedKeys = [...new Set(collectLocalizationUsages(config.root).map((u) => u.key))];
for (const [locale, table] of Object.entries(config.localizations)) {
  if (locale === config.defaultLocale) continue;
  for (const key of usedKeys) {
    if (isMissingLocaleValue(defaultLocaleTable[key])) continue; // reported by UNKNOWN_LOC_KEY / EMPTY_LOC_VALUE
    if (isMissingLocaleValue(table[key])) {
      issues.push({ code: "LOCALE_KEY_GAP", locale, key, message: /* unchanged */ });
    }
  }
}
```

**Tree-scoped instead of table-scoped (closes I2).** The loop iterated `Object.keys(defaultLocaleTable)`,
so a key present in `localizations` but referenced by no node produced a warning per non-default
locale. `removeNode` never prunes `localizations`, so add-node → type the copy → delete-node
orphans the key permanently, and no builder UI can delete a localization key. The matrix's rows
come from tree usage, so the orphan had no row either: an unclearable warning with nothing to act
on. Pre-P2 the blank orphan case produced nothing (the check was `key in table`); P2 manufactured
these. Scoping the loop to tree usage matches the matrix and makes them agree.

**Skip keys already reported (closes I3).** The message *"which is set in the default locale"*
became false the moment the predicate stopped requiring a non-blank default value — and it was
emitted alongside an `UNKNOWN_LOC_KEY` asserting the opposite about the same key. Skipping keys
whose default value is missing makes the message true again and removes the contradiction.

This also removes M4's "gap without a matrix row" direction. The other direction (a key absent
from the default table shows as incomplete in the matrix but produces no `LOCALE_KEY_GAP`) remains
and stays logged — `EMPTY_LOC_VALUE`/`UNKNOWN_LOC_KEY` already name that key, so the author is not
left without a signal.

`collectLocalizationUsages` is already exported and already walks `overrides`, `cellTemplate` and
`fallback`, so override-introduced keys keep their gap warnings.

---

## 6. Consumers to move

| Site | Today | After |
|---|---|---|
| `apps/api/.../paywalls.ts:208` — PATCH save | `isBlockingIssue` | `isBlockingIssue` (unchanged call, narrowed meaning) |
| `apps/api/.../paywalls.ts:494` — publish | `isBlockingIssue` | **`isPublishBlockingIssue`** |
| `vm.errorIssues` → `canPublish`, drawer errors, top-bar red count | `isBlockingIssue` | **`isPublishBlockingIssue`** |
| `vm.warningIssues` | `!isBlockingIssue` | **`!isPublishBlockingIssue`** |

Routing `errorIssues` onto the publish predicate is what makes the UI honest: a blank default
string shows as a red error that names the blocking condition and disables Publish, while the work
keeps autosaving. No third UI tier is needed — the drawer's existing errors/warnings split already
expresses it.

**Nothing blank reaches a device.** Allowing the draft to persist with a blank string is safe
precisely because the publish gate still rejects it: `/v1/placements` and the fallback export both
serve the **published version snapshot**, and a snapshot is only ever written by the publish route
this change keeps gated. The draft is builder state, not device state.

Blast radius outside these: none. A repo-wide grep found `collectLocalizationKeys` referenced only
by `validate.ts` and its test; the Rust core, the four renderers, `render-fixtures.json` and the
rest of the API never consume issue codes. `EMPTY_LOC_VALUE` joins the `BuilderIssue["code"]` union
and the dashboard renders `issue.message` verbatim, so nothing needs a new label.

---

## 7. Testing

The point of this phase is that a gate was wrong and nothing caught it. The tests must exercise
the gates, not just the validator.

- **`packages/shared`** — absent key → `UNKNOWN_LOC_KEY` and `isBlockingIssue` true; blank key →
  `EMPTY_LOC_VALUE`, `isBlockingIssue` **false**, `isPublishBlockingIssue` **true**; orphaned key →
  no issue in any locale; key set in default and missing elsewhere → `LOCALE_KEY_GAP` and its
  message names a key that really is set.
- **`apps/api`** — the regression test whose absence let C1 ship: PATCH a builderConfig whose
  default-locale value is blank and assert **200**, then assert the publish route rejects the same
  config with `PAYWALL_NOT_PUBLISHABLE`. This must use the real route, not the validator directly —
  validator-level assertions are what missed it the first time.
- **`apps/dashboard`** — `canPublish` false while a blank default string exists; `errorIssues`
  contains the `EMPTY_LOC_VALUE`; the localization matrix still marks the same cell missing (the
  matrix and the gates agree).

---

## 8. Global constraints

- TypeScript strict. Zod for API input. Responses `{ data }` / `{ error }`.
- **The fence that caused this bug is explicitly lifted:** this change spans `packages/shared/`,
  `apps/api/` and `apps/dashboard/` by design. A change to the shared validator's severity model is
  a cross-consumer change and must be reviewed as one.
- **No magic values** — issue codes and the two sets are structured data, not magic values.
- No DB change, no migration, no SDK/wire change.
- Conventional commits; work committed on the current branch (`main`), no new branches.
- Tests: `pnpm --filter <pkg> exec vitest run <path>` (no bare `vitest` script).

---

## 9. Follow-ons (deferred)

- Prune orphaned keys from `localizations` (on `removeNode`, or an "unused strings" section of the
  matrix with a delete affordance).
- M5 — `viaOverride` should be true only when *every* usage of the key is override-introduced.
- M6 — the layer tree excludes `fallback` subtrees a matrix jump can select.
- A `beforeunload` / unmount flush for `autosave`, so a permanent save failure is not the only
  thing standing between the author and lost work.
- Make `AutosaveBadge` distinguish a retryable failure from a permanent 400.
