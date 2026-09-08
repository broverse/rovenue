import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import { mcpTokens, type McpToken, type NewMcpToken } from "../schema";

// =============================================================
// MCP tokens — Drizzle repository
// =============================================================
//
// User-bound, single-project Bearer [REDACTED] for the MCP surface (Task 4 mints
// `rov_mcp_<tokenId>_<random>` and verifies by parsing the embedded id,
// which is why `create` takes a caller-supplied id and `findById` is the
// hot lookup). Shaped after `api-keys.ts` without its `environment` /
// `allowedOrigins` baggage.

/**
 * Insert a new mcp_tokens row with the caller-supplied id so the id
 * embedded in the plaintext secret matches the stored row.
 */
export async function create(
  db: Db,
  row: NewMcpToken,
): Promise<McpToken> {
  const rows = await db.insert(mcpTokens).values(row).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create MCP token");
  return created;
}

/**
 * Single-row lookup by primary key. The verification path parses the
 * token id out of the presented secret and hits this — no table scan,
 * no per-row hash compare.
 */
export async function findById(
  db: Db,
  id: string,
): Promise<McpToken | null> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fire-and-forget lastUsedAt touch. Called per authenticated MCP request
 * so the dashboard can surface "last seen" per token.
 */
export async function touchLastUsed(db: Db, id: string): Promise<void> {
  await db
    .update(mcpTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpTokens.id, id));
}

/**
 * Revoke a single token by setting `revokedAt`. Scoped to BOTH the token
 * id and its owning project so a guessed id from another project can't be
 * revoked (IDOR guard — the same precedent every repository here follows),
 * and only affects rows that are still active. Returns the affected row or
 * null when nothing matched (already revoked, or wrong project) — callers
 * map null to 404.
 */
export async function revoke(
  db: Db,
  projectId: string,
  id: string,
): Promise<McpToken | null> {
  const rows = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.id, id),
        eq(mcpTokens.projectId, projectId),
        isNull(mcpTokens.revokedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Every token of a project, oldest first. Returns full rows (including the
 * secret hash) — the dashboard route projects to a safe shape; secrecy is
 * enforced at that layer, not here.
 */
export async function listByProject(
  db: Db,
  projectId: string,
): Promise<McpToken[]> {
  return db
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.projectId, projectId))
    .orderBy(asc(mcpTokens.createdAt));
}
