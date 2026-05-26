// =============================================================
// Drizzle entrypoint
// =============================================================
//
// Re-exports the pool factory, schema namespace, and client
// singleton under a single import path so downstream callers do:
//
//   import { db, projects, auditLogs } from "@rovenue/db/drizzle";
//
// The top-level `@rovenue/db` re-exports this namespace as
// `drizzle` for the common `import { drizzle } from "@rovenue/db"`
// shape.

export { createPool, getPool, closePool } from "./pool";
export { createDb, getDb, db, schema, type Db } from "./client";
export * from "./schema";
export * from "./enums";
export * from "./validators";
export * from "./shadow";
export * from "./sql-helpers";
export * as subscriberRepo from "./repositories/subscribers";
export * as featureFlagRepo from "./repositories/feature-flags";
export * as auditLogRepo from "./repositories/audit-logs";
export * as experimentRepo from "./repositories/experiments";
export * as accessRepo from "./repositories/access";
export * as creditLedgerRepo from "./repositories/credit-ledger";
export * as apiKeyRepo from "./repositories/api-keys";
export * as projectRepo from "./repositories/projects";
export * as audienceRepo from "./repositories/audiences";
export * as outboxRepo from "./repositories/outbox";
export * as outgoingWebhookRepo from "./repositories/outgoing-webhooks";
export * as dashboardFeatureFlagRepo from "./repositories/feature-flags-dashboard";
export * as userRepo from "./repositories/users";
export * as sessionRepo from "./repositories/sessions";
export * as accountRepo from "./repositories/accounts";
export * as personalAccessTokenRepo from "./repositories/personal-access-tokens";
export * as userPreferencesRepo from "./repositories/user-preferences";
export * as productGroupRepo from "./repositories/product-groups";
export * as experimentAssignmentRepo from "./repositories/experiment-assignments";
export * as purchaseRepo from "./repositories/purchases";
export * as webhookEventRepo from "./repositories/webhook-events";
export * as subscriberDetailRepo from "./repositories/subscriber-detail";
export * as purchaseExtRepo from "./repositories/purchases-ext";
export * as revenueEventRepo from "./repositories/revenue-events";
export * as lockRepo from "./repositories/locks";
export * as savedChartViewRepo from "./repositories/saved-chart-views";
export * as chartAnnotationRepo from "./repositories/chart-annotations";
export * as productRepo from "./repositories/products";
export * as cohortRepo from "./repositories/cohorts";
export * as savedQueryRepo from "./repositories/saved-queries";
export * as fxRateRepo from "./repositories/fx-rates";
export * as scheduledActionsRepo from "./repositories/scheduled-actions";
