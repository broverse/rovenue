# Cohorts CRUD + Retention (dashboard)

Date: 2026-05-26
Status: Approved
Owner: V. Furkan

## Problem

The dashboard's `/projects/$projectId/cohorts` page renders entirely
from `apps/dashboard/src/components/cohorts/mock-data.ts`. The "+ New
cohort" button has no click handler. Meanwhile the backend already
exposes full CRUD plus a retention endpoint at
`/dashboard/projects/:projectId/cohorts` (POST / GET / PATCH / DELETE
plus `GET /:id/retention`), and the dashboard hooks
(`useProjectCohorts`, `useCohortById`, `useCohortRetention`,
`useCreateCohort`, `useUpdateCohort`, `useDeleteCohort`) are already
wired in `apps/dashboard/src/lib/hooks/useProjectCohorts.ts`.

Users cannot create, edit, or delete a cohort from the dashboard.
Everything they see — saved cohorts list, retention heatmap, KPIs — is
fake.

## Goal

Wire the cohorts page to the real backend for the data the backend
actually provides. Add create / edit / delete flows. The four panels
whose underlying endpoints do not exist yet stay mocked, but get a
"MOCK" badge so it is obvious what is not yet wired.

Non-goals (deferred to Phase 2):

- Backend endpoints for cohort-level LTV, monthly churn, country
  breakdown, member preview, and aggregate KPIs (avg retention / best
  cohort / blended LTV).
- Wiring the sync destinations panel to `syncDestinations` on
  `CohortRow` (the column exists; the UI flow does not).
- Cohort `group` taxonomy (Behavior / Lifecycle / Acquisition) — needs
  a schema/metadata decision before UI.
- A "duplicate cohort" affordance.

## Architecture

### Routes

Three TanStack-Router file routes under
`apps/dashboard/src/routes/_authed/projects/$projectId/`:

- `cohorts.tsx` (existing) — list + selected detail. Reads real data.
  Header keeps "+ New cohort" but now links to `cohorts/new`. The
  selected cohort is tracked via a `?selected=<id>` search param (not
  a separate route — keeps the dense hero+heatmap layout in one place
  and preserves deep-linking).
- `cohorts/new.tsx` (new) — create form.
- `cohorts/$cohortId.tsx` (new) — edit form. Loads the row via
  `useCohortById`.

### Cohort rule builder

`apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx` (new).
Not shared with audiences — `CohortRule` is a flat, narrowly typed
structured DSL (`{ match, filters[] }` with enum fields and operators),
whereas audience rules are nested sift documents. Reusing the audience
builder would require a translation layer in both directions; cheaper
and clearer to write the cohort-specific builder.

Component shape:

```ts
type Props = {
  rule: CohortRule;                       // controlled
  onChange: (next: CohortRule) => void;
};
```

Layout:

1. A `match` toggle: "Match **all** / **any** of the following".
2. A vertical list of `<FilterRow>` items.
3. An "Add filter" menu listing the six fields.

`<FilterRow>` is field-aware. Picking a `field` constrains the visible
operators and the value editor:

| Field             | Allowed ops | Value editor                                       |
|-------------------|-------------|----------------------------------------------------|
| `country`         | `eq`, `in`  | chip input of ISO-3166 alpha-2 codes (uppercased)  |
| `store`           | `eq`, `in`  | chip select: `apple` / `google` / `stripe`         |
| `productId`       | `eq`, `in`  | chip input (free-text product identifiers)         |
| `purchaseType`    | `eq`, `in`  | chip select: `subscription` / `consumable` / `non_consumable` |
| `firstSeenAfter`  | `gte`       | single date picker → ISO timestamp                 |
| `firstSeenBefore` | `lte`       | single date picker → ISO timestamp                 |

`between` is not exposed in the v1 builder — none of the six fields
have a natural between-UI today. The operator stays in the schema for
future numeric fields.

Local validation rules (the builder drops invalid fragments before
emitting):

- `eq` requires a non-empty scalar value.
- `in` requires a non-empty array.
- Date fields require a valid ISO timestamp.

The builder is UI-only. It does NOT know about projects, mutations,
or routing. It accepts a `CohortRule` and emits a new `CohortRule`.

### Data flow

No new hooks. The existing
`apps/dashboard/src/lib/hooks/useProjectCohorts.ts` already exports
everything we need.

`cohorts.tsx`:

1. `useProjectCohorts(projectId)` for the rail.
2. Selected id = `?selected=<id>` search param, falling back to the
   first row's id. When the list mutates (create/delete), the
   selected id is reconciled in an effect: keep current if it still
   exists, otherwise fall back to first row, otherwise clear.
3. Client-side filter input filters the rail by name (case-insensitive
   `includes`). Replaces today's `Filter cohorts…` placeholder.
4. `useCohortRetention({ projectId, id: selectedId, granularity: "week", periods: 13 })`
   drives:
   - Hero `SIZE` from `retention.size`.
   - Hero `W4 RETENTION` from `retention.points.find(p => p.period === 4)?.pct`.
   - Retention heatmap from `retention.points`.
