import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import type {
  ListMembersResponse,
  ProjectMemberRow,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

const ASSIGNABLE_ROLE_VALUES = [
  MemberRole.ADMIN,
  MemberRole.DEVELOPER,
  MemberRole.GROWTH,
  MemberRole.CUSTOMER_SUPPORT,
] as const;

export const updateMemberBodySchema = z.object({
  role: z.enum(ASSIGNABLE_ROLE_VALUES),
});

export const transferOwnershipBodySchema = z.object({
  toUserId: z.string().min(1),
});

function toMemberRow(m: {
  id: string;
  userId: string;
  role: MemberRole;
  createdAt: Date;
  user: { email: string; name: string | null; image: string | null };
}): ProjectMemberRow {
  return {
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
  };
}

async function countOwners(projectId: string): Promise<number> {
  return drizzle.projectRepo.countProjectOwners(drizzle.db, projectId);
}

export const membersRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /dashboard/projects/:projectId/members
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:read");

    const rows = await drizzle.projectRepo.listProjectMembers(
      drizzle.db,
      projectId,
    );
    const payload: ListMembersResponse = { members: rows.map(toMemberRow) };
    return c.json(ok(payload));
  })

  // PATCH /dashboard/projects/:projectId/members/:userId
  .patch(
    "/:userId",
    zValidator("json", updateMemberBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const targetUserId = c.req.param("userId");
      if (!projectId || !targetUserId)
        throw new HTTPException(400, { message: "Missing projectId or userId" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "members:manage");
      const body = c.req.valid("json");

      if (targetUserId === user.id) {
        throw new HTTPException(400, {
          message: "Cannot change your own role",
        });
      }

      const target = await drizzle.projectRepo.findMembership(
        drizzle.db,
        projectId,
        targetUserId,
      );
      if (!target)
        throw new HTTPException(404, { message: "Member not found" });
      if (target.role === MemberRole.OWNER) {
        throw new HTTPException(400, {
          message: "Cannot modify an OWNER. Transfer ownership first.",
        });
      }

      const updated = await drizzle.db.transaction(async (tx) => {
        const row = await drizzle.projectRepo.updateProjectMemberRole(
          tx,
          projectId,
          targetUserId,
          body.role,
        );
        if (!row)
          throw new HTTPException(404, { message: "Member not found" });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "member.role_changed",
            resource: "member",
            resourceId: row.id,
            before: { role: target.role },
            after: { role: body.role },
            ...extractRequestContext(c),
          },
          tx,
        );
        return row;
      });

      return c.json(ok({ member: toMemberRow(updated) }));
    },
  )

  // DELETE /dashboard/projects/:projectId/members/:userId
  .delete("/:userId", async (c) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    if (!projectId || !targetUserId)
      throw new HTTPException(400, { message: "Missing projectId or userId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    if (targetUserId === user.id) {
      throw new HTTPException(400, {
        message: "Use POST /members/leave to remove yourself",
      });
    }

    const target = await drizzle.projectRepo.findMembership(
      drizzle.db,
      projectId,
      targetUserId,
    );
    if (!target)
      throw new HTTPException(404, { message: "Member not found" });
    if (target.role === MemberRole.OWNER) {
      throw new HTTPException(400, {
        message: "Cannot remove an OWNER. Transfer ownership first.",
      });
    }

    await drizzle.db.transaction(async (tx) => {
      await audit(
        {
          projectId,
          userId: user.id,
          action: "member.removed",
          resource: "member",
          resourceId: target.id,
          before: { userId: targetUserId, role: target.role },
          ...extractRequestContext(c),
        },
        tx,
      );
      await drizzle.projectRepo.deleteProjectMember(tx, projectId, targetUserId);
    });

    return c.json(ok({ id: target.id }));
  })

  // POST /dashboard/projects/:projectId/members/leave
  .post("/leave", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    const membership = await assertProjectCapability(
      projectId,
      user.id,
      "project:read",
    );

    if (membership.role === MemberRole.OWNER) {
      const owners = await countOwners(projectId);
      if (owners <= 1) {
        throw new HTTPException(400, {
          message: "Cannot leave: you are the last OWNER",
        });
      }
    }

    await drizzle.db.transaction(async (tx) => {
      await audit(
        {
          projectId,
          userId: user.id,
          action: "member.left",
          resource: "member",
          resourceId: membership.id,
          before: { userId: user.id, role: membership.role },
          ...extractRequestContext(c),
        },
        tx,
      );
      await drizzle.projectRepo.deleteProjectMember(tx, projectId, user.id);
    });

    return c.json(ok({ left: true }));
  })

  // POST /dashboard/projects/:projectId/members/transfer
  .post(
    "/transfer",
    zValidator("json", transferOwnershipBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId)
        throw new HTTPException(400, { message: "Missing projectId" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "project:transfer");
      const { toUserId } = c.req.valid("json");

      if (toUserId === user.id) {
        throw new HTTPException(400, {
          message: "Cannot transfer ownership to yourself",
        });
      }

      const target = await drizzle.projectRepo.findMembership(
        drizzle.db,
        projectId,
        toUserId,
      );
      if (!target) {
        throw new HTTPException(404, {
          message: "Target user is not a member of this project",
        });
      }
      if (target.role === MemberRole.OWNER) {
        throw new HTTPException(409, {
          message: "Target is already an OWNER",
        });
      }

      await drizzle.db.transaction(async (tx) => {
        await drizzle.projectRepo.updateProjectMemberRole(
          tx,
          projectId,
          toUserId,
          MemberRole.OWNER,
        );
        await drizzle.projectRepo.updateProjectMemberRole(
          tx,
          projectId,
          user.id,
          MemberRole.ADMIN,
        );
        await audit(
          {
            projectId,
            userId: user.id,
            action: "member.ownership_transferred",
            resource: "project",
            resourceId: projectId,
            before: { ownerUserId: user.id },
            after: { ownerUserId: toUserId },
            ...extractRequestContext(c),
          },
          tx,
        );
      });

      return c.json(ok({ transferred: true }));
    },
  );
