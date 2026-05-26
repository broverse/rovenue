// =============================================================
// Public invitation routes (no project-member auth required)
//
// GET  /invitations/:token         — anonymous preview
// POST /invitations/:token/accept  — authenticated accept
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import type {
  AcceptInvitationResponse,
  InvitationPreviewResponse,
} from "@rovenue/shared";
import { hashInvitationToken } from "../../lib/invitation-token";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

export const publicInvitationsRoute = new Hono()
  // GET /invitations/:token
  .get("/:token", async (c) => {
    const token = c.req.param("token");
    if (!token || !token.startsWith("rov_inv_")) {
      throw new HTTPException(404, { message: "Invalid invitation token" });
    }
    const hash = hashInvitationToken(token);
    const inv = await drizzle.invitationRepo.findInvitationByTokenHash(
      drizzle.db,
      hash,
    );
    if (!inv) {
      throw new HTTPException(404, { message: "Invitation not found" });
    }
    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      inv.projectId,
    );
    const inviter = await drizzle.userRepo.findUserById(
      drizzle.db,
      inv.invitedByUserId,
    );

    const now = new Date();
    let status: InvitationPreviewResponse["status"];
    if (inv.acceptedAt) status = "accepted";
    else if (inv.revokedAt) status = "revoked";
    else if (inv.expiresAt <= now) status = "expired";
    else status = "pending";

    const payload: InvitationPreviewResponse = {
      projectId: inv.projectId,
      projectName: project?.name ?? "(unknown project)",
      inviterName: inviter?.name ?? null,
      role: inv.role,
      email: inv.email,
      status,
      expiresAt: inv.expiresAt.toISOString(),
    };
    return c.json(ok(payload));
  })

  // POST /invitations/:token/accept
  .post("/:token/accept", requireDashboardAuth, async (c) => {
    const token = c.req.param("token");
    if (!token || !token.startsWith("rov_inv_")) {
      throw new HTTPException(404, { message: "Invalid invitation token" });
    }
    const user = c.get("user");
    const hash = hashInvitationToken(token);
    const inv = await drizzle.invitationRepo.findInvitationByTokenHash(
      drizzle.db,
      hash,
    );
    if (!inv) throw new HTTPException(404, { message: "Invitation not found" });
    if (inv.acceptedAt)
      throw new HTTPException(409, { message: "Already accepted" });
    if (inv.revokedAt)
      throw new HTTPException(410, { message: "Invitation revoked" });
    if (inv.expiresAt <= new Date())
      throw new HTTPException(410, { message: "Invitation expired" });

    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new HTTPException(403, {
        message: `This invitation was sent to ${inv.email}`,
      });
    }

    // If they're already a member, only mark accepted (idempotent).
    const existing = await drizzle.projectRepo.findMembership(
      drizzle.db,
      inv.projectId,
      user.id,
    );
    if (existing) {
      await drizzle.invitationRepo.markAccepted(drizzle.db, inv.id);
      const payload: AcceptInvitationResponse = {
        projectId: inv.projectId,
        role: existing.role,
      };
      return c.json(ok(payload));
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.projectRepo.createProjectMember(tx, {
        projectId: inv.projectId,
        userId: user.id,
        role: inv.role,
      });
      await drizzle.invitationRepo.markAccepted(tx, inv.id);
      await audit(
        {
          projectId: inv.projectId,
          userId: user.id,
          action: "invitation.accepted",
          resource: "invitation",
          resourceId: inv.id,
          after: { role: inv.role },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    const payload: AcceptInvitationResponse = {
      projectId: inv.projectId,
      role: inv.role,
    };
    return c.json(ok(payload));
  });
