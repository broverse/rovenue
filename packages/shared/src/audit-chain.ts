import { createHash } from "node:crypto";

// =============================================================
// Audit chain canonical form
// =============================================================
//
// The per-project audit hash chain (apps/api/src/lib/audit.ts) hashes
// each row over this canonical encoding. It lives here, rather than in
// the API, so an external verifier can recompute a hash without
// importing anything from the server it is auditing.
//
// `JSON.stringify` does not guarantee key order across engines. A
// compliance-grade chain must be byte-identical on re-hash, so keys are
// emitted in sorted order and arrays/objects are recursed explicitly.

/** Identifies which canonical encoding a proof bundle's hashes used.
 *  Written into every bundle; a verifier refuses a version it does not
 *  implement rather than guessing. */
export const AUDIT_CHAIN_FORMAT_V1 = "rovenue.audit-chain.v1";

/** Exactly the fields the row hash covers, in the order audit.ts builds
 *  them. Adding or reordering a field changes every subsequent hash. */
export interface AuditChainPayload {
  projectId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** ISO-8601. Stringified by the caller — this module never sees a Date. */
  createdAt: string;
  prevHash: string | null;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(",")}}`;
}

export function hashAuditRow(payload: AuditChainPayload): string {
  return createHash("sha256").update(canonicalJSON(payload)).digest("hex");
}
