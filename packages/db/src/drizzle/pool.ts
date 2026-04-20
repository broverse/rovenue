import { Pool, type PoolConfig } from "pg";

// =============================================================
// Shared pg Pool
// =============================================================
//
// Drizzle and Prisma both run against Postgres, but Prisma manages
// its own connection pool internally (via the query engine binary)
// while Drizzle expects us to bring our own. During the hybrid
// period where both ORMs coexist we keep them on distinct pools
// so a leak on one side doesn't starve the other — they share a
// DATABASE_URL, nothing else.
//
// The pool is created lazily so importing this module in a
// test environment without DATABASE_URL (vitest picks up .env.test
// later) doesn't crash at import time.

const globalForPool = globalThis as unknown as {
  rovenueDrizzlePool?: Pool;
};

export interface CreatePoolOptions extends Partial<PoolConfig> {
  connectionString?: string;
}

const DEFAULT_POOL_OPTIONS: PoolConfig = {
  // Matches Prisma's default connection limit shape — a tiny
  // default keeps test isolation; real deployments override via
  // DATABASE_URL `?connection_limit=...` or env overrides.
  max: 10,
  idleTimeoutMillis: 30_000,
  // Aggressive connectionTimeoutMillis surfaces bad DSNs fast
  // instead of the default Node behaviour that hangs until the
  // OS-level TCP timeout.
  connectionTimeoutMillis: 5_000,
};

function resolveConnectionString(
  options: CreatePoolOptions | undefined,
): string {
  const cs = options?.connectionString ?? process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      "Drizzle pool requires DATABASE_URL (or options.connectionString) to be set",
    );
  }
  return cs;
}

export function createPool(options?: CreatePoolOptions): Pool {
  return new Pool({
    ...DEFAULT_POOL_OPTIONS,
    ...options,
    connectionString: resolveConnectionString(options),
  });
}

/**
 * Singleton pool for day-to-day reads/writes. Re-uses the same
 * `globalThis` slot across HMR reloads in dev so repeated module
 * evaluations don't leak connections.
 */
export function getPool(): Pool {
  if (!globalForPool.rovenueDrizzlePool) {
    globalForPool.rovenueDrizzlePool = createPool();
  }
  return globalForPool.rovenueDrizzlePool;
}

/**
 * Drain the singleton pool. Call from graceful-shutdown hooks in
 * workers/scripts; the API server leaves the pool open for the
 * lifetime of the process.
 */
export async function closePool(): Promise<void> {
  const pool = globalForPool.rovenueDrizzlePool;
  if (!pool) return;
  globalForPool.rovenueDrizzlePool = undefined;
  await pool.end();
}
