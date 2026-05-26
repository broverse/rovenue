# Subscriptions Page Refocus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the Subscriptions page down to its real job — viewing subscriptions — by unmounting three side-panels, replacing inert filter pills with a real server-driven `FilterToolbar`, and adding click-to-sort column headers, all driven by URL search params.

**Architecture:** Spec lives at `docs/superpowers/specs/2026-05-26-subscriptions-page-refocus-design.md`. Single PR. The API endpoint `GET /v1/dashboard/projects/:projectId/subscriptions` gains seven query params (`store`, `productId`, `autoRenew`, `isTrial`, `isIntro`, `hasIssue`, date ranges, `sort`) and a cursor v2 format. The dashboard route adopts TanStack Router `validateSearch` (mirror the pattern already used in `transactions.tsx`), threads a normalized search object through a new `useProjectSubscriptions(searchParams)` shape, and renders a new `<FilterToolbar />` plus a sortable `<SubscriptionsTable />`.

**Tech Stack:** Hono + Zod + Drizzle ORM (Postgres 16), React + TanStack Router + React Query, Vitest + Better Auth (real session integration tests).

**Spec:** `docs/superpowers/specs/2026-05-26-subscriptions-page-refocus-design.md`

---

## Pre-flight Checklist (do once before Task 1)

- [ ] **Read the spec end-to-end:** `docs/superpowers/specs/2026-05-26-subscriptions-page-refocus-design.md`.
- [ ] **Read these files** to absorb the patterns this plan mirrors:
  - `apps/dashboard/src/routes/_authed/projects/$projectId/transactions.tsx` — the same `validateSearch` + URL state + sortable-header pattern this plan is bringing to subscriptions. Copy its style.
  - `apps/dashboard/src/components/transactions/tx-filter-bar.tsx` — `FilterPill` + click-away popover composition.
  - `apps/api/src/services/metrics/subscriptions.ts` — current `listSubscriptions` implementation.
  - `apps/api/src/routes/dashboard/subscriptions.integration.test.ts` — existing test bootstrapping (Better Auth session, RUN_ID seeding) you will reuse.
- [ ] **Heads-up — unrelated WIP in the working tree:** `apps/api/src/routes/dashboard/experiments.ts`, `apps/dashboard/src/lib/hooks/useExperiments.ts`, `packages/db/src/drizzle/repositories/experiments.ts`, `packages/shared/src/dashboard.ts` are modified by an unrelated stream of work. Do **not** stage or commit them as part of this plan. Be careful with `git add` — use explicit paths, never `git add .` or `git add -A`.

---

## File Inventory

**Backend — `apps/api`:**
- *Modify* `src/services/metrics/subscriptions.ts` — extend `ListSubscriptionsInput`, add `buildListWhere`, `orderByForSort`, NULLS-LAST cursor v2 encode/decode. Swap default order column from `created_at` to `purchase_date`.
- *Modify* `src/routes/dashboard/subscriptions.ts` — extend `listQuerySchema`, parse CSV params.
- *Modify* `src/routes/dashboard/subscriptions.integration.test.ts` — new tests for filters + sort + cursor.

**Shared — `packages/shared`:**
- *Modify* `src/dashboard.ts` — add `SubscriptionSortKey`, `SubscriptionStoreCode`, `SubscriptionsListQuery`.

**Dashboard — `apps/dashboard`:**
- *Modify* `src/routes/_authed/projects/$projectId/subscriptions.tsx` — `validateSearch`, URL state via `Route.useSearch()` / `Route.useNavigate()`; mount `<FilterToolbar />`; thread `sort` into `<SubscriptionsTable />`; remove `RenewalCalendar`, `BillingIssuesPanel`, `CohortRetentionPanel` mounts and the inline filter strip + the top-right Sort/More buttons.
- *Modify* `src/components/subscriptions/subscriptions-table.tsx` — sortable Th component, `sort` + `onSortChange` props.
- *Create* `src/components/subscriptions/filter-toolbar.tsx` — new component (Search + Store + Product + Auto-renew + More filters popover + count + Clear-all).
- *Modify* `src/components/subscriptions/index.ts` — barrel `FilterToolbar` export.
- *Modify* `src/lib/hooks/useProjectSubscriptions.ts` — extend params; add `buildListParams` helper.
- *Modify* `src/i18n/locales/en.json` + `tr.json` — toolbar + sort labels.

---

## Task 1: Shared types — `SubscriptionSortKey` + store union

**Files:**
- Modify: `packages/shared/src/dashboard.ts`

- [ ] **Step 1: Read the file** to find the existing subscription types block.

```bash
grep -n "SubscriptionScopeName\|SubscriptionRow\|SubscriptionsListResponse" packages/shared/src/dashboard.ts
```

You'll see the block around line 700–753.

- [ ] **Step 2: Append new types directly after the `SubscriptionsListResponse` interface**

Open `packages/shared/src/dashboard.ts` and insert just after the line `export interface SubscriptionsListResponse { … }` block closes:

```ts
// =============================================================
// Subscriptions list — sort key + filter union
// =============================================================
//
// `SubscriptionSortKey` is the canonical sort identifier the API
// accepts via `?sort=…`. The dashboard maps `<Th>` column clicks to
// these keys (see SubscriptionsTable.sortableColumns).
//
//   started_desc (default) — purchaseDate DESC, id DESC
//   started_asc            — purchaseDate ASC,  id ASC
//   renews_asc             — expiresDate ASC NULLS LAST, id ASC
//   renews_desc            — expiresDate DESC NULLS LAST, id DESC
//   price_desc             — priceAmount DESC NULLS LAST, id DESC
//   price_asc              — priceAmount ASC NULLS LAST, id ASC
//   status                 — status ASC, id ASC

export const subscriptionSortKeys = [
  "started_desc",
  "started_asc",
  "renews_asc",
  "renews_desc",
  "price_desc",
  "price_asc",
  "status",
] as const;

export type SubscriptionSortKey = (typeof subscriptionSortKeys)[number];

export const subscriptionStoreCodes = [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "WEB",
  "MANUAL",
] as const;

export type SubscriptionStoreCode = (typeof subscriptionStoreCodes)[number];

// All optional client-side query fields the list endpoint accepts.
// Mirrors the URL search-param shape used by the dashboard route.
export interface SubscriptionsListQuery {
  scope?: SubscriptionScopeName;
  search?: string;
  cursor?: string;
  limit?: number;
  store?: ReadonlyArray<SubscriptionStoreCode>;
  productId?: ReadonlyArray<string>;
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
  sort?: SubscriptionSortKey;
}
```

- [ ] **Step 3: Build the shared package**

```bash
pnpm --filter @rovenue/shared build
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): SubscriptionSortKey + filter union for list endpoint"
```

---

## Task 2: API route — extend `listQuerySchema`

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscriptions.ts`

- [ ] **Step 1: Update the `@rovenue/shared` import** at the top of the route file

Find the existing import line and add `subscriptionSortKeys`, `subscriptionStoreCodes` so the Zod schema can reuse the shared enums:

```ts
import {
  grantSubscriptionRequestSchema,
  subscriptionSortKeys,
  subscriptionStoreCodes,
} from "@rovenue/shared";
```

- [ ] **Step 2: Replace the existing `listQuerySchema`**

Find the current block (around line 43):

```ts
const listQuerySchema = z.object({
  scope: z.enum(subscriptionScopes).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
  search: z.string().trim().min(1).optional(),
});
```

Replace it with:

```ts
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PRODUCT_IDS = 50;

const csvList = <T extends string>(allowed: ReadonlyArray<T>) =>
  z
    .string()
    .min(1)
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const seen = new Set<T>();
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!(allowed as ReadonlyArray<string>).includes(trimmed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown value: ${trimmed}`,
          });
          return z.NEVER;
        }
        seen.add(trimmed as T);
      }
      return seen.size > 0 ? (Array.from(seen) as ReadonlyArray<T>) : undefined;
    });

const csvIds = z
  .string()
  .min(1)
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    const ids = Array.from(
      new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
    if (ids.length === 0) return undefined;
    if (ids.length > MAX_PRODUCT_IDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many ids (max ${MAX_PRODUCT_IDS})`,
      });
      return z.NEVER;
    }
    return ids as ReadonlyArray<string>;
  });

const boolish = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true"));

const isoDate = z
  .string()
  .regex(ISO_DATE_RE, "expected YYYY-MM-DD")
  .optional();

// `subscriptionStoreCodes` + `subscriptionSortKeys` are exported from
// @rovenue/shared (added in Task 1). Import them at the top of this file
// so the schema and the shared type stay in lock-step.

const listQuerySchema = z.object({
  scope: z.enum(subscriptionScopes).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  store: csvList(subscriptionStoreCodes),
  productId: csvIds,
  autoRenew: boolish,
  isTrial: boolish,
  isIntro: boolish,
  hasIssue: z
    .enum(["true"])
    .optional()
    .transform((v) => v === "true"),
  purchasedFrom: isoDate,
  purchasedTo: isoDate,
  expiresFrom: isoDate,
  expiresTo: isoDate,
  sort: z.enum(subscriptionSortKeys).default("started_desc"),
});
```

- [ ] **Step 3: Update the `.get("/")` handler** to thread the new fields through

Find the existing handler:

```ts
.get("/", zValidator("query", listQuerySchema), async (c) => {
  …
  const { scope, limit, cursor: rawCursor, search } = c.req.valid("query");
  const cursor = rawCursor ? decodeSubsCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    throw new HTTPException(400, { message: "Invalid cursor" });
  }

  const payload = await listSubscriptions({
    projectId,
    scope,
    limit,
    cursor,
    search: search ?? null,
  });
  return c.json(ok(payload));
})
```

Replace the destructure + call with:

```ts
const q = c.req.valid("query");
const cursor = q.cursor ? decodeSubsCursor(q.cursor, q.sort) : null;
if (q.cursor && !cursor) {
  throw new HTTPException(400, { message: "Invalid cursor" });
}

