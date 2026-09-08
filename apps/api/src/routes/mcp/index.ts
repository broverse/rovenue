import { Hono } from "hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostOriginValidation } from "@modelcontextprotocol/hono";
import { buildMcpServer } from "../../services/mcp/server";

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
  .all("*", (c) => mcpHandler.fetch(c.req.raw));
