import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { placements, type NewPlacement, type Placement } from "../schema";

// =============================================================
// Placement catalog — Drizzle repository
// =============================================================
//
// A placement is an ordered list of audience-targeted rows the SDK
// evaluates to resolve which paywall (or experiment, or nothing) a
// given subscriber sees. `rows` is the versioned payload: every
// update that touches it bumps `revision` so SDK caches and the
// dashboard can detect staleness.

export async function listPlacements(
  db: Db,
  projectId: string,
): Promise<Placement[]> {
  return db
    .select()
    .from(placements)
    .where(eq(placements.projectId, projectId))
    .orderBy(placements.identifier);
}

export async function findPlacementById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Placement | null> {
  const rows = await db
    .select()
    .from(placements)
    .where(and(eq(placements.projectId, projectId), eq(placements.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPlacementByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<Placement | null> {
  const rows = await db
    .select()
    .from(placements)
    .where(
      and(
        eq(placements.projectId, projectId),
        eq(placements.identifier, identifier),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createPlacement(
  db: Db,
  input: NewPlacement,
): Promise<Placement> {
  const [row] = await db.insert(placements).values(input).returning();
  return row!;
}

export interface UpdatePlacementInput {
  identifier?: string;
  name?: string;
  rows?: unknown;
  isActive?: boolean;
}

/**
 * Update a placement. When the patch touches `rows`, `revision` is
 * incremented atomically (`revision = revision + 1`) so callers never
 * race a read-modify-write against a concurrent update — the DB does
 * the bump, not the application layer.
 */
export async function updatePlacement(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdatePlacementInput,
): Promise<Placement | null> {
  const { rows: newRows, ...rest } = patch;
  const hasRows = Object.prototype.hasOwnProperty.call(patch, "rows");

  const [row] = await db
    .update(placements)
    .set({
      ...rest,
      ...(hasRows ? { rows: newRows, revision: sql`${placements.revision} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(placements.projectId, projectId), eq(placements.id, id)))
    .returning();
  return row ?? null;
}

export async function deletePlacement(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(placements)
    .where(and(eq(placements.projectId, projectId), eq(placements.id, id)))
    .returning({ id: placements.id });
  return rows.length > 0;
}
