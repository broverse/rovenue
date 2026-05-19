import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../client";
import { chartAnnotations, type ChartAnnotation, type NewChartAnnotation } from "../schema";

// =============================================================
// chart_annotations repository
// =============================================================
//
// Project-scoped annotations. List is bounded by an optional
// time window so the request payload stays small even on
// projects with thousands of pinned events.

export interface ListAnnotationsInput {
  projectId: string;
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date;
  limit?: number;
}

export async function listAnnotations(
  db: Db,
  input: ListAnnotationsInput,
): Promise<ChartAnnotation[]> {
  const where = [eq(chartAnnotations.projectId, input.projectId)];
  if (input.from) where.push(gte(chartAnnotations.occurredAt, input.from));
  if (input.to) where.push(lte(chartAnnotations.occurredAt, input.to));
  return db
    .select()
    .from(chartAnnotations)
    .where(and(...where))
    .orderBy(asc(chartAnnotations.occurredAt))
    .limit(input.limit ?? 500);
}

export async function createAnnotation(
  db: Db,
  input: NewChartAnnotation,
): Promise<ChartAnnotation> {
  const [row] = await db.insert(chartAnnotations).values(input).returning();
  return row!;
}

export async function deleteAnnotation(
  db: Db,
  id: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(chartAnnotations)
    .where(
      and(
        eq(chartAnnotations.id, id),
        eq(chartAnnotations.projectId, projectId),
      ),
    )
    .returning({ id: chartAnnotations.id });
  return rows.length > 0;
}
