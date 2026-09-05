-- Task 10: keep existing integrations receiving the purchases they
-- already asked for.
--
-- `enabled_events` is a stored text[] written from whatever the dashboard
-- submitted; there is no defaulting to the catalog. A connection created
-- before 2026-09-04 therefore holds an array that CANNOT contain
-- revenue.NON_RENEWING_PURCHASE.
--
-- Until now a consumable or one-time purchase reached those connections
-- as revenue.INITIAL. Splitting the type without this migration would
-- stop deliveries that work today -- a silent regression on live customer
-- integrations.
--
-- Scoped to connections that already have revenue.INITIAL: those have
-- declared they want to hear about purchases, and this preserves that.
-- A connection WITHOUT it opted out of purchase events and must not be
-- opted back in.
--
-- revenue.REACTIVATION is deliberately NOT added: it is a genuinely new
-- signal nobody has ever received, so it ships opt-in.
UPDATE "integration_connections"
SET "enabled_events" = (
  SELECT array_agg(DISTINCT e)
  FROM unnest(
    "enabled_events" || ARRAY['revenue.CREDIT_PURCHASE', 'revenue.NON_RENEWING_PURCHASE']
  ) AS e
)
WHERE 'revenue.INITIAL' = ANY("enabled_events");
