CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."billing_dunning_phase" AS ENUM('retrying', 'past_due', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."billing_invoice_status" AS ENUM('draft', 'open', 'paid', 'uncollectible', 'void');--> statement-breakpoint
CREATE TYPE "public"."billing_meter_key" AS ENUM('mtr', 'events', 'sql_queries');--> statement-breakpoint
CREATE TYPE "public"."billing_pending_action" AS ENUM('downgrade_to_free', 'pause', 'delete');--> statement-breakpoint
CREATE TYPE "public"."billing_state" AS ENUM('free', 'active', 'past_due', 'paused', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."billing_tier" AS ENUM('free', 'indie', 'pro', 'scale', 'growth', 'enterprise');--> statement-breakpoint
CREATE TABLE "billing_dunning_state" (
	"project_id" text PRIMARY KEY NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"current_phase" "billing_dunning_phase",
	"ui_locked_at" timestamp with time zone,
	"sdk_locked_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"last_email_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"number" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_due" numeric(12, 4) NOT NULL,
	"amount_paid" numeric(12, 4) DEFAULT '0' NOT NULL,
	"refunded_amount" numeric(12, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" "billing_invoice_status" NOT NULL,
	"hosted_invoice_url" text,
	"pdf_url" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_payment_attempt" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "billing_payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"stripe_payment_method_id" text NOT NULL,
	"brand" text NOT NULL,
	"last4" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payment_methods_stripe_payment_method_id_unique" UNIQUE("stripe_payment_method_id")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"state" "billing_state" DEFAULT 'free' NOT NULL,
	"tier" "billing_tier" DEFAULT 'free' NOT NULL,
	"cycle" "billing_cycle" DEFAULT 'monthly' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"pending_action" "billing_pending_action",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_tier_limits" (
	"tier" "billing_tier" NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"price_usd_cents" integer NOT NULL,
	"stripe_price_id" text,
	"mtr_min" numeric(12, 4) NOT NULL,
	"mtr_max" numeric(12, 4),
	"events_limit" integer,
	"sql_limit" integer,
	"retention_days" integer NOT NULL,
	"audit_log_days" integer NOT NULL,
	CONSTRAINT "billing_tier_limits_tier_cycle_pk" PRIMARY KEY("tier","cycle")
);
--> statement-breakpoint
CREATE TABLE "usage_snapshots" (
	"project_id" text NOT NULL,
	"meter_key" "billing_meter_key" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"current_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"limit_value" numeric(18, 4),
	"soft_cap_warned_at" timestamp with time zone,
	"hard_cap_warned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_snapshots_project_id_meter_key_period_start_pk" PRIMARY KEY("project_id","meter_key","period_start")
);
--> statement-breakpoint
ALTER TABLE "billing_dunning_state" ADD CONSTRAINT "billing_dunning_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payment_methods" ADD CONSTRAINT "billing_payment_methods_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_invoices_project_created_idx" ON "billing_invoices" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_payment_methods_default_uq" ON "billing_payment_methods" USING btree ("project_id") WHERE "billing_payment_methods"."is_default" = true;--> statement-breakpoint
CREATE INDEX "billing_payment_methods_project_idx" ON "billing_payment_methods" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_project_active_uq" ON "billing_subscriptions" USING btree ("project_id") WHERE "billing_subscriptions"."state" != 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_id_uq" ON "billing_subscriptions" USING btree ("stripe_subscription_id");
