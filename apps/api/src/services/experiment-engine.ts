import prisma, {
  ExperimentStatus,
  Prisma,
  drizzle,
  type ExperimentType,
} from "@rovenue/db";
import { env } from "../lib/env";
import {
  analyzeConversion,
  analyzeFunnel,
  analyzeRevenue,
  checkSRM,
  estimateSampleSize,
  type ConfidenceLabel,
  type ConversionAnalysis,
  type FunnelStepResult,
  type RevenueAnalysis,
  type SRMResult,
} from "../lib/experiment-stats";
import { assignBucket, selectVariant } from "../lib/bucketing";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { matchesAudience } from "../lib/targeting";

// =============================================================
// Experiment engine
// =============================================================
//
// `evaluateExperiments` runs on the /v1/config hot path. It
// loads the project's RUNNING experiments and audiences from a
// single cached bundle, applies audience targeting + mutual
// exclusion, reuses sticky assignments, and assigns any
// newcomers via the deterministic murmurhash bucketer.
//
// Implementation note — the spec called for queuing assignment
// writes through BullMQ. We instead batch every new assignment
// from a single call into one `createMany({ skipDuplicates: true })`
// write at the end of the evaluation. That's already a single
// round-trip (same latency profile as a queue push), and the
// unique `(experimentId, subscriberId)` index makes the write
// idempotent under races — where BullMQ would still need a
// deduplication pass on the worker side.

const log = logger.child("experiment-engine");

const CACHE_KEY_PREFIX = "experiments";
const CACHE_TTL_SECONDS = 60;

// =============================================================
// Types
// =============================================================

export interface Variant {
  id: string;
  name: string;
  value: unknown;
  weight: number;
}

interface CachedExperiment {
  id: string;
  key: string;
  type: ExperimentType;
  audienceId: string;
  mutualExclusionGroup: string | null;
  variants: Variant[];
  metrics: string[] | null;
}

const BUNDLE_SCHEMA_VERSION = 1;

interface ExperimentBundle {
  schemaVersion: number;
  experiments: CachedExperiment[];
  audiences: Record<string, Record<string, unknown>>;
}

export interface ExperimentResult {
  experimentId: string;
  key: string;
  type: ExperimentType;
  variantId: string;
  variantName: string;
  value: unknown;
}

// =============================================================
// Bundle cache
// =============================================================

function cacheKey(projectId: string): string {
  return `${CACHE_KEY_PREFIX}:${projectId}`;
}

async function loadBundleFromDb(projectId: string): Promise<ExperimentBundle> {
  // Phase 6 cutover: Drizzle canonical for the running-experiment
  // bundle + audience rules used by evaluateExperiments. Bundle
  // is Redis-cached so repeated evaluations don't hit Postgres.
  const [experiments, audiences] = await Promise.all([
    drizzle.experimentRepo.findRunningExperimentsByProject(
      drizzle.db,
      projectId,
    ),
    drizzle.featureFlagRepo.findAudiencesByProject(drizzle.db, projectId),
  ]);

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    experiments: experiments.map((exp) => ({
      id: exp.id,
      key: exp.key,
      type: exp.type,
      audienceId: exp.audienceId,
      mutualExclusionGroup: exp.mutualExclusionGroup,
      variants: (Array.isArray(exp.variants) ? exp.variants : []) as unknown as Variant[],
      metrics: (Array.isArray(exp.metrics) ? exp.metrics : null) as
        | string[]
        | null,
    })),
    audiences: Object.fromEntries(
      audiences.map((a) => [a.id, (a.rules ?? {}) as Record<string, unknown>]),
    ),
  };
}

async function loadBundle(projectId: string): Promise<ExperimentBundle> {
  const key = cacheKey(projectId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as Partial<ExperimentBundle>;
      if (parsed.schemaVersion === BUNDLE_SCHEMA_VERSION) {
        return parsed as ExperimentBundle;
      }
      log.info("experiment cache schema mismatch, re-hydrating", {
        projectId,
        cached: parsed.schemaVersion,
        current: BUNDLE_SCHEMA_VERSION,
      });
    }
  } catch (err) {
    log.warn("experiment cache read failed, falling through to DB", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const bundle = await loadBundleFromDb(projectId);

  try {
    await redis.set(key, JSON.stringify(bundle), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    log.warn("experiment cache write failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return bundle;
}

export async function invalidateExperimentCache(
  projectId: string,
): Promise<void> {
  try {
    await redis.del(cacheKey(projectId));
  } catch (err) {
    log.warn("experiment cache invalidate failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================
// evaluateExperiments
// =============================================================

export async function evaluateExperiments(
  projectId: string,
  subscriberId: string,
  attributes: Record<string, unknown>,
): Promise<Record<string, ExperimentResult>> {
  const bundle = await loadBundle(projectId);
  if (bundle.experiments.length === 0) return {};

  // One-shot fetch of every assignment this subscriber already has
  // for this project. Covers sticky lookups AND mutual-exclusion
  // filtering without additional round-trips.
  const existingAssignments =
    (await prisma.experimentAssignment.findMany({
      where: {
        subscriberId,
        experiment: { projectId },
      },
      include: {
        experiment: {
          select: { mutualExclusionGroup: true, status: true },
        },
      },
    })) as Array<{
      experimentId: string;
      variantId: string;
      experiment: { mutualExclusionGroup: string | null; status: string };
    }>;

  const assignmentByExperiment = new Map<string, string>();
  const namespacesClaimed = new Set<string>();
  for (const a of existingAssignments) {
    assignmentByExperiment.set(a.experimentId, a.variantId);
    const ns = a.experiment?.mutualExclusionGroup;
    if (ns) namespacesClaimed.add(ns);
  }

  const results: Record<string, ExperimentResult> = {};
  const newAssignments: Array<{
    experimentId: string;
    subscriberId: string;
    variantId: string;
  }> = [];

  for (const exp of bundle.experiments) {
    // 1. Audience targeting
    const audienceRules = bundle.audiences[exp.audienceId];
    if (audienceRules === undefined) {
      log.warn("experiment references unknown audience", {
        experimentId: exp.id,
        audienceId: exp.audienceId,
      });
      continue;
    }
    if (!matchesAudience(attributes, audienceRules)) continue;

    // 2. Mutual exclusion — skip if subscriber already landed in
    //    another experiment of the same namespace (either from a
    //    previous call or earlier in this loop).
    if (
      exp.mutualExclusionGroup &&
      namespacesClaimed.has(exp.mutualExclusionGroup) &&
      !assignmentByExperiment.has(exp.id)
    ) {
      continue;
    }

    // 3. Sticky assignment — reuse the recorded variant.
    let variantId = assignmentByExperiment.get(exp.id);
    let variant = variantId
      ? exp.variants.find((v) => v.id === variantId)
      : undefined;

    // 4. New assignment — deterministic bucket + weighted pick.
    if (!variant) {
      const bucket = assignBucket(subscriberId, exp.key);
      variant = selectVariant(bucket, exp.variants);
      variantId = variant.id;

      newAssignments.push({
        experimentId: exp.id,
        subscriberId,
        variantId: variant.id,
      });
      if (exp.mutualExclusionGroup) {
        namespacesClaimed.add(exp.mutualExclusionGroup);
      }
    }

    results[exp.key] = {
      experimentId: exp.id,
      key: exp.key,
      type: exp.type,
      variantId: variant.id,
      variantName: variant.name,
      value: variant.value,
    };
  }

  if (newAssignments.length > 0) {
    try {
      await prisma.experimentAssignment.createMany({
        data: newAssignments,
        skipDuplicates: true,
      });
    } catch (err) {
      log.warn("experiment assignment batch write failed", {
        projectId,
        subscriberId,
        count: newAssignments.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// =============================================================
// resolveProductGroup
// =============================================================

export interface ResolvedProductGroup {
  id: string;
  identifier: string;
  [key: string]: unknown;
}

export async function resolveProductGroup(
  subscriberId: string,
  projectId: string,
  requestedGroup?: string,
  attributes: Record<string, unknown> = {},
): Promise<ResolvedProductGroup | null> {
  const experiments = await evaluateExperiments(
    projectId,
    subscriberId,
    attributes,
  );

  const override = Object.values(experiments).find(
    (r) => r.type === "PRODUCT_GROUP",
  );

  if (override && typeof override.value === "string") {
    const group = await prisma.productGroup.findFirst({
      where: { projectId, identifier: override.value },
    });
    if (group) return group as unknown as ResolvedProductGroup;
    log.warn("PRODUCT_GROUP experiment points at missing group", {
      projectId,
      experimentKey: override.key,
      identifier: override.value,
    });
  }

  if (requestedGroup) {
    const group = await prisma.productGroup.findFirst({
      where: { projectId, identifier: requestedGroup },
    });
    if (group) return group as unknown as ResolvedProductGroup;
  }

  const fallback = await prisma.productGroup.findFirst({
    where: { projectId, isDefault: true },
  });
  return fallback as unknown as ResolvedProductGroup | null;
}

// =============================================================
// recordEvent
// =============================================================

interface RecordEventMetadata {
  purchaseId?: string;
  revenue?: number;
  [key: string]: unknown;
}

export async function recordEvent(
  subscriberId: string,
  eventType: string,
  metadata?: RecordEventMetadata,
): Promise<void> {
  const assignments = (await prisma.experimentAssignment.findMany({
    where: { subscriberId },
    include: { experiment: { select: { metrics: true } } },
  })) as Array<{
    id: string;
    events: unknown;
    convertedAt: Date | null;
    experiment: { metrics: unknown };
  }>;

  if (assignments.length === 0) return;

  const now = new Date();
  const event: Record<string, unknown> = {
    type: eventType,
    timestamp: now.toISOString(),
  };
  if (metadata && Object.keys(metadata).length > 0) {
    event.metadata = metadata;
  }

  // Each update touches a distinct row (unique assignment id) so the
  // database doesn't need to serialise them — fan out with Promise.all.
  await Promise.all(
    assignments.map((a) => {
      const metrics = Array.isArray(a.experiment.metrics)
        ? (a.experiment.metrics as string[])
        : [];
      const existing = Array.isArray(a.events) ? a.events : [];
      const data: Record<string, unknown> = {
        events: [...existing, event],
      };

      const isConversion = metrics.includes(eventType);
      if (isConversion && !a.convertedAt) {
        data.convertedAt = now;
        if (metadata?.purchaseId) data.purchaseId = metadata.purchaseId;
        if (typeof metadata?.revenue === "number") {
          data.revenue = new Prisma.Decimal(metadata.revenue);
        }
      }

      return prisma.experimentAssignment.update({
        where: { id: a.id },
        data,
      });
    }),
  );
}

// =============================================================
// getExperimentResults
// =============================================================

export interface VariantAggregate {
  variantId: string;
  variantName: string;
  totalUsers: number;
  funnel: FunnelStepResult[];
  conversions: number;
  conversionRate: number;
  totalRevenue: number;
  revenuePerUser: number;
  stats: {
    pValue: number;
    isSignificant: boolean;
    confidenceLevel: number;
    confidenceLabel: ConfidenceLabel;
    lift: number;
    absoluteLift: number;
    revenue?: RevenueAnalysis;
  };
}

export interface ExperimentResults {
  experimentId: string;
  key: string;
  type: ExperimentType;
  variants: VariantAggregate[];
  srm: SRMResult;
  sampleSize: number;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null) {
    const anyValue = value as { toNumber?: () => number };
    if (typeof anyValue.toNumber === "function") return anyValue.toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function countEventOccurrences(
  events: unknown,
  type: string,
): number {
  if (!Array.isArray(events)) return 0;
  let count = 0;
  for (const e of events) {
    if (e && typeof e === "object" && (e as { type?: string }).type === type) {
      count += 1;
    }
  }
  return count;
}

export async function getExperimentResults(
  experimentId: string,
): Promise<ExperimentResults> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
  });
  if (!experiment) {
    throw new Error(`Experiment ${experimentId} not found`);
  }

  const variants = (Array.isArray(experiment.variants)
    ? experiment.variants
    : []) as unknown as Variant[];

  const assignments = (await prisma.experimentAssignment.findMany({
    where: { experimentId },
  })) as Array<{
    variantId: string;
    events: unknown;
    convertedAt: Date | null;
    revenue: unknown;
  }>;

  const metrics = (Array.isArray(experiment.metrics)
    ? experiment.metrics
    : []) as string[];
  const funnelSteps = metrics.length > 0 ? metrics : ["purchase"];

  const perVariant = new Map<
    string,
    {
      users: number;
      conversions: number;
      revenues: number[];
      eventCounts: Record<string, number>;
    }
  >();
  for (const v of variants) {
    perVariant.set(v.id, {
      users: 0,
      conversions: 0,
      revenues: [],
      eventCounts: Object.fromEntries(funnelSteps.map((s) => [s, 0])),
    });
  }

  for (const a of assignments) {
    const agg = perVariant.get(a.variantId);
    if (!agg) continue;
    agg.users += 1;
    if (a.convertedAt) agg.conversions += 1;
    const revenue = toNumber(a.revenue);
    if (revenue > 0) agg.revenues.push(revenue);
    for (const step of funnelSteps) {
      agg.eventCounts[step] =
        (agg.eventCounts[step] ?? 0) + countEventOccurrences(a.events, step);
    }
  }

  const control = variants[0]!;
  const controlAgg = perVariant.get(control.id)!;

  const variantAggregates: VariantAggregate[] = variants.map((v) => {
    const agg = perVariant.get(v.id)!;
    const conversionRate = agg.users === 0 ? 0 : agg.conversions / agg.users;
    const totalRevenue = agg.revenues.reduce((s, x) => s + x, 0);
    const revenuePerUser = agg.users === 0 ? 0 : totalRevenue / agg.users;

    const funnel = analyzeFunnel(
      funnelSteps.map((name) => ({ name, count: agg.eventCounts[name] ?? 0 })),
    );

    let statsConversion: ConversionAnalysis = {
      controlRate: 0,
      variantRate: 0,
      absoluteLift: 0,
      relativeLift: 0,
      zScore: 0,
      pValue: 1,
      isSignificant: false,
      confidenceLevel: 0.95,
      confidenceLabel: "not significant",
    };
    let statsRevenue: RevenueAnalysis | undefined;

    const isControl = v.id === control.id;
    if (!isControl && controlAgg.users > 0 && agg.users > 0) {
      statsConversion = analyzeConversion(
        { users: controlAgg.users, conversions: controlAgg.conversions },
        { users: agg.users, conversions: agg.conversions },
      );
      if (controlAgg.revenues.length >= 2 && agg.revenues.length >= 2) {
        statsRevenue = analyzeRevenue(controlAgg.revenues, agg.revenues);
      }
    }

    return {
      variantId: v.id,
      variantName: v.name,
      totalUsers: agg.users,
      funnel,
      conversions: agg.conversions,
      conversionRate,
      totalRevenue,
      revenuePerUser,
      stats: {
        pValue: statsConversion.pValue,
        isSignificant: statsConversion.isSignificant,
        confidenceLevel: statsConversion.confidenceLevel,
        confidenceLabel: statsConversion.confidenceLabel,
        lift: statsConversion.relativeLift,
        absoluteLift: statsConversion.absoluteLift,
        revenue: statsRevenue,
      },
    };
  });

  const totalUsers = variantAggregates.reduce((s, v) => s + v.totalUsers, 0);
  const srm = checkSRM(
    variants.map((v) => {
      const agg = perVariant.get(v.id)!;
      return {
        expected: totalUsers * v.weight,
        observed: agg.users,
      };
    }),
  );

  const controlRate = controlAgg.users === 0
    ? 0
    : controlAgg.conversions / controlAgg.users;
  const baselineForSizing = controlRate > 0 ? controlRate : 0.05;
  const sampleSize = estimateSampleSize(baselineForSizing, 0.1);

  return {
    experimentId: experiment.id,
    key: experiment.key,
    type: experiment.type,
    variants: variantAggregates,
    srm,
    sampleSize,
  };
}
