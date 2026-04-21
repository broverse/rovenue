import { drizzle } from "@rovenue/db";
import { isInRollout } from "../lib/bucketing";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { matchesAudience } from "../lib/targeting";

// =============================================================
// Feature flag evaluation engine
// =============================================================
//
// Evaluation is always deterministic for a given
// (projectId, flagKey, subscriberId, attributes) tuple. The only
// non-determinism lives in the cache layer — flag definitions are
// cached in Redis per project for 60s so steady-state evaluation
// is a single Redis GET + in-memory rule loop.
//
// Cache invalidation happens on flag/audience CRUD through
// `invalidateFlagCache(projectId)`. Per-subscriber evaluation
// results are never cached — rule + rollout logic needs to run
// fresh on every request so that a rollout percent change or
// attribute shift takes effect immediately.

const log = logger.child("flag-engine");

const CACHE_KEY_PREFIX = "flags";
const CACHE_TTL_SECONDS = 60;

// =============================================================
// Shapes
// =============================================================

interface FlagRule {
  audienceId: string;
  value: unknown;
  rolloutPercentage?: number | null;
}

interface CachedFlag {
  id: string;
  key: string;
  isEnabled: boolean;
  defaultValue: unknown;
  rules: FlagRule[];
}

const BUNDLE_SCHEMA_VERSION = 1;

interface FlagBundle {
  schemaVersion: number;
  flags: CachedFlag[];
  /** audienceId → rules JSON; empty object = All Users. */
  audiences: Record<string, Record<string, unknown>>;
}

// =============================================================
// Bundle loading + caching
// =============================================================

function cacheKey(projectId: string): string {
  return `${CACHE_KEY_PREFIX}:${projectId}`;
}

async function loadBundleFromDb(projectId: string): Promise<FlagBundle> {
  // Phase 6 cutover: Drizzle is the canonical reader after the
  // Phase 3 shadow cycle ran clean. Both fetches run in parallel;
  // the bundle is then Redis-cached for 60s so steady-state
  // evaluation doesn't hit Postgres at all.
  const [flags, audiences] = await Promise.all([
    drizzle.featureFlagRepo.findFeatureFlagsByProject(drizzle.db, projectId),
    drizzle.featureFlagRepo.findAudiencesByProject(drizzle.db, projectId),
  ]);

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    flags: flags.map((f) => ({
      id: f.id,
      key: f.key,
      isEnabled: f.isEnabled,
      defaultValue: f.defaultValue as unknown,
      rules: (Array.isArray(f.rules) ? f.rules : []) as unknown as FlagRule[],
    })),
    audiences: Object.fromEntries(
      audiences.map((a) => [a.id, (a.rules ?? {}) as Record<string, unknown>]),
    ),
  };
}

async function loadBundle(projectId: string): Promise<FlagBundle> {
  const key = cacheKey(projectId);

  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as Partial<FlagBundle>;
      if (parsed.schemaVersion === BUNDLE_SCHEMA_VERSION) {
        return parsed as FlagBundle;
      }
      log.info("flag cache schema mismatch, re-hydrating", {
        projectId,
        cached: parsed.schemaVersion,
        current: BUNDLE_SCHEMA_VERSION,
      });
    }
  } catch (err) {
    log.warn("flag cache read failed, falling through to DB", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const bundle = await loadBundleFromDb(projectId);

  try {
    await redis.set(key, JSON.stringify(bundle), "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    log.warn("flag cache write failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return bundle;
}

export async function invalidateFlagCache(projectId: string): Promise<void> {
  try {
    await redis.del(cacheKey(projectId));
  } catch (err) {
    log.warn("flag cache invalidate failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================
// Rule evaluation
// =============================================================

function evaluate(
  flag: CachedFlag,
  subscriberId: string,
  attributes: Record<string, unknown>,
  audiences: Record<string, Record<string, unknown>>,
): unknown {
  // 1. Kill switch — disabled flags always return the baseline.
  if (!flag.isEnabled) return flag.defaultValue;

  // 2. First matching rule (with a satisfied rollout) wins.
  for (const rule of flag.rules) {
    const audienceRules = audiences[rule.audienceId];
    if (audienceRules === undefined) {
      // Audience was deleted after the flag was saved — skip
      // rather than crash so the flag falls through to the next
      // rule or the default value.
      continue;
    }

    if (!matchesAudience(attributes, audienceRules)) continue;

    if (rule.rolloutPercentage == null) {
      return rule.value;
    }

    if (isInRollout(subscriberId, flag.key, rule.rolloutPercentage)) {
      return rule.value;
    }

    // Audience matched but subscriber didn't win the rollout —
    // fall through so a lower-priority rule can still apply.
  }

  // 3. No rule matched — default.
  return flag.defaultValue;
}

// =============================================================
// Public API
// =============================================================

export async function evaluateFlag(
  projectId: string,
  flagKey: string,
  subscriberId: string,
  attributes: Record<string, unknown>,
): Promise<unknown> {
  const bundle = await loadBundle(projectId);
  const flag = bundle.flags.find((f) => f.key === flagKey);
  if (!flag) {
    log.warn("unknown flag requested", { projectId, flagKey });
    return null;
  }
  return evaluate(flag, subscriberId, attributes, bundle.audiences);
}

export async function evaluateAllFlags(
  projectId: string,
  subscriberId: string,
  attributes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bundle = await loadBundle(projectId);
  const result: Record<string, unknown> = {};
  for (const flag of bundle.flags) {
    if (!flag.isEnabled) continue;
    result[flag.key] = evaluate(
      flag,
      subscriberId,
      attributes,
      bundle.audiences,
    );
  }
  return result;
}
