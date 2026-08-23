// =============================================================
// Funnel runtime cache — Redis-backed published bundle cache
// =============================================================
//
// Public runtime endpoints read the latest published funnel
// config (pages with branching rules stripped, theme, settings)
// from Redis on the hot path. Dashboard publish/duplicate/revert
// invalidate the slug after the canonical write completes.
//
// Cache failures are never fatal: callers do
// `readPublishedConfig(slug) ?? loadFromDb(slug)`, so a Redis error
// (or a corrupt payload) must surface as a miss — not a throw — or
// the Postgres fallback sitting right next to the call never runs
// and every published funnel page 500s for the duration of a Redis
// blip. Same discipline as flag-engine.ts / experiment-engine.ts.
//
// Keys: funnel:runtime:<slug>
// TTL : 5 minutes — bounded staleness even if an invalidation is
//                   missed.

import { redis } from "../../lib/redis";
import { logger } from "../../lib/logger";

const log = logger.child("funnel-runtime-cache");

const TTL_SECONDS = 300;
const PREFIX = "funnel:runtime:";

export async function readPublishedConfig<T>(slug: string): Promise<T | null> {
  try {
    const raw = await redis.get(PREFIX + slug);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    log.warn("cache read failed — falling through to Postgres", {
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function writePublishedConfig(
  slug: string,
  value: unknown,
): Promise<void> {
  try {
    await redis.set(PREFIX + slug, JSON.stringify(value), "EX", TTL_SECONDS);
  } catch (err) {
    log.warn("cache write failed — serving from Postgres until Redis returns", {
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function invalidatePublishedConfig(slug: string): Promise<void> {
  try {
    await redis.del(PREFIX + slug);
  } catch (err) {
    // The 5-minute TTL bounds staleness if this delete is lost; failing the
    // dashboard publish over it would be strictly worse.
    log.warn("cache invalidation failed — TTL bounds staleness", {
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
