import bcrypt from "bcryptjs";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { drizzle } from "@rovenue/db";

export interface McpTokenContext {
  tokenId: string;
  projectId: string;
  userId: string;
  scope: string;
}

declare module "hono" {
  interface ContextVariableMap {
    mcpToken: McpTokenContext;
  }
}

/**
 * Token-verifier seam. A single injectable `(raw) => context | null`
 * function so OAuth can later slot into the same shape without re-plumbing
 * the route. Deliberately NOT the SDK's `OAuthTokenVerifier`: there is no
 * authorization server here, so nothing is published under
 * `/.well-known/oauth-protected-resource` — advertising one would make a
 * conformant client attempt a flow that cannot succeed.
 */
export type McpTokenVerifier = (
  rawToken: string,
) => Promise<McpTokenContext | null>;

/**
 * MCP token layout: `rov_mcp_<tokenId>_<random>`
 *
 * The row id is encoded in the token so verification starts with an
 * indexed lookup on the embedded id before running one bcrypt comparison
 * — otherwise every request would bcrypt every non-revoked token in the
 * table. The id alphabet (hex, see the dashboard mint) contains no `_`,
 * so the first delimiter after the prefix is unambiguous. The WHOLE raw
 * token is compared against `keySecretHash`, as `api-key-auth.ts` does.
 *
 * Reject order: unparseable prefix → row not found → hash mismatch →
 * `revokedAt` set → `expiresAt` in the past. All five are the same null
 * to the caller; the route maps null to one 401 and never leaks which.
 * Never accepts a token Rovenue did not issue — there is no passthrough
 * path here and there must not be one.
 */
function parseMcpTokenId(rawToken: string): string | null {
  if (!rawToken.startsWith(MCP_TOKEN_PREFIX)) return null;
  const body = rawToken.slice(MCP_TOKEN_PREFIX.length);
  const delimiter = body.indexOf("_");
  if (delimiter <= 0) return null;
  return body.slice(0, delimiter);
}

export const verifyMcpToken: McpTokenVerifier = async (rawToken) => {
  const tokenId = parseMcpTokenId(rawToken);
  if (!tokenId) return null;

  const record = await drizzle.mcpTokenRepo.findById(drizzle.db, tokenId);
  if (!record) return null;

  const valid = await bcrypt.compare(rawToken, record.keySecretHash);
  if (!valid) return null;

  if (record.revokedAt) return null;
  if (record.expiresAt != null && record.expiresAt < new Date()) return null;

  return {
    tokenId: record.id,
    projectId: record.projectId,
    userId: record.userId,
    scope: record.scope,
  };
};
