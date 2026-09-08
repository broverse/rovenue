import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

const BCRYPT_ROUNDS = 10;

const MCP_TOKEN_SCOPES = ["read", "read_write"] as const;

const createMcpTokenBodySchema = z.object({
  label: z.string().min(1).max(100),
  scope: z.enum(MCP_TOKEN_SCOPES),
  expiresAt: z.string().datetime({ offset: true }).nullish(),
});

/**
 * Pre-generate the token row id in JS so we can embed it inside the secret
 * plaintext and persist the matching bcrypt hash in a single `create` call.
 * The verifier parses the id back out of the token, so the id inside the
 * plaintext MUST match the row id.
 *
 * The token layout is `rov_mcp_<tokenId>_<random>`; the verifier splits on
 * the first `_` after the prefix to recover <tokenId>. The id MUST NOT
 * contain `_` — that's why this helper emits hex, not a cuid2.
 */
function newMcpTokenId(): string {
  return randomBytes(16).toString("hex");
}

function urlSafeRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function toSafeRow(t: {
  id: string;
  label: string;
  scope: string;
  keyPublic: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: t.id,
    label: t.label,
    scope: t.scope,
    keyPublic: t.keyPublic,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export const mcpTokensRoute = new Hono()
  .use("*", requireDashboardAuth)
  // POST / — mint a token and return the secret exactly once. The audit
  // payload carries only the public id — never the secret or its hash.
  .post("/", validate("json", createMcpTokenBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");
    const { label, scope, expiresAt } = c.req.valid("json");

    const tokenId = newMcpTokenId();
    const keyPublic = `${MCP_TOKEN_PREFIX}${tokenId}`;

    const { token, created } = await drizzle.db.transaction(async (tx) => {
      // Secret layout: `rov_mcp_<tokenId>_<random>`. The verifier uses the
      // id prefix for an indexed lookup before bcrypt compare, so the id
      // baked into the plaintext must match the stored row.
      const secretPlaintext = `${MCP_TOKEN_PREFIX}${tokenId}_${urlSafeRandom(32)}`;
      const keySecretHash = await bcrypt.hash(secretPlaintext, BCRYPT_ROUNDS);

      const created = await drizzle.mcpTokenRepo.create(tx, {
        id: tokenId,
        projectId,
        userId: user.id,
        label,
        scope,
        keyPublic,
        keySecretHash,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      await audit(
        {
          projectId,
          userId: user.id,
          action: "mcp_token.created",
          resource: "mcp_token",
          resourceId: tokenId,
          after: { id: tokenId, label, scope, keyPublic },
          ...extractRequestContext(c),
        },
        tx,
      );

      return { token: secretPlaintext, created };
    });

    return c.json(ok({ mcpToken: toSafeRow(created), token }));
  })
  // GET / — list tokens. Never returns the secret or its hash.
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");

    const tokens = await drizzle.mcpTokenRepo.listByProject(drizzle.db, projectId);
    return c.json(ok({ tokens: tokens.map(toSafeRow) }));
  })
  // DELETE /:tokenId — revoke a single token (sets revokedAt). Scoped to
  // the project in the repo so a foreign token id 404s. 404 when nothing
  // active matched.
  .delete("/:tokenId", async (c) => {
    const projectId = c.req.param("projectId");
    const tokenId = c.req.param("tokenId");
    if (!projectId || !tokenId)
      throw new HTTPException(400, { message: "Missing projectId or tokenId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");

    await drizzle.db.transaction(async (tx) => {
      const revoked = await drizzle.mcpTokenRepo.revoke(tx, projectId, tokenId);
      if (!revoked) {
        throw new HTTPException(404, { message: "MCP token not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "mcp_token.revoked",
          resource: "mcp_token",
          resourceId: tokenId,
          before: { id: revoked.id, label: revoked.label },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ id: tokenId }));
  });
