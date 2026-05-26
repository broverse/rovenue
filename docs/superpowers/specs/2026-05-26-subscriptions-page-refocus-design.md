# Subscriptions Page Refocus — Design Spec

**Status:** Approved
**Date:** 2026-05-26
**Scope:** `apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx` + the API list endpoint that backs it.

## Goal

Refocus the Subscriptions page on its primary job — viewing subscriptions. Strip out side panels that drifted in (renewal calendar, billing issues, cohort retention) and turn the inert filter/sort UI into a real server-driven filter + column-header sort experience.

## Problem

Today the page mounts five sibling panels: KPI cards, CompositionBar, RenewalCalendar, the subscriptions table, BillingIssuesPanel and CohortRetentionPanel. The table itself has filter "pills" and a "Sort: Next renewal" button that are visual-only — they don't talk to the API. The API only supports `scope` (status) and `search` query params.

For users who come here to browse subscriptions, the panels below the table are noise, and the filter row promises capabilities the page can't deliver.

## Non-Goals

- Deleting the unmounted components from the codebase. They stay (may be reused on a future dedicated page).
- Wiring the Export CSV flow to the new filter/sort state. That has its own plan (`docs/superpowers/plans/2026-05-26-subscriptions-header-actions.md`) and stays unchanged here.
- Saved filter views / personalized presets.
- Server-side product autocomplete; the page reuses the existing `useProjectProducts` flat list.

## Page Layout (new)

In order, top to bottom:

1. **Header** — Schedule / Export CSV / New Subscription buttons. Unchanged.
2. **KPI cards (4)** — Total Active / Renewing 7d / Grace Retry / Canceling. Unchanged.
3. **CompositionBar** — Live segment breakdown. Unchanged.
4. **ScopeTabs** — Status quick filters (all / active / trial / grace / canceling / issues / churned). Unchanged. The current inert top-right "Sort: Next renewal" button and the `MoreHorizontal` more button next to it are **removed** — sort lives on column headers now.
5. **FilterToolbar** *(new component)* — Search + Store + Product + Auto-renew + "More filters" popover (date ranges + flags) + result count + Clear-all.
6. **SubscriptionsTable** — Now with sortable column headers. `Started`, `Renews`, `Price`, `Status` headers are clickable; chevron shows current direction. This is the only sort indicator on the page.
7. **Load more** button (pagination). Unchanged.

**Removed mounts** *(components remain in codebase, just unmounted from this page)*:
- `RenewalCalendar`
- `BillingIssuesPanel`
- `CohortRetentionPanel`

**Removed inline controls** from the route file: the top-right `Sort: Next renewal` + `MoreHorizontal` buttons, and the inline search + filter-pill strip (its concerns move into `FilterToolbar`).

## API Sözleşmesi

### Endpoint

`GET /v1/dashboard/projects/:projectId/subscriptions`

### Query schema (extended)

| Param | Tip | Notlar |
|---|---|---|
| `scope` | enum *(existing)* | Status scope. Default `all`. |
| `search` | string *(existing)* | `ilike` on `id` / `subscriberId` / `storeTransactionId`. |
| `cursor` | opaque base64url *(existing, v2 format)* | See *Cursor encoding* below. |
| `limit` | int 1..200 *(existing)* | Default 50. |
| `store` | CSV `APP_STORE,PLAY_STORE,STRIPE,WEB,MANUAL` | `inArray(p.store, …)`. Unknown values rejected by Zod enum. |
| `productId` | CSV cuid | `inArray(p.productId, …)`. Bounded to 50 ids to keep WHERE small. |
| `autoRenew` | `"true" \| "false"` | `eq(p.autoRenewStatus, …)`. Omit = both. |
| `isTrial` | `"true" \| "false"` | `eq(p.isTrial, …)`. |
| `isIntro` | `"true" \| "false"` | `eq(p.isIntroOffer, …)`. |
| `hasIssue` | `"true"` | `status='GRACE_PERIOD' AND (autoRenewStatus IS NULL OR autoRenewStatus = true)`. |
| `purchasedFrom` / `purchasedTo` | ISO date | `gte/lte(p.purchaseDate, …)`. |
| `expiresFrom` / `expiresTo` | ISO date | `gte/lte(p.expiresDate, …)`. |
| `sort` | enum (see below) | Default `started_desc`. |

