-- PR1 backfill: rename legacy product `storeIds` JSON keys
-- (ios/android/web) to the canonical store keys (apple/google/stripe) used by
-- the purchase-time lookup (`findProductByStoreId`) and the SDK offerings
-- response. Products imported under the platform keys were invisible to
-- fulfillment — no purchase row, entitlement, or currency grant was created.
-- Idempotent: only rows still carrying a legacy key are touched, and the keys
-- are renamed (values preserved). Any pre-existing canonical key is kept; a
-- legacy key's value wins on the unlikely chance both are present.
UPDATE "products"
SET "storeIds" = (
  ("storeIds" - 'ios' - 'android' - 'web')
  || CASE WHEN "storeIds" ? 'ios'
       THEN jsonb_build_object('apple', "storeIds"->>'ios') ELSE '{}'::jsonb END
  || CASE WHEN "storeIds" ? 'android'
       THEN jsonb_build_object('google', "storeIds"->>'android') ELSE '{}'::jsonb END
  || CASE WHEN "storeIds" ? 'web'
       THEN jsonb_build_object('stripe', "storeIds"->>'web') ELSE '{}'::jsonb END
)
WHERE "storeIds" ?| array['ios', 'android', 'web'];