const payload = await listSubscriptions({
  projectId,
  scope: q.scope,
  limit: q.limit,
  cursor,
  sort: q.sort,
  search: q.search ?? null,
  store: q.store ?? null,
  productId: q.productId ?? null,
  autoRenew: q.autoRenew ?? null,
  isTrial: q.isTrial ?? null,
  isIntro: q.isIntro ?? null,
  hasIssue: q.hasIssue,
  purchasedFrom: q.purchasedFrom ?? null,
  purchasedTo: q.purchasedTo ?? null,
  expiresFrom: q.expiresFrom ?? null,
  expiresTo: q.expiresTo ?? null,
});
return c.json(ok(payload));
```

(`decodeSubsCursor` now takes the active sort key — added in Task 4.)

- [ ] **Step 4: Type-check the API package** (it will fail until Task 3+4 land — that's expected)

```bash
pnpm --filter @rovenue/api typecheck 2>&1 | head -30
```

Expected: failures on `decodeSubsCursor` signature and `listSubscriptions` input — the service signature changes in Tasks 3 + 4. Move on; do not commit yet.

- [ ] **Step 5: Stash this change** until the service catches up

We commit the route + service together in Task 4. For now leave the file modified.

---

## Task 3: Service — extend `ListSubscriptionsInput` + `buildListWhere`

**Files:**
- Modify: `apps/api/src/services/metrics/subscriptions.ts`

- [ ] **Step 1: Replace the `ListSubscriptionsInput` interface** (around line 196)

Find:

```ts
export interface ListSubscriptionsInput {
  projectId: string;
  scope: SubscriptionScopeName;
  limit: number;
  cursor: ParsedSubsCursor | null;
  search: string | null;
}
```

Replace with:

```ts
export interface ListSubscriptionsInput {
  projectId: string;
  scope: SubscriptionScopeName;
  limit: number;
  cursor: ParsedSubsCursor | null;
  search: string | null;
  sort: SubscriptionSortKey;
  store: ReadonlyArray<SubscriptionStoreCode> | null;
  productId: ReadonlyArray<string> | null;
  autoRenew: boolean | null;
  isTrial: boolean | null;
  isIntro: boolean | null;
  hasIssue: boolean;
  purchasedFrom: string | null;
  purchasedTo: string | null;
  expiresFrom: string | null;
  expiresTo: string | null;
}
```

- [ ] **Step 2: Add the imports for the new shared types**

Find the existing import from `@rovenue/shared` at the top of the file and add `SubscriptionSortKey`, `SubscriptionStoreCode`:

```ts
import type {
  BillingIssueRow,
  BillingIssuesResponse,
  RenewalCalendarDay,
  RenewalCalendarResponse,
  SubscriptionRow,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionUiStatus,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
} from "@rovenue/shared";
```

- [ ] **Step 3: Add the WHERE-builder helper above `listSubscriptions`**

Just before `export async function listSubscriptions(`, insert:

```ts
function buildListFilters(input: ListSubscriptionsInput) {
  const p = drizzle.schema.purchases;
  const filters: ReturnType<typeof and>[] = [];

  if (input.store && input.store.length > 0) {
    filters.push(inArray(p.store, [...input.store]));
  }
  if (input.productId && input.productId.length > 0) {
    filters.push(inArray(p.productId, [...input.productId]));
  }
  if (input.autoRenew !== null) {
    filters.push(eq(p.autoRenewStatus, input.autoRenew));
  }
  if (input.isTrial !== null) filters.push(eq(p.isTrial, input.isTrial));
  if (input.isIntro !== null) filters.push(eq(p.isIntroOffer, input.isIntro));
  if (input.hasIssue) {
    filters.push(
      and(
        eq(p.status, "GRACE_PERIOD"),
        or(isNull(p.autoRenewStatus), eq(p.autoRenewStatus, true)),
      )!,
    );
  }
  if (input.purchasedFrom) {
    filters.push(gte(p.purchaseDate, new Date(input.purchasedFrom)));
  }
  if (input.purchasedTo) {
    // Inclusive end-of-day so YYYY-MM-DD bounds work intuitively.
    const end = new Date(input.purchasedTo);
    end.setUTCHours(23, 59, 59, 999);
    filters.push(lte(p.purchaseDate, end));
  }
  if (input.expiresFrom) {
    filters.push(gte(p.expiresDate, new Date(input.expiresFrom)));
  }
  if (input.expiresTo) {
    const end = new Date(input.expiresTo);
    end.setUTCHours(23, 59, 59, 999);
    filters.push(lte(p.expiresDate, end));
  }
  if (input.search) {
    const needle = `%${input.search.toLowerCase()}%`;
    filters.push(
      or(
        ilike(p.id, needle),
        ilike(p.subscriberId, needle),
        ilike(p.storeTransactionId, needle),
      )!,
    );
  }
  return filters;
}
```

- [ ] **Step 4: Do not yet wire the helper into `listSubscriptions`** — that happens in Task 4 (which also rewrites the cursor + ORDER BY). Leave the file with the helper added.

- [ ] **Step 5: Sanity build**

```bash
pnpm --filter @rovenue/api typecheck 2>&1 | head -30
```

Expected: still failures on the unchanged `listSubscriptions` body referencing the old `input.search` shape via `input.cursor`. Move to Task 4.

---

## Task 4: Service — sort + NULLS-LAST cursor v2 + `listSubscriptions` rewrite

**Files:**
- Modify: `apps/api/src/services/metrics/subscriptions.ts`

- [ ] **Step 1: Replace the cursor block** (the `CURSOR_VERSION`, `ParsedSubsCursor`, `encodeSubsCursor`, `decodeSubsCursor` block at lines 100-126)

```ts
// =============================================================
// Cursor v2 (sortKey + sortValue + id)
// =============================================================

const CURSOR_VERSION = "v2";

export interface ParsedSubsCursor {
  sort: SubscriptionSortKey;
  /** ISO timestamp / decimal string / status enum / "" when sortValue is NULL. */
  sortValue: string;
  id: string;
}

export function encodeSubsCursor(c: ParsedSubsCursor): string {
  const raw = `${CURSOR_VERSION}|${c.sort}|${c.sortValue}|${c.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeSubsCursor(
  cursor: string,
  expectedSort: SubscriptionSortKey,
): ParsedSubsCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = raw.split("|");
    if (parts.length !== 4) return null;
    const [version, sort, sortValue, id] = parts;
    if (version !== CURSOR_VERSION) return null;
    if (sort !== expectedSort) return null;
    if (!id) return null;
    return {
      sort: sort as SubscriptionSortKey,
      sortValue,
      id,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Add ORDER BY + cursor helpers**

Insert directly after `buildListFilters`:

```ts
// Column accessor + direction descriptor per sort key. `nullable`
// flags the keys whose sort column can be NULL — those need an extra
// CASE expression to keep NULL rows at the end and still cursor through.
const SORT_DESCRIPTORS: Record<
  SubscriptionSortKey,
  {
    column: (p: typeof drizzle.schema.purchases) => any;
    direction: "asc" | "desc";
    nullable: boolean;
  }
> = {
  started_desc: {
    column: (p) => p.purchaseDate,
    direction: "desc",
    nullable: false,
  },
  started_asc: {
    column: (p) => p.purchaseDate,
    direction: "asc",
    nullable: false,
  },
  renews_asc: {
    column: (p) => p.expiresDate,
    direction: "asc",
    nullable: true,
  },
  renews_desc: {
    column: (p) => p.expiresDate,
    direction: "desc",
    nullable: true,
  },
  price_desc: {
    column: (p) => p.priceAmount,
    direction: "desc",
    nullable: true,
  },
  price_asc: {
    column: (p) => p.priceAmount,
    direction: "asc",
    nullable: true,
  },
  status: { column: (p) => p.status, direction: "asc", nullable: false },
};

function nullFlag(column: any) {
  // Postgres-side: 0 for non-NULL rows, 1 for NULL — sorted ASC keeps
  // NULL rows after everything else regardless of `direction`.
  return sql<number>`CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END`;
}

function buildOrderBy(sort: SubscriptionSortKey) {
  const p = drizzle.schema.purchases;
  const desc_ = SORT_DESCRIPTORS[sort];
  const col = desc_.column(p);
  const dir = desc_.direction;
  const id = p.id;
  const order = [
    desc_.nullable ? asc(nullFlag(col)) : null,
    dir === "asc" ? asc(col) : desc(col),
    dir === "asc" ? asc(id) : desc(id),
  ].filter(Boolean) as any[];
  return order;
}

// Build the cursor WHERE: keeps the row order strictly monotonic across
// pages. Tuple compare in SQL using the same nullFlag-then-col-then-id
// shape as ORDER BY.
function cursorWhere(input: ListSubscriptionsInput): ReturnType<typeof and> | undefined {
  const cur = input.cursor;
  if (!cur) return undefined;
  const desc_ = SORT_DESCRIPTORS[input.sort];
  const p = drizzle.schema.purchases;
  const col = desc_.column(p);
  const id = p.id;
  const dir = desc_.direction;

  const wasNull = desc_.nullable && cur.sortValue === "";

  // Coerce string sortValue into the column's expected type for SQL compare.
  const valueLiteral = wasNull
    ? null
    : input.sort === "status"
      ? sql`${cur.sortValue}::text`
      : input.sort.startsWith("price")
        ? sql`${cur.sortValue}::numeric`
        : sql`${cur.sortValue}::timestamptz`;

  // Build the strictly-after-cursor predicate based on direction.
  // For nullable sorts: the cursor is either in the non-NULL bucket
  // (nullFlag=0) or NULL bucket (nullFlag=1). Rows AFTER the cursor are
  // either the same bucket with a later col/id, or the NULL bucket (only
  // when the cursor is in non-NULL).
  if (!desc_.nullable) {
    if (dir === "desc") {
      return or(
        lt(col, valueLiteral as any),
        and(eq(col, valueLiteral as any), lt(id, cur.id)),
      )!;
    }
    return or(
      gt(col, valueLiteral as any),
      and(eq(col, valueLiteral as any), gt(id, cur.id)),
    )!;
  }

  if (wasNull) {
    // Already in the NULL bucket — id-only tiebreaker.
    return and(isNull(col), dir === "desc" ? lt(id, cur.id) : gt(id, cur.id));
  }
  // Non-NULL bucket; either advance within bucket or move to NULL bucket.
  const sameBucket =
    dir === "desc"
      ? or(
          and(
            isNotNull(col),
            or(
              lt(col, valueLiteral as any),
              and(eq(col, valueLiteral as any), lt(id, cur.id)),
            ),
          ),
        )
      : or(
          and(
            isNotNull(col),
            or(
              gt(col, valueLiteral as any),
              and(eq(col, valueLiteral as any), gt(id, cur.id)),
            ),
          ),
        );
  return or(sameBucket, isNull(col));
}

function encodeNextCursor(
  sort: SubscriptionSortKey,
  row: typeof drizzle.schema.purchases.$inferSelect,
): string {
  const desc_ = SORT_DESCRIPTORS[sort];
  let sortValue = "";
  switch (sort) {
    case "started_desc":
    case "started_asc":
      sortValue = row.purchaseDate.toISOString();
      break;
    case "renews_asc":
    case "renews_desc":
      sortValue = row.expiresDate ? row.expiresDate.toISOString() : "";
      break;
    case "price_asc":
    case "price_desc":
      sortValue = row.priceAmount ?? "";
      break;
    case "status":
      sortValue = row.status;
      break;
  }
  return encodeSubsCursor({ sort, sortValue, id: row.id });
}
```

- [ ] **Step 3: Add the missing `gt` / `isNotNull` imports**

Update the top-of-file drizzle import. Find:

```ts
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
```

If `gt` is not already in the list, add it (also ensure `isNotNull` is present — it already should be):

```ts
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
```

- [ ] **Step 4: Replace the body of `listSubscriptions`**

Find the function (around line 204) and replace its body with:

```ts
export async function listSubscriptions(
  input: ListSubscriptionsInput,
): Promise<SubscriptionsListResponse> {
  const limit = Math.min(Math.max(input.limit, 1), PAGE_LIMIT_MAX);
  const fetchLimit = limit + 1;
  const now = new Date();
  const p = drizzle.schema.purchases;

  const where = [eq(p.projectId, input.projectId)];
  const scoped = scopeWhere(input.scope, now);
  if (scoped) where.push(scoped);
  for (const f of buildListFilters(input)) {
    if (f) where.push(f);
  }
  const curWhere = cursorWhere(input);
  if (curWhere) where.push(curWhere);

  const rows = await drizzle.db
    .select()
    .from(p)
    .where(and(...where))
    .orderBy(...buildOrderBy(input.sort))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const productIds = page.map((r) => r.productId);
  const display = await fetchProductDisplay(input.projectId, productIds);

  const mapped: SubscriptionRow[] = page.map((row) => {
    const meta = display.get(row.productId);
    const status = mapStatus({
      status: row.status,
      autoRenewStatus: row.autoRenewStatus,
    });
    const hasIssue =
      status === "grace" &&
      (row.autoRenewStatus === true || row.autoRenewStatus === null);
    return {
      id: row.id,
      subscriberId: row.subscriberId,
      productId: row.productId,
      productName: meta?.displayName ?? null,
      productIdentifier: meta?.identifier ?? null,
      store: row.store,
      status,
      priceAmount: row.priceAmount ?? null,
      priceCurrency: row.priceCurrency ?? null,
      isTrial: row.isTrial,
      isIntroOffer: row.isIntroOffer,
      autoRenew: row.autoRenewStatus,
      purchaseDate: row.purchaseDate.toISOString(),
      expiresDate: row.expiresDate?.toISOString() ?? null,
      gracePeriodExpires: row.gracePeriodExpires?.toISOString() ?? null,
      cancellationDate: row.cancellationDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      hasIssue,
    };
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeNextCursor(input.sort, last) : null;
  return { rows: mapped, nextCursor };
}
```

- [ ] **Step 5: Type-check both API + shared**

```bash
pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/api typecheck 2>&1 | head -30
```

Expected: exits 0 on both. If `listSubscriptions` callsites elsewhere in the codebase fail (the only callsite is the route file modified in Task 2 — search to confirm), fix them with the same input shape.

```bash
grep -rn "listSubscriptions(" apps/api/src
```

- [ ] **Step 6: Commit Tasks 2–4 together**

```bash
git add apps/api/src/routes/dashboard/subscriptions.ts apps/api/src/services/metrics/subscriptions.ts
git commit -m "feat(api): subscription list filters, sort keys, cursor v2"
```

---

## Task 5: API integration tests — filters + sort + cursor

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscriptions.integration.test.ts`

- [ ] **Step 1: Read** the top of the existing test file to see the seeding helpers (`createUserAndSession`, `RUN_ID`, `buildApp`). You'll use them as-is.

```bash
head -100 apps/api/src/routes/dashboard/subscriptions.integration.test.ts
```

- [ ] **Step 2: Add a fixture-builder helper** at the bottom of the file (above `afterAll` if it exists, otherwise at end-of-file)

```ts
// ---------------------------------------------------------------------------
// Seed helper for the list/filter/sort tests below
// ---------------------------------------------------------------------------

async function seedListFixture(suffix: string) {
  const db = drizzle.db;
  const { userId, cookie } = await createUserAndSession(suffix);
  const projectId = `proj_list_${RUN_ID}_${suffix}`;
  const subscriberId = `sub_list_${RUN_ID}_${suffix}`;
  const productId = `prod_list_${RUN_ID}_${suffix}`;
  const productB = `prod_list_${RUN_ID}_${suffix}_b`;

  await db.insert(projects).values({ id: projectId, name: suffix, ownerUserId: userId });
  await db.insert(subscribers).values({ id: subscriberId, projectId, appUserId: suffix });
  await db.insert(products).values([
    { id: productId, projectId, identifier: `id-${suffix}`, displayName: "A", type: "AUTO_RENEWABLE", isActive: true },
    { id: productB, projectId, identifier: `id-${suffix}-b`, displayName: "B", type: "AUTO_RENEWABLE", isActive: true },
  ]);

  // Six purchases spanning stores, expiry status, price tiers, and one NULL-expires row.
  const now = Date.now();
  const day = 86_400_000;
  const purchasesSeed = [
    { id: `p1_${suffix}`, store: "APP_STORE", price: "9.99", purchaseDate: new Date(now - 5 * day), expiresDate: new Date(now + 10 * day), autoRenew: true, isTrial: false, status: "ACTIVE", productId },
    { id: `p2_${suffix}`, store: "PLAY_STORE", price: "19.99", purchaseDate: new Date(now - 3 * day), expiresDate: new Date(now + 30 * day), autoRenew: false, isTrial: false, status: "ACTIVE", productId },
    { id: `p3_${suffix}`, store: "STRIPE", price: "4.99", purchaseDate: new Date(now - 4 * day), expiresDate: new Date(now + 2 * day), autoRenew: true, isTrial: false, status: "ACTIVE", productId: productB },
    { id: `p4_${suffix}`, store: "STRIPE", price: "29.99", purchaseDate: new Date(now - 10 * day), expiresDate: new Date(now + 60 * day), autoRenew: true, isTrial: true, status: "TRIAL", productId },
    { id: `p5_${suffix}`, store: "MANUAL", price: "0", purchaseDate: new Date(now - 1 * day), expiresDate: null, autoRenew: false, isTrial: false, status: "ACTIVE", productId: productB },
    { id: `p6_${suffix}`, store: "APP_STORE", price: "14.99", purchaseDate: new Date(now - 2 * day), expiresDate: new Date(now + 5 * day), autoRenew: true, isTrial: false, status: "GRACE_PERIOD", productId },
  ];

  for (const row of purchasesSeed) {
    await db.insert(purchases).values({
      id: row.id,
      projectId,
      subscriberId,
      productId: row.productId,
      store: row.store as any,
      storeTransactionId: row.id,
      originalTransactionId: row.id,
      status: row.status as any,
      isTrial: row.isTrial,
      isIntroOffer: false,
      isSandbox: false,
      purchaseDate: row.purchaseDate,
      originalPurchaseDate: row.purchaseDate,
      expiresDate: row.expiresDate,
      priceAmount: row.price,
      priceCurrency: "USD",
      environment: "PRODUCTION",
      autoRenewStatus: row.autoRenew,
    });
  }

  return { userId, cookie, projectId, productId, productB, ids: purchasesSeed.map((r) => r.id) };
}

async function listRequest(cookie: string, projectId: string, qs: string) {
  const app = buildApp();
  const res = await app.request(
    `/projects/${projectId}/subscriptions${qs ? `?${qs}` : ""}`,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    rows: Array<{ id: string; store: string; expiresDate: string | null; priceAmount: string | null; status: string }>;
    nextCursor: string | null;
  };
}
```

- [ ] **Step 3: Add a `describe` block** for the list endpoint, just before any existing `describe("POST …")` block

```ts
describe("GET /projects/:projectId/subscriptions — filters + sort", () => {
  it("filters by store (multi-select)", async () => {
    const { cookie, projectId } = await seedListFixture("store");
    const body = await listRequest(cookie, projectId, "store=STRIPE,MANUAL");
    expect(body.rows.every((r) => r.store === "STRIPE" || r.store === "MANUAL")).toBe(true);
    expect(body.rows.length).toBe(3);
  });

  it("filters by productId (CSV)", async () => {
    const { cookie, projectId, productB } = await seedListFixture("prod");
    const body = await listRequest(cookie, projectId, `productId=${productB}`);
    expect(body.rows.length).toBe(2);
  });

  it("filters by autoRenew=false", async () => {
    const { cookie, projectId } = await seedListFixture("auto");
    const body = await listRequest(cookie, projectId, "autoRenew=false");
    expect(body.rows.length).toBe(2);
  });

  it("filters by isTrial=true", async () => {
    const { cookie, projectId } = await seedListFixture("trial");
    const body = await listRequest(cookie, projectId, "isTrial=true");
    expect(body.rows.length).toBe(1);
  });

  it("filters by hasIssue=true (grace + autorenew on)", async () => {
    const { cookie, projectId } = await seedListFixture("issue");
    const body = await listRequest(cookie, projectId, "hasIssue=true");
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].status).toBe("grace");
  });

  it("sort=price_desc with NULLS LAST and cursor walk", async () => {
    const { cookie, projectId } = await seedListFixture("price");
    const first = await listRequest(cookie, projectId, "sort=price_desc&limit=4");
    expect(first.rows.map((r) => r.priceAmount)).toEqual(["29.99", "19.99", "14.99", "9.99"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRequest(
      cookie,
      projectId,
      `sort=price_desc&limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.rows.map((r) => r.priceAmount)).toEqual(["4.99", "0"]);
  });

  it("sort=renews_asc puts NULL expiresDate rows last", async () => {
    const { cookie, projectId } = await seedListFixture("renews");
    const body = await listRequest(cookie, projectId, "sort=renews_asc&limit=10");
    const ids = body.rows.map((r) => r.expiresDate);
    // The single NULL row must be the last entry.
    expect(ids[ids.length - 1]).toBeNull();
    // Everything before it must be ASC and non-null.
    const nonNull = ids.slice(0, -1).filter((v): v is string => v !== null);
    expect([...nonNull].sort()).toEqual(nonNull);
  });

  it("rejects a cursor when sort changes", async () => {
    const { cookie, projectId } = await seedListFixture("xsort");
    const first = await listRequest(cookie, projectId, "sort=price_desc&limit=2");
    expect(first.nextCursor).not.toBeNull();
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?sort=started_desc&cursor=${encodeURIComponent(first.nextCursor!)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown store value via Zod", async () => {
    const { cookie, projectId } = await seedListFixture("bad");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?store=NOPE`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects autoRenew=on (not a boolish enum)", async () => {
    const { cookie, projectId } = await seedListFixture("badbool");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?autoRenew=on`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 4: Run the new tests**

```bash
pnpm --filter @rovenue/api test subscriptions.integration -- --run
```

Expected: all new cases PASS. If a case fails because the `purchases` row insert is missing some `NOT NULL` column you didn't seed, copy the missing column default from a passing existing test in the file (the grant tests) and update the helper. Do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/subscriptions.integration.test.ts
git commit -m "test(api): list endpoint filter + sort + cursor coverage"
```

---

## Task 6: Dashboard hook — extend `useProjectSubscriptions`

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts`

- [ ] **Step 1: Replace the top of the file** (imports + `useProjectSubscriptions` block)

Find:

```ts
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  BillingIssuesResponse,
  RenewalCalendarResponse,
  SubscriptionScopeName,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

interface ListParams {
  projectId: string;
  scope: SubscriptionScopeName;
  search?: string;
  limit?: number;
}

export function useProjectSubscriptions({ projectId, scope, search, limit }: ListParams) {
  return useInfiniteQuery({
    queryKey: ["subscriptions", "list", projectId, scope, search ?? "", limit],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SubscriptionsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (limit) params.set("limit", String(limit));
      if (search) params.set("search", search);
      if (pageParam) params.set("cursor", pageParam);
      return api<SubscriptionsListResponse>(
        `/dashboard/projects/${projectId}/subscriptions?${params.toString()}`,
      );
    },
  });
}
```

Replace with:

```ts
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  BillingIssuesResponse,
  RenewalCalendarResponse,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

export interface SubscriptionsListParams {
  projectId: string;
  scope: SubscriptionScopeName;
  sort: SubscriptionSortKey;
  search?: string;
  limit?: number;
  store?: ReadonlyArray<SubscriptionStoreCode>;
  productId?: ReadonlyArray<string>;
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
}

// Stable, normalized key shape for React Query — alphabetized arrays so
// equivalent filter sets share a cache entry.
function normalizedKey(p: SubscriptionsListParams) {
  return {
    scope: p.scope,
    sort: p.sort,
    search: p.search ?? "",
    limit: p.limit ?? null,
    store: p.store && p.store.length > 0 ? [...p.store].sort() : null,
    productId: p.productId && p.productId.length > 0 ? [...p.productId].sort() : null,
    autoRenew: p.autoRenew ?? null,
    isTrial: p.isTrial ?? null,
    isIntro: p.isIntro ?? null,
    hasIssue: p.hasIssue ?? null,
    purchasedFrom: p.purchasedFrom ?? null,
    purchasedTo: p.purchasedTo ?? null,
    expiresFrom: p.expiresFrom ?? null,
    expiresTo: p.expiresTo ?? null,
  };
}

function buildListParams(p: SubscriptionsListParams, cursor?: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set("scope", p.scope);
  params.set("sort", p.sort);
  if (p.limit) params.set("limit", String(p.limit));
  if (p.search) params.set("search", p.search);
  if (p.store && p.store.length > 0) params.set("store", p.store.join(","));
  if (p.productId && p.productId.length > 0)
    params.set("productId", p.productId.join(","));
  if (p.autoRenew !== undefined) params.set("autoRenew", String(p.autoRenew));
  if (p.isTrial !== undefined) params.set("isTrial", String(p.isTrial));
  if (p.isIntro !== undefined) params.set("isIntro", String(p.isIntro));
  if (p.hasIssue) params.set("hasIssue", "true");
  if (p.purchasedFrom) params.set("purchasedFrom", p.purchasedFrom);
  if (p.purchasedTo) params.set("purchasedTo", p.purchasedTo);
  if (p.expiresFrom) params.set("expiresFrom", p.expiresFrom);
  if (p.expiresTo) params.set("expiresTo", p.expiresTo);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export function useProjectSubscriptions(p: SubscriptionsListParams) {
  return useInfiniteQuery({
    queryKey: ["subscriptions", "list", p.projectId, normalizedKey(p)],
    enabled: Boolean(p.projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SubscriptionsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = buildListParams(p, pageParam).toString();
      return api<SubscriptionsListResponse>(
        `/dashboard/projects/${p.projectId}/subscriptions?${qs}`,
      );
    },
  });
}
```

(Leave the rest of the file — `useProjectSubscriptionsKpis`, etc. — untouched.)

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck 2>&1 | head -30
```

Expected: failures only in `subscriptions.tsx` (it still calls `useProjectSubscriptions` with the old shape). That's fine — Task 9 will fix it.

---

## Task 7: SubscriptionsTable — sortable headers

**Files:**
- Modify: `apps/dashboard/src/components/subscriptions/subscriptions-table.tsx`

- [ ] **Step 1: Replace the file**

```tsx
import { Fragment } from "react";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubscriptionSortKey } from "@rovenue/shared";
import { Checkbox } from "../../ui/checkbox";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../subscribers/user-avatar";
import { CountdownCell } from "./countdown-cell";
import { ExpandedRow } from "./expanded-row";
import { LifecycleStrip } from "./lifecycle-strip";
import { StoreChip } from "./store-chip";
import { SubscriptionStatusChip } from "./subscription-status-chip";
import type { Subscription } from "./types";

export type SortColumn = "started" | "renews" | "price" | "status";

const COLUMN_KEYS: Record<SortColumn, { asc: SubscriptionSortKey; desc: SubscriptionSortKey; defaultDir: "asc" | "desc" }> = {
  started: { asc: "started_asc", desc: "started_desc", defaultDir: "desc" },
  renews: { asc: "renews_asc", desc: "renews_desc", defaultDir: "asc" },
  price: { asc: "price_asc", desc: "price_desc", defaultDir: "desc" },
  status: { asc: "status", desc: "status", defaultDir: "asc" },
};

function currentColumn(sort: SubscriptionSortKey): SortColumn | null {
  for (const col of Object.keys(COLUMN_KEYS) as SortColumn[]) {
    if (COLUMN_KEYS[col].asc === sort || COLUMN_KEYS[col].desc === sort) return col;
  }
  return null;
}

function currentDirection(sort: SubscriptionSortKey): "asc" | "desc" {
  return sort.endsWith("_asc") ? "asc" : "desc";
}

function nextSort(sort: SubscriptionSortKey, target: SortColumn): SubscriptionSortKey {
  const col = currentColumn(sort);
  if (col === target) {
    return currentDirection(sort) === "asc" ? COLUMN_KEYS[target].desc : COLUMN_KEYS[target].asc;
  }
  return COLUMN_KEYS[target].defaultDir === "asc"
    ? COLUMN_KEYS[target].asc
    : COLUMN_KEYS[target].desc;
}

type Props = {
  subscriptions: ReadonlyArray<Subscription>;
  selectedIds: ReadonlySet<string>;
  expandedId: string | null;
  sort: SubscriptionSortKey;
  onSortChange: (next: SubscriptionSortKey) => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onToggleExpand: (id: string) => void;
};

export function SubscriptionsTable({
  subscriptions,
  selectedIds,
  expandedId,
  sort,
  onSortChange,
  onToggleSelect,
  onToggleSelectAll,
  onToggleExpand,
}: Props) {
  const { t } = useTranslation();
  const allChecked =
    subscriptions.length > 0 && subscriptions.every((s) => selectedIds.has(s.id));
  const someChecked =
    !allChecked && subscriptions.some((s) => selectedIds.has(s.id));
  const activeCol = currentColumn(sort);
  const activeDir = currentDirection(sort);

  return (
    <div className="overflow-x-auto rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full min-w-[1100px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-rv-divider text-left">
            <th className="w-7 px-3 py-2.5" />
            <th className="w-8 px-3 py-2.5">
              <Checkbox
                checked={allChecked}
                indeterminate={someChecked}
                onChange={onToggleSelectAll}
                ariaLabel={t("subscriptions.table.selectAll")}
              />
            </th>
            <Th>{t("subscriptions.table.subscription")}</Th>
            <Th>{t("subscriptions.table.user")}</Th>
            <Th>{t("subscriptions.table.product")}</Th>
            <SortableTh
              label={t("subscriptions.table.status")}
              column="status"
              active={activeCol === "status"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "status"))}
            />
            <Th>{t("subscriptions.table.store")}</Th>
            <SortableTh
              label={t("subscriptions.table.price")}
              column="price"
              active={activeCol === "price"}
              direction={activeDir}
              align="right"
              onClick={() => onSortChange(nextSort(sort, "price"))}
            />
            <SortableTh
              label={t("subscriptions.table.term")}
              column="started"
              active={activeCol === "started"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "started"))}
            />
            <Th>{t("subscriptions.table.lifecycle")}</Th>
            <SortableTh
              label={t("subscriptions.table.nextEvent")}
              column="renews"
              active={activeCol === "renews"}
              direction={activeDir}
              onClick={() => onSortChange(nextSort(sort, "renews"))}
            />
          </tr>
        </thead>

        <tbody>
          {subscriptions.length === 0 && (
            <tr>
              <td colSpan={11} className="px-6 py-12 text-center">
                <p className="text-[13px] text-rv-mute-500">
                  {t("subscriptions.table.empty")}
                </p>
              </td>
            </tr>
          )}

          {subscriptions.map((sub) => {
            const isExpanded = expandedId === sub.id;
            return (
              <Fragment key={sub.id}>
                <tr
                  onClick={() => onToggleExpand(sub.id)}
                  className={cn(
                    "cursor-pointer border-b border-white/[0.03] transition hover:bg-rv-c2",
                    isExpanded && "bg-rv-c2",
                  )}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-flex size-5 items-center justify-center text-rv-mute-500 transition",
                        isExpanded && "rotate-90 text-rv-accent-400",
                      )}
                    >
                      <ChevronRight size={13} />
                    </span>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(sub.id)}
                      onChange={() => onToggleSelect(sub.id)}
                      ariaLabel={t("subscriptions.table.selectRow", { id: sub.id })}
                    />
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="font-rv-mono text-[12px] font-medium">{sub.id}</div>
                    <div className="font-rv-mono text-[10px] text-rv-mute-500">
                      {sub.autoRenew
                        ? t("subscriptions.table.autoRenew")
                        : t("subscriptions.table.manual")}
                      {sub.intro && ` · ${t("subscriptions.table.intro")}`}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2 font-rv-mono text-[12px]">
                      <UserAvatar fullId={sub.user} size="sm" className="size-[22px] text-[9px]" />
                      <span className="truncate">{sub.user}</span>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 font-rv-mono text-[12px]">{sub.product}</td>

                  <td className="px-3 py-2.5">
                    <div className="inline-flex items-center gap-1">
                      <SubscriptionStatusChip status={sub.status} />
                      {sub.lastIssue && (
                        <Chip tone="danger" aria-label={sub.lastIssue}>!</Chip>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2.5">
                    <StoreChip store={sub.store} />
                  </td>

                  <td className="px-3 py-2.5 text-right font-rv-mono text-[12px] tabular-nums">
                    ${sub.price.toFixed(2)}
                    <span className="ml-0.5 text-rv-mute-500">/{sub.billingCycle[0]}</span>
                  </td>

                  <td className="px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-600">
                    {sub.term}
                  </td>

                  <td className="px-3 py-2.5">
                    <LifecycleStrip pct={sub.renewsPct} hasIssue={!!sub.lastIssue} />
                  </td>

                  <td className="px-3 py-2.5">
                    <CountdownCell sub={sub} />
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="border-y border-rv-divider bg-rv-c2">
                    <td colSpan={11} className="p-0">
                      <ExpandedRow sub={sub} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {subscriptions.length > 0 && (
        <div className="flex items-center justify-between border-t border-rv-divider px-3 py-2 text-[11px] text-rv-mute-500">
          <span className="inline-flex items-center gap-1.5 font-rv-mono">
            <RefreshCw size={11} className="text-rv-mute-500" />
            {t("subscriptions.table.footerHint")}
          </span>
          <span className="font-rv-mono">
            {t("subscriptions.table.rowCount", { count: subscriptions.length })}
          </span>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-rv-divider px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function SortableTh({
  label,
  column,
  active,
  direction,
  align,
  onClick,
}: {
  label: string;
  column: SortColumn;
  active: boolean;
  direction: "asc" | "desc";
  align?: "right";
  onClick: () => void;
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap border-b border-rv-divider px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" && "text-right",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`Sort by ${column}`}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 transition hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? (
          direction === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />
        ) : (
          <ChevronDown size={11} className="opacity-30" />
        )}
      </button>
    </th>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck 2>&1 | head -30
```

Expected: route file still failing (Task 9), but this file clean.

---

## Task 8: New `FilterToolbar` component

**Files:**
- Create: `apps/dashboard/src/components/subscriptions/filter-toolbar.tsx`
- Modify: `apps/dashboard/src/components/subscriptions/index.ts`

- [ ] **Step 1: Read** `apps/dashboard/src/components/transactions/tx-filter-bar.tsx` to see the existing `FilterPill` + click-away popover composition. We mirror its style.

- [ ] **Step 2: Create the file**

```tsx
// apps/dashboard/src/components/subscriptions/filter-toolbar.tsx
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubscriptionStoreCode } from "@rovenue/shared";
import { FilterPill } from "../subscribers/filter-pill";
import { cn } from "../../lib/cn";

// Public value object — owned by the route, passed in.
export interface SubscriptionsFilterValue {
  search: string;
  store: ReadonlyArray<SubscriptionStoreCode>;
  productId: ReadonlyArray<string>;
  autoRenew: boolean | undefined;
  isTrial: boolean | undefined;
  isIntro: boolean | undefined;
  hasIssue: boolean;
  purchasedFrom: string | undefined;
  purchasedTo: string | undefined;
  expiresFrom: string | undefined;
  expiresTo: string | undefined;
}

export interface ProductOption {
  id: string;
  label: string;
}

type Props = {
  value: SubscriptionsFilterValue;
  onChange: (next: SubscriptionsFilterValue) => void;
  products: ReadonlyArray<ProductOption>;
  visible: number;
  total: number;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
};

const STORE_OPTIONS: ReadonlyArray<SubscriptionStoreCode> = [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "WEB",
  "MANUAL",
];

export function FilterToolbar({
  value,
  onChange,
  products,
  visible,
  total,
  searchInputRef,
}: Props) {
  const { t } = useTranslation();
  const hasAny =
    value.search.length > 0 ||
    value.store.length > 0 ||
    value.productId.length > 0 ||
    value.autoRenew !== undefined ||
    value.isTrial !== undefined ||
    value.isIntro !== undefined ||
    value.hasIssue ||
    Boolean(value.purchasedFrom || value.purchasedTo || value.expiresFrom || value.expiresTo);

  const patch = (p: Partial<SubscriptionsFilterValue>) => onChange({ ...value, ...p });

  const clearAll = () =>
    onChange({
      search: "",
      store: [],
      productId: [],
      autoRenew: undefined,
      isTrial: undefined,
      isIntro: undefined,
      hasIssue: false,
      purchasedFrom: undefined,
      purchasedTo: undefined,
      expiresFrom: undefined,
      expiresTo: undefined,
    });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5">
      <label className="flex h-[26px] min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
        <Search size={12} className="text-rv-mute-500" />
        <input
          ref={searchInputRef}
          value={value.search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder={t("subscriptions.filters.searchPlaceholder")}
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
        />
        {value.search ? (
          <button
            type="button"
            onClick={() => patch({ search: "" })}
            aria-label={t("subscriptions.filters.clearSearch")}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
          >
            <X size={11} />
          </button>
        ) : null}
      </label>

      <StoreFilter value={value.store} onChange={(store) => patch({ store })} />
      <ProductFilter
        value={value.productId}
        onChange={(productId) => patch({ productId })}
        options={products}
      />
      <AutoRenewFilter
        value={value.autoRenew}
        onChange={(autoRenew) => patch({ autoRenew })}
      />
      <MoreFiltersPopover value={value} onChange={onChange} />

      {hasAny ? (
        <FilterPill onClick={clearAll}>
          <X size={10} />
          {t("subscriptions.filters.clearAll")}
        </FilterPill>
      ) : null}

      <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
        {t("subscriptions.filters.showing", {
          visible: visible.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// click-away helper (mirrors transactions module)
// ---------------------------------------------------------------------------

function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onAway]);
  return ref;
}

// ---------------------------------------------------------------------------
// Individual filter pieces
// ---------------------------------------------------------------------------

function StoreFilter({
  value,
  onChange,
}: {
  value: ReadonlyArray<SubscriptionStoreCode>;
  onChange: (next: ReadonlyArray<SubscriptionStoreCode>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const toggle = (s: SubscriptionStoreCode) =>
    onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.store")}{" "}
        <span className="font-medium text-foreground">
          {value.length > 0 ? value.length : t("subscriptions.filters.any")}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[200px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          {STORE_OPTIONS.map((s) => (
            <label
              key={s}
              className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[12px] hover:bg-rv-c2"
            >
              <input
                type="checkbox"
                checked={value.includes(s)}
                onChange={() => toggle(s)}
              />
              {t(`subscriptions.filters.storeLabels.${s}`)}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductFilter({
  value,
  onChange,
  options,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<string>) => void;
  options: ReadonlyArray<ProductOption>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useClickAway(() => setOpen(false));
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={value.length > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.product")}{" "}
        <span className="font-medium text-foreground">
          {value.length > 0 ? value.length : t("subscriptions.filters.any")}
        </span>
      </FilterPill>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-[260px] rounded-md border border-rv-divider bg-rv-c1 p-2 shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("subscriptions.filters.productSearch")}
            className="mb-1.5 h-7 w-full rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
          />
          <div className="max-h-[200px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-1 text-[12px] text-rv-mute-500">
                {t("subscriptions.filters.noResults")}
              </div>
            ) : (
              filtered.map((opt) => (
                <label
                  key={opt.id}
                  className="flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-[12px] hover:bg-rv-c2"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(opt.id)}
                    onChange={() => toggle(opt.id)}
                  />
                  <span className="truncate">{opt.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AutoRenewFilter({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}) {
  const { t } = useTranslation();
  const next = () => {
    if (value === undefined) onChange(true);
    else if (value === true) onChange(false);
    else onChange(undefined);
  };
  return (
    <FilterPill active={value !== undefined} onClick={next}>
      {t("subscriptions.filters.autoRenew")}{" "}
      <span className="font-medium text-foreground">
        {value === undefined
          ? t("subscriptions.filters.any")
          : value
            ? t("subscriptions.filters.on")
            : t("subscriptions.filters.off")}
      </span>
    </FilterPill>
  );
}

function MoreFiltersPopover({
  value,
  onChange,
}: {
  value: SubscriptionsFilterValue;
  onChange: (next: SubscriptionsFilterValue) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useClickAway(() => setOpen(false));
  const activeCount =
    (value.isTrial !== undefined ? 1 : 0) +
    (value.isIntro !== undefined ? 1 : 0) +
    (value.hasIssue ? 1 : 0) +
    (value.purchasedFrom || value.purchasedTo ? 1 : 0) +
    (value.expiresFrom || value.expiresTo ? 1 : 0);

  return (
    <div ref={ref} className="relative">
      <FilterPill active={activeCount > 0} onClick={() => setOpen((o) => !o)}>
        {t("subscriptions.filters.more")}{" "}
        {activeCount > 0 ? (
          <span className="font-medium text-foreground">{activeCount}</span>
        ) : null}
      </FilterPill>
      {open ? (
        <div className="absolute right-0 top-full z-10 mt-1 w-[320px] rounded-md border border-rv-divider bg-rv-c1 p-3 shadow-lg">
          <FlagToggle
            label={t("subscriptions.filters.isTrial")}
            value={value.isTrial}
            onChange={(v) => onChange({ ...value, isTrial: v })}
          />
          <FlagToggle
            label={t("subscriptions.filters.isIntro")}
            value={value.isIntro}
            onChange={(v) => onChange({ ...value, isIntro: v })}
          />
          <FlagToggle
            label={t("subscriptions.filters.hasIssue")}
            value={value.hasIssue ? true : undefined}
            onChange={(v) => onChange({ ...value, hasIssue: v === true })}
          />
          <hr className="my-2 border-rv-divider" />
          <DateRange
            label={t("subscriptions.filters.purchasedRange")}
            from={value.purchasedFrom}
            to={value.purchasedTo}
            onChange={(f, t_) => onChange({ ...value, purchasedFrom: f, purchasedTo: t_ })}
          />
          <DateRange
            label={t("subscriptions.filters.expiresRange")}
            from={value.expiresFrom}
            to={value.expiresTo}
            onChange={(f, t_) => onChange({ ...value, expiresFrom: f, expiresTo: t_ })}
          />
        </div>
      ) : null}
    </div>
  );
}

function FlagToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px]">
      <span>{label}</span>
      <div className="flex gap-1">
        {(["any", true, false] as const).map((v) => {
          const target = v === "any" ? undefined : v;
          const active = value === target;
          return (
            <button
              key={String(v)}
              type="button"
              onClick={() => onChange(target)}
              className={cn(
                "h-6 cursor-pointer rounded-md px-2 text-[11px]",
                active
                  ? "bg-rv-accent-500/15 text-rv-accent-400 border border-rv-accent-500/45"
                  : "bg-rv-c2 text-rv-mute-700 border border-rv-divider",
              )}
            >
              {v === "any" ? "—" : v ? "On" : "Off"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateRange({
  label,
  from,
  to,
  onChange,
}: {
  label: string;
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  return (
    <div className="py-1">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-rv-mute-500">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange(e.target.value || undefined, to)}
          className="h-7 flex-1 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
        />
        <span className="text-rv-mute-500">–</span>
        <input
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange(from, e.target.value || undefined)}
          className="h-7 flex-1 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] outline-none focus:border-rv-accent-500"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Barrel re-export**

Open `apps/dashboard/src/components/subscriptions/index.ts` and add:

```ts
export { FilterToolbar } from "./filter-toolbar";
export type { SubscriptionsFilterValue, ProductOption } from "./filter-toolbar";
```

- [ ] **Step 4: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck 2>&1 | head -30
```

Expected: only `subscriptions.tsx` still failing — Task 9 fixes it.

---

## Task 9: Rewire `subscriptions.tsx` route

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx`

- [ ] **Step 1: Replace the whole file with the rewired version**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CalendarDays, Download, Plus } from "lucide-react";
import type {
  SubscriptionRow,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionUiStatus,
  SubscriptionsCompositionResponse,
} from "@rovenue/shared";
import { subscriptionSortKeys, subscriptionStoreCodes } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  CompositionBar,
  FilterToolbar,
  SCOPE_COUNTS,
  SUBSCRIPTIONS,
  ScopeTabs,
  SubscriptionsTable,
  type CompositionSegment,
  type ProductOption,
  type Subscription,
  type SubscriptionScope,
  type SubscriptionStatus,
  type SubscriptionStore,
  type SubscriptionsFilterValue,
} from "../../../../components/subscriptions";
import {
  useProjectSubscriptions,
  useProjectSubscriptionsComposition,
  useProjectSubscriptionsKpis,
} from "../../../../lib/hooks/useProjectSubscriptions";
import { useProjectProducts } from "../../../../lib/hooks/useProjectProducts";

// =============================================================
// URL search-param schema
// =============================================================

const SCOPE_VALUES: ReadonlyArray<SubscriptionScopeName> = [
  "all",
  "active",
  "trial",
  "grace",
  "canceling",
  "issues",
  "churned",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SubsSearch {
  scope: SubscriptionScopeName;
  q?: string;
  store?: SubscriptionStoreCode[];
  productId?: string[];
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
  sort: SubscriptionSortKey;
}

function parseScope(raw: unknown): SubscriptionScopeName {
  return typeof raw === "string" && (SCOPE_VALUES as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriptionScopeName)
    : "all";
}

function parseSort(raw: unknown): SubscriptionSortKey {
  return typeof raw === "string" && (subscriptionSortKeys as ReadonlyArray<string>).includes(raw)
    ? (raw as SubscriptionSortKey)
    : "started_desc";
}

function parseStores(raw: unknown): SubscriptionStoreCode[] | undefined {
  const cands = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const allowed = new Set(subscriptionStoreCodes as ReadonlyArray<string>);
  const out = cands
    .map((s) => String(s).trim().toUpperCase())
    .filter((s): s is SubscriptionStoreCode => allowed.has(s));
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function parseIds(raw: unknown): string[] | undefined {
  const cands = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.length > 0
      ? raw.split(",")
      : [];
  const out = cands.map((s) => String(s).trim()).filter((s) => s.length > 0);
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function parseBool(raw: unknown): boolean | undefined {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return undefined;
}

function parseDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) return undefined;
  return Number.isNaN(new Date(raw).getTime()) ? undefined : raw;
}

export const Route = createFileRoute("/_authed/projects/$projectId/subscriptions")({
  validateSearch: (raw: Record<string, unknown>): SubsSearch => ({
    scope: parseScope(raw.scope),
    q: typeof raw.q === "string" && raw.q.length > 0 ? raw.q : undefined,
    store: parseStores(raw.store),
    productId: parseIds(raw.productId),
    autoRenew: parseBool(raw.autoRenew),
    isTrial: parseBool(raw.isTrial),
    isIntro: parseBool(raw.isIntro),
    hasIssue: raw.hasIssue === true || raw.hasIssue === "true" ? true : undefined,
    purchasedFrom: parseDate(raw.purchasedFrom),
    purchasedTo: parseDate(raw.purchasedTo),
    expiresFrom: parseDate(raw.expiresFrom),
    expiresTo: parseDate(raw.expiresTo),
    sort: parseSort(raw.sort),
  }),
  component: SubscriptionsRouteComponent,
});

const TOTAL_FALLBACK = 21117;

function SubscriptionsRouteComponent() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/subscriptions" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <SubscriptionsPage projectId={projectId} />;
}

// =============================================================
// Wire → UI adapters (unchanged)
// =============================================================

const UI_STATUS_MAP: Record<SubscriptionUiStatus, SubscriptionStatus> = {
  active: "active",
  trial: "trial",
  grace: "grace",
  canceling: "canceling",
  churned: "churned",
};

const STORE_MAP: Record<string, SubscriptionStore> = {
  APP_STORE: "ios", APPLE: "ios", IOS: "ios",
  PLAY_STORE: "play", GOOGLE: "play", PLAY: "play",
  STRIPE: "stripe", WEB: "web", MANUAL: "web",
};

function mapStore(raw: string): SubscriptionStore {
  return STORE_MAP[raw.toUpperCase()] ?? "web";
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.round((t - nowMs) / DAY_MS);
}

function termDescriptor(row: SubscriptionRow, t: ReturnType<typeof useTranslation>["t"]): string {
  if (row.isTrial) return t("subscriptions.term.trial", { defaultValue: "Trial" });
  if (row.cancellationDate) {
    const ends = new Date(row.cancellationDate);
    return t("subscriptions.term.ends", {
      defaultValue: `Ends ${ends.toLocaleDateString()}`,
      date: ends.toLocaleDateString(),
    });
  }
  return t("subscriptions.term.recurring", { defaultValue: "Recurring" });
}

const COMPOSITION_COLOR: Record<SubscriptionUiStatus, string> = {
  active: "var(--color-rv-accent-500)",
  trial: "var(--color-rv-success)",
  canceling: "var(--color-rv-warning)",
  grace: "var(--color-rv-danger)",
  churned: "var(--color-rv-mute-600)",
};

function toUiSubscription(row: SubscriptionRow, nowMs: number, t: ReturnType<typeof useTranslation>["t"]): Subscription {
  const price = row.priceAmount !== null ? Number(row.priceAmount) : 0;
  const renewsIn = daysUntil(row.expiresDate ?? row.gracePeriodExpires, nowMs);
  return {
    id: row.id,
    user: shortId(row.subscriberId),
    product: row.productName ?? row.productIdentifier ?? row.productId,
    status: UI_STATUS_MAP[row.status],
    store: mapStore(row.store),
    price: Number.isFinite(price) ? price : 0,
    billingCycle: "monthly",
    started: row.purchaseDate.slice(0, 10),
    renewsIn,
    renewsPct: Math.max(0, Math.min(100, ((renewsIn + 30) / 60) * 100)),
    autoRenew: row.autoRenew ?? false,
    term: termDescriptor(row, t),
    trialDays: row.isTrial ? 7 : 0,
    intro: row.isIntroOffer,
    cancelPolicy:
      row.status === "canceling"
        ? "user_canceled"
        : row.status === "grace"
          ? "billing_retry"
          : "none",
    entitlements: [],
    lastIssue: row.hasIssue ? "Renewal pending" : undefined,
  };
}

function toCompositionSegments(
  response: SubscriptionsCompositionResponse | undefined,
): ReadonlyArray<CompositionSegment> | undefined {
  if (!response || response.total === 0) return undefined;
  return response.segments
    .filter((s) => s.count > 0)
    .map((s) => {
      const key: CompositionSegment["key"] = s.key === "churned" ? "active" : s.key;
      return { key, count: s.count, share: `${s.share.toFixed(1)}%`, color: COMPOSITION_COLOR[s.key] };
    });
}

// =============================================================
// Page
// =============================================================

function SubscriptionsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  // Debounced search input → URL
  const [searchInput, setSearchInput] = useState(search.q ?? "");
  useEffect(() => setSearchInput(search.q ?? ""), [search.q]);
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      void navigate({
        search: (prev) => ({ ...prev, q: trimmed.length > 0 ? trimmed : undefined }),
        replace: true,
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, navigate]);

  // Hook params derived from URL search params (skip the local searchInput).
  const list = useProjectSubscriptions({
    projectId,
    scope: search.scope,
    sort: search.sort,
    search: search.q,
    store: search.store as ReadonlyArray<SubscriptionStoreCode> | undefined,
    productId: search.productId,
    autoRenew: search.autoRenew,
    isTrial: search.isTrial,
    isIntro: search.isIntro,
    hasIssue: search.hasIssue,
    purchasedFrom: search.purchasedFrom,
    purchasedTo: search.purchasedTo,
    expiresFrom: search.expiresFrom,
    expiresTo: search.expiresTo,
  });
  const kpis = useProjectSubscriptionsKpis(projectId);
  const composition = useProjectSubscriptionsComposition(projectId);
  // First page only — product picker doesn't need to walk the cursor.
  const productList = useProjectProducts({ projectId, includeInactive: false, limit: 100 });

  const nowMs = useMemo(() => Date.now(), [list.dataUpdatedAt]);

  const realRows = useMemo<ReadonlyArray<Subscription> | null>(() => {
    const pages = list.data?.pages;
    if (!pages || pages.length === 0) return null;
    return pages.flatMap((p) => p.rows.map((row) => toUiSubscription(row, nowMs, t)));
  }, [list.data, nowMs, t]);

  const rows: ReadonlyArray<Subscription> = realRows ?? SUBSCRIPTIONS;

  const productOptions: ReadonlyArray<ProductOption> = useMemo(() => {
    const first = productList.data?.pages?.[0];
    if (!first) return [];
    return first.rows.map((p) => ({ id: p.id, label: p.displayName }));
  }, [productList.data]);

  const filterValue: SubscriptionsFilterValue = useMemo(
    () => ({
      search: searchInput,
      store: (search.store ?? []) as ReadonlyArray<SubscriptionStoreCode>,
      productId: search.productId ?? [],
      autoRenew: search.autoRenew,
      isTrial: search.isTrial,
      isIntro: search.isIntro,
      hasIssue: search.hasIssue === true,
      purchasedFrom: search.purchasedFrom,
      purchasedTo: search.purchasedTo,
      expiresFrom: search.expiresFrom,
      expiresTo: search.expiresTo,
    }),
    [search, searchInput],
  );

  const onFilterChange = (next: SubscriptionsFilterValue) => {
    setSearchInput(next.search);
    void navigate({
      search: (prev) => ({
        ...prev,
        // search is debounced via the useEffect above; don't write it here.
        store: next.store.length > 0 ? [...next.store] : undefined,
        productId: next.productId.length > 0 ? [...next.productId] : undefined,
        autoRenew: next.autoRenew,
        isTrial: next.isTrial,
        isIntro: next.isIntro,
        hasIssue: next.hasIssue ? true : undefined,
        purchasedFrom: next.purchasedFrom,
        purchasedTo: next.purchasedTo,
        expiresFrom: next.expiresFrom,
        expiresTo: next.expiresTo,
      }),
      replace: true,
    });
  };

  const onScopeChange = (scope: SubscriptionScope) =>
    void navigate({ search: (prev) => ({ ...prev, scope }), replace: false });

  const onSortChange = (sort: SubscriptionSortKey) =>
    void navigate({ search: (prev) => ({ ...prev, sort }), replace: false });

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (rows.length === 0) return;
    if (rows.every((s) => selectedIds.has(s.id))) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((s) => s.id)));
  };

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  // Press `/` to focus the search input
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const input = searchInputRef.current;
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const kpiTotalActive = kpis.data?.totalActive ?? 20721;
  const kpiRenewing = kpis.data?.renewing7 ?? 2184;
  const kpiGrace = kpis.data?.graceRetry ?? 84;
  const kpiCanceling = kpis.data?.canceling ?? 312;

  const compositionSegments = toCompositionSegments(composition.data);
  const compositionTotal = composition.data?.total;
  const totalForFilterBar = composition.data?.total ?? realRows?.length ?? TOTAL_FALLBACK;

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">{t("subscriptions.title")}</h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">{t("subscriptions.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm"><CalendarDays size={13} />{t("subscriptions.actions.schedule")}</Button>
          <Button variant="flat" size="sm"><Download size={13} />{t("subscriptions.actions.exportCsv")}</Button>
          <Button variant="solid-primary" size="sm"><Plus size={13} />{t("subscriptions.actions.newSubscription")}</Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("subscriptions.kpi.totalActive")} value={kpiTotalActive.toLocaleString()} description={t("subscriptions.kpi.totalActiveDelta")} descriptionTone="success" />
        <StatCard label={t("subscriptions.kpi.renewing7")} value={kpiRenewing.toLocaleString()} description={t("subscriptions.kpi.renewing7Description")} />
        <StatCard label={t("subscriptions.kpi.graceRetry")} value={<span className="text-rv-warning">{kpiGrace.toLocaleString()}</span>} description={t("subscriptions.kpi.graceRetryDescription")} />
        <StatCard label={t("subscriptions.kpi.canceling")} value={<span>{kpiCanceling.toLocaleString()}</span>} description={t("subscriptions.kpi.cancelingDescription")} descriptionTone="danger" />
      </div>

      <div className="mb-4">
        <CompositionBar
          updatedLabel={t("subscriptions.live.updated", { value: "12s" })}
          segments={compositionSegments}
          total={compositionTotal}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ScopeTabs value={search.scope as SubscriptionScope} onChange={onScopeChange} counts={SCOPE_COUNTS} />
      </div>

      <FilterToolbar
        value={filterValue}
        onChange={onFilterChange}
        products={productOptions}
        visible={rows.length}
        total={totalForFilterBar}
        searchInputRef={searchInputRef}
      />

      <SubscriptionsTable
        subscriptions={rows}
        selectedIds={selectedIds}
        expandedId={expandedId}
        sort={search.sort}
        onSortChange={onSortChange}
        onToggleSelect={toggleOne}
        onToggleSelectAll={toggleAll}
        onToggleExpand={toggleExpand}
      />

      {list.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="flat"
            size="sm"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck 2>&1 | head -30
```

Expected: exits 0. If a sibling component (`SubscriptionScope`, `SCOPE_COUNTS`) was imported through a barrel and complains about removed re-exports, open `apps/dashboard/src/components/subscriptions/index.ts` and confirm `FilterToolbar` is exported. Do not remove `RenewalCalendar`, `BillingIssuesPanel`, `CohortRetentionPanel` from the barrel — they're still exported, just not mounted here.

- [ ] **Step 3: Commit**

```bash
git add \
  apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts \
  apps/dashboard/src/components/subscriptions/subscriptions-table.tsx \
  apps/dashboard/src/components/subscriptions/filter-toolbar.tsx \
  apps/dashboard/src/components/subscriptions/index.ts \
  apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx
git commit -m "feat(dashboard): refocus subscriptions page on view + real filters/sort"
```

---

## Task 10: i18n keys

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Modify: `apps/dashboard/src/i18n/locales/tr.json`

- [ ] **Step 1: Locate the existing `subscriptions.filters` block in both files**

```bash
grep -n '"filters"' apps/dashboard/src/i18n/locales/en.json
grep -n '"filters"' apps/dashboard/src/i18n/locales/tr.json
```

- [ ] **Step 2: Replace the `filters` block in `en.json`** with these keys (merge — keep any existing siblings that aren't listed here)

```json
"filters": {
  "searchPlaceholder": "Search subscription ID, user, transaction ID",
  "clearSearch": "Clear search",
  "store": "Store",
  "storeLabels": {
    "APP_STORE": "App Store",
    "PLAY_STORE": "Play Store",
    "STRIPE": "Stripe",
    "WEB": "Web",
    "MANUAL": "Manual"
  },
  "product": "Product",
  "productSearch": "Search products",
  "noResults": "No matches",
  "autoRenew": "Auto-renew",
  "any": "Any",
  "on": "On",
  "off": "Off",
  "more": "More filters",
  "isTrial": "Trial",
  "isIntro": "Intro offer",
  "hasIssue": "Has issue",
  "purchasedRange": "Purchased",
  "expiresRange": "Expires",
  "clearAll": "Clear all",
  "showing": "{{visible}} of {{total}}"
}
```

- [ ] **Step 3: Replace the `filters` block in `tr.json`**

```json
"filters": {
  "searchPlaceholder": "Abonelik ID, kullanıcı, transaction ID",
  "clearSearch": "Aramayı temizle",
  "store": "Mağaza",
  "storeLabels": {
    "APP_STORE": "App Store",
    "PLAY_STORE": "Play Store",
    "STRIPE": "Stripe",
    "WEB": "Web",
    "MANUAL": "Manuel"
  },
  "product": "Ürün",
  "productSearch": "Ürün ara",
  "noResults": "Sonuç yok",
  "autoRenew": "Oto-yenileme",
  "any": "Hepsi",
  "on": "Açık",
  "off": "Kapalı",
  "more": "Daha fazla filtre",
  "isTrial": "Deneme",
  "isIntro": "Intro teklifi",
  "hasIssue": "Sorunlu",
  "purchasedRange": "Satın alma",
  "expiresRange": "Bitiş",
  "clearAll": "Temizle",
  "showing": "{{visible}} / {{total}}"
}
```

- [ ] **Step 4: Quick smoke**

```bash
pnpm --filter @rovenue/dashboard build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json apps/dashboard/src/i18n/locales/tr.json
git commit -m "feat(dashboard): i18n keys for subscriptions filter toolbar"
```

---

## Task 11: Dashboard unit tests — sortable Th + FilterToolbar

**Files:**
- Create: `apps/dashboard/tests/components/subscriptions-table-sort.test.tsx`
- Create: `apps/dashboard/tests/components/filter-toolbar.test.tsx`

- [ ] **Step 1: Read** `apps/dashboard/tests/components/app-switcher.test.tsx` to see the `I18nextProvider` + `QueryClientProvider` + `vi.mock("@tanstack/react-router", …)` wrapper pattern used by this codebase. The new tests mirror it.

- [ ] **Step 2: Write the SubscriptionsTable sort test**

```tsx
// apps/dashboard/tests/components/subscriptions-table-sort.test.tsx
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { SubscriptionsTable } from "../../src/components/subscriptions/subscriptions-table";
import type { Subscription } from "../../src/components/subscriptions/types";

const SUB: Subscription = {
  id: "p_demo",
  user: "u_demo",
  product: "Pro",
  status: "active",
  store: "stripe",
  price: 9.99,
  billingCycle: "monthly",
  started: "2026-01-01",
  renewsIn: 10,
  renewsPct: 50,
  autoRenew: true,
  term: "Recurring",
  trialDays: 0,
  intro: false,
  cancelPolicy: "none",
  entitlements: [],
};

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            subscriptions: {
              table: {
                subscription: "Subscription",
                user: "User",
                product: "Product",
                status: "Status",
                store: "Store",
                price: "Price",
                term: "Started",
                lifecycle: "Lifecycle",
                nextEvent: "Renews",
                autoRenew: "Auto",
                manual: "Manual",
                intro: "Intro",
                selectAll: "Select all",
                selectRow: "Select {{id}}",
                empty: "No subscriptions",
                rowCount: "{{count}} rows",
                footerHint: "Live",
              },
            },
          },
        },
      },
    });
  }
});

describe("SubscriptionsTable — sortable headers", () => {
  it("clicking Started toggles sort direction; clicking Price switches column", async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <I18nextProvider i18n={i18next}>
        <SubscriptionsTable
          subscriptions={[SUB]}
          selectedIds={new Set()}
          expandedId={null}
          sort="started_desc"
          onSortChange={onSortChange}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          onToggleExpand={() => {}}
        />
      </I18nextProvider>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /sort by started/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("started_asc");

    // Re-render with the new sort and verify clicking again flips back to desc.
    rerender(
      <I18nextProvider i18n={i18next}>
        <SubscriptionsTable
          subscriptions={[SUB]}
          selectedIds={new Set()}
          expandedId={null}
          sort="started_asc"
          onSortChange={onSortChange}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          onToggleExpand={() => {}}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /sort by started/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("started_desc");

    // Switching to a different column uses that column's default direction (price → price_desc).
    await user.click(screen.getByRole("button", { name: /sort by price/i }));
    expect(onSortChange).toHaveBeenLastCalledWith("price_desc");
  });
});
```

- [ ] **Step 3: Write the FilterToolbar test**

```tsx
// apps/dashboard/tests/components/filter-toolbar.test.tsx
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import {
  FilterToolbar,
  type SubscriptionsFilterValue,
} from "../../src/components/subscriptions/filter-toolbar";

const EMPTY: SubscriptionsFilterValue = {
  search: "",
  store: [],
  productId: [],
  autoRenew: undefined,
  isTrial: undefined,
  isIntro: undefined,
  hasIssue: false,
  purchasedFrom: undefined,
  purchasedTo: undefined,
  expiresFrom: undefined,
  expiresTo: undefined,
};

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            subscriptions: {
              filters: {
                searchPlaceholder: "Search",
                clearSearch: "Clear search",
                store: "Store",
                storeLabels: {
                  APP_STORE: "App Store",
                  PLAY_STORE: "Play Store",
                  STRIPE: "Stripe",
                  WEB: "Web",
                  MANUAL: "Manual",
                },
                product: "Product",
                productSearch: "Search products",
                noResults: "No matches",
                autoRenew: "Auto-renew",
                any: "Any",
                on: "On",
                off: "Off",
                more: "More filters",
                isTrial: "Trial",
                isIntro: "Intro offer",
                hasIssue: "Has issue",
                purchasedRange: "Purchased",
                expiresRange: "Expires",
                clearAll: "Clear all",
                showing: "{{visible}} of {{total}}",
              },
            },
          },
        },
      },
    });
  }
});

describe("FilterToolbar", () => {
  it("auto-renew pill cycles undefined → true → false → undefined", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={EMPTY}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: true }),
    );

    rerender(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={{ ...EMPTY, autoRenew: true }}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: false }),
    );

    rerender(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={{ ...EMPTY, autoRenew: false }}
          onChange={onChange}
          products={[]}
          visible={0}
          total={0}
        />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole("button", { name: /auto-renew/i }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRenew: undefined }),
    );
  });

  it("Clear all renders only when filters are set and resets the whole value", async () => {
    const onChange = vi.fn();
    const populated: SubscriptionsFilterValue = {
      ...EMPTY,
      search: "abc",
      store: ["STRIPE"],
      productId: ["p_a"],
      autoRenew: true,
      hasIssue: true,
    };
    render(
      <I18nextProvider i18n={i18next}>
        <FilterToolbar
          value={populated}
          onChange={onChange}
          products={[{ id: "p_a", label: "A" }]}
          visible={3}
          total={10}
        />
      </I18nextProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onChange).toHaveBeenCalledWith({
      search: "",
      store: [],
      productId: [],
      autoRenew: undefined,
      isTrial: undefined,
      isIntro: undefined,
      hasIssue: false,
      purchasedFrom: undefined,
      purchasedTo: undefined,
      expiresFrom: undefined,
      expiresTo: undefined,
    });
  });
});
```

- [ ] **Step 4: Run the new tests**

```bash
pnpm --filter @rovenue/dashboard test subscriptions-table-sort -- --run
pnpm --filter @rovenue/dashboard test filter-toolbar -- --run
```

Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add \
  apps/dashboard/tests/components/subscriptions-table-sort.test.tsx \
  apps/dashboard/tests/components/filter-toolbar.test.tsx
git commit -m "test(dashboard): sortable Th + FilterToolbar unit tests"
```

