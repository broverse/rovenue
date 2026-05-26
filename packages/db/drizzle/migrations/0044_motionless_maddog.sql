CREATE TYPE "public"."NotificationChannel" AS ENUM('email', 'push', 'inapp');--> statement-breakpoint
CREATE TYPE "public"."NotificationDeliveryStatus" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."PushPlatform" AS ENUM('ios', 'android');