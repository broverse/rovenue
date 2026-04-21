CREATE TYPE "public"."CreditLedgerType" AS ENUM('PURCHASE', 'SPEND', 'REFUND', 'BONUS', 'EXPIRE', 'TRANSFER_IN', 'TRANSFER_OUT');--> statement-breakpoint
CREATE TYPE "public"."Environment" AS ENUM('PRODUCTION', 'SANDBOX');--> statement-breakpoint
CREATE TYPE "public"."ExperimentStatus" AS ENUM('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."ExperimentType" AS ENUM('FLAG', 'PRODUCT_GROUP', 'PAYWALL', 'ELEMENT');--> statement-breakpoint
CREATE TYPE "public"."FeatureFlagType" AS ENUM('BOOLEAN', 'STRING', 'NUMBER', 'JSON');--> statement-breakpoint
CREATE TYPE "public"."MemberRole" AS ENUM('OWNER', 'ADMIN', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."OutgoingWebhookStatus" AS ENUM('PENDING', 'SENT', 'FAILED', 'DEAD', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."ProductType" AS ENUM('SUBSCRIPTION', 'CONSUMABLE', 'NON_CONSUMABLE');--> statement-breakpoint
CREATE TYPE "public"."PurchaseStatus" AS ENUM('TRIAL', 'ACTIVE', 'EXPIRED', 'REFUNDED', 'REVOKED', 'PAUSED', 'GRACE_PERIOD');--> statement-breakpoint
CREATE TYPE "public"."RevenueEventType" AS ENUM('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'CANCELLATION', 'REFUND', 'REACTIVATION', 'CREDIT_PURCHASE');--> statement-breakpoint
CREATE TYPE "public"."Store" AS ENUM('APP_STORE', 'PLAY_STORE', 'STRIPE');--> statement-breakpoint
CREATE TYPE "public"."WebhookEventStatus" AS ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."WebhookSource" AS ENUM('APPLE', 'GOOGLE', 'STRIPE');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"label" text NOT NULL,
	"keyPublic" text NOT NULL,
	"keySecretHash" text NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"environment" "Environment" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_keyPublic_unique" UNIQUE("keyPublic")
);
--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resourceId" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ipAddress" text,
	"userAgent" text,
	"prevHash" text,
	"rowHash" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_rowHash_unique" UNIQUE("rowHash")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"type" "CreditLedgerType" NOT NULL,
	"amount" integer NOT NULL,
	"balance" integer NOT NULL,
	"referenceType" text,
	"referenceId" text,
	"description" text,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"experimentId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"variantId" text NOT NULL,
	"assignedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"convertedAt" timestamp with time zone,
	"purchaseId" text,
	"revenue" numeric(12, 4),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "ExperimentType" NOT NULL,
	"key" text NOT NULL,
	"audienceId" text NOT NULL,
	"status" "ExperimentStatus" DEFAULT 'DRAFT' NOT NULL,
	"variants" jsonb NOT NULL,
	"metrics" jsonb,
	"mutualExclusionGroup" text,
	"startedAt" timestamp with time zone,
	"completedAt" timestamp with time zone,
	"winnerVariantId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"key" text NOT NULL,
	"type" "FeatureFlagType" NOT NULL,
	"defaultValue" jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outgoing_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"eventType" text NOT NULL,
	"subscriberId" text NOT NULL,
	"purchaseId" text,
	"payload" jsonb NOT NULL,
	"url" text NOT NULL,
	"status" "OutgoingWebhookStatus" DEFAULT 'PENDING' NOT NULL,
	"httpStatus" integer,
	"responseBody" text,
	"lastErrorMessage" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextRetryAt" timestamp with time zone,
	"sentAt" timestamp with time zone,
	"deadAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"identifier" text NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"identifier" text NOT NULL,
	"type" "ProductType" NOT NULL,
	"storeIds" jsonb NOT NULL,
	"displayName" text NOT NULL,
	"entitlementKeys" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"creditAmount" integer,
	"isActive" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"role" "MemberRole" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"appleCredentials" jsonb,
	"googleCredentials" jsonb,
	"stripeCredentials" jsonb,
	"webhookUrl" text,
	"webhookSecret" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"productId" text NOT NULL,
	"store" "Store" NOT NULL,
	"storeTransactionId" text NOT NULL,
	"originalTransactionId" text NOT NULL,
	"status" "PurchaseStatus" NOT NULL,
	"isTrial" boolean DEFAULT false NOT NULL,
	"isIntroOffer" boolean DEFAULT false NOT NULL,
	"isSandbox" boolean DEFAULT false NOT NULL,
	"purchaseDate" timestamp with time zone NOT NULL,
	"expiresDate" timestamp with time zone,
	"originalPurchaseDate" timestamp with time zone NOT NULL,
	"priceAmount" numeric(12, 4),
	"priceCurrency" text,
	"environment" "Environment" NOT NULL,
	"autoRenewStatus" boolean,
	"cancellationDate" timestamp with time zone,
	"refundDate" timestamp with time zone,
	"gracePeriodExpires" timestamp with time zone,
	"ownershipType" text,
	"verifiedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"purchaseId" text NOT NULL,
	"type" "RevenueEventType" NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"currency" text NOT NULL,
	"amountUsd" numeric(12, 4) NOT NULL,
	"store" "Store" NOT NULL,
	"productId" text NOT NULL,
	"eventDate" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscriber_access" (
	"id" text PRIMARY KEY NOT NULL,
	"subscriberId" text NOT NULL,
	"purchaseId" text NOT NULL,
	"entitlementKey" text NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"expiresDate" timestamp with time zone,
	"store" "Store" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"appUserId" text NOT NULL,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deletedAt" timestamp with time zone,
	"mergedInto" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp,
	"updatedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"source" "WebhookSource" NOT NULL,
	"eventType" text NOT NULL,
	"storeEventId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "WebhookEventStatus" DEFAULT 'RECEIVED' NOT NULL,
	"subscriberId" text,
	"purchaseId" text,
	"errorMessage" text,
	"processedAt" timestamp with time zone,
	"retryCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experimentId_experiments_id_fk" FOREIGN KEY ("experimentId") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_audienceId_audiences_id_fk" FOREIGN KEY ("audienceId") REFERENCES "public"."audiences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_purchaseId_purchases_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_productId_products_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_purchaseId_purchases_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_productId_products_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_access" ADD CONSTRAINT "subscriber_access_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_access" ADD CONSTRAINT "subscriber_access_purchaseId_purchases_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_purchaseId_purchases_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_projectId_idx" ON "api_keys" USING btree ("projectId");--> statement-breakpoint
CREATE UNIQUE INDEX "audiences_projectId_name_key" ON "audiences" USING btree ("projectId","name");--> statement-breakpoint
CREATE INDEX "audiences_projectId_idx" ON "audiences" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "audit_logs_projectId_createdAt_idx" ON "audit_logs" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_resourceId_idx" ON "audit_logs" USING btree ("resourceId");--> statement-breakpoint
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "credit_ledger_subscriberId_createdAt_idx" ON "credit_ledger" USING btree ("subscriberId","createdAt");--> statement-breakpoint
CREATE INDEX "credit_ledger_projectId_subscriberId_idx" ON "credit_ledger" USING btree ("projectId","subscriberId");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_assignments_experimentId_subscriberId_key" ON "experiment_assignments" USING btree ("experimentId","subscriberId");--> statement-breakpoint
CREATE INDEX "experiment_assignments_subscriberId_idx" ON "experiment_assignments" USING btree ("subscriberId");--> statement-breakpoint
CREATE INDEX "experiment_assignments_experimentId_convertedAt_idx" ON "experiment_assignments" USING btree ("experimentId","convertedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_projectId_key_key" ON "experiments" USING btree ("projectId","key");--> statement-breakpoint
CREATE INDEX "experiments_projectId_status_idx" ON "experiments" USING btree ("projectId","status");--> statement-breakpoint
CREATE INDEX "experiments_mutualExclusionGroup_idx" ON "experiments" USING btree ("mutualExclusionGroup");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_projectId_key_key" ON "feature_flags" USING btree ("projectId","key");--> statement-breakpoint
CREATE INDEX "feature_flags_projectId_isEnabled_idx" ON "feature_flags" USING btree ("projectId","isEnabled");--> statement-breakpoint
CREATE INDEX "outgoing_webhooks_status_nextRetryAt_idx" ON "outgoing_webhooks" USING btree ("status","nextRetryAt");--> statement-breakpoint
CREATE INDEX "outgoing_webhooks_projectId_status_idx" ON "outgoing_webhooks" USING btree ("projectId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_projectId_identifier_key" ON "product_groups" USING btree ("projectId","identifier");--> statement-breakpoint
CREATE INDEX "product_groups_projectId_isDefault_idx" ON "product_groups" USING btree ("projectId","isDefault");--> statement-breakpoint
CREATE UNIQUE INDEX "products_projectId_identifier_key" ON "products" USING btree ("projectId","identifier");--> statement-breakpoint
CREATE INDEX "products_projectId_isActive_idx" ON "products" USING btree ("projectId","isActive");--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members" USING btree ("projectId","userId");--> statement-breakpoint
CREATE INDEX "project_members_userId_idx" ON "project_members" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_store_storeTransactionId_key" ON "purchases" USING btree ("store","storeTransactionId");--> statement-breakpoint
CREATE INDEX "purchases_originalTransactionId_idx" ON "purchases" USING btree ("originalTransactionId");--> statement-breakpoint
CREATE INDEX "purchases_subscriberId_status_idx" ON "purchases" USING btree ("subscriberId","status");--> statement-breakpoint
CREATE INDEX "purchases_expiresDate_idx" ON "purchases" USING btree ("expiresDate");--> statement-breakpoint
CREATE INDEX "revenue_events_projectId_eventDate_idx" ON "revenue_events" USING btree ("projectId","eventDate");--> statement-breakpoint
CREATE INDEX "revenue_events_subscriberId_type_idx" ON "revenue_events" USING btree ("subscriberId","type");--> statement-breakpoint
CREATE INDEX "subscriber_access_subscriberId_isActive_idx" ON "subscriber_access" USING btree ("subscriberId","isActive");--> statement-breakpoint
CREATE INDEX "subscriber_access_subscriberId_entitlementKey_idx" ON "subscriber_access" USING btree ("subscriberId","entitlementKey");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_projectId_appUserId_key" ON "subscribers" USING btree ("projectId","appUserId");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_storeEventId_key" ON "webhook_events" USING btree ("source","storeEventId");--> statement-breakpoint
CREATE INDEX "webhook_events_status_retryCount_idx" ON "webhook_events" USING btree ("status","retryCount");