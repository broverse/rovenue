import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { experiments, paywalls, placements, type NewPaywall, type Paywall } from "../schema";

// =============================================================
// Paywall catalog — Drizzle repository
// =============================================================
//
// A paywall is a named, versioned remote-config document rendered
// by the SDK against a specific offering. `deletePaywall` refuses
// to delete a paywall that is still referenced — either directly by
// a placement row's `target.paywallId`, or indirectly through a
// PAYWALL-type experiment variant's `value.paywallId` — so callers
// always get a clear error instead of a dangling reference.

export async function listPaywalls(
  db: Db,
  projectId: string,
): Promise<Paywall[]> {
  return db
    .select()
    .from(paywalls)
    .where(eq(paywalls.projectId, projectId))
    .orderBy(paywalls.identifier);
}

export async function findPaywallById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Paywall | null> {
  const rows = await db
    .select()
    .from(paywalls)
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPaywallsByIds(
  db: Db,
  projectId: string,
  ids: string[],
): Promise<Paywall[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(paywalls)
    .where(and(eq(paywalls.projectId, projectId), inArray(paywalls.id, ids)));
}

export async function findPaywallByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<Paywall | null> {
  const rows = await db
    .select()
    .from(paywalls)
    .where(
      and(
        eq(paywalls.projectId, projectId),
        eq(paywalls.identifier, identifier),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createPaywall(
  db: Db,
  input: NewPaywall,
): Promise<Paywall> {
  const [row] = await db.insert(paywalls).values(input).returning();
  return row!;
}

export interface UpdatePaywallInput {
  identifier?: string;
  name?: string;
  offeringId?: string;
  remoteConfig?: unknown;
  configFormatVersion?: number;
  builderConfig?: unknown;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export async function updatePaywall(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdatePaywallInput,
): Promise<Paywall | null> {
  const [row] = await db
    .update(paywalls)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Delete a paywall, rejecting when it is still referenced by:
 *   (a) a placement row whose `target.paywallId` points at it, or
 *   (b) a PAYWALL-type experiment whose `variants` array contains a
 *       variant with `value.paywallId` pointing at it.
 *
 * Both checks scan JSONB arrays with `jsonb_array_elements` rather
 * than a `@>` containment query — the paywallId can appear nested at
 * different depths/shapes across placement row targets and experiment
 * variants, which `@>` can't express reliably.
 */
export async function deletePaywall(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const referencedByPlacement = await db.execute(sql`
    SELECT 1 FROM ${placements}
    WHERE "placements"."projectId" = ${projectId}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements("placements"."rows") r
        WHERE r->'target'->>'paywallId' = ${id}
      )
    LIMIT 1
  `);
  if ((referencedByPlacement as unknown as { rows: unknown[] }).rows.length > 0) {
    throw new Error(
      `Cannot delete paywall ${id}: referenced by one or more placement rows`,
    );
  }

  const referencedByExperiment = await db.execute(sql`
    SELECT 1 FROM ${experiments}
    WHERE "experiments"."projectId" = ${projectId}
      AND "experiments"."type" = 'PAYWALL'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements("experiments"."variants") v
        WHERE v->'value'->>'paywallId' = ${id}
      )
    LIMIT 1
  `);
  if (
    (referencedByExperiment as unknown as { rows: unknown[] }).rows.length > 0
  ) {
    throw new Error(
      `Cannot delete paywall ${id}: referenced by a PAYWALL experiment variant`,
    );
  }

  const rows = await db
    .delete(paywalls)
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, id)))
    .returning({ id: paywalls.id });
  return rows.length > 0;
}
