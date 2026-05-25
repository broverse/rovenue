CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"base" text DEFAULT 'USD' NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"fetchedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_date_base_quote_pk" PRIMARY KEY("date","base","quote")
);
--> statement-breakpoint
CREATE INDEX "fx_rates_quote_date_idx" ON "fx_rates" USING btree ("quote","date");