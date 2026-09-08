-- 0134_mcp_access_aggregate.sql
-- Add 'MCP_ACCESS' to the outbox aggregate_type enum.
--
-- Follows the 0043 (BILLING) / 0047 (NOTIFICATION) / 0052 (FUNNEL)
-- precedent: single ALTER TYPE ... ADD VALUE, no type-swap (a swap
-- would drop values added by earlier migrations). IF NOT EXISTS keeps
-- a re-run safe; the MCP access trail is the only writer of this value
-- and ships in the same release, so the "can't use a new enum value in
-- the same tx" guard never trips in practice.

ALTER TYPE "aggregate_type" ADD VALUE IF NOT EXISTS 'MCP_ACCESS';
