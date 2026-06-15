ALTER TYPE "public"."OutgoingWebhookStatus" ADD VALUE 'DELIVERING' BEFORE 'SENT';--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD COLUMN "claimedAt" timestamp with time zone;