import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostOriginValidation } from "@modelcontextprotocol/hono";
import { BEARER_SCHEME, HEADER } from "@rovenue/shared";
import { drizzle } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { buildMcpServer } from "../../services/mcp/server";
import { assertToolAllowed, authorizeMcpRequest } from "../../services/mcp/authorize";
import { verifyMcpToken } from "./auth";

const log = logger.child("mcp-auth");

/**
 * One handler for the whole subtree. Statelessness lives in the factory:
 * `createMcpHandler` builds a fresh `McpServer` (and its transport) per
 * request, so sharing this handler across requests is the documented shape,
 * not shared mutable state.
 *
 * `legacy: "reject"` makes this a modern-only strict endpoint. This server
 * speaks the 2026-07-28 revision (`server/discover`); the retired
 * `initialize` handshake is answered with the unsupported-protocol-version
 * error naming the supported revision, never served.
 *
 * The entry performs no token verification itself (Task 4): validated
 * `authInfo` will be passed per request via `handler.fetch(req, { authInfo })`.
 */
const mcpHandler = createMcpHandler((ctx) => buildMcpServer(ctx), {
  legacy: "reject",
});

const BEARER_PREFIX_LOWER = `${BEARER_SCHEME.toLowerCase()} `;

/**
 * Origin is validated before anything else. HTTP transports are exposed to
 * DNS rebinding; this is not optional.
 *
 * Policy: localhost-class origins only. MCP clients are non-browser agents
 * (Claude Code, Cursor, …) that send no `Origin` header and therefore pass;
 * a browser may only reach this endpoint from a localhost-class origin, so a
 * malicious page cannot drive a victim's browser against a remote API.
 * Scoped to this subtree with `.use("*", …)` on `mcpRoute`, never on the
 * root app.
 */
export const mcpRoute = new Hono()
  .use("*", localhostOriginValidation())
  .use("*", async (c, next) => {
    // Every /mcp request carries a user-bound token (Task 4). A missing or
    // unverifiable Bearer [REDACTED] is the same 401 — never leak which check failed.
    const header = c.req.header(HEADER.AUTHORIZATION);
    const raw =
      header && header.toLowerCase().startsWith(BEARER_PREFIX_LOWER)
        ? header.slice(BEARER_PREFIX_LOWER.length).trim()
        : null;
    const ctx = raw ? await verifyMcpToken(raw) : null;
    if (!ctx) {
      throw new HTTPException(401, { message: "Invalid or expired MCP token" });
    }
    c.set("mcpToken", ctx);

    // Fire-and-forget last-used touch.
    drizzle.mcpTokenRepo
      .touchLastUsed(drizzle.db, ctx.tokenId)
      .catch((err: unknown) => {
        log.warn("lastUsedAt update failed", {
          tokenId: ctx.tokenId,
          err: err instanceof Error ? err.message : String(err),
        });
      });

    await next();
  })
  .use("*", async (c, next) => {
    // Authorization resolves per request (Task 5). The membership is
    // re-read on every call: no baked-in role, no cross-request cache.
    const ctx = c.get("mcpToken");
    await authorizeMcpRequest(ctx);

    // Scope is enforced BEFORE dispatch, never inside a tool body: a
    // rejected write leaves no intent row or other side effect. The body
    // is read from a clone so the handler still receives an unread
    // request; an unparseable body simply skips gating and lets the
    // handler answer (415/400) on its own terms.
    let method: unknown;
    let toolName: unknown;
    try {
      const probed = (await c.req.raw.clone().json()) as {
        method?: unknown;
        params?: { name?: unknown };
      };
      method = probed.method;
      toolName = probed.params?.name;
    } catch {
      method = undefined;
    }
    if (method === "tools/call") {
      assertToolAllowed(ctx, toolName);
    }

    await next();
  })
  .all("*", (c) => mcpHandler.fetch(c.req.raw));
