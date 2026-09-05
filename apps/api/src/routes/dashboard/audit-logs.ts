import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { AUDIT_CHAIN_FORMAT_V1 } from "@rovenue/shared/audit-chain";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { validate } from "../../lib/validate";

// =============================================================
// Dashboard: Audit log viewer
// =============================================================
//
// Read-only endpoint for the dashboard audit trail. Supports
// filtering by action, userId, resource, resourceId, and a
// date range. Results are paginated with cursor-based or
// offset-based pagination (limit + offset for simplicity).

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// =============================================================
// Proof export (§9.3)
// =============================================================
//
// `/proof` hands out a self-verifying bundle: exactly the fields
// `hashAuditRow` (@rovenue/shared/audit-chain) covers, plus the
// hash columns, so an external verifier can re-derive every
// `rowHash` offline with no Rovenue code. Capped so an export
// over a busy project's whole history can't be used as a
// denial-of-service vector.
export const AUDIT_PROOF_MAX_ENTRIES = 5000;

type AuditProofRow = Awaited<
  ReturnType<typeof drizzle.auditLogRepo.listAuditProofRows>
>[number];

export interface AuditProofBundle {
  formatVersion: string;
  projectId: string;
  exportedAt: string;
  origin: { rowHash: string } | null;
  tip: { rowHash: string | null; createdAt: string } | null;
  // True when the read hit AUDIT_PROOF_MAX_ENTRIES: at exactly the cap,
  // a bundle is otherwise byte-indistinguishable from a complete export,
  // and a verifier would wrongly declare a partial segment the whole
  // history. Derived, never trusted from the caller.
  truncated: boolean;
  entries: AuditProofRow[];
}

const auditProofQuerySchema = z.object({
  // `{ offset: true }` so `+03:00`-style offsets validate — the sibling
  // list route's manual `new Date(from)` already accepts them, and this
  // schema must not be stricter than that for the same query shape.
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const auditLogsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const action = c.req.query("action");
    const filterUserId = c.req.query("userId");
    const resource = c.req.query("resource");
    const resourceId = c.req.query("resourceId");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");

    const limit = Math.min(
      rawLimit ? parseInt(rawLimit, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT,
      MAX_LIMIT,
    );
    const offset = rawOffset ? parseInt(rawOffset, 10) || 0 : 0;

    const repoFilters = {
      projectId,
      ...(action && { action }),
      ...(filterUserId && { userId: filterUserId }),
      ...(resource && { resource }),
      ...(resourceId && { resourceId }),
      ...(from && { from: new Date(from) }),
      ...(to && { to: new Date(to) }),
    };

    const [logs, total] = await Promise.all([
      drizzle.auditLogRepo.listAuditLogs(drizzle.db, {
        ...repoFilters,
        limit,
        offset,
      }),
      drizzle.auditLogRepo.countAuditLogs(drizzle.db, repoFilters),
    ]);

    return c.json(
      ok({
        logs,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      }),
    );
  })
  // ----- GET /audit-logs/proof?projectId=... -----
  //
  // Registered before `/:id` so `proof` is never captured as the
  // `:id` path param.
  .get("/proof", validate("query", auditProofQuerySchema), async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const { from, to } = c.req.valid("query");

    const entries = await drizzle.auditLogRepo.listAuditProofRows(drizzle.db, {
      projectId,
      ...(from && { from: new Date(from) }),
      ...(to && { to: new Date(to) }),
      limit: AUDIT_PROOF_MAX_ENTRIES,
    });

    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];

    // `!= null` (not truthiness) states the actual intent: an absent
    // prevHash is what makes origin null, not a falsy string. Hashes are
    // 64 hex chars so an empty string can't occur in practice, but the
    // check should say what it means.
    const origin: AuditProofBundle["origin"] =
      firstEntry?.prevHash != null ? { rowHash: firstEntry.prevHash } : null;
    const tip: AuditProofBundle["tip"] = lastEntry
      ? { rowHash: lastEntry.rowHash, createdAt: lastEntry.createdAt }
      : null;

    return c.json(
      ok<AuditProofBundle>({
        formatVersion: AUDIT_CHAIN_FORMAT_V1,
        projectId,
        exportedAt: new Date().toISOString(),
        origin,
        tip,
        truncated: entries.length === AUDIT_PROOF_MAX_ENTRIES,
        entries,
      }),
    );
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const entry = await drizzle.auditLogRepo.findAuditLogById(drizzle.db, id);
    if (!entry) {
      throw new HTTPException(404, { message: "Audit log entry not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(entry.projectId, user.id);

    return c.json(ok({ entry }));
  });
