DROP INDEX "subscribers_access_reconciliation_idx";--> statement-breakpoint
CREATE INDEX "subscribers_access_reconciliation_idx" ON "subscribers" USING btree ("lastAccessReconciledAt" NULLS FIRST);