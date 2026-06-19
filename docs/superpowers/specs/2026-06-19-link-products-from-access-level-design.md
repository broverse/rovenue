# Link Products from the Access Level Page

**Date:** 2026-06-19
**Status:** Approved — ready for implementation plan

## Problem

The Access Level detail page (`apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`)
shows a **"Products that grant it"** section that is read-only. The only way to make a
product grant an access level is to open that product (product drawer) and link it there.

Users want to manage the relationship from the Access Level page directly:
pick which products grant the selected access without leaving the page.

## Key constraint: no API or schema changes

The product → access relationship is stored as `products.accessIds[]` — a `TEXT[]` column
on the `products` table containing `access.id` values. The Access Level page already derives
its granting-products list by filtering:

```ts
allProducts.filter((p) => p.accessIds.includes(selected.id))
```

Linking/unlinking a product to an access level is therefore just a mutation of that product's
`accessIds` array, which the existing `PATCH /dashboard/projects/{projectId}/products/{id}`
endpoint already supports (via `useUpdateProduct`). **This feature is dashboard-only:** no new
endpoint, no Drizzle migration, no schema change.

## Scope

- Add a **"Link products"** action to the "Products that grant it" section that opens a
  searchable multi-select modal. The modal manages both linking and unlinking for the
  selected access level.
- Add a per-row **unlink (×)** control on each product in the granting-products list for
  quick one-off removal.
- The existing product-drawer linking flow stays untouched. Both surfaces edit the same
  `products.accessIds[]` relationship.

Out of scope: server-side product search, changes to offerings/packages, any API endpoint
or schema work.

## Components

### New: `apps/dashboard/src/components/access/link-products-modal.tsx`

A modal that, given the selected access level and the project id:

- Loads the project's products via `useProjectProducts`, fetching **all pages** on open so
  search covers the full catalog (not just the first page).
- Renders a search input (filters client-side by `displayName` / `identifier`) and a list of
  products, each with a checkbox.
- Pre-checks every product where `product.accessIds.includes(access.id)`.
- Tracks pending checkbox state locally; **Confirm** applies the diff, **Cancel** discards it.
- On confirm, for each product whose checkbox differs from its persisted state, issues a
  `PATCH` via `useUpdateProduct`:
  - newly checked → `accessIds: [...existing, access.id]`
  - newly unchecked → `accessIds: existing.filter((id) => id !== access.id)`
- Runs the PATCHes in parallel, then invalidates the products query so the page re-derives
  `grantingProducts`.

### Modified: `access.tsx`

- Add a **"Link products"** button in the "Products that grant it" section header that opens
  the modal for the currently selected access level.
- Add a per-row unlink (×) button on each granting product; clicking it PATCHes that product
  with `access.id` removed from its `accessIds`, then invalidates the products query.

## Data flow

1. User opens the modal from the selected access level.
2. Modal loads all products and pre-checks those already granting the access.
3. User toggles checkboxes / searches, then confirms.
4. Modal computes the diff vs. persisted `accessIds`, fires parallel `PATCH` requests.
5. On success, products query is invalidated; `grantingProducts` re-derives and the list updates.

## Error handling

- If one or more PATCHes fail, surface a toast describing the failure and refetch the products
  query so the UI reflects whatever actually persisted (no optimistic divergence left behind).
- Disable the Confirm button while mutations are in flight.

## Testing

- Component test for `link-products-modal`: pre-check reflects current `accessIds`; confirm
  fires the correct add/remove PATCH payloads only for changed rows; search filters the list.
- Verify the per-row unlink removes only the targeted access id and leaves the product's other
  access ids intact.

## Open follow-up (not in scope)

If a project can hold hundreds+ of products, replace client-side search with a server-side
`?search=` query param on the products list endpoint. Deferred until needed.