5. Hero `90-DAY LTV` and `MONTHLY CHURN` remain placeholder values
   from `mock-data.ts`, each rendered with `<MockBadge>`. Same for the
   top KPI strip, LTV curves, country breakdown, member avatars row,
   and sync destinations panel.

`granularity: "week"` and `periods: 13` give us 0..12 — comfortably
includes week 4 and matches the heatmap's column count.

### Create / Edit forms

`apps/dashboard/src/components/cohorts/cohort-form.tsx` (new). One
component, prop `mode: "create" | "edit"`. Mirrors the audience form
layout from `2026-05-26-audience-crud-design.md`.

Sections (each rendered as a `<Section>` card, the same helper used in
`flag-form.tsx` / `audience-form.tsx`):

1. **Basics** — name (required, trimmed, 1..160 chars), description
   (optional textarea, trimmed, ≤500, `""` becomes `null` on PATCH).
2. **Rules** — `<CohortRuleBuilder>`, with the empty-state line
   "Cohort matches every subscriber when no filters are set". Below
   the builder, a read-only `<pre>` showing the emitted `CohortRule`
   JSON so power users can verify the document.

Submit payload:

| Field         | Source                                                          |
|---------------|-----------------------------------------------------------------|
| `name`        | required, trimmed                                               |
| `description` | optional, trimmed; `""` becomes `null` on PATCH                 |
| `rules`       | the builder's current `CohortRule`                              |

`syncDestinations` and `metadata` are not editable in this pass — the
existing values are preserved verbatim on PATCH (omit the field; the
API leaves it untouched).

Submit success → navigate to `/cohorts?selected=<id>`. Cancel link
returns to `/cohorts`.

Delete (edit mode only): a kebab menu in the form header with a
"Delete" item → `window.confirm("Delete cohort '<name>'?")` →
`useDeleteCohort` → navigate to `/cohorts`. Same pattern as the
audience delete flow.

### Saved cohorts rail (real data)

`saved-cohorts-rail.tsx` keeps its visual treatment but drops the
`group` field. `CohortRow` has no group concept, so the rail renders a
single section header (`cohorts.list.allHeading` → "All cohorts") with
all rows beneath it. The filter input filters by name.

Each row shows: a colour dot (deterministic hash of `id` → a fixed
palette of six colours so the same cohort keeps the same dot across
sessions), the name, and the size if known (drawn from the retention
endpoint of the *selected* cohort only — non-selected rows show no
size, since retention is per-id and we are not going to fan out N
queries).

### Cohort definition card (selected detail)

`cohort-builder.tsx` is renamed internally to `CohortDefinitionCard`
(file path stays for diff hygiene; the named export changes). It
becomes a read-only summary of the selected cohort's real rules:

- Renders each filter from `selected.rules.filters` as a `<QueryChip>`,
  with the `match` mode as the separator ("AND" for `all`, "OR" for
  `any`).
- The card header still has Duplicate / Save buttons; **Save is
  replaced by an "Edit" link** to `cohorts/$cohortId`. Duplicate is
  deferred (Phase 2 out-of-scope).
- The "Matches X users · refreshed Ym ago" footer reads
  `retention.size` and the query's `dataUpdatedAt`.

If the selected cohort's rules are empty (`filters: []`), the card
renders "No filters — matches every subscriber".

### Empty state

When `useProjectCohorts` returns `{ cohorts: [] }`:

- The rail shows "No cohorts yet" with an inline `+ New cohort` link
  to `cohorts/new`.
- The hero + heatmap region shows "Create your first cohort to see
  retention" with the same link.
- The mock panels (LTV curves, country breakdown, member avatars row,
  sync destinations) **hide entirely** — no point showing fake numbers
  with nothing real to anchor them to.
- The top KPI strip cards still render (they are project-wide), but
  with values dashed out (`—`) instead of the mock numbers.

### Error handling

- **409 on POST / PATCH** ("Cohort name already in use") → surface as
  an inline error on the name field. Same path used by flag-form /
  audience-form.
- **404 on `useCohortById` load in edit route** → redirect to
  `/cohorts` with a toast "Cohort not found".
- **Retention endpoint failure** → heatmap shows "Couldn't load
  retention" with a retry button (calls `refetch()`); hero `SIZE` and
  `W4 RETENTION` fall back to `—`. The CH path can be slow / flaky on
  fresh projects; one slow query must not gate the whole page.
- **List endpoint failure** → rail shows "Couldn't load cohorts" with
  retry. Page still renders the (mock) KPI strip.

### Mock badge

`apps/dashboard/src/components/cohorts/mock-badge.tsx` (new). A small
muted pill reading "MOCK" with a tooltip "Backend not wired yet —
shows placeholder data". Placed once per non-wired card:

- Top KPI strip: on `Avg W4 Retention`, `Best Cohort`, `Blended 90-day
  LTV` (the `Saved Cohorts` count is real, no badge there).
