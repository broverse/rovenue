// =============================================================
// Unsubscribe-link tokens (HMAC-SHA256, base64url body.signature)
// =============================================================
//
// The List-Unsubscribe header in outgoing notification email
// carries a URL of the form `…/unsubscribe?token=<body>.<sig>`
// signed by UNSUB_SIGNING_KEY. The public unsubscribe handler
// verifies the signature, checks expiry, and applies the change
// without requiring a session — RFC 8058 one-click compliant.
//
// Format:
//   token := base64url(JSON(payload)) "." base64url(HMAC-SHA256)
//
// Payload:
//   { userId, scope, projectId?, exp }
//
// scope is "channel:email" for blanket unsubscribes, or
// `event:<eventKey>` for per-event opt-outs. exp is a unix
// seconds timestamp.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribePayload {
  userId: string;
  scope: "channel:email" | `event:${string}`;
  projectId?: string;
  /** unix epoch seconds */
  exp: number;
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

function hmacSign(body: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  return b64urlEncode(createHmac("sha256", key).update(body).digest());
}

export function signUnsubscribeToken(
  payload: UnsubscribePayload,
  keyHex: string,
): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = hmacSign(body, keyHex);
  return `${body}.${sig}`;
}

export class UnsubscribeTokenError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "malformed"
      | "invalid_signature"
      | "expired"
      | "malformed_payload",
  ) {
    super(message);
    this.name = "UnsubscribeTokenError";
  }
}

export function verifyUnsubscribeToken(
  token: string,
  keyHex: string,
  nowMs: number = Date.now(),
): UnsubscribePayload {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnsubscribeTokenError("malformed unsubscribe token", "malformed");
  }
  const [body, sig] = parts;
  const expected = hmacSign(body, keyHex);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnsubscribeTokenError(
      "invalid unsubscribe signature",
      "invalid_signature",
    );
  }

  let payload: UnsubscribePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString()) as UnsubscribePayload;
  } catch {
    throw new UnsubscribeTokenError(
      "malformed unsubscribe payload",
      "malformed_payload",
    );
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.userId !== "string" ||
    typeof payload.scope !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new UnsubscribeTokenError(
      "malformed unsubscribe payload",
      "malformed_payload",
    );
  }
  if (payload.exp * 1000 < nowMs) {
    throw new UnsubscribeTokenError("expired unsubscribe token", "expired");
  }
  return payload;
}
