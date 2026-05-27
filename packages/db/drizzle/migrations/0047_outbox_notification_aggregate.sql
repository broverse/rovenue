-- 0047_outbox_notification_aggregate.sql
-- Add 'NOTIFICATION' to the outbox aggregate_type enum.
--
-- Originally drafted as a type-swap (CREATE _new / ALTER USING / DROP /
-- RENAME) mirroring 0039_member_role_rebuild.sql. The merge with billing
-- (0043_aggregate_type_billing.sql) shifted this migration to 0047 and
-- forced a rewrite — the swap-based form would silently drop the BILLING
-- value that 0043 added.
--
-- Single ALTER TYPE ... ADD VALUE keeps things atomic enough (the only
-- caller of NOTIFICATION outbox writes ships in the same release as this
-- migration, so the "can't use new enum value in the same tx" guard
-- never trips in practice).

ALTER TYPE "aggregate_type" ADD VALUE IF NOT EXISTS 'NOTIFICATION';
