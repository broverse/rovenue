// =============================================================
// Custom-domain hostname → funnel resolver
// =============================================================
//
// Mirrors the published-bundle cache pattern at
// services/funnel/runtime-cache.ts — Redis hot path with Postgres
// fallback. Only rows that are both DNS-verified AND cert-issued are
// resolvable; anything else returns null so the edge serves a 404
// rather than a half-configured funnel.
//
// Keys: custom_domain:host:<hostname>      — `${funnelId}:${slug}`
//                                            (negative cache uses the
//                                             literal string "∅")
// TTL : 300 s (positive) / 60 s (negative)

import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { redis } from "../../lib/redis";

const PREFIX = "custom_domain:host:";
const TTL_POSITIVE = 300;
const TTL_NEGATIVE = 60;
const NEGATIVE_MARKER = "∅"; // ∅

export interface ResolvedHost {
  funnelId: string;
  slug: string;
}

function normalize(host: string): string {
  // Strip an optional :port and lowercase — Host headers can include one
  // (e.g. `quiz.acme.com:8080` in dev) and DNS is case-insensitive.
  return host.split(":")[0]?.toLowerCase() ?? "";
}

/** Resolve a hostname to a verified funnel. Returns null when unknown or unverified. */
export async function resolveHost(host: string): Promise<ResolvedHost | null> {
  const key = normalize(host);
  if (!key) return null;
  const cacheKey = PREFIX + key;

  const cached = await redis.get(cacheKey);
  if (cached === NEGATIVE_MARKER) return null;
  if (cached) {
    const idx = cached.indexOf(":");
    if (idx > 0) {
      return { funnelId: cached.slice(0, idx), slug: cached.slice(idx + 1) };
    }
  }

  const row = await drizzle.customDomainRepo.findByHostname(drizzle.db, key);
  // The edge serves only fully-ready rows — verified AND cert issued.
  // Anything else (pending verify, cert still issuing, cert failed) is a
  // negative result.
  if (!row || !row.verifiedAt || row.certStatus !== "issued") {
    await redis.set(cacheKey, NEGATIVE_MARKER, "EX", TTL_NEGATIVE);
    return null;
  }

  const funnel = await drizzle.db
    .select({ slug: drizzle.funnels.slug, status: drizzle.funnels.status })
    .from(drizzle.funnels)
    .where(eq(drizzle.funnels.id, row.funnelId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!funnel || funnel.status !== "published") {
    // Funnel is gone or not yet published — don't serve the hostname.
    await redis.set(cacheKey, NEGATIVE_MARKER, "EX", TTL_NEGATIVE);
    return null;
  }

  const resolved: ResolvedHost = { funnelId: row.funnelId, slug: funnel.slug };
  await redis.set(cacheKey, `${resolved.funnelId}:${resolved.slug}`, "EX", TTL_POSITIVE);
  return resolved;
}

/**
 * Invalidate the Redis entry for a hostname. Called by every dashboard
 * mutation that could change resolution: attach, verify, cert flips,
 * delete. Cheap — a single `DEL` — so we err on the side of calling it.
 */
export async function invalidateHost(host: string): Promise<void> {
  const key = normalize(host);
  if (!key) return;
  await redis.del(PREFIX + key);
}
