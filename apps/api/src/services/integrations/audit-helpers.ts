// =============================================================
// Audit helpers for integration connection lifecycle events
// =============================================================
//
// Wraps the generic audit() function with integration-specific
// action names and credential redaction so call sites never
// accidentally log raw cipher text.

import type { AuditTx } from "../../lib/audit";

// =============================================================
// Types
// =============================================================

export interface AuditDeps {
  audit: (
    entry: {
      projectId: string;
      userId: string;
      action: string;
      resource: string;
      resourceId: string;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
    },
    tx?: AuditTx,
  ) => Promise<void>;
}

interface BaseAuditParams {
  tx: AuditTx;
  projectId: string;
  userId: string;
  resourceId: string;
}

export interface CreateAuditParams extends BaseAuditParams {
  after: Record<string, unknown>;
}

export interface UpdateAuditParams extends BaseAuditParams {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export type DeleteAuditParams = BaseAuditParams;

// =============================================================
// Credential redaction
// =============================================================

const SENSITIVE_KEYS = new Set(["credentialsCipher", "access_token"]);

/**
 * Returns a shallow copy of `bag` with known sensitive keys replaced
 * by "[REDACTED]". Returns null for falsy input.
 */
export function redactCredentialsBag(
  bag: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!bag) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}

// =============================================================
// Helpers
// =============================================================

export async function auditIntegrationCreate(
  deps: AuditDeps,
  params: CreateAuditParams,
): Promise<void> {
  await deps.audit(
    {
      projectId: params.projectId,
      userId: params.userId,
      action: "integration.connection.created",
      resource: "integration_connection",
      resourceId: params.resourceId,
      after: redactCredentialsBag(params.after),
    },
    params.tx,
  );
}

export async function auditIntegrationUpdate(
  deps: AuditDeps,
  params: UpdateAuditParams,
): Promise<void> {
  await deps.audit(
    {
      projectId: params.projectId,
      userId: params.userId,
      action: "integration.connection.updated",
      resource: "integration_connection",
      resourceId: params.resourceId,
      before: redactCredentialsBag(params.before),
      after: redactCredentialsBag(params.after),
    },
    params.tx,
  );
}

export async function auditIntegrationDelete(
  deps: AuditDeps,
  params: DeleteAuditParams,
): Promise<void> {
  await deps.audit(
    {
      projectId: params.projectId,
      userId: params.userId,
      action: "integration.connection.deleted",
      resource: "integration_connection",
      resourceId: params.resourceId,
    },
    params.tx,
  );
}
