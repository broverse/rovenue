import { createHash } from "node:crypto";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import { env } from "../../lib/env";

/**
 * The MCP access trail (design D6 / plan Task 10).
 *
 * Every tool call reaching the MCP handler emits exactly one MCP_ACCESS
 * outbox row — the transactional outbox is the ONLY path to the event
 * bus and the analytics store, so a direct write here would bypass the
 * dispatcher and lose the at-least-once guarantee. The trail
 * deliberately does NOT go in audit_logs: that table is a per-project
 * append-only hash chain, and a row per read would bloat it for no
 * benefit.
 *
 * Privacy: the row carries the tool and the actor, never argument
 * values — only a sha256 digest of the canonicalized arguments. A query
 * string can itself be PII, and this row is destined for analytics
 * storage.
 *
 * Quota (R3 resolution — two limits, not one):
 * 1. An abuse floor per token per calendar month that ignores
 *    quotasUnlimited() and applies in BOTH host modes. Not a billing
 *    limit; a self-hoster who raises it buys nothing.
 * 2. The tier ladder on top (cloud billing instrument): QuotaInput gains
 *    usage.mcpCalls and ExceededAxis gains "mcp_calls". The trail itself
 *    is the counter — no second counting system with its own window.
 */

export const MCP_ACCESS_AGGREGATE = "MCP_ACCESS";
export const MCP_TOOL_CALLED_EVENT = "mcp.tool_called";

/** Default abuse floor; env-overridable, host-mode independent. */
export const MCP_ABUSE_FLOOR_DEFAULT = 50_000;

export function mcpAbuseFloorLimit(): number {
  return env.MCP_MAX_CALLS_PER_TOKEN_PER_MONTH;
}

/** Pure by design: the floor never consults quotasUnlimited(). */
export function isAbuseFloorExceeded(
  callsThisMonth: number,
  limit: number = mcpAbuseFloorLimit(),
): boolean {
  return callsThisMonth >= limit;
}

export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

/** Canonical JSON: sorted keys, recursive. Digest input, never stored. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function argsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalize(args ?? null)).digest("hex");
}

export interface McpAccessEntry {
  projectId: string;
  tokenId: string;
  userId: string;
  toolName: string;
  scope: string;
  /** Raw arguments — digested, never stored. */
  args: unknown;
  /** Transport-level success (HTTP < 400), not tool isError. */
  ok: boolean;
}

/**
 * Insert one access row through the caller's handle: pass a transaction
 * and the row commits/rolls back with it; pass drizzle.db for a standalone
 * statement. Exactly one row per call — the route awaits this before
 * returning, so a counted call always has its row.
 */
export async function recordMcpAccess(
  db: Db,
  entry: McpAccessEntry,
): Promise<void> {
  await drizzle.outboxRepo.insert(db, {
    aggregateType: MCP_ACCESS_AGGREGATE,
    aggregateId: entry.tokenId,
    eventType: MCP_TOOL_CALLED_EVENT,
    payload: {
      projectId: entry.projectId,
      tokenId: entry.tokenId,
      userId: entry.userId,
      toolName: entry.toolName,
      scope: entry.scope,
      argsDigest: argsDigest(entry.args),
      ok: entry.ok,
      // Call time in the payload (not just the outbox row's createdAt):
      // the ClickHouse MV reads occurredAt from here, same convention as
      // the other pipelines.
      occurredAt: new Date().toISOString(),
    },
  });
}

/**
 * Count trail rows since `since`, scoped to one token (abuse floor) or
 * one project (tier ladder). Counting the trail itself is what keeps
 * this from becoming a second counting system with its own window.
 * The outbox table stays small (outbox-cleanup deletes published rows
 * hourly), so no extra index is warranted.
 */
export async function countMcpAccessSince(
  db: Db,
  scope: { tokenId: string } | { projectId: string },
  since: Date,
): Promise<number> {
  // The aggregateId is the token, so token scoping is a column equality
  // while project scoping reads the payload (same ->> precedent as the
  // notification tests).
  const base = and(
    eq(drizzle.schema.outboxEvents.aggregateType, MCP_ACCESS_AGGREGATE),
    gte(drizzle.schema.outboxEvents.createdAt, since),
  );
  const scoped =
    "tokenId" in scope
      ? and(
          base,
          eq(drizzle.schema.outboxEvents.aggregateId, scope.tokenId),
        )
      : and(
          base,
          sql`${drizzle.schema.outboxEvents.payload}->>'projectId' = ${scope.projectId}`,
        );
  const [row] = await db
    .select({ n: count() })
    .from(drizzle.schema.outboxEvents)
    .where(scoped);
  return Number(row?.n ?? 0);
}
