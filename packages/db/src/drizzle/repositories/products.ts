import { and, asc, count, desc, eq, ilike, inArray, lt, or } from "drizzle-orm";
import type { Db } from "../client";
import {
  products,
  type NewProduct,
  type Product,
} from "../schema";

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
  const [row] = await db.insert(products).values(input).returning();
  return row!;
}

export interface UpdateProductInput {
  identifier?: string;
  displayName?: string;
  type?: Product["type"];
  storeIds?: Record<string, string>;
  entitlementKeys?: string[];
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
  const [row] = await db
    .update(products)
    .set({ ...patch, updatedAt: new Date() })
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
