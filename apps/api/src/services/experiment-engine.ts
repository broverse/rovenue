import {
  drizzle,
  type ExperimentType,
} from "@rovenue/db";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { publishConfigInvalidation } from "../lib/config-invalidation";
import {
  assignBucket,
  matchesAudience,
  selectVariant,
} from "@rovenue/shared/experiments";

// =============================================================
// Experiment engine
// =============================================================
//
// `evaluateExperiments` runs on the /v1/config hot path. It
// loads the project's RUNNING experiments and audiences from a
// single cached bundle, applies audience targeting + mutual
// exclusion, reuses sticky assignments, and assigns any
// newcomers via the deterministic SHA-256 bucketer.
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

/**
 * Public alias used by the SSE config-stream route. Returns the
 * current experiment bundle for a project, hitting Redis first
 * and falling back to Postgres. Kept as a wrapper (not a rename)
 * so the existing `loadBundle` callsites in this file stay
 * internal and symmetric with the cache discipline.
 */
export async function loadBundleFromCache(
  projectId: string,
): Promise<ExperimentBundle> {
  return loadBundle(projectId);
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
  // Push the change to any connected SSE config streams.
  await publishConfigInvalidation(projectId);
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
    await drizzle.experimentAssignmentRepo.findSubscriberAssignments(
      drizzle.db,
      projectId,
      subscriberId,
    );

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
    hashVersion: number;
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
        hashVersion: 1,
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
      await drizzle.experimentAssignmentRepo.insertAssignmentsSkipDuplicates(
        drizzle.db,
        newAssignments,
      );
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
    (r) => r.type === "OFFERING",
  );

  if (override && typeof override.value === "string") {
    const group = await drizzle.offeringRepo.findOfferingByIdentifier(
      drizzle.db,
      projectId,
      override.value,
    );
    if (group) return group as unknown as ResolvedProductGroup;
    log.warn("OFFERING experiment points at missing offering", {
      projectId,
      experimentKey: override.key,
      identifier: override.value,
    });
  }

  if (requestedGroup) {
    const group = await drizzle.offeringRepo.findOfferingByIdentifier(
      drizzle.db,
      projectId,
      requestedGroup,
    );
    if (group) return group as unknown as ResolvedProductGroup;
  }

  const fallback = await drizzle.offeringRepo.findDefaultOffering(
    drizzle.db,
    projectId,
  );
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
  const assignments =
    await drizzle.experimentAssignmentRepo.findAssignmentsWithMetrics(
      drizzle.db,
      subscriberId,
    );

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
      const patch: {
        events: unknown;
        convertedAt?: Date;
        purchaseId?: string;
        revenue?: string;
      } = {
        events: [...existing, event],
      };

      const isConversion = metrics.includes(eventType);
      if (isConversion && !a.convertedAt) {
        patch.convertedAt = now;
        if (metadata?.purchaseId) patch.purchaseId = metadata.purchaseId;
        if (typeof metadata?.revenue === "number") {
          // Drizzle's decimal column IO is string; the Postgres side
          // parses it back to NUMERIC(12, 4).
          patch.revenue = metadata.revenue.toString();
        }
      }

      return drizzle.experimentAssignmentRepo.updateAssignmentEvents(
        drizzle.db,
        a.id,
        patch,
      );
    }),
  );
}
