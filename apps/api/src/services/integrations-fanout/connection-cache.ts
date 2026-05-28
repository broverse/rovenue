import { EventEmitter } from "node:events";
import type { IntegrationConnection } from "@rovenue/db";

// =============================================================
// Multi-replica cache invalidation contract
// =============================================================
//
// In-process EventEmitter invalidation only reaches the replica that
// served the dashboard PATCH/DELETE. Sibling replicas pick up the
// change via the 60-second TTL — same pattern as the webhook-delivery
// connection cache. If on-call observes >60s replica lag in
// production, replace this cache with a Redis pub/sub bridge.
// =============================================================

interface CacheEntry {
  value: IntegrationConnection[];
  expiresAt: number;
}

export interface ConnectionCacheOptions {
  ttlMs: number;
  loader: (projectId: string) => Promise<IntegrationConnection[]>;
}

export function createConnectionCache(opts: ConnectionCacheOptions) {
  const store = new Map<string, CacheEntry>();
  const emitter = new EventEmitter();

  async function get(projectId: string): Promise<IntegrationConnection[]> {
    const entry = store.get(projectId);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await opts.loader(projectId);
    store.set(projectId, { value, expiresAt: Date.now() + opts.ttlMs });
    return value;
  }

  function invalidate(projectId: string): void {
    store.delete(projectId);
    emitter.emit("invalidate", projectId);
  }

  function onInvalidate(fn: (projectId: string) => void): () => void {
    emitter.on("invalidate", fn);
    return () => emitter.off("invalidate", fn);
  }

  return { get, invalidate, onInvalidate };
}

export type ConnectionCache = ReturnType<typeof createConnectionCache>;
