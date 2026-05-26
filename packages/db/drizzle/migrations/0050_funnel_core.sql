CREATE TYPE "public"."FunnelDeferredPlatform" AS ENUM('ios');--> statement-breakpoint
CREATE TYPE "public"."FunnelPurchaseStatus" AS ENUM('pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."FunnelSessionState" AS ENUM('in_progress', 'paid', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."FunnelStatus" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."FunnelTemplateScope" AS ENUM('system', 'user');--> statement-breakpoint
CREATE TABLE "funnel_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"page_id" text NOT NULL,
	"question_id" text NOT NULL,
	"answer_json" jsonb NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_claim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"email_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by_subscriber_id" text,
	CONSTRAINT "funnel_claim_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "funnel_claim_tokens_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "funnel_deferred_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"platform" "FunnelDeferredPlatform" NOT NULL,
	"ip_hash" text NOT NULL,
	"user_agent" text NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"screen_dims" text NOT NULL,
	"device_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"matched_at" timestamp with time zone,
	"matched_install_id" text
);
--> statement-breakpoint
CREATE TABLE "funnel_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"product_id" text,
	"stripe_checkout_session_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"amount_cents" integer,
	"currency" text,
	"status" "FunnelPurchaseStatus" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "funnel_purchases_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "funnel_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"funnel_id" text NOT NULL,
	"funnel_version_id" text NOT NULL,
	"project_id" text NOT NULL,
	"anon_id" text NOT NULL,
	"state" "FunnelSessionState" DEFAULT 'in_progress' NOT NULL,
	"current_page_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"utm_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "funnel_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"preview_image_url" text,
	"pages_json" jsonb NOT NULL,
	"theme_json" jsonb NOT NULL,
	"settings_json" jsonb NOT NULL,
	"scope" "FunnelTemplateScope" DEFAULT 'system' NOT NULL,
	"project_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"funnel_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"pages_json" jsonb NOT NULL,
	"theme_json" jsonb NOT NULL,
	"settings_json" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "FunnelStatus" DEFAULT 'draft' NOT NULL,
	"current_version_id" text,
	"draft_pages_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_theme_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "funnel_answers" ADD CONSTRAINT "funnel_answers_session_id_funnel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."funnel_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_claim_tokens" ADD CONSTRAINT "funnel_claim_tokens_session_id_funnel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."funnel_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_deferred_claims" ADD CONSTRAINT "funnel_deferred_claims_token_id_funnel_claim_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."funnel_claim_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_purchases" ADD CONSTRAINT "funnel_purchases_session_id_funnel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."funnel_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sessions" ADD CONSTRAINT "funnel_sessions_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_sessions" ADD CONSTRAINT "funnel_sessions_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_templates" ADD CONSTRAINT "funnel_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_versions" ADD CONSTRAINT "funnel_versions_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_versions" ADD CONSTRAINT "funnel_versions_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_answers_session_question_unique" ON "funnel_answers" USING btree ("session_id","question_id");--> statement-breakpoint
CREATE INDEX "funnel_answers_session_idx" ON "funnel_answers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "funnel_claim_tokens_email_idx" ON "funnel_claim_tokens" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "funnel_claim_tokens_expires_idx" ON "funnel_claim_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "funnel_deferred_claims_ip_expires_idx" ON "funnel_deferred_claims" USING btree ("ip_hash","expires_at");--> statement-breakpoint
CREATE INDEX "funnel_deferred_claims_token_idx" ON "funnel_deferred_claims" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "funnel_purchases_project_status_idx" ON "funnel_purchases" USING btree ("project_id","status","paid_at");--> statement-breakpoint
CREATE INDEX "funnel_purchases_stripe_sub_idx" ON "funnel_purchases" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "funnel_sessions_funnel_started_idx" ON "funnel_sessions" USING btree ("funnel_id","started_at");--> statement-breakpoint
CREATE INDEX "funnel_sessions_state_activity_idx" ON "funnel_sessions" USING btree ("state","last_activity_at");--> statement-breakpoint
CREATE INDEX "funnel_sessions_project_started_idx" ON "funnel_sessions" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "funnel_templates_scope_category_idx" ON "funnel_templates" USING btree ("scope","category");--> statement-breakpoint
CREATE INDEX "funnel_templates_project_idx" ON "funnel_templates" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_versions_funnel_version_unique" ON "funnel_versions" USING btree ("funnel_id","version_no");--> statement-breakpoint
CREATE INDEX "funnels_project_status_idx" ON "funnels" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "funnels_project_slug_unique" ON "funnels" USING btree ("project_id","slug");