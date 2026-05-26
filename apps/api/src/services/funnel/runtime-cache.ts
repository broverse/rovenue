// =============================================================
// Funnel runtime cache — Redis-backed published bundle cache
// =============================================================
//
// Public runtime endpoints read the latest published funnel
// config (pages with branching rules stripped, theme, settings)
// from Redis on the hot path. Dashboard publish/duplicate/revert
// invalidate the slug after the canonical write completes.
//
// Keys: funnel:runtime:<slug>
// TTL : 5 minutes — bounded staleness even if an invalidation is
//                   missed.

import { redis } from "../../lib/redis";

const TTL_SECONDS = 300;
const PREFIX = "funnel:runtime:";

export async function readPublishedConfig<T>(slug: string): Promise<T | null> {
  const raw = await redis.get(PREFIX + slug);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function writePublishedConfig(
  slug: string,
  value: unknown,
): Promise<void> {
  await redis.set(PREFIX + slug, JSON.stringify(value), "EX", TTL_SECONDS);
}

export async function invalidatePublishedConfig(slug: string): Promise<void> {
  await redis.del(PREFIX + slug);
}
