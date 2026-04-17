-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SUBSCRIPTION', 'CONSUMABLE', 'NON_CONSUMABLE');

-- CreateEnum
CREATE TYPE "Store" AS ENUM ('APP_STORE', 'PLAY_STORE', 'STRIPE');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'REFUNDED', 'REVOKED', 'PAUSED', 'GRACE_PERIOD');

-- CreateEnum
CREATE TYPE "CreditLedgerType" AS ENUM ('PURCHASE', 'SPEND', 'REFUND', 'BONUS', 'EXPIRE', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "WebhookSource" AS ENUM ('APPLE', 'GOOGLE', 'STRIPE');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutgoingWebhookStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RevenueEventType" AS ENUM ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CANCELLATION', 'REFUND', 'REACTIVATION', 'CREDIT_PURCHASE');

-- CreateEnum
CREATE TYPE "ExperimentType" AS ENUM ('FLAG', 'PRODUCT_GROUP', 'PAYWALL', 'ELEMENT');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FeatureFlagType" AS ENUM ('BOOLEAN', 'STRING', 'NUMBER', 'JSON');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyPublic" TEXT NOT NULL,
    "keySecretHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMPTZ,
    "expiresAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ,
    "environment" "Environment" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "appleCredentials" JSONB,
    "googleCredentials" JSONB,
    "stripeCredentials" JSONB,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "storeIds" JSONB NOT NULL,
    "displayName" TEXT NOT NULL,
    "entitlementKeys" TEXT[],
    "creditAmount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_groups" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "products" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscribers" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "appUserId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "deletedAt" TIMESTAMPTZ,
    "mergedInto" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "store" "Store" NOT NULL,
    "storeTransactionId" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "isTrial" BOOLEAN NOT NULL DEFAULT false,
    "isIntroOffer" BOOLEAN NOT NULL DEFAULT false,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "purchaseDate" TIMESTAMPTZ NOT NULL,
    "expiresDate" TIMESTAMPTZ,
    "originalPurchaseDate" TIMESTAMPTZ NOT NULL,
    "priceAmount" DECIMAL(12,4),
    "priceCurrency" TEXT,
    "environment" "Environment" NOT NULL,
    "autoRenewStatus" BOOLEAN,
    "cancellationDate" TIMESTAMPTZ,
    "refundDate" TIMESTAMPTZ,
    "gracePeriodExpires" TIMESTAMPTZ,
    "ownershipType" TEXT,
    "verifiedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriber_access" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "entitlementKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresDate" TIMESTAMPTZ,
    "store" "Store" NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscriber_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "type" "CreditLedgerType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "WebhookSource" NOT NULL,
    "eventType" TEXT NOT NULL,
    "storeEventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "subscriberId" TEXT,
    "purchaseId" TEXT,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMPTZ,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outgoing_webhooks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "payload" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "status" "OutgoingWebhookStatus" NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "responseBody" TEXT,
    "lastErrorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMPTZ,
    "sentAt" TIMESTAMPTZ,
    "deadAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "type" "RevenueEventType" NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,4) NOT NULL,
    "store" "Store" NOT NULL,
    "productId" TEXT NOT NULL,
    "eventDate" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audiences" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ExperimentType" NOT NULL,
    "key" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "variants" JSONB NOT NULL,
    "metrics" JSONB,
    "mutualExclusionGroup" TEXT,
    "startedAt" TIMESTAMPTZ,
    "completedAt" TIMESTAMPTZ,
    "winnerVariantId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignments" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "events" JSONB NOT NULL DEFAULT '[]',
    "convertedAt" TIMESTAMPTZ,
    "purchaseId" TEXT,
    "revenue" DECIMAL(12,4),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "FeatureFlagType" NOT NULL,
    "defaultValue" JSONB NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyPublic_key" ON "api_keys"("keyPublic");

-- CreateIndex
CREATE INDEX "api_keys_projectId_idx" ON "api_keys"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "products_projectId_isActive_idx" ON "products"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "products_projectId_identifier_key" ON "products"("projectId", "identifier");

-- CreateIndex
CREATE INDEX "product_groups_projectId_isDefault_idx" ON "product_groups"("projectId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "product_groups_projectId_identifier_key" ON "product_groups"("projectId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "subscribers_projectId_appUserId_key" ON "subscribers"("projectId", "appUserId");

-- CreateIndex
CREATE INDEX "purchases_originalTransactionId_idx" ON "purchases"("originalTransactionId");

-- CreateIndex
CREATE INDEX "purchases_subscriberId_status_idx" ON "purchases"("subscriberId", "status");

-- CreateIndex
CREATE INDEX "purchases_expiresDate_idx" ON "purchases"("expiresDate");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_store_storeTransactionId_key" ON "purchases"("store", "storeTransactionId");

-- CreateIndex
CREATE INDEX "subscriber_access_subscriberId_isActive_idx" ON "subscriber_access"("subscriberId", "isActive");

-- CreateIndex
CREATE INDEX "subscriber_access_subscriberId_entitlementKey_idx" ON "subscriber_access"("subscriberId", "entitlementKey");

-- CreateIndex
CREATE INDEX "credit_ledger_subscriberId_createdAt_idx" ON "credit_ledger"("subscriberId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_ledger_projectId_subscriberId_idx" ON "credit_ledger"("projectId", "subscriberId");

-- CreateIndex
CREATE INDEX "webhook_events_status_retryCount_idx" ON "webhook_events"("status", "retryCount");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_source_storeEventId_key" ON "webhook_events"("source", "storeEventId");

-- CreateIndex
CREATE INDEX "outgoing_webhooks_status_nextRetryAt_idx" ON "outgoing_webhooks"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "outgoing_webhooks_projectId_status_idx" ON "outgoing_webhooks"("projectId", "status");

-- CreateIndex
CREATE INDEX "revenue_events_projectId_eventDate_idx" ON "revenue_events"("projectId", "eventDate");

-- CreateIndex
CREATE INDEX "revenue_events_subscriberId_type_idx" ON "revenue_events"("subscriberId", "type");

-- CreateIndex
CREATE INDEX "audiences_projectId_idx" ON "audiences"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "audiences_projectId_name_key" ON "audiences"("projectId", "name");

-- CreateIndex
CREATE INDEX "experiments_projectId_status_idx" ON "experiments"("projectId", "status");

-- CreateIndex
CREATE INDEX "experiments_mutualExclusionGroup_idx" ON "experiments"("mutualExclusionGroup");

-- CreateIndex
CREATE UNIQUE INDEX "experiments_projectId_key_key" ON "experiments"("projectId", "key");

-- CreateIndex
CREATE INDEX "experiment_assignments_subscriberId_idx" ON "experiment_assignments"("subscriberId");

-- CreateIndex
CREATE INDEX "experiment_assignments_experimentId_convertedAt_idx" ON "experiment_assignments"("experimentId", "convertedAt");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignments_experimentId_subscriberId_key" ON "experiment_assignments"("experimentId", "subscriberId");

-- CreateIndex
CREATE INDEX "feature_flags_projectId_isEnabled_idx" ON "feature_flags"("projectId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_projectId_key_key" ON "feature_flags"("projectId", "key");

-- CreateIndex
CREATE INDEX "audit_logs_projectId_createdAt_idx" ON "audit_logs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_resourceId_idx" ON "audit_logs"("resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriber_access" ADD CONSTRAINT "subscriber_access_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriber_access" ADD CONSTRAINT "subscriber_access_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "audiences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