`hasIssue=true` filter is **independent** of `scope=issues`. The tab is a quick-jump shortcut; the toggle is a row-level flag filter that composes with any scope.

### Sort keys

| Key | ORDER BY | NULL handling |
|---|---|---|
| `started_desc` *(default)* | `purchase_date DESC, id DESC` | — |
| `started_asc` | `purchase_date ASC, id ASC` | — |
| `renews_asc` | `expires_date ASC NULLS LAST, id ASC` | rows with `expires_date IS NULL` sort last |
| `renews_desc` | `expires_date DESC NULLS LAST, id DESC` | rows with `expires_date IS NULL` sort last |
| `price_desc` | `price_amount DESC NULLS LAST, id DESC` | — |
| `price_asc` | `price_amount ASC NULLS LAST, id ASC` | — |
| `status` | `status ASC, id ASC` | uses the DB enum's lexical order; UI labels the column non-toggling |

The current implementation orders by `created_at` — kept conceptually as `started_desc` since `purchase_date` is what users mean by "started". `created_at` is an internal write timestamp; switch to `purchase_date` so the UI is honest.

### Cursor encoding (v2)

```
raw = `v2|${sortKey}|${sortValueIso}|${id}`
cursor = base64url(raw)
```

- `sortValueIso` is the row's sort column value, ISO-serialized (Date → `toISOString()`; number → string; null → empty string).
- On read: cursor's `sortKey` must equal the request's `sort`. Mismatch → `400 Invalid cursor`. (Frontend never sends a cursor across sort changes; this is a server-side guard.)
- Tuple compare via `WHERE (sortCol, id) < (cursorSortCol, cursorId)` for desc, `>` for asc. NULLS-LAST is enforced with a `CASE WHEN sortCol IS NULL THEN 1 ELSE 0 END` lead term so NULL rows sort after non-NULL ones consistently.
- Old `v1|createdAt|id` cursors → `400 Invalid cursor` (we don't issue them anymore; clients refetch from page 1).

### Backward compat

Calling the endpoint with no new params returns the same shape and order as before *except* the order column changes from `created_at` to `purchase_date`. This is a behavioral change worth flagging in the migration test — the two are usually within seconds of each other for organic webhook traffic but can diverge for `MANUAL` grants where `purchase_date` is `now()` but `created_at` is also `now()`.

## UI Contract

### URL state

Filters and sort live in TanStack Router search params, owned by the route. The route's `validateSearch` schema:

```ts
{
  scope?: 'all' | 'active' | 'trial' | 'grace' | 'canceling' | 'issues' | 'churned'
  q?: string                              // search
  store?: string                          // CSV
  productId?: string                      // CSV
  autoRenew?: 'true' | 'false'
  isTrial?: 'true' | 'false'
  isIntro?: 'true' | 'false'
  hasIssue?: 'true'
  purchasedFrom?: string                  // ISO date
  purchasedTo?: string
  expiresFrom?: string
  expiresTo?: string
  sort?: SubscriptionSortKey              // default 'started_desc'
}
```

Avantajlar: shareable links, refresh-safe, browser back/forward works, deep-linking from dashboards (e.g., "show me Stripe + canceling, sorted by price").

### SubscriptionsTable changes

New props on the existing component:

```ts
sort: SubscriptionSortKey
onSortChange: (next: SubscriptionSortKey) => void
sortableColumns?: ReadonlyArray<'started' | 'renews' | 'price' | 'status'>
```

`<Th sortable column="started" sort={sort} onSortChange={onSortChange}>` renders a chevron and toggles direction:
- Same column clicked → asc ↔ desc toggle.
- Different column clicked → that column's default direction: `started=desc`, `renews=asc`, `price=desc`, `status=asc`.

Non-sortable columns keep the existing dumb `<Th>`.

### FilterToolbar (new)

`apps/dashboard/src/components/subscriptions/filter-toolbar.tsx`. Self-contained component that owns no state — receives the parsed search object + a single `onChange(patch: Partial<Search>)` callback. Parent (route) maps that to `useNavigate({ search: (s) => ({ ...s, ...patch }) })`.

Internal layout (left → right):
- Search input (replaces inline search on the route)
- Store `FilterPill` + popover (checkbox list of `APP_STORE / PLAY_STORE / STRIPE / WEB / MANUAL`)
- Product `FilterPill` + popover (search-filterable multi-select, fed by `useProjectProducts(projectId)`)
- Auto-renew tri-state pill (`All / On / Off`)
- "More filters" pill → popover containing date ranges (Purchase / Expires) + `Trial only` / `Intro offer` / `Has issue` toggles
- Right side: `{filteredCount}/{totalCount}` mono counter + "Clear all" link (only renders when any non-default filter is set)

`ScopeTabs` stays on its own row above the toolbar — it's a tab affordance, not a chip.

### Hook changes

`useProjectSubscriptions` parameter object widens to mirror the URL state. Internally:

```ts
function buildListParams(search: SubsSearch): URLSearchParams { … }
```

The hook's React Query key includes the full normalized search object so distinct filters don't share a cache. The `useProjectProducts(projectId)` hook is added if not present (mirror existing `useProject` style; project-scoped list with no pagination — products are bounded per project).

## State Flow

```
URL search params (TanStack Router)
  ──► route.useSearch() in subscriptions.tsx
       ──► passed to <FilterToolbar /> as `value`
       ──► passed to useProjectSubscriptions(...)
            ──► GET /subscriptions?<params>
       ──► passed to <SubscriptionsTable sort=… />

User interaction (toolbar pill / column header)
  ──► onChange(patch)
       ──► useNavigate({ search: (s) => ({ ...s, ...patch }) })
       ──► URL updates, route re-renders, queries refetch
```

Single source of truth: the URL. No local React state mirrors filters.

## Edge Cases

- **Filter combination empty:** No rows returned → table shows existing empty state. Counter shows `0/{totalCount}`.
- **Sort by `expires` with mixed NULL:** NULLS LAST is consistent across pages because the `CASE WHEN sortCol IS NULL THEN 1 ELSE 0` lead term is also embedded in the cursor's WHERE tuple compare.
- **Search + filters:** They AND together. Search is a substring on id-shape fields; filters are equality / range.
- **`hasIssue` + scope=`churned`:** `hasIssue` requires `status=GRACE_PERIOD`, scope=`churned` requires terminal status. Empty result by construction. Acceptable — user can see they've drawn a contradiction; no special UI.
- **Stale cursor across sort change:** Server returns 400, frontend's React Query refetches page 1. Already the behavior when cursor decoding fails.
- **Product ids referencing deleted products:** Server filter still applies (it's just `inArray`); table renders the row with `productName` resolution returning null and falling back to identifier or id, which the existing `toUiSubscription` already handles.
- **Auto-renew filter on `TRIAL` rows:** Trials have `autoRenewStatus = null` in many cases. `autoRenew=true` (`eq(p.autoRenewStatus, true)`) will hide them — that's correct; trials are not "auto-renewing" in the renewal sense.

## Testing

### API (Vitest + testcontainers)

- `listSubscriptions` smoke per sort key (one per: started_asc/desc, renews_asc/desc, price_asc/desc, status). Assert order is correct on a seeded fixture covering all five stores and mixed expiry dates.
- `listSubscriptions` cursor walk: page 1 + page 2 under `renews_asc` returns disjoint, contiguous sets, with NULL-expiry rows surfacing only on the last page.
- `listSubscriptions` filter matrix: at least 4 combinations:
  - `store=APP_STORE,STRIPE` alone
  - `productId=<a>,<b>` alone
  - `autoRenew=false + isTrial=false + scope=active`
  - `purchasedFrom=<7d ago> + expiresTo=<30d ahead>`
- `listSubscriptions` cursor invalidation: page-1 cursor under `sort=started_desc`, then re-call with `sort=price_desc` and the same cursor → 400.
- Route Zod test: bad `store=NOPE` → 400; `productId` over 50 entries → 400; `autoRenew=on` (instead of `"true"`) → 400.

### Dashboard (Vitest + RTL)

- `subscriptions-table.tsx`: click `Started` Th twice → first call `onSortChange('started_desc')`, second `onSortChange('started_asc')`; chevron rotates.
- `filter-toolbar.tsx`: toggling Auto-renew pill cycles `undefined → 'true' → 'false' → undefined`; calls `onChange` with the right patch each time.
- `filter-toolbar.tsx`: with all filters set, "Clear all" renders and calls `onChange` with every filter key set to `undefined`.

### Not covered (out of scope)
- E2E browser test of the whole route. Project doesn't have one currently; not adding one for this change.

## File Inventory

**Backend — `apps/api`:**
- *Modify* `src/services/metrics/subscriptions.ts` — extend `ListSubscriptionsInput`, add `buildListWhere`, `orderByForSort`, cursor v2 encode/decode. Swap order column from `created_at` to `purchase_date`.
- *Modify* `src/routes/dashboard/subscriptions.ts` — extend `listQuerySchema`, parse CSV params.
- *Modify* `src/routes/dashboard/subscriptions.integration.test.ts` — new cases above.

**Shared — `packages/shared`:**
- *Modify* `src/dashboard.ts` — add `SubscriptionSortKey` union, `subscriptionSortKeySchema`. Keep `SubscriptionsListResponse` unchanged.

**Dashboard — `apps/dashboard`:**
- *Modify* `src/routes/_authed/projects/$projectId/subscriptions.tsx` — drop the bottom grid + RenewalCalendar mount; add `validateSearch`; thread URL state through hook + components; remove the inline filter strip code.
- *Modify* `src/components/subscriptions/subscriptions-table.tsx` — sortable Th.
- *Create* `src/components/subscriptions/filter-toolbar.tsx`.
- *Modify* `src/components/subscriptions/index.ts` — export `FilterToolbar`.
- *Modify* `src/lib/hooks/useProjectSubscriptions.ts` — extend params; add `buildListParams` helper.
- *Create* (if absent) `src/lib/hooks/useProjectProducts.ts`.
- *Modify* `src/i18n/locales/en.json` + `tr.json` — toolbar labels, sort labels.

## Migration / Rollout

- Single PR. No feature flag — the page-level changes don't have an API consumer outside the dashboard, and the API param additions are pure additions plus one order-column swap (covered by the test suite).
- ClickHouse / Postgres schema: no changes.
- No data migration.

## Risks

- **Order-column swap (`created_at` → `purchase_date`)**: For rows created by webhook in near-real-time these are within seconds. For backfilled / late-imported rows they can differ by days (the store's purchase date can be weeks old while `created_at` is the import moment). `MANUAL` comp grants set both to `now()` so they're equal there. The test matrix covers ordering on a mixed fixture, but a screenshot diff would not. Acceptable risk — the new column is the more honest sort.
- **WHERE clause complexity**: With every filter set, the SQL builds a 10-condition AND. All filtered columns are either part of an existing index (`projectId`, `status`, `purchase_date`) or low-cardinality (store enum). No new indexes added; we'll watch query plan after rollout.
- **URL bloat**: With all filters set the URL gets long. TanStack Router serializes efficiently; no concern under 2KB.
