import { and, count, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  experimentAssignments,
  experiments,
  type ExperimentAssignment,
} from "../schema";

// DB or Drizzle tx handle — writes accept either.
type DbOrTx = Db;

// =============================================================
// Experiment assignment reads
// =============================================================

/**
 * All assignments for a subscriber across a single project's
 * experiments, with the experiment's status + mutualExclusionGroup
 * inlined via an inner join.
 */
export interface AssignmentWithExperiment {
  id: string;
  experimentId: string;
  subscriberId: string;
  variantId: string;
  assignedAt: Date;
  events: unknown;
  convertedAt: Date | null;
  purchaseId: string | null;
  revenue: string | null;
  experiment: {
    status: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
    mutualExclusionGroup: string | null;
  };
}

export async function findSubscriberAssignments(
  db: Db,
  projectId: string,
  subscriberId: string,
): Promise<AssignmentWithExperiment[]> {
  const rows = await db
    .select({
      id: experimentAssignments.id,
      experimentId: experimentAssignments.experimentId,
      subscriberId: experimentAssignments.subscriberId,
      variantId: experimentAssignments.variantId,
      assignedAt: experimentAssignments.assignedAt,
      events: experimentAssignments.events,
      convertedAt: experimentAssignments.convertedAt,
      purchaseId: experimentAssignments.purchaseId,
      revenue: experimentAssignments.revenue,
      expStatus: experiments.status,
      expMutualExclusionGroup: experiments.mutualExclusionGroup,
    })
    .from(experimentAssignments)
    .innerJoin(
      experiments,
      eq(experiments.id, experimentAssignments.experimentId),
    )
    .where(
      and(
        eq(experimentAssignments.subscriberId, subscriberId),
        eq(experiments.projectId, projectId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    experimentId: r.experimentId,
    subscriberId: r.subscriberId,
    variantId: r.variantId,
    assignedAt: r.assignedAt,
    events: r.events,
    convertedAt: r.convertedAt,
    purchaseId: r.purchaseId,
    revenue: r.revenue,
    experiment: {
      status: r.expStatus,
      mutualExclusionGroup: r.expMutualExclusionGroup,
    },
  }));
}

export interface AssignmentWithMetrics {
  id: string;
  events: unknown;
  convertedAt: Date | null;
  experiment: { metrics: unknown };
}

export async function findAssignmentsWithMetrics(
  db: Db,
  subscriberId: string,
): Promise<AssignmentWithMetrics[]> {
  const rows = await db
    .select({
      id: experimentAssignments.id,
      events: experimentAssignments.events,
      convertedAt: experimentAssignments.convertedAt,
      metrics: experiments.metrics,
    })
    .from(experimentAssignments)
    .innerJoin(
      experiments,
      eq(experiments.id, experimentAssignments.experimentId),
    )
    .where(eq(experimentAssignments.subscriberId, subscriberId));
  return rows.map((r) => ({
    id: r.id,
    events: r.events,
    convertedAt: r.convertedAt,
    experiment: { metrics: r.metrics },
  }));
}

export async function findAssignmentsByExperiment(
  db: Db,
  experimentId: string,
): Promise<ExperimentAssignment[]> {
  return db
    .select()
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experimentId));
}

export async function countAssignments(
  db: Db,
  experimentId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experimentId));
  return Number(rows[0]?.total ?? 0);
}

export async function countConvertedAssignments(
  db: Db,
  experimentId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.experimentId, experimentId),
        isNotNull(experimentAssignments.convertedAt),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

// =============================================================
// Writes
// =============================================================

export interface NewAssignmentInput {
  experimentId: string;
  subscriberId: string;
  variantId: string;
  hashVersion?: number;
}

/**
 * Batch-insert new assignments, ignoring duplicates on
 * (experimentId, subscriberId) via onConflictDoNothing.
 */
export async function insertAssignmentsSkipDuplicates(
  db: DbOrTx,
  rows: NewAssignmentInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(experimentAssignments)
    .values(
      rows.map((r) => ({
        ...r,
        hashVersion: r.hashVersion ?? 1,
      })),
    )
    .onConflictDoNothing({
      target: [
        experimentAssignments.experimentId,
        experimentAssignments.subscriberId,
      ],
    });
}

export interface AssignmentEventPatch {
  events: unknown;
  convertedAt?: Date;
  purchaseId?: string;
  /** String-encoded decimal — Drizzle decimal columns use string IO. */
  revenue?: string;
}

/**
 * Partial update of an assignment — callers compose this from
 * whichever of (events, convertedAt, purchaseId, revenue) they
 * want to write on a given event recording pass.
 */
export async function updateAssignmentEvents(
  db: DbOrTx,
  id: string,
  patch: AssignmentEventPatch,
): Promise<void> {
  const data: Partial<typeof experimentAssignments.$inferInsert> = {
    events: patch.events as typeof experimentAssignments.$inferInsert.events,
    updatedAt: new Date(),
  };
  if (patch.convertedAt !== undefined) data.convertedAt = patch.convertedAt;
  if (patch.purchaseId !== undefined) data.purchaseId = patch.purchaseId;
  if (patch.revenue !== undefined) data.revenue = patch.revenue;
  await db
    .update(experimentAssignments)
    .set(data)
    .where(eq(experimentAssignments.id, id));
}
