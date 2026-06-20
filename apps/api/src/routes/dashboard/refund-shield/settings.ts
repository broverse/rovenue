import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../../lib/validate";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { MemberRole, drizzle, getDb } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../../lib/audit";
import { logger } from "../../../lib/logger";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";

const log = logger.child("refund-shield-settings");

// =============================================================
// Dashboard: Refund Shield — project settings (T16)
// =============================================================
//
//   GET /dashboard/projects/:projectId/refund-shield/settings
//   PUT /dashboard/projects/:projectId/refund-shield/settings
//
// Settings live on the `projects` row itself (refundShieldEnabled,
// refundShieldResponseDelayMinutes, refundShieldConsentAcknowledgedAt,
// refundShieldConsentAcknowledgedBy). Enabling the feature is OWNER-
// only and requires explicit consent acknowledgement — the consent
// timestamp + user id are stamped on first-enable and retained across
// subsequent enable/disable cycles so the compliance trail is
// preserved.

const { projects } = drizzle.schema;

const putBodySchema = z
  .object({
    enabled: z.boolean(),
    responseDelayMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    consentAcknowledged: z.boolean().optional(),
  })
  .strict();

interface SettingsWire {
  enabled: boolean;
  responseDelayMinutes: number;
  consentAcknowledgedAt: string | null;
  consentAcknowledgedBy: string | null;
}

function toWire(row: {
  refundShieldEnabled: boolean;
  refundShieldResponseDelayMinutes: number;
  refundShieldConsentAcknowledgedAt: Date | null;
  refundShieldConsentAcknowledgedBy: string | null;
}): SettingsWire {
  return {
    enabled: row.refundShieldEnabled,
    responseDelayMinutes: row.refundShieldResponseDelayMinutes,
    consentAcknowledgedAt:
      row.refundShieldConsentAcknowledgedAt?.toISOString() ?? null,
    consentAcknowledgedBy: row.refundShieldConsentAcknowledgedBy,
  };
}

export const refundShieldSettingsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /settings -----
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const db = getDb();
    const rows = await db
      .select({
        refundShieldEnabled: projects.refundShieldEnabled,
        refundShieldResponseDelayMinutes:
          projects.refundShieldResponseDelayMinutes,
        refundShieldConsentAcknowledgedAt:
          projects.refundShieldConsentAcknowledgedAt,
        refundShieldConsentAcknowledgedBy:
          projects.refundShieldConsentAcknowledgedBy,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new HTTPException(404, { message: "Project not found" });
    }
    return c.json(ok({ settings: toWire(row) }));
  })
  // ----- PUT /settings -----
  .put("/", validate("json", putBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    // OWNER-only — refund shield enable/disable touches Apple's
    // production refund-decision pipeline.
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const body = c.req.valid("json");
    const db = getDb();
    const existingRows = await db
      .select({
        refundShieldEnabled: projects.refundShieldEnabled,
        refundShieldResponseDelayMinutes:
          projects.refundShieldResponseDelayMinutes,
        refundShieldConsentAcknowledgedAt:
          projects.refundShieldConsentAcknowledgedAt,
        refundShieldConsentAcknowledgedBy:
          projects.refundShieldConsentAcknowledgedBy,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    // Consent gate: enabling for the first time (no prior consent
    // timestamp) requires an explicit consentAcknowledged: true in
    // the request body. Once consent has been acknowledged, the
    // stamp is retained across subsequent disable -> re-enable so
    // the trail survives operator churn.
    const consentAlreadyAcknowledged =
      existing.refundShieldConsentAcknowledgedAt !== null;
    if (body.enabled && !consentAlreadyAcknowledged && !body.consentAcknowledged) {
      throw new HTTPException(400, {
        message:
          "consentAcknowledged: true is required when enabling Refund Shield for the first time",
      });
    }

    const patch: Partial<typeof projects.$inferInsert> = {
      refundShieldEnabled: body.enabled,
    };
    if (body.responseDelayMinutes !== undefined) {
      patch.refundShieldResponseDelayMinutes = body.responseDelayMinutes;
    }
    if (!consentAlreadyAcknowledged && body.consentAcknowledged) {
      patch.refundShieldConsentAcknowledgedAt = new Date();
      patch.refundShieldConsentAcknowledgedBy = user.id;
    }

    const updatedRows = await db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, projectId))
      .returning({
        refundShieldEnabled: projects.refundShieldEnabled,
        refundShieldResponseDelayMinutes:
          projects.refundShieldResponseDelayMinutes,
        refundShieldConsentAcknowledgedAt:
          projects.refundShieldConsentAcknowledgedAt,
        refundShieldConsentAcknowledgedBy:
          projects.refundShieldConsentAcknowledgedBy,
      });
    const updated = updatedRows[0];
    if (!updated) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    // Audit log: refund_shield.settings.updated against the project
    // resource. We deliberately do NOT pass the project's own
    // updateProject tx here — this endpoint uses the non-tx getDb()
    // path. A separate audit() opens its own inner tx + advisory
    // lock. Failures don't roll back the settings change (the
    // settings write already committed) but we log loudly so the
    // chain gap is investigable. Compliance precedent: see
    // dashboard/feature-flags.ts which audits post-write similarly.
    try {
      await audit({
        projectId,
        userId: user.id,
        action: "refund_shield.settings.updated",
        resource: "project",
        resourceId: projectId,
        before: {
          enabled: existing.refundShieldEnabled,
          responseDelayMinutes: existing.refundShieldResponseDelayMinutes,
          consentAcknowledgedAt:
            existing.refundShieldConsentAcknowledgedAt?.toISOString() ?? null,
        },
        after: {
          enabled: updated.refundShieldEnabled,
          responseDelayMinutes: updated.refundShieldResponseDelayMinutes,
          consentAcknowledgedAt:
            updated.refundShieldConsentAcknowledgedAt?.toISOString() ?? null,
          // Capture whether this PUT crossed the consent gate so
          // auditors can reconstruct the enable history without
          // diffing the chain manually.
          consentAcknowledged: body.consentAcknowledged ?? false,
        },
        ...extractRequestContext(c),
      });
    } catch (err) {
      log.warn("refund-shield settings audit write failed", {
        projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json(ok({ settings: toWire(updated) }));
  });
