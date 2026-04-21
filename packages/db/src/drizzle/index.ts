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
export * from "./sql-helpers";
export * from "./views";
export * as subscriberRepo from "./repositories/subscribers";
export * as featureFlagRepo from "./repositories/feature-flags";
export * as auditLogRepo from "./repositories/audit-logs";
export * as metricsRepo from "./repositories/metrics";
export * as experimentRepo from "./repositories/experiments";
export * as accessRepo from "./repositories/access";
export * as creditLedgerRepo from "./repositories/credit-ledger";
export * as apiKeyRepo from "./repositories/api-keys";
export * as projectRepo from "./repositories/projects";
export * as audienceRepo from "./repositories/audiences";
export * as outgoingWebhookRepo from "./repositories/outgoing-webhooks";
export * as dashboardFeatureFlagRepo from "./repositories/feature-flags-dashboard";
export * as userRepo from "./repositories/users";
export * as productGroupRepo from "./repositories/product-groups";
export * as experimentAssignmentRepo from "./repositories/experiment-assignments";
export * as purchaseRepo from "./repositories/purchases";
export * as webhookEventRepo from "./repositories/webhook-events";
export * as subscriberDetailRepo from "./repositories/subscriber-detail";
