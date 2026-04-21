import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  productGroups,
  products,
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
 * Find a product by its per-store identifier. Mirrors
 *   prisma.product.findFirst({
 *     where: { projectId, storeIds: { path: [store], equals: storeId } }
 *   })
 *
 * Uses a Postgres JSON operator (`->>`) with a SQL template —
 * both `store` (key path) and `storeId` (value) are bound via
 * sql.param so nothing reaches the query body as raw text. The
 * `store` argument is constrained to a fixed string union so
 * the key lookup can't be coerced into an arbitrary expression.
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
