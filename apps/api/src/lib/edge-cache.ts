import { drizzle } from "@rovenue/db";
import { env } from "./env";
import { logger } from "./logger";

// =============================================================
// Global edge-cache purge
// =============================================================
//
// The Cloudflare edge-cache Worker (deploy/cloudflare/edge-cache)
// caches project-wide /v1/offerings responses keyed by
// SHA-256(public API key). Catalog mutations (offering / product
// create-update-delete) do NOT flow through the outbox, so we purge
// the edge explicitly from the dashboard mutation handlers.
//
// Fire-and-forget + best-effort: the call never blocks or fails the
// dashboard response, and no-ops entirely when the purge endpoint is
// unconfigured (self-host without a CDN). The Worker's short TTL is
// the backstop if a purge is ever missed.

export function purgeProjectCatalogCache(projectId: string): void {
  const url = env.EDGE_CACHE_PURGE_URL;
  const secret = env.EDGE_CACHE_PURGE_SECRET;
  if (!url || !secret) return;
  void purge(projectId, url, secret);
}

async function purge(
  projectId: string,
  url: string,
  secret: string,
): Promise<void> {
  try {
    // A project may carry several active public keys (rotation); the
    // cache is isolated per key, so purge each one.
    const keys = await drizzle.apiKeyRepo.listActiveApiKeys(
      drizzle.db,
      projectId,
    );
    await Promise.all(
      keys.map(async (k) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-edge-purge-secret": secret,
          },
          body: JSON.stringify({ key: k.keyPublic }),
        });
        if (!res.ok) {
          logger.warn("edge-cache.purge.non-2xx", {
            projectId,
            status: res.status,
          });
        }
      }),
    );
  } catch (err) {
    logger.warn("edge-cache.purge.error", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
