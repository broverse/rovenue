// =============================================================
// Drizzle entrypoint
// =============================================================
//
// Re-exports the pool factory, schema namespace, and client
// singleton under a single import path so downstream callers do:
//
//   import { db, projects, auditLogs } from "@rovenue/db/drizzle";
//
// Prisma remains the default @rovenue/db export during the hybrid
// period (see packages/db/src/index.ts).

export { createPool, getPool, closePool } from "./pool";
export { createDb, getDb, db, schema, type Db } from "./client";
export * from "./schema";
export * from "./enums";
export * from "./validators";
export * from "./shadow";
export * as subscriberRepo from "./repositories/subscribers";
export * as featureFlagRepo from "./repositories/feature-flags";
export * as auditLogRepo from "./repositories/audit-logs";
