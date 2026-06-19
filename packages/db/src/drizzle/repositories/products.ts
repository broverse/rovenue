import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  products,
  type NewProduct,
  type Product,
} from "../schema";

const ALLOWED_STORE_KEYS = ["ios", "android", "web"] as const;
type AllowedStoreKey = (typeof ALLOWED_STORE_KEYS)[number];

function isAllowedStoreKey(key: string): key is AllowedStoreKey {
  return (ALLOWED_STORE_KEYS as ReadonlyArray<string>).includes(key);
}

/**
 * Canonical `storeIds` JSON keys. The dashboard/import surface speaks
 * platform keys (`ios`/`android`/`web`), but the purchase-time lookup
 * (`findProductByStoreId`) and the SDK offerings response read store keys
 * (`apple`/`google`/`stripe`). Everything is PERSISTED under the canonical
 * store keys so config and fulfillment can never diverge. Map at every write
 * boundary; unknown keys pass through unchanged (already canonical or custom).
 */
const STORE_KEY_TO_CANONICAL: Record<AllowedStoreKey, string> = {
  ios: "apple",
  android: "google",
  web: "stripe",
};

export function canonicalStoreKey(key: string): string {
  return STORE_KEY_TO_CANONICAL[key as AllowedStoreKey] ?? key;
}

/** Rewrite a `storeIds` map so every key is canonical (apple/google/stripe). */
export function normalizeStoreIds(
  storeIds: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(storeIds)) {
    out[canonicalStoreKey(key)] = value;
  }
  return out;
}

// =============================================================
// products repository (dashboard CRUD)
// =============================================================
//
// SDK-side reads still live in product-groups.ts because product
// catalog membership is the SDK's primary lookup path. This
// module adds the dashboard's CRUD-shaped surface so callers
// can list / create / update / archive products without rolling
// raw Drizzle queries at each route.

export interface ListProductsInput {
  projectId: string;
  /** `true` includes archived (isActive=false), default `true`. */
  includeInactive?: boolean;
  /** Free-text — matches identifier, displayName, or id (case-insensitive). */
  search?: string | null;
  /** Restrict to one or more product types. */
  types?: ReadonlyArray<Product["type"]> | null;
  /** Restrict to products that have a non-empty id for any of these stores. */
  stores?: ReadonlyArray<AllowedStoreKey> | null;
  /** Optional cursor: ISO timestamp of last row's `createdAt`. */
  cursor?: { createdAt: Date; id: string } | null;
  limit?: number;
}

export async function listProducts(
  db: Db,
  input: ListProductsInput,
): Promise<Product[]> {
  const where = [eq(products.projectId, input.projectId)];
  if (input.includeInactive === false) {
    where.push(eq(products.isActive, true));
  }
  if (input.search) {
    const needle = `%${input.search.toLowerCase()}%`;
    where.push(
      or(
        ilike(products.identifier, needle),
        ilike(products.displayName, needle),
        ilike(products.id, needle),
      )!,
    );
  }
  if (input.types && input.types.length > 0) {
    where.push(inArray(products.type, [...input.types]));
  }
  if (input.stores && input.stores.length > 0) {
    // `storeIds ?| ARRAY[...]` — true when any of the supplied store keys
    // is present in the JSONB blob. Keys are constrained to the allowed
    // union above, so the param array is safe to bind.
    const safeStores = input.stores
      .filter(isAllowedStoreKey)
      .map(canonicalStoreKey);
    if (safeStores.length > 0) {
      where.push(
        sql`${products.storeIds} ?| ${sql.param(safeStores)}::text[]`,
      );
    }
  }
  if (input.cursor) {
    where.push(
      or(
        lt(products.createdAt, input.cursor.createdAt),
        and(
          eq(products.createdAt, input.cursor.createdAt),
          lt(products.id, input.cursor.id),
        ),
      )!,
    );
  }
  return db
    .select()
    .from(products)
    .where(and(...where))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(input.limit ?? 100);
}

