# Audience CRUD (dashboard)

Date: 2026-05-26
Status: Approved
Owner: V. Furkan

## Problem

The dashboard's `/projects/$projectId/audiences` page is read-only. The
backend already exposes full CRUD at `/dashboard/audiences` (POST, PATCH,
DELETE) with the default `All Users` audience protected from deletion,
but there is no UI to drive it. Users cannot create custom targeting
groups for feature flags or experiments without going through the API.

## Goal

Let dashboard users create, edit, and delete custom audiences from the
audiences page. The default `All Users` audience must remain
undeletable and must always exist (the API already enforces this; the
UI mirrors it).

Non-goals: changing the rules engine, surfacing audience usage across
feature flags, audience versioning, bulk operations.

## Architecture

### Routes

Three TanStack-Router file routes under
`apps/dashboard/src/routes/_authed/projects/$projectId/`:

- `audiences.tsx` (existing) — list. Header gains a "New audience"
  button. Each row gets a kebab menu (Edit / Delete).
- `audiences/new.tsx` (new) — create form.
- `audiences/$audienceId.tsx` (new) — edit form. Default audience
  renders in read-only mode.

### Shared condition builder

`apps/dashboard/src/components/feature-flags/flag-form.tsx` already
contains a non-trivial structured editor for sift-style conditions:
`ConditionRow`, `ConditionMenu`, `ChipInput`, `PlatformChips`, plus the
serialisation helpers `conditionsToSift` and `siftToConditions` and the
`DraftCondition` / `ConditionKind` types. Audience rules are the same
sift document shape (validated by `validateAudienceRules` in
`packages/shared/src/experiments/targeting.ts`), so we extract this
machinery into a new shared module:

```
apps/dashboard/src/components/targeting/
├── condition-builder.tsx   (named exports: ConditionList, types)
└── sift-codec.ts           (conditionsToSift, siftToConditions)
```

`flag-form.tsx` is updated to import from these modules instead of
defining them inline. The audience form imports the same.

The builder remains UI-only; it does NOT know about audience or flag
domain types. It accepts `conditions: DraftCondition[]` and
`onChange: (next: DraftCondition[]) => void`.

### Data flow

Mutation hooks added to
`apps/dashboard/src/lib/hooks/useProjectAdmin.ts`:

```ts
useCreateAudience()  // POST /dashboard/audiences
useUpdateAudience()  // PATCH /dashboard/audiences/:id
useDeleteAudience()  // DELETE /dashboard/audiences/:id
```

All three invalidate `["audiences", projectId]` on success. Hooks
follow the same shape as the existing experiment mutations
(`useCreateExperiment`, etc.).

Form submit payload:

| Field         | Source                                          |
|---------------|-------------------------------------------------|
| `name`        | required, trimmed, ≥1 char                      |
| `description` | optional, trimmed; `""` becomes `null` on PATCH |
| `rules`       | `conditionsToSift(conditions) ?? {}`            |

Empty `rules` (no conditions) keeps the existing "matches every
subscriber" semantics — the SDK's `matchesAudience` short-circuits to
`true` on `{}`.

### Default audience handling

The default `All Users` audience is detected via `isDefault: true` on
the row payload (already returned by the API).

- **List**: row is still a link to `/audiences/$audienceId`, but the
  kebab menu is not rendered (no Edit, no Delete). Clicking the row
  opens the read-only form. The chip already reads "Default".
- **Edit form**: every field (name, description, rules) is disabled.
  A banner at the top reads "Default audience cannot be edited." No
  Save button. This is the simplest and safest treatment.

### Delete flow

- Triggered from the kebab menu's "Delete" item (custom audiences
  only).
- `window.confirm("Delete audience '<name>'?")` — matches the
  `experiments.lifecycle.stopConfirm` pattern.
- On 409 from the API ("Audience is in use by at least one
  experiment"), show the message in a toast/inline error. We do NOT
  enumerate which experiments use it; users can navigate to the
  experiments page if they need to.

### Form layout (mirrors the experiment / flag forms)

Two sections rendered as `<Section>` cards (the same helper used in
`flag-form.tsx`):

1. **Basics** — name (required), description (optional textarea).
2. **Targeting Rules** — `<ConditionList>` with an "Add condition"
   menu, empty state "Matches every subscriber when no conditions are
   set". Below the list: a tiny preview of the emitted sift JSON
   (read-only `<pre>`), so power users can verify the document.

Submit button uses the existing `<Button variant="solid-primary">`. On
success, navigates back to `/audiences`. Cancel link returns to the
same.

### Validation

- Client: name non-empty.
- Client: each condition fragment is valid (the builder already drops
  fragments that resolve to `null` from `conditionToFragment`).
- Server: `validateAudienceRules` already enforces operator allowlist,
  depth, node count, array length. Surface server-side validation
  errors via the existing `ApiError` path used by flag-form /
  experiment-form.

## Testing

- Round-trip unit test for `conditionsToSift` / `siftToConditions`
  after extraction, to guarantee no behavioural change to flag-form.
  Add to `apps/dashboard/tests/`.
- MSW handler for `POST /dashboard/audiences`,
  `PATCH /dashboard/audiences/:id`, `DELETE /dashboard/audiences/:id`
  in `apps/dashboard/tests/msw/handlers.ts`.
- Form-level test: filling name + adding a country condition produces
  the expected POST body
  `{ name: "EU", rules: { country: { $in: ["DE","FR"] } } }`.

No backend changes required; the existing dashboard-routes integration
tests already cover the API surface.

## i18n

New keys under `audiences.*` in
`apps/dashboard/src/i18n/locales/en.json`:

- `audiences.new.*` (title, subtitle, submit, etc.)
- `audiences.edit.*` (title, subtitle, defaultBanner, submit)
- `audiences.actions.edit`, `audiences.actions.delete`
- `audiences.delete.confirm`, `audiences.delete.inUse`
- `audiences.list.newButton`

Reuse `featureFlags.new.conditions.*` keys where the builder shares the
labels (the extraction step renames them to a neutral
`targeting.conditions.*` namespace and updates both consumers).

## File inventory

**New:**
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/new.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/$audienceId.tsx`
- `apps/dashboard/src/components/audiences/audience-form.tsx`
- `apps/dashboard/src/components/targeting/condition-builder.tsx`
- `apps/dashboard/src/components/targeting/sift-codec.ts`
- `apps/dashboard/tests/audience-form.test.tsx`
- `apps/dashboard/tests/sift-codec.test.ts`

**Modified:**
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences.tsx`
  (header button, row kebab, link wrapping)
- `apps/dashboard/src/lib/hooks/useProjectAdmin.ts`
  (add Create/Update/Delete mutation hooks; also export
  `useAudience(id)` reading from the list cache when possible)
- `apps/dashboard/src/components/feature-flags/flag-form.tsx`
  (replace inline condition builder with imports from
  `../targeting/*`)
- `apps/dashboard/src/i18n/locales/en.json`
- `apps/dashboard/tests/msw/handlers.ts`

**No backend changes.**

## Out of scope

- Showing which experiments / flags currently target an audience.
- Audience preview ("how many subscribers match these rules right
  now?"). The SDK evaluates rules client-side; there is no
  server-side count today.
- A "duplicate audience" affordance.
- Raw-JSON mode toggle on the rules editor.
