DROP INDEX "idx_rss_outcome_lookup";--> statement-breakpoint
CREATE INDEX "idx_rss_outcome_lookup" ON "refund_shield_responses" USING btree ("project_id","apple_original_transaction_id");