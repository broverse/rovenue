CREATE TYPE "public"."refund_shield_apple_environment" AS ENUM('PRODUCTION', 'SANDBOX');--> statement-breakpoint
ALTER TABLE "refund_shield_responses" ADD COLUMN "apple_environment" "refund_shield_apple_environment" DEFAULT 'PRODUCTION' NOT NULL;
