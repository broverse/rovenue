import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "../client";
import {
  paywallVersions,
  type NewPaywallVersion,
  type PaywallVersion,
} from "../schema";

// =============================================================
// Paywall published-version snapshots — Drizzle repository
// =============================================================
//
// Rows here are IMMUTABLE except for `label` ("Name this version…").
// Publishing appends; reverting copies a snapshot back into the
// paywall's draft columns rather than mutating history.

export async function findById(db: Db, id: string): Promise<PaywallVersion | null> {
  const rows = await db
    .select()
    .from(paywallVersions)
    .where(eq(paywallVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Batched lookup — used by the /v1/placements experiment-variant hot path. */
export async function findByIds(db: Db, ids: string[]): Promise<PaywallVersion[]> {
  if (ids.length === 0) return [];
  return db.select().from(paywallVersions).where(inArray(paywallVersions.id, ids));
}

export async function findByVersionNo(
  db: Db,
  paywallId: string,
  versionNo: number,
): Promise<PaywallVersion | null> {
  const rows = await db
    .select()
    .from(paywallVersions)
    .where(
      and(
        eq(paywallVersions.paywallId, paywallId),
        eq(paywallVersions.versionNo, versionNo),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listByPaywall(
  db: Db,
  paywallId: string,
): Promise<PaywallVersion[]> {
  return db
    .select()
    .from(paywallVersions)
    .where(eq(paywallVersions.paywallId, paywallId))
    .orderBy(desc(paywallVersions.versionNo));
}

export async function nextVersionNo(db: Db, paywallId: string): Promise<number> {
  const [row] = await db
    .select({ v: max(paywallVersions.versionNo) })
    .from(paywallVersions)
    .where(eq(paywallVersions.paywallId, paywallId));
  return (row?.v ?? 0) + 1;
}

export async function insert(
  db: Db,
  row: NewPaywallVersion,
): Promise<PaywallVersion> {
  const [inserted] = await db.insert(paywallVersions).values(row).returning();
  return inserted!;
}

export async function setLabel(
  db: Db,
  paywallId: string,
  versionNo: number,
  label: string | null,
): Promise<PaywallVersion | null> {
  const [row] = await db
    .update(paywallVersions)
    .set({ label })
    .where(
      and(
        eq(paywallVersions.paywallId, paywallId),
        eq(paywallVersions.versionNo, versionNo),
      ),
    )
    .returning();
  return row ?? null;
}
