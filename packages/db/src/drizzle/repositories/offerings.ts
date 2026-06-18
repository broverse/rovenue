import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  offerings,
  products,
  type NewOffering,
  type Offering,
  type Product,
} from "../schema";

// =============================================================
// Offering catalog reads — Drizzle repository
// =============================================================
//
// Covers every read currently in apps/api/src/routes/v1/
// offerings.ts. Offering lookups are SDK hot paths (paywall
// rendering) so single-row fetches stay index-driven.

export async function listOfferings(
  db: Db,
  projectId: string,
): Promise<Offering[]> {
  return db
    .select()
    .from(offerings)
    .where(eq(offerings.projectId, projectId))
    .orderBy(desc(offerings.isDefault), asc(offerings.identifier));
}


export async function findDefaultOffering(
  db: Db,
  projectId: string,
): Promise<Offering | null> {
  const rows = await db
    .select()
    .from(offerings)
    .where(
      and(eq(offerings.projectId, projectId), eq(offerings.isDefault, true)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findOfferingByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<Offering | null> {
  const rows = await db
    .select()
    .from(offerings)
    .where(
      and(
        eq(offerings.projectId, projectId),
        eq(offerings.identifier, identifier),
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

export async function findOfferingById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Offering | null> {
  const rows = await db
    .select()
    .from(offerings)
    .where(and(eq(offerings.projectId, projectId), eq(offerings.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createOffering(
  db: Db,
  input: NewOffering,
): Promise<Offering> {
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      // Only one default per project. Clear the flag on any
      // existing default in the same transaction so the unique
      // (projectId, isDefault=true) invariant survives concurrent
      // creates — the trailing UPDATE in this branch + the INSERT
      // below run inside the same tx and serialise via the row
      // lock the UPDATE takes.
      await tx
        .update(offerings)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(offerings.projectId, input.projectId),
            eq(offerings.isDefault, true),
          ),
        );
    }
    const [row] = await tx.insert(offerings).values(input).returning();
    return row!;
  });
}

export interface UpdateOfferingInput {
  identifier?: string;
  isDefault?: boolean;
  packages?: unknown;
  metadata?: Record<string, unknown>;
}

export async function updateOffering(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdateOfferingInput,
): Promise<Offering | null> {
  return db.transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx
        .update(offerings)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(offerings.projectId, projectId),
            eq(offerings.isDefault, true),
            ne(offerings.id, id),
          ),
        );
    }
    const [row] = await tx
      .update(offerings)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(offerings.projectId, projectId), eq(offerings.id, id)))
      .returning();
    return row ?? null;
  });
}

export async function deleteOffering(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(offerings)
    .where(and(eq(offerings.projectId, projectId), eq(offerings.id, id)))
    .returning({ id: offerings.id });
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
