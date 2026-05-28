// =============================================================
// access-catalog repo — CRUD for the `access` table
// =============================================================
//
// The `access` table is the catalog of access rights (one row per
// (projectId, identifier)), replacing free-form entitlement key
// strings. This repo wraps the table with the standard CRUD
// surface used by dashboard routes and the access engine.
//
// Note on naming: the existing `accessRepo` (./access.ts) operates
// on `subscriber_access`. To avoid overloading "access", this repo
// is exported as `accessCatalogRepo` from the drizzle barrel.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  access,
  products,
  type AccessRow,
  type NewAccessRow,
} from "../schema";

export async function create(
  db: Db,
  input: Omit<NewAccessRow, "id" | "createdAt" | "updatedAt">,
): Promise<AccessRow> {
  const [row] = await db.insert(access).values(input).returning();
  if (!row) throw new Error("access-catalog.create: no row returned");
  return row;
}

export async function list(db: Db, projectId: string): Promise<AccessRow[]> {
  return db
    .select()
    .from(access)
    .where(eq(access.projectId, projectId))
    .orderBy(access.createdAt);
}

export async function findById(
  db: Db,
  id: string,
): Promise<AccessRow | null> {
  const rows = await db.select().from(access).where(eq(access.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<AccessRow | null> {
  const rows = await db
    .select()
    .from(access)
    .where(
      and(eq(access.projectId, projectId), eq(access.identifier, identifier)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findByIds(
  db: Db,
  ids: string[],
): Promise<AccessRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(access).where(inArray(access.id, ids));
}

export async function update(
  db: Db,
  id: string,
  patch: Partial<
    Pick<AccessRow, "identifier" | "displayName" | "description" | "metadata">
  >,
): Promise<void> {
  await db
    .update(access)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(access.id, id));
}

export async function deleteById(db: Db, id: string): Promise<void> {
  await db.delete(access).where(eq(access.id, id));
}

/**
 * Count products in this project whose `accessIds[]` array contains
 * the given access id. Used by the dashboard catalog list to show
 * "linked products" per access row.
 */
export async function countProducts(
  db: Db,
  accessId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(sql`${accessId} = ANY(${products.accessIds})`);
  return row?.n ?? 0;
}
