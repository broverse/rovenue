// =============================================================
// MCP: HMAC-ticketed raw-body asset upload
// =============================================================
//
// The confirm step to the `stage_asset_upload` MCP tool's propose
// step. The stage tool mints a short-lived HMAC ticket; the agent
// then POSTs the raw bytes here with the ticket. This route runs the
// FULL pipeline — the dashboard's own byte-core
// (`processAssetUpload`: name check, capability, storage, quota
// pre-check, normalise, dedup, reserve, put, row commit + audit) —
// never a weaker re-implementation.
//
// Why a separate HTTP route instead of an MCP tool call: a 50 MB
// video cannot ride inside a JSON `tools/call` envelope. The MCP
// token still authenticates (same `verifyMcpToken` as the protocol
// endpoint), so the upload is bound to the same project-scoped
// identity that staged it.
//
// Gate order (all fail-closed, cheapest first):
// 1. Bearer MCP token (401 — same message as the MCP endpoint).
// 2. `read_write` scope (403 — a `read` token stages nothing and
//    uploads nothing).
// 3. Live ADMIN-or-above membership (403 — the MCP write tier; the
//    dashboard's `assets:write` also admits DEVELOPER, but MCP writes
//    stay ADMIN-gated like every other MCP write tool).
// 4. Ticket: HMAC valid, unexpired, and bound to THIS project, kind,
//    and name (401/403/400 — a ticket staged for another project or
//    kind is useless here even to its own stager).
// 5. `processAssetUpload` — which re-checks the `assets:write`
//    capability itself (dashboard parity) and audits the commit.
//
// Per-kind `bodyLimit` caps come from the dashboard's own
// `assetUploadBodyLimit` factory — one shared factory, never two
// numbers that can drift. The rate limiter mirrors the dashboard's
// `asset-upload` limiter (same per-minute max) under its own bucket
// name so abuse of one surface never starves the other.
//
// No new DB table, no sweeper: tickets are stateless HMAC, and replay
// safety is the pipeline's content-hash dedup (a re-played ticket
// resolves to the existing row, HTTP 200, no second quota charge).
//
// The fonts group reuses this shape: `lib/upload-ticket.ts` binds an
// opaque kind string, so a staged font upload needs only its own
// ticket kind value plus a route entry pointing at the fonts
// byte-core — no new ticket infra.

import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { MemberRole } from "@rovenue/db";
import {
  ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
  BEARER_SCHEME,
  HEADER,
  type AssetKind,
} from "@rovenue/shared";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { assertProjectAccess } from "../../lib/project-access";
import {
  getUploadTicketKey,
  UploadTicketError,
  verifyUploadTicket,
} from "../../lib/upload-ticket";
import { MCP_SCOPE_READ_WRITE } from "../../services/mcp/authorize";
import { verifyMcpToken } from "./auth";
// Narrow dashboard→MCP reuse (same exception as the MCP delete_asset
// tool's import of the dashboard's query schema): the transport cap
// and the whole byte-core, never a re-declaration.
import {
  assetUploadBodyLimit,
  processAssetUpload,
} from "../dashboard/assets";

const BEARER_PREFIX_LOWER = `${BEARER_SCHEME.toLowerCase()} `;

export const UPLOAD_KINDS = ["image", "video", "lottie"] as const satisfies readonly AssetKind[];

function ticketedUploadHandler(kind: AssetKind) {
  return async (c: Context) => {
    // 1 + 2. The same Bearer [REDACTED] the MCP protocol endpoint verifies —
    // missing/unverifiable is one 401 that never says which check
    // failed, then the write scope gate (a `read` token uploads
    // nothing).
    const header = c.req.header(HEADER.AUTHORIZATION);
    const raw =
      header && header.toLowerCase().startsWith(BEARER_PREFIX_LOWER)
        ? header.slice(BEARER_PREFIX_LOWER.length).trim()
        : null;
    const token = raw ? await verifyMcpToken(raw) : null;
    if (!token) {
      throw new HTTPException(401, { message: "Invalid or expired MCP token" });
    }
    if (token.scope !== MCP_SCOPE_READ_WRITE) {
      throw new HTTPException(403, { message: "This token is read-only" });
    }

    // 3. Live ADMIN-or-above membership, re-read per request (no
    // baked-in role — a demotion must take effect immediately, same
    // as the protocol endpoint). OWNER outranks ADMIN, so owners pass.
    await assertProjectAccess(token.projectId, token.userId, MemberRole.ADMIN);

    // 4. The staged ticket binds project + kind + name. The name is
    // authoritative from the ticket (there is no `?name=` override to
    // swap after staging), and the kind must equal this registration
    // — a ticket staged for `image` uploads no `video`.
    const ticket = c.req.query("ticket") ?? "";
    let payload: { projectId: string; kind: string; name: string };
    try {
      payload = verifyUploadTicket(ticket, getUploadTicketKey());
    } catch (err) {
      if (err instanceof UploadTicketError && err.code === "expired") {
        throw new HTTPException(401, { message: "Upload ticket expired; stage again" });
      }
      if (err instanceof UploadTicketError && err.code === "misconfigured") {
        throw new HTTPException(503, { message: "Upload staging is not configured" });
      }
      throw new HTTPException(401, { message: "Invalid upload ticket" });
    }
    if (payload.projectId !== token.projectId) {
      throw new HTTPException(403, { message: "Upload ticket is for another project" });
    }
    if (payload.kind !== kind) {
      throw new HTTPException(400, { message: "Upload ticket is for another asset kind" });
    }

    // 5. The full pipeline incl. audit. `processAssetUpload`
    // re-checks `assets:write` itself (dashboard parity) — the ADMIN
    // gate above is the MCP tier, this is the product capability.
    return processAssetUpload(c, {
      kind,
      projectId: token.projectId,
      name: payload.name,
      userId: token.userId,
    });
  };
}

export const mcpAssetUploadRoute = new Hono().use(
  "*",
  endpointRateLimit({
    name: "mcp-asset-upload",
    max: ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
    identify: (c) => c.req.header(HEADER.AUTHORIZATION) ?? "unknown",
  }),
);

// Three registrations, one handler factory — same reason as the
// dashboard loop: `bodyLimit`'s `maxSize` is fixed at registration
// time, so each kind binds its own real cap via the SHARED factory.
for (const kind of UPLOAD_KINDS) {
  mcpAssetUploadRoute.post(`/${kind}`, assetUploadBodyLimit(kind), ticketedUploadHandler(kind));
}
