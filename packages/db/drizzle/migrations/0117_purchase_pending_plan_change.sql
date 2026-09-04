ALTER TABLE "purchases" ADD COLUMN "pendingProductId" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "pendingChangeType" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "pendingChangeEffectiveAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_pendingProductId_products_id_fk" FOREIGN KEY ("pendingProductId") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;