export async function findProductById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Product | null> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.projectId, projectId), eq(products.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findProductByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<Product | null> {
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.projectId, projectId),
        eq(products.identifier, identifier),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findProductsByIds(
  db: Db,
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<Product[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(products)
    .where(
      and(eq(products.projectId, projectId), inArray(products.id, [...ids])),
    )
    .orderBy(asc(products.identifier));
}

export async function createProduct(
  db: Db,
  input: NewProduct,
): Promise<Product> {
  // Persist storeIds under canonical store keys so a product created via the
  // free-form dashboard form is found by the purchase-time lookup.
  const normalized: NewProduct = input.storeIds
    ? { ...input, storeIds: normalizeStoreIds(input.storeIds as Record<string, string>) }
    : input;
  const [row] = await db.insert(products).values(normalized).returning();
  return row!;
}

export interface UpdateProductInput {
  identifier?: string;
  displayName?: string;
  type?: Product["type"];
  storeIds?: Record<string, string>;
  accessIds?: string[];
  creditAmount?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export async function updateProduct(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<Product | null> {
  const normalizedPatch = patch.storeIds
    ? { ...patch, storeIds: normalizeStoreIds(patch.storeIds) }
    : patch;
  const [row] = await db
    .update(products)
    .set({ ...normalizedPatch, updatedAt: new Date() })
    .where(and(eq(products.projectId, projectId), eq(products.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteProduct(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  // Hard delete is fine — `purchases.productId` FK doesn't cascade,
  // so the call fails if any purchase row references the product.
  // The dashboard should soft-delete by setting isActive=false
  // through `updateProduct` for products with history; this method
  // is the explicit "destroy a draft" path.
  const rows = await db
    .delete(products)
    .where(and(eq(products.projectId, projectId), eq(products.id, id)))
    .returning({ id: products.id });
  return rows.length > 0;
}

export interface BulkCreateProductsInput {
  projectId: string;
  /** Store key the SKUs were copied from — written into each row's `storeIds`. */
  store: AllowedStoreKey;
  items: ReadonlyArray<{
    identifier: string;
    displayName: string;
    type: Product["type"];
    storeId: string;
    accessIds?: ReadonlyArray<string>;
    creditAmount?: number | null;
    metadata?: Record<string, unknown>;
  }>;
}

export type BulkCreateSkipReason =
  | "duplicate-identifier"
  | "duplicate-store-id";

export interface BulkCreateProductsResult {
  created: ReadonlyArray<Product>;
  skipped: ReadonlyArray<{
    identifier: string;
    storeId: string;
    reason: BulkCreateSkipReason;
  }>;
}

/**
 * Insert many products in a single transaction. Per-row conflicts
 * (duplicate identifier in this project, duplicate storeId on the
 * target store, or any duplicates inside the same payload) are
 * returned as `skipped` instead of aborting the whole batch — the
 * caller can surface them to the user.
 */
export async function bulkCreateProducts(
  db: Db,
  input: BulkCreateProductsInput,
): Promise<BulkCreateProductsResult> {
  if (input.items.length === 0) {
    return { created: [], skipped: [] };
  }

  return db.transaction(async (tx) => {
    const identifiers = Array.from(new Set(input.items.map((i) => i.identifier)));
    const storeIdValues = Array.from(new Set(input.items.map((i) => i.storeId)));

    const existingByIdentifier = identifiers.length
      ? await tx
          .select({
            id: products.id,
            identifier: products.identifier,
          })
          .from(products)
          .where(
            and(
              eq(products.projectId, input.projectId),
              inArray(products.identifier, identifiers),
            ),
          )
      : [];
    const takenIdentifiers = new Set(existingByIdentifier.map((r) => r.identifier));

    const existingByStoreId = storeIdValues.length
      ? await tx
          .select({
            id: products.id,
            storeIds: products.storeIds,
          })
          .from(products)
          .where(
            and(
              eq(products.projectId, input.projectId),
              sql`${products.storeIds}->>${sql.param(canonicalStoreKey(input.store))} = ANY(${sql.param(storeIdValues)}::text[])`,
            ),
          )
      : [];
    const takenStoreIds = new Set(
      existingByStoreId
        .map((r) => {
          const map = r.storeIds as Record<string, string> | null;
          return map?.[canonicalStoreKey(input.store)];
        })
        .filter((s): s is string => typeof s === "string"),
    );

    const seenIdentifiers = new Set<string>();
    const seenStoreIds = new Set<string>();
    const toInsert: NewProduct[] = [];
    const skipped: Array<{
      identifier: string;
      storeId: string;
      reason: BulkCreateSkipReason;
    }> = [];

    for (const item of input.items) {
      if (takenIdentifiers.has(item.identifier) || seenIdentifiers.has(item.identifier)) {
        skipped.push({
          identifier: item.identifier,
          storeId: item.storeId,
          reason: "duplicate-identifier",
        });
        continue;
      }
      if (takenStoreIds.has(item.storeId) || seenStoreIds.has(item.storeId)) {
        skipped.push({
          identifier: item.identifier,
          storeId: item.storeId,
          reason: "duplicate-store-id",
        });
        continue;
      }
      seenIdentifiers.add(item.identifier);
      seenStoreIds.add(item.storeId);
      toInsert.push({
        projectId: input.projectId,
        identifier: item.identifier,
        type: item.type,
        displayName: item.displayName,
        storeIds: { [canonicalStoreKey(input.store)]: item.storeId },
        accessIds: item.accessIds ? [...item.accessIds] : [],
        creditAmount: item.creditAmount ?? null,
        isActive: true,
        metadata: item.metadata ?? {},
      });
    }

    const created = toInsert.length
      ? await tx.insert(products).values(toInsert).returning()
      : [];

    return { created, skipped };
  });
}

export async function countProducts(
  db: Db,
  projectId: string,
): Promise<{ total: number; active: number }> {
  const [totalRow] = await db
    .select({ c: count() })
    .from(products)
    .where(eq(products.projectId, projectId));
  const [activeRow] = await db
    .select({ c: count() })
    .from(products)
    .where(and(eq(products.projectId, projectId), eq(products.isActive, true)));
  return {
    total: Number(totalRow?.c ?? 0),
    active: Number(activeRow?.c ?? 0),
  };
}
