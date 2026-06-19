CREATE TABLE "product_currency_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"productId" text NOT NULL,
	"currencyId" text NOT NULL,
	"amount" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_currencies" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"archivedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "currencyId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "product_currency_grants" ADD CONSTRAINT "product_currency_grants_productId_products_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_currency_grants" ADD CONSTRAINT "product_currency_grants_currencyId_virtual_currencies_id_fk" FOREIGN KEY ("currencyId") REFERENCES "public"."virtual_currencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_currencies" ADD CONSTRAINT "virtual_currencies_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_currency_grants_productId_currencyId_key" ON "product_currency_grants" USING btree ("productId","currencyId");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_currencies_projectId_code_key" ON "virtual_currencies" USING btree ("projectId","code");--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_currencyId_virtual_currencies_id_fk" FOREIGN KEY ("currencyId") REFERENCES "public"."virtual_currencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_subscriberId_currencyId_createdAt_idx" ON "credit_ledger" USING btree ("subscriberId","currencyId","createdAt");