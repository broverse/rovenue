import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  productGroups,
  products,
  type NewProductGroup,
  type Product,
  type ProductGroup,
} from "../schema";

// =============================================================
// Product catalog reads — Drizzle repository
// =============================================================
//
// Covers every read currently in apps/api/src/routes/v1/
// product-groups.ts. Product-group lookups are SDK hot paths
// (paywall rendering) so single-row fetches stay index-driven.

export async function listProductGroups(
  db: Db,
  projectId: string,
): Promise<ProductGroup[]> {
  return db
    .select()
    .from(productGroups)
    .where(eq(productGroups.projectId, projectId))
    .orderBy(desc(productGroups.isDefault), asc(productGroups.identifier));
}

export async function findDefaultProductGroup(
  db: Db,
  projectId: string,
): Promise<ProductGroup | null> {
  const rows = await db
    .select()
    .from(productGroups)
    .where(
      and(
        eq(productGroups.projectId, projectId),
        eq(productGroups.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findProductGroupByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<ProductGroup | null> {
  const rows = await db
    .select()
    .from(productGroups)
    .where(
      and(
        eq(productGroups.projectId, projectId),
        eq(productGroups.identifier, identifier),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findProductsByIds(
  db: Db,
  projectId: string,
  ids: string[],
): Promise<Product[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(products)
    .where(and(eq(products.projectId, projectId), inArray(products.id, ids)));
}

export type ProductStore = "apple" | "google" | "stripe";

/**
 * Find a product by its per-store identifier. Uses a Postgres
 * JSON operator (`->>`) with a SQL template — both `store` (key
 * path) and `storeId` (value) are bound via sql.param so nothing
 * reaches the query body as raw text. The `store` argument is
 * constrained to a fixed string union so the key lookup can't be
 * coerced into an arbitrary expression.
 */
export async function findProductByStoreId(
  db: Db,
  projectId: string,
  store: ProductStore,
  storeId: string,
): Promise<Product | null> {
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.projectId, projectId),
        sql`${products.storeIds}->>${sql.param(store)} = ${sql.param(storeId)}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Dashboard mutations
// =============================================================
//
// The SDK reads above stay narrowly typed and hot-path-friendly.
// Mutation helpers below back the dashboard CRUD route — they're
// fine to bundle here so the read + write surfaces share the
// uniqueness constraints around `identifier` and `isDefault`.

export async function findProductGroupById(
  db: Db,
  projectId: string,
  id: string,
): Promise<ProductGroup | null> {
  const rows = await db
    .select()
    .from(productGroups)
    .where(
      and(eq(productGroups.projectId, projectId), eq(productGroups.id, id)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createProductGroup(
  db: Db,
  input: NewProductGroup,
): Promise<ProductGroup> {
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      // Only one default per project. Clear the flag on any
      // existing default in the same transaction so the unique
      // (projectId, isDefault=true) invariant survives concurrent
      // creates — the trailing UPDATE in this branch + the INSERT
      // below run inside the same tx and serialise via the row
      // lock the UPDATE takes.
      await tx
        .update(productGroups)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(productGroups.projectId, input.projectId),
            eq(productGroups.isDefault, true),
          ),
        );
    }
    const [row] = await tx.insert(productGroups).values(input).returning();
    return row!;
  });
}

export interface UpdateProductGroupInput {
  identifier?: string;
  isDefault?: boolean;
  products?: unknown;
  metadata?: Record<string, unknown>;
}

export async function updateProductGroup(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdateProductGroupInput,
): Promise<ProductGroup | null> {
  return db.transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx
        .update(productGroups)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(productGroups.projectId, projectId),
            eq(productGroups.isDefault, true),
            ne(productGroups.id, id),
          ),
        );
    }
    const [row] = await tx
      .update(productGroups)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(productGroups.projectId, projectId), eq(productGroups.id, id)),
      )
      .returning();
    return row ?? null;
  });
}

export async function deleteProductGroup(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(productGroups)
    .where(
      and(eq(productGroups.projectId, projectId), eq(productGroups.id, id)),
    )
    .returning({ id: productGroups.id });
  return rows.length > 0;
}

/**
 * Receipt-verification lookup: match a product by either its
 * canonical `identifier` OR its per-store id in the `storeIds`
 * JSONB blob. Used by verifyAppleReceipt / verifyGoogleReceipt
 * where the caller passes their own productId and we cross-
 * reference against the platform transaction's productId.
 */
export async function findProductByIdentifierOrStoreId(
  db: Db,
  projectId: string,
  identifier: string,
  store: ProductStore,
  storeId: string,
): Promise<Product | null> {
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.projectId, projectId),
        sql`(${products.identifier} = ${sql.param(identifier)}
             OR ${products.storeIds}->>${sql.param(store)} = ${sql.param(storeId)})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
