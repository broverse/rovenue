-- 0089_dear_night_thrasher.sql
--
-- Task 5 (paywall-placements): two independent changes bundled into one
-- migration since both land with the same feature.
--
-- 1. `aggregate_type` gains 'PAYWALL_EVENT' — the outbox aggregate for
--    `paywall_view` SDK events, dispatched to the `rovenue.paywall_events`
--    Kafka topic (apps/api/src/workers/outbox-dispatcher.ts). This enum has
--    always been hand-migrated (see 0013/0043/0047/0052_aggregate_type_*.sql)
--    because it was created via a raw DO-block, not drizzle-kit's own
--    generate flow — `drizzle-kit generate` does not track it, so the ALTER
--    TYPE below is authored by hand rather than auto-generated.
--
-- 2. `purchases.presentedContext` — nullable jsonb snapshot of the paywall
--    attribution the SDK/webhook supplied at purchase time ({ placementId,
--    paywallId, variantId?, experimentKey? }). Never validated against live
--    placement/paywall/experiment rows — attribution must not fail a
--    purchase.

ALTER TYPE "aggregate_type" ADD VALUE IF NOT EXISTS 'PAYWALL_EVENT';--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "presentedContext" jsonb;
