import {
  drizzle,
  type ExperimentType,
} from "@rovenue/db";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { publishConfigInvalidation } from "../lib/config-invalidation";
import { HOLDOUT_BUCKET_SEED } from "../lib/experiment-constants";
import { eventBus } from "./event-bus";
import {
  assignBucket,
  isInRollout,
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

// Bumped 1 -> 2 for Task 8: the bundle shape gained `holdoutPercentage`,
// and a cached v1 entry would silently read it as `undefined` (falsy,
// same as "no holdout") for up to CACHE_TTL_SECONDS after a deploy that
// sets holdoutPercentage > 0 — a brief window where the feature looks
// like it isn't working. Bumping forces one re-hydration from Postgres
// per project on first evaluation, via the schema-mismatch branch below.
const BUNDLE_SCHEMA_VERSION = 2;

interface ExperimentBundle {
  schemaVersion: number;
  experiments: CachedExperiment[];
  audiences: Record<string, Record<string, unknown>>;
  /** `projects.holdoutPercentage`, 0..100. Cached alongside the
   *  experiments/audiences it gates so a holdout-percentage change
   *  takes effect on the same TTL as any other experiment change. */
  holdoutPercentage: number;
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
  const [experiments, audiences, holdoutPercentage] = await Promise.all([
    drizzle.experimentRepo.findRunningExperimentsByProject(
      drizzle.db,
      projectId,
    ),
    drizzle.featureFlagRepo.findAudiencesByProject(drizzle.db, projectId),
    drizzle.projectRepo.findProjectHoldoutPercentage(drizzle.db, projectId),
  ]);

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    holdoutPercentage,
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

  // Task 8 — project-level holdout. `HOLDOUT_BUCKET_SEED` is a seed
  // distinct from every experiment's own `key` (used as ITS seed just
  // below at the real assignment draw), which is what makes holdout
  // membership statistically independent of any experiment's variant
  // assignment. Computed once per call, not per experiment: membership
  // is a property of (subscriberId, project), not of which experiment is
  // being considered.
  const isHeldOut =
    bundle.holdoutPercentage > 0 &&
    isInRollout(subscriberId, HOLDOUT_BUCKET_SEED, bundle.holdoutPercentage / 100);

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

    // Held out: this experiment WOULD have applied (audience matched),
    // but the subscriber is withheld into the project-level holdout
    // cohort instead. No assignment is written and no result is
    // returned — the caller gets whatever default/control behaviour
    // applies when an experiment key has no override, exactly as if
    // this experiment did not exist for them. The exposure is still
    // recorded (against the reserved HOLDOUT_COHORT_ID) because an
    // unmeasured holdout is just a smaller audience, not a comparison.
    // Best-effort: a publish failure here must not break config
    // evaluation for the caller, so it's logged and swallowed exactly
    // like the assignment batch write below.
    if (isHeldOut) {
      try {
        await drizzle.db.transaction((tx) =>
          eventBus.publishHoldoutExposure(tx, {
            experimentId: exp.id,
            projectId,
            subscriberId,
          }),
        );
      } catch (err) {
        log.warn("holdout exposure publish failed", {
          projectId,
          experimentId: exp.id,
          subscriberId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

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
