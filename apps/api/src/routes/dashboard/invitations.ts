// =============================================================
// /dashboard/projects/:projectId/invitations
// =============================================================
//
// POST   /          — create (or refresh) an invitation
// GET    /          — list all invitations for the project
// DELETE /:id       — revoke an invitation
// POST   /:id/resend — rotate token + re-enqueue email (60s cooldown)
//
// All endpoints are gated on requireDashboardAuth +
// assertProjectCapability("members:manage").

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import {
  ASSIGNABLE_ROLES,
  type CreateInvitationResponse,
  type InvitationRow,
  type ListInvitationsResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";
import { env } from "../../lib/env";
import { generateInvitationToken } from "../../lib/invitation-token";
import { enqueueInvitationEmail } from "../../workers/email";
import { redis } from "../../lib/redis";

const INVITE_TTL_DAYS = 7;
const RESEND_COOLDOWN_SECONDS = 60;

const createBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(ASSIGNABLE_ROLES),
});

function toRow(r: {
  id: string;
  email: string;
  role: string;
  status: string;
  deliveryStatus: string;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date;
}): InvitationRow {
  return {
    id: r.id,
    email: r.email,
    role: r.role as InvitationRow["role"],
    status: r.status as InvitationRow["status"],
    deliveryStatus: r.deliveryStatus as InvitationRow["deliveryStatus"],
    deliveryError: r.deliveryError,
    invitedByName: r.invitedByName,
    expiresAt: r.expiresAt.toISOString(),
    lastSentAt: r.lastSentAt ? r.lastSentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export const invitationsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /dashboard/projects/:projectId/invitations
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const rows = await drizzle.invitationRepo.listInvitations(
      drizzle.db,
      projectId,
    );
    const payload: ListInvitationsResponse = { invitations: rows.map(toRow) };
    return c.json(ok(payload));
  })

  // POST /dashboard/projects/:projectId/invitations
  .post("/", zValidator("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");
    const body = c.req.valid("json");

    const email = body.email.toLowerCase();
    if (email === user.email.toLowerCase()) {
      throw new HTTPException(400, { message: "Cannot invite yourself" });
    }

    // Already a project member?
    const existingUser = await drizzle.userRepo.findUserByEmail(
      drizzle.db,
      email,
    );
    if (existingUser) {
      const m = await drizzle.projectRepo.findMembership(
        drizzle.db,
        projectId,
        existingUser.id,
      );
      if (m) {
        throw new HTTPException(409, {
          message: "ALREADY_MEMBER: that email is already a project member",
        });
      }
    }

    const prior = await drizzle.invitationRepo.findPendingInvitationByEmail(
      drizzle.db,
      projectId,
      email,
    );

    const suppression = await drizzle.invitationRepo.findCrossProjectSuppression(
      drizzle.db,
      email,
    );

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    let refreshed = false;

    const created = await drizzle.db.transaction(async (tx) => {
      if (prior) {
        await drizzle.invitationRepo.revokeInvitation(tx, prior.id);
        refreshed = true;
      }
      const row = await drizzle.invitationRepo.createInvitation(tx, {
        projectId,
        email,
        role: body.role,
        tokenHash: token.hash,
        invitedByUserId: user.id,
        expiresAt,
        deliveryStatus: suppression ? "SUPPRESSED" : undefined,
        deliveryError: suppression
          ? `cross-project suppression: prior ${suppression.status}`
          : undefined,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "invitation.created",
          resource: "invitation",
          resourceId: row.id,
          after: { email, role: body.role, refreshed },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    const inviteUrl = `${env.DASHBOARD_URL}/invitations/${token.plaintext}`;

    if (!suppression) {
      await enqueueInvitationEmail(created.id, inviteUrl);
    }

    const list = await drizzle.invitationRepo.listInvitations(
      drizzle.db,
      projectId,
    );
    const rowForResponse = list.find((i) => i.id === created.id);
    if (!rowForResponse) {
      throw new HTTPException(500, {
        message: "Just-created invitation vanished",
      });
    }
    const payload: CreateInvitationResponse = {
      invitation: toRow(rowForResponse),
      inviteUrl,
    };
    if (refreshed) c.header("X-Rovenue-Refreshed", "true");
    return c.json(ok(payload), 201);
  })

  // DELETE /dashboard/projects/:projectId/invitations/:invitationId
  .delete("/:invitationId", async (c) => {
    const projectId = c.req.param("projectId");
    const invitationId = c.req.param("invitationId");
    if (!projectId || !invitationId)
      throw new HTTPException(400, { message: "Missing param" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const row = await drizzle.invitationRepo.findInvitationById(
      drizzle.db,
      invitationId,
    );
    if (!row || row.projectId !== projectId) {
      throw new HTTPException(404, { message: "Invitation not found" });
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.invitationRepo.revokeInvitation(tx, invitationId);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "invitation.revoked",
          resource: "invitation",
          resourceId: invitationId,
          before: { email: row.email, role: row.role },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ revoked: true }));
  })

  // POST /dashboard/projects/:projectId/invitations/:invitationId/resend
  .post("/:invitationId/resend", async (c) => {
    const projectId = c.req.param("projectId");
    const invitationId = c.req.param("invitationId");
    if (!projectId || !invitationId)
      throw new HTTPException(400, { message: "Missing param" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const key = `invite:resend:${invitationId}`;
    const acquired = await redis.set(
      key,
      "1",
      "EX",
      RESEND_COOLDOWN_SECONDS,
      "NX",
    );
    if (acquired !== "OK") {
      throw new HTTPException(429, {
        message: `Wait ${RESEND_COOLDOWN_SECONDS}s before resending`,
      });
    }

    const existing = await drizzle.invitationRepo.findInvitationById(
      drizzle.db,
      invitationId,
    );
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Invitation not found" });
    }
    if (
      existing.acceptedAt ||
      existing.revokedAt ||
      existing.expiresAt <= new Date()
    ) {
      throw new HTTPException(409, {
        message: "Invitation is not in a sendable state",
      });
    }
    if (existing.deliveryStatus === "SUPPRESSED") {
      throw new HTTPException(409, {
        message: "Invitation was suppressed; cannot resend",
      });
    }

    const token = generateInvitationToken();
    await drizzle.invitationRepo.updateTokenHash(
      drizzle.db,
      invitationId,
      token.hash,
    );
    const inviteUrl = `${env.DASHBOARD_URL}/invitations/${token.plaintext}`;
    await enqueueInvitationEmail(invitationId, inviteUrl);

    await audit(
      {
        projectId,
        userId: user.id,
        action: "invitation.resent",
        resource: "invitation",
        resourceId: invitationId,
        ...extractRequestContext(c),
      },
      drizzle.db,
    );

    return c.json(ok({ resent: true }));
  });
