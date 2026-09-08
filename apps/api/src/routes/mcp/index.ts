import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostOriginValidation } from "@modelcontextprotocol/hono";
import { BEARER_SCHEME, HEADER } from "@rovenue/shared";
import { drizzle, type MemberRole } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { buildMcpServer } from "../../services/mcp/server";
import { assertToolAllowed, authorizeMcpRequest } from "../../services/mcp/authorize";
import { env } from "../../lib/env";
import { quotasUnlimited } from "../../lib/host-mode";
import {
  evaluateQuota,
  resolveTier,
} from "../../services/copilot/quota";
import {
  countMcpAccessSince,
  isAbuseFloorExceeded,
  mcpAbuseFloorLimit,
  monthStartUtc,
  recordMcpAccess,
} from "../../services/mcp/access-log";
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

declare module "hono" {
  interface ContextVariableMap {
    mcpRole: MemberRole;
  }
}

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
    // The live role is stashed for tool execution below.
    const ctx = c.get("mcpToken");
    const { role } = await authorizeMcpRequest(ctx);
    c.set("mcpRole", role);

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

      // Abuse floor (Task 10, R3): per token per calendar month, enforced
      // in BOTH host modes — deliberately no quotasUnlimited() check. The
      // trail itself is the counter; no second counting system.
      const used = await countMcpAccessSince(
        drizzle.db,
        { tokenId: ctx.tokenId },
        monthStartUtc(),
      );
      if (isAbuseFloorExceeded(used)) {
        const resetAt = new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth() + 1,
            1,
          ),
        ).toISOString();
        throw new HTTPException(429, {
          message: `Monthly MCP call limit reached (${used}/${mcpAbuseFloorLimit()}); resets ${resetAt}`,
        });
      }

      // Tier ladder (spec R3: "the tier ladder still applies on top, in
      // cloud mode only, as the billing instrument"). Counts the SAME
      // trail by project — no second counting system. Skipped entirely
      // when unlimited (self-host / enterprise): the ladder is off there
      // by design, and skipping avoids two DB reads per call.
      // Each surface enforces only the axis it consumes: chat passes
      // mcpCalls: 0, MCP passes messages/tokens: 0. Cross-gating (chat
      // usage blocking MCP or vice versa) would couple unrelated
      // resources; the shared budget is per-axis, not per-surface.
      if (!quotasUnlimited()) {
        const project = await drizzle.projectRepo.findProjectById(
          drizzle.db,
          ctx.projectId,
        );
        if (!project) {
          throw new HTTPException(404, { message: "Project not found" });
        }
        const { tier } = resolveTier({
          project: {
            metadata: project.settings as Record<string, unknown> | null,
          },
          env,
          unlimited: false,
        });
        const mcpCalls = await countMcpAccessSince(
          drizzle.db,
          { projectId: ctx.projectId },
          monthStartUtc(),
        );
        const verdict = evaluateQuota({
          tier,
          unlimited: false,
          usage: { messages: 0, inputTokens: 0, outputTokens: 0, mcpCalls },
        });
        if (!verdict.allowed) {
          const resetAt = new Date(
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth() + 1,
              1,
            ),
          ).toISOString();
          throw new HTTPException(429, {
            message: `Monthly ${verdict.exceeded} limit reached for tier ${tier}; resets ${resetAt}`,
          });
        }
      }
    }

    await next();
  })
  .all("*", async (c) => {
    // Project-scoped identity for tool execution, via the handler's
    // pass-through `authInfo` seam (extra = the SDK's designed slot for
    // additional auth-attached data). Verified token + live membership,
    // resolved above on this same request.
    const ctx = c.get("mcpToken");
    const res = await mcpHandler.fetch(c.req.raw, {
      authInfo: {
        token: ctx.tokenId,
        clientId: ctx.userId,
        scopes: [ctx.scope],
        extra: { projectId: ctx.projectId, role: c.get("mcpRole") },
      },
    });

    // Access trail: exactly one MCP_ACCESS outbox row per tool call that
    // reached the handler. Awaited before returning so a counted call
    // always has its row; a trail failure must never rewrite the tool
    // result the handler already produced, so it logs instead of
    // throwing (touchLastUsed above follows the same precedent).
    let probed: { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    try {
      probed = (await c.req.raw.clone().json()) as typeof probed;
    } catch {
      probed = {};
    }
    if (probed.method === "tools/call" && typeof probed.params?.name === "string") {
      try {
        await recordMcpAccess(drizzle.db, {
          projectId: ctx.projectId,
          tokenId: ctx.tokenId,
          userId: ctx.userId,
          toolName: probed.params.name,
          scope: ctx.scope,
          args: probed.params.arguments ?? null,
          ok: res.status < 400,
        });
      } catch (err: unknown) {
        log.warn("mcp access trail write failed", {
          tokenId: ctx.tokenId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return res;
  });
