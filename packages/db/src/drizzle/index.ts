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
export * as accessCatalogRepo from "./repositories/access-catalog";
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
export * as offeringRepo from "./repositories/offerings";
export * as experimentAssignmentRepo from "./repositories/experiment-assignments";
export * as purchaseRepo from "./repositories/purchases";
export * as webhookEventRepo from "./repositories/webhook-events";
export * as subscriberDetailRepo from "./repositories/subscriber-detail";
export * as purchaseExtRepo from "./repositories/purchases-ext";
export * as revenueEventRepo from "./repositories/revenue-events";
export * as lockRepo from "./repositories/locks";
export * as savedChartViewRepo from "./repositories/saved-chart-views";
export * as chartAnnotationRepo from "./repositories/chart-annotations";
export * as customChartRepo from "./repositories/custom-charts";
export * as productRepo from "./repositories/products";
export * as cohortRepo from "./repositories/cohorts";
export * as savedQueryRepo from "./repositories/saved-queries";
export * as fxRateRepo from "./repositories/fx-rates";
export * as scheduledActionsRepo from "./repositories/scheduled-actions";
export * as invitationRepo from "./repositories/invitations";
export * as billingSubscriptionRepo from "./repositories/billing-subscriptions";
export * as billingPaymentMethodRepo from "./repositories/billing-payment-methods";
export * as billingInvoiceRepo from "./repositories/billing-invoices";
export * as billingDunningStateRepo from "./repositories/billing-dunning-state";
export * as usageSnapshotRepo from "./repositories/usage-snapshots";
export * as billingTierLimitsRepo from "./repositories/billing-tier-limits";
export * as notificationRepo from "./repositories/notifications";
export * as notificationPreferencesRepo from "./repositories/notification-preferences";
export * as notificationDeliveryRepo from "./repositories/notification-deliveries";
export * as pushDeviceRepo from "./repositories/push-devices";
export * as notificationSuppressionRepo from "./repositories/notification-suppression";
export * as userKnownDeviceRepo from "./repositories/user-known-devices";
export * as funnelRepo from "./repositories/funnels";
export * as funnelVersionRepo from "./repositories/funnel-versions";
export * as funnelTemplateRepo from "./repositories/funnel-templates";
export * as funnelSessionRepo from "./repositories/funnel-sessions";
export * as funnelAnswerRepo from "./repositories/funnel-answers";
export * as funnelPurchaseRepo from "./repositories/funnel-purchases";
export * as funnelClaimTokenRepo from "./repositories/funnel-claim-tokens";
export * as funnelDeferredClaimRepo from "./repositories/funnel-deferred-claims";
export * as customDomainRepo from "./repositories/custom-domains";
