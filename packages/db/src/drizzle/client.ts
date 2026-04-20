import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getPool } from "./pool";
import * as schema from "./schema";

// =============================================================
// Drizzle client
// =============================================================
//
// `db` is the primary export callers reach for during the Prisma
// → Drizzle coexistence window. It's typed against the full
// schema namespace so relational queries (db.query.projects.
// findMany({ with: { members: true } })) get full inference.
//
// We expose `createDb(pool)` alongside the singleton so tests can
// swap in a custom Pool (pg-mem, test container, or a dedicated
// CI connection) without touching the global slot.

const globalForDb = globalThis as unknown as {
  rovenueDrizzleDb?: NodePgDatabase<typeof schema>;
};

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool = getPool()): Db {
  return drizzle(pool, { schema });
}

export function getDb(): Db {
  if (!globalForDb.rovenueDrizzleDb) {
    globalForDb.rovenueDrizzleDb = createDb();
  }
  return globalForDb.rovenueDrizzleDb;
}

/**
 * Convenience export — mirrors Prisma's `import { prisma } from
 * "@rovenue/db"` ergonomics. Lazy-initialised through a Proxy so
 * modules that import this before DATABASE_URL is set (tests,
 * scripts) don't crash at import time.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { schema };
