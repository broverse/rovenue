import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client";
import { virtualCurrencies, type VirtualCurrencyRow } from "../schema";

export interface CreateVirtualCurrencyArgs {
  projectId: string;
  code: string;
  name: string;
}

export async function createVirtualCurrency(
  db: Db,
  args: CreateVirtualCurrencyArgs,
): Promise<VirtualCurrencyRow> {
  const rows = await db
    .insert(virtualCurrencies)
    .values({
      projectId: args.projectId,
      code: args.code,
      name: args.name,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("createVirtualCurrency: no row returned");
  return row;
}

export async function listVirtualCurrencies(
  db: Db,
  projectId: string,
  opts?: { includeArchived?: boolean },
): Promise<VirtualCurrencyRow[]> {
  const where = opts?.includeArchived
    ? eq(virtualCurrencies.projectId, projectId)
    : and(
        eq(virtualCurrencies.projectId, projectId),
        isNull(virtualCurrencies.archivedAt),
      );
  return db
    .select()
    .from(virtualCurrencies)
    .where(where)
    .orderBy(asc(virtualCurrencies.code));
}

export async function findVirtualCurrencyByCode(
  db: Db,
  projectId: string,
  code: string,
): Promise<VirtualCurrencyRow | null> {
  const rows = await db
    .select()
    .from(virtualCurrencies)
    .where(
      and(
        eq(virtualCurrencies.projectId, projectId),
        eq(virtualCurrencies.code, code),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findVirtualCurrencyById(
  db: Db,
  projectId: string,
  id: string,
): Promise<VirtualCurrencyRow | null> {
  const rows = await db
    .select()
    .from(virtualCurrencies)
    .where(
      and(
        eq(virtualCurrencies.projectId, projectId),
        eq(virtualCurrencies.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function renameVirtualCurrency(
  db: Db,
  projectId: string,
  id: string,
  name: string,
): Promise<VirtualCurrencyRow | null> {
  const rows = await db
    .update(virtualCurrencies)
    .set({ name })
    .where(
      and(
        eq(virtualCurrencies.projectId, projectId),
        eq(virtualCurrencies.id, id),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function archiveVirtualCurrency(
  db: Db,
  projectId: string,
  id: string,
): Promise<VirtualCurrencyRow | null> {
  const rows = await db
    .update(virtualCurrencies)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(virtualCurrencies.projectId, projectId),
        eq(virtualCurrencies.id, id),
        isNull(virtualCurrencies.archivedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function countActiveVirtualCurrencies(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(virtualCurrencies)
    .where(
      and(
        eq(virtualCurrencies.projectId, projectId),
        isNull(virtualCurrencies.archivedAt),
      ),
    );
  return rows[0]?.n ?? 0;
}
