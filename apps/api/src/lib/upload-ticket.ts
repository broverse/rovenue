// =============================================================
// Staged-upload tickets (HMAC-SHA256, base64url body.signature)
// =============================================================
//
// A stateless upload authorisation for raw-body transports that cannot
// carry a session cookie or re-validate through the dashboard auth
// middleware — the MCP asset upload (routes/mcp/uploads.ts) and, by
// design, the fonts group's staged upload later. No database table, no
// sweeper: the ticket IS the state, verified on every upload.
//
// Format:
//   ticket := base64url(JSON(payload)) "." base64url(HMAC-SHA256)
//
// Payload:
//   { projectId, kind, name, exp }
//
// `kind` is an opaque string here on purpose: this module binds a
// caller-declared kind, it does not enumerate one. The assets group
// passes image/video/lottie; the fonts group reuses this same module
// with its own kind value and its own route-side allow-list. Expiry is
// a unix seconds timestamp, ~15 minutes out (UPLOAD_TICKET_TTL_MS).
//
// Replay safety comes from the pipeline, not the ticket: a re-played
// ticket re-uploads bytes the content-hash dedup resolves to the same
// row, so a second POST cannot create a second asset or charge quota
// twice. The ticket only needs to NOT be forgeable or eternal.
//
// The signing key is the app's existing BETTER_AUTH_SECRET (see
// getUploadTicketKey) — the same secret the auth-crypto surface
// already trusts — never a new env var, never a hardcoded fallback.
// A missing secret fails closed: signing and verification both throw
// rather than minting an unsigned ticket.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export interface UploadTicketPayload {
  projectId: string;
  /** Caller-declared kind (assets: image/video/lottie). Bound, not enumerated. */
  kind: string;
  name: string;
  /** unix epoch seconds */
  exp: number;
}

/** How far out a freshly minted ticket expires. Short on purpose: the
 *  ticket authorises one upload, staged moments ago by the same agent. */
export const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000;

/** Upload URL path the stage tools hand out, relative to the API root.
 *  One place so the tool and the route file cannot disagree. */
export function uploadTicketPath(kind: string): string {
  return `/mcp/uploads/${kind}`;
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded = s + "===".slice((s.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function hmacSign(body: string, key: string): string {
  return b64urlEncode(createHmac("sha256", key).update(body).digest());
}

/**
 * The signing key. BETTER_AUTH_SECRET is the existing app secret the
 * auth surface already requires — reusing it adds no new secret to
 * rotate or leak. Throws when unset so a misconfigured deploy refuses
 * to stage uploads rather than minting tickets nobody can verify (or
 * worse, verifying against an empty key).
 */
export function getUploadTicketKey(): string {
  const key = env.BETTER_AUTH_SECRET;
  if (!key) {
    throw new UploadTicketError(
      "upload ticket signing is not configured",
      "misconfigured",
    );
  }
  return key;
}

export class UploadTicketError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "malformed"
      | "invalid_signature"
      | "expired"
      | "malformed_payload"
      | "misconfigured",
  ) {
    super(message);
    this.name = "UploadTicketError";
  }
}

export function signUploadTicket(
  payload: UploadTicketPayload,
  key: string,
): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = hmacSign(body, key);
  return `${body}.${sig}`;
}

/** Mint + expiry in one call: the shape the stage tools return. */
export function mintUploadTicket(
  input: { projectId: string; kind: string; name: string },
  key: string,
  nowMs: number = Date.now(),
): { ticket: string; expiresAt: string } {
  const exp = Math.floor((nowMs + UPLOAD_TICKET_TTL_MS) / 1000);
  const ticket = signUploadTicket({ ...input, exp }, key);
  return { ticket, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyUploadTicket(
  ticket: string,
  key: string,
  nowMs: number = Date.now(),
): UploadTicketPayload {
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UploadTicketError("malformed upload ticket", "malformed");
  }
  const [body, sig] = parts;
  const expected = hmacSign(body, key);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UploadTicketError("invalid upload ticket signature", "invalid_signature");
  }

  let payload: UploadTicketPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString()) as UploadTicketPayload;
  } catch {
    throw new UploadTicketError("malformed upload ticket payload", "malformed_payload");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.projectId !== "string" ||
    !payload.projectId ||
    typeof payload.kind !== "string" ||
    !payload.kind ||
    typeof payload.name !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new UploadTicketError("malformed upload ticket payload", "malformed_payload");
  }
  if (payload.exp * 1000 < nowMs) {
    throw new UploadTicketError("expired upload ticket", "expired");
  }
  return payload;
}
