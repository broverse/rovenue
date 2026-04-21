import { and, asc, desc, eq, inArray } from "drizzle-orm";
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

// NOTE: product lookup by (projectId, store, storeId) needs a
// typed JSONB path selector that Drizzle doesn't expose cleanly
// in v0.45. Webhook + receipt-verify callers stay on the Prisma
// `storeIds: { path: [store], equals: storeId }` pattern for
// now — those paths migrate in the webhook-cutover phase.