---

## Task 12: End-to-end smoke + final commit

- [ ] **Step 1: Full type + build sweep**

```bash
pnpm --filter @rovenue/shared build && \
  pnpm --filter @rovenue/api typecheck && \
  pnpm --filter @rovenue/dashboard typecheck
```

Expected: all three exit 0.

- [ ] **Step 2: Run the API test suite scoped to subscriptions**

```bash
pnpm --filter @rovenue/api test subscriptions -- --run
```

Expected: all PASS, including the new list/filter/sort cases from Task 5 and the pre-existing grant/schedule cases.

- [ ] **Step 3: Boot the dashboard locally and manually verify**

```bash
pnpm --filter @rovenue/dashboard dev
```

In the browser:
- Navigate to a project's `/subscriptions`. Verify the page no longer renders the renewal calendar, the billing issues panel, or the cohort retention panel.
- Type in the search box → URL gets `?q=…` after 300 ms; results filter.
- Click the **Store** pill → check `STRIPE`. URL updates with `?store=STRIPE`; table filters.
- Click **Product** pill → multi-select two products. URL gets `?productId=a,b`.
- Click **Auto-renew** pill → cycles `Any → On → Off → Any`.
- Open **More filters** → toggle `Trial = On`, set a purchase date range. URL updates.
- Click **Clear all** → URL drops all filter params.
- Click the **Started** header → chevron flips, query refetches. Click again → direction reverses.
- Click **Price** header → switches sort column. Click **Renews** header → renews_asc default.
- Refresh the page with all filters in the URL → state restored.
- Browser **Back** → previous filter set restored.

Document anything that doesn't work in a follow-up commit; do not call the task done if the manual verification fails.

- [ ] **Step 4: Final commit (only if any tidy-up was needed)**

```bash
git status --short
# If only the staged/already-committed files appear, skip this commit.
# Otherwise: stage just the changed files explicitly (no `git add .`).
```
