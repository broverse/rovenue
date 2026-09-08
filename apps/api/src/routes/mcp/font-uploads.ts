// =============================================================
// MCP: HMAC-ticketed raw-body font upload
// =============================================================
//
// The confirm step to the `stage_font_upload` MCP tool's propose
// step. The stage tool mints a short-lived HMAC ticket; the agent
// then POSTs the raw font bytes here with the ticket. This route runs
// the FULL pipeline — the dashboard's own font byte-core
// (`processFontUpload`: locator check, capability, magic bytes,
// family ownership, quota with skip-on-replace, upsert + audit) —
// never a weaker re-implementation.
//
// Why a separate HTTP route instead of an MCP tool call: font bytes
// cannot ride inside a JSON `tools/call` envelope. The MCP token
// still authenticates (same `verifyMcpToken` as the protocol
// endpoint), so the upload is bound to the same project-scoped
// identity that staged it.
//
// The ticket binds project + kind + the full font locator. A font
// has no file name — its identity is (familyName | familyId,
// weight, style) — so the ticket's `name` field carries that locator
// as JSON (`encodeFontTicketName`), validated on both sides by the
// dashboard's own `fontLocatorSchema`. The ticket format itself is
// untouched: the fonts group reuses `lib/upload-ticket.ts` exactly
// as the assets group built it, with its own kind value ("font")
// plus this file's route-side allow-list.
//
// Gate order (all fail-closed, cheapest first):
// 1. Bearer [REDACTED] token (401 — same message as the MCP endpoint).
// 2. `read_write` scope (403 — a `read` token stages nothing and
//    uploads nothing).
// 3. Live ADMIN-or-above membership (403 — the MCP write tier; the
//    dashboard's `fonts:write` also admits DEVELOPER, but MCP writes
//    stay ADMIN-gated like every other MCP write tool).
// 4. Ticket: HMAC valid, unexpired, bound to THIS project and the
//    "font" kind, carrying a well-formed locator (401/403/400).
// 5. `processFontUpload` — which re-checks the `fonts:write`
//    capability itself (dashboard parity) and audits the commit.
//
// The transport cap is the dashboard's own `fontUploadBodyLimit`
// factory — one shared factory, never two numbers that can drift.
// The rate limiter mirrors the dashboard's asset-upload limiter
// (same per-minute max) under its own bucket name so abuse of one
// surface never starves the other.
//
// No new DB table, no sweeper: tickets are stateless HMAC, and replay
// safety is the pipeline's face upsert (a re-played ticket against
// the same familyId/weight/style replaces the same row — no second
// face, no quota growth).

import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { MemberRole } from "@rovenue/db";
import {
  ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
  BEARER_SCHEME,
  HEADER,
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
// Narrow dashboard→MCP reuse (same exception as the MCP asset
// upload's import of the dashboard's byte-core): the transport cap,
// the locator schema, and the whole byte-core, never a
// re-declaration.
import {
  fontLocatorSchema,
  fontUploadBodyLimit,
  processFontUpload,
  type FontLocator,
} from "../dashboard/fonts";

const BEARER_PREFIX_LOWER = `${BEARER_SCHEME.toLowerCase()} `;

/** The ticket kind this transport stages and accepts. Bound, not enumerated. */
export const FONT_UPLOAD_TICKET_KIND = "font";

/** The raw-body upload URL the stage tool hands out, relative to the API root. */
export const FONT_UPLOAD_URL_PATH = "/mcp/font-uploads/font";

/**
 * Encode the locator into the ticket's `name` field. Key order is
 * fixed (family first, then weight, then style) so the same locator
 * always produces the same string — the ticket HMAC covers it either
 * way, but determinism keeps staged tickets comparable.
 */
export function encodeFontTicketName(locator: FontLocator): string {
  const ordered: Record<string, unknown> = {};
  if (locator.familyName !== undefined) ordered.familyName = locator.familyName;
  if (locator.familyId !== undefined) ordered.familyId = locator.familyId;
  ordered.weight = locator.weight;
  ordered.style = locator.style;
  return JSON.stringify(ordered);
}

/** Parse the ticket's `name` field back into a validated locator. Null when forged. */
export function decodeFontTicketName(name: string): FontLocator | null {
  let raw: unknown;
  try {
    raw = JSON.parse(name);
  } catch {
    return null;
  }
  const parsed = fontLocatorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function ticketedFontUploadHandler(c: Context) {
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

  // 4. The staged ticket binds project + kind + locator. The locator
  // is authoritative from the ticket (there is no query override to
  // swap after staging), and the kind must be this transport's own —
  // a ticket staged for an asset kind uploads no font.
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
  if (payload.kind !== FONT_UPLOAD_TICKET_KIND) {
    throw new HTTPException(400, { message: "Upload ticket is for another upload kind" });
  }
  const locator = decodeFontTicketName(payload.name);
  if (!locator) {
    throw new HTTPException(401, { message: "Invalid upload ticket" });
  }

  // 5. The full pipeline incl. audit. `processFontUpload`
  // re-checks `fonts:write` itself (dashboard parity) — the ADMIN
  // gate above is the MCP tier, this is the product capability.
  return processFontUpload(c, {
    projectId: token.projectId,
    userId: token.userId,
    ...locator,
  });
}

export const mcpFontUploadRoute = new Hono().use(
  "*",
  endpointRateLimit({
    name: "mcp-font-upload",
    max: ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
    identify: (c) => c.req.header(HEADER.AUTHORIZATION) ?? "unknown",
  }),
);

// One registration, one kind: `bodyLimit`'s `maxSize` is fixed at
// registration time, and this transport carries exactly one cap via
// the SHARED factory.
mcpFontUploadRoute.post("/font", fontUploadBodyLimit(), ticketedFontUploadHandler);