- Hero card: on `90-DAY LTV` and `MONTHLY CHURN`.
- Member avatars row.
- LTV curves panel.
- Country breakdown panel.
- Sync destinations panel.

The badge is intentionally visible — it is a temporary affordance to
keep the page coherent without pretending fake numbers are real.
Phase 2 removes it as each endpoint lands.

## Validation

- **Client**: name non-empty after trim; each filter fragment is
  validated by the builder before it gets into `rule.filters`.
- **Server**: `cohortRuleSchema` in `apps/api/src/routes/dashboard/cohorts.ts`
  already enforces the field/operator/value shape. Surface server-side
  validation errors via the existing `ApiError` path.

## Testing

- `cohort-rule-builder.test.tsx`:
  - Adding a `country in` filter emits
    `{ field: "country", op: "in", value: ["US","CA"] }`.
  - Removing the last filter emits `filters: []`.
  - Switching field from `country` to `firstSeenAfter` resets the op
    to `gte` and the value editor to the date picker.
- `cohort-form.test.tsx`:
  - Submit calls the `POST /dashboard/projects/:projectId/cohorts`
    handler with `{ name, description, rules }`.
  - 409 response surfaces an inline error on the name field.
  - Success navigates to `/cohorts?selected=<new-id>`.
- MSW handlers in `apps/dashboard/tests/msw/handlers.ts` for POST,
  PATCH, DELETE on `/dashboard/projects/:projectId/cohorts(/:id)?` and
  GET on `/:id/retention`.

No backend changes are required, so no backend tests are added.

## i18n

New keys under `cohorts.*` in
`apps/dashboard/src/i18n/locales/en.json`:

- `cohorts.new.*` (title, subtitle, submit)
- `cohorts.edit.*` (title, subtitle, submit)
- `cohorts.form.basics.heading`, `cohorts.form.basics.name`,
  `cohorts.form.basics.description`
- `cohorts.form.rules.heading`, `cohorts.form.rules.emptyHint`,
  `cohorts.form.rules.match.all`, `cohorts.form.rules.match.any`
- `cohorts.form.rules.addFilter`, plus one key per field name
- `cohorts.form.rules.op.eq`, `…in`, `…gte`, `…lte`
- `cohorts.actions.delete`
- `cohorts.delete.confirm` ("Delete cohort '{{name}}'?")
- `cohorts.delete.inUse` (reserved for a future "cohort referenced by
  experiment" 409 — not raised today but keeps room open)
- `cohorts.list.allHeading`, `cohorts.list.empty`,
  `cohorts.list.emptyCta`
- `cohorts.hero.emptyState`, `cohorts.hero.retentionFailed`
- `cohorts.mockBadge.label`, `cohorts.mockBadge.tooltip`
- `cohorts.errors.nameInUse`

The existing `cohorts.builder.*` keys are reused where possible. Keys
no longer used (`cohorts.builder.save` etc.) are deleted.

## File inventory

**New**
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/new.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/$cohortId.tsx`
- `apps/dashboard/src/components/cohorts/cohort-form.tsx`
- `apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx`
- `apps/dashboard/src/components/cohorts/mock-badge.tsx`
- `apps/dashboard/tests/cohort-rule-builder.test.tsx`
- `apps/dashboard/tests/cohort-form.test.tsx`

**Modified**
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts.tsx`
  (real data, search-param selection, empty state, error states)
- `apps/dashboard/src/components/cohorts/cohort-builder.tsx`
  (becomes read-only `CohortDefinitionCard`; "Save" becomes "Edit"
  link; reads real rules)
- `apps/dashboard/src/components/cohorts/saved-cohorts-rail.tsx`
  (real rows, single "All cohorts" heading, deterministic colour
  dots, name filter)
- `apps/dashboard/src/components/cohorts/cohort-hero.tsx`
  (size + W4 from `useCohortRetention`; mock-badge the other two
  metrics)
- `apps/dashboard/src/components/cohorts/retention-heatmap.tsx`
  (consume `CohortRetentionResponse.points` instead of `COHORT_ROWS`)
- `apps/dashboard/src/components/cohorts/index.ts` (exports)
- `apps/dashboard/src/components/cohorts/mock-data.ts`
  (trim — keep only LTV curves, country breakdown, sync destinations,
  member avatars; remove `SAVED_COHORTS`, `COHORT_ROWS`,
  `KPI_VALUES.bestCohort*`)
- `apps/dashboard/src/i18n/locales/en.json`
- `apps/dashboard/tests/msw/handlers.ts`

**No backend changes.**

## Out of scope

- Backend endpoints for cohort-level LTV, monthly churn, country
  breakdown, member preview, and aggregate KPIs (Phase 2).
- Wiring the sync destinations panel to `syncDestinations` on
  `CohortRow` (Phase 2).
- Cohort `group` taxonomy (Behavior / Lifecycle / Acquisition) (Phase 2).
- Duplicate-cohort affordance.
- `between` operator UI.
- Editing `syncDestinations` / `metadata` from the form.
