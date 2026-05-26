import { createHash, randomBytes } from "node:crypto";

const PREFIX = "rov_inv_";

export interface GeneratedInvitationToken {
  /** Sent to the invitee. NEVER persisted — only its sha256 hash. */
  plaintext: string;
  /** sha256(plaintext) in hex. Persisted as project_invitations.tokenHash. */
  hash: string;
}

export function generateInvitationToken(): GeneratedInvitationToken {
  // 32 bytes → 43 base64url chars; well above brute-force horizon and
  // short enough to fit comfortably in an email body.
  const body = randomBytes(32).toString("base64url");
  const plaintext = `${PREFIX}${body}`;
  return { plaintext, hash: hashInvitationToken(plaintext) };
}

export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
