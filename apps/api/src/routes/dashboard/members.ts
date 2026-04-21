import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import type {
  AddMemberResponse,
  ListMembersResponse,
  ProjectMemberRow,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Project members
// =============================================================
//
// Every project has at least one OWNER at all times — attempts to
// demote or remove the last OWNER return 400. "Add member" looks
// up an existing User by email; a real invite flow (token + email
// delivery) is a separate feature and not in scope here.

const memberRoleValues = [
  MemberRole.OWNER,
  MemberRole.ADMIN,
  MemberRole.VIEWER,
] as const;

export const addMemberBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(memberRoleValues),
});

export const updateMemberBodySchema = z.object({
  role: z.enum(memberRoleValues),
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
  // =============================================================
  // GET /dashboard/projects/:projectId/members
  // =============================================================
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const rows = await drizzle.projectRepo.listProjectMembers(
      drizzle.db,
      projectId,
    );

    const payload: ListMembersResponse = { members: rows.map(toMemberRow) };
    return c.json(ok(payload));
  })
  // =============================================================
  // POST /dashboard/projects/:projectId/members — OWNER only
  // =============================================================
  .post("/", zValidator("json", addMemberBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const body = c.req.valid("json");

    const targetUser = await drizzle.userRepo.findUserByEmail(
      drizzle.db,
      body.email,
    );
    if (!targetUser) {
      throw new HTTPException(404, {
        message: "No user with that email. Ask them to sign in first.",
      });
    }

    const existing = await drizzle.projectRepo.findMembership(
      drizzle.db,
      projectId,
      targetUser.id,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: "That user is already a project member",
      });
    }

    const created = await drizzle.db.transaction(async (tx) => {
      const member = await drizzle.projectRepo.createProjectMember(tx, {
        projectId,
        userId: targetUser.id,
        role: body.role,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "member.invited",
          resource: "member",
          resourceId: member.id,
          after: { userId: targetUser.id, email: targetUser.email, role: body.role },
          ...extractRequestContext(c),
        },
        tx,
      );
      return member;
    });

    const row: ProjectMemberRow = {
      id: created.id,
      userId: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      image: targetUser.image,
      role: created.role,
      createdAt: created.createdAt.toISOString(),
    };
    const payload: AddMemberResponse = { member: row };
    return c.json(ok(payload));
  })
  // =============================================================
  // PATCH /dashboard/projects/:projectId/members/:userId — OWNER only
  // =============================================================
  .patch("/:userId", zValidator("json", updateMemberBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    if (!projectId || !targetUserId) {
      throw new HTTPException(400, { message: "Missing projectId or userId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const body = c.req.valid("json");

    const target = await drizzle.projectRepo.findMembership(
      drizzle.db,
      projectId,
      targetUserId,
    );
    if (!target) throw new HTTPException(404, { message: "Member not found" });

    // Demote-last-OWNER guard: if we're moving the only OWNER off the
    // OWNER role, the project is left un-administrable — reject.
    if (target.role === MemberRole.OWNER && body.role !== MemberRole.OWNER) {
      const owners = await countOwners(projectId);
      if (owners <= 1) {
        throw new HTTPException(400, {
          message: "Cannot demote the last OWNER",
        });
      }
    }

    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.projectRepo.updateProjectMemberRole(
        tx,
        projectId,
        targetUserId,
        body.role,
      );
      if (!row) {
        throw new HTTPException(404, { message: "Member not found" });
      }
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
  })
  // =============================================================
  // DELETE /dashboard/projects/:projectId/members/:userId — OWNER only
  // =============================================================
  .delete("/:userId", async (c) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    if (!projectId || !targetUserId) {
      throw new HTTPException(400, { message: "Missing projectId or userId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

    const target = await drizzle.projectRepo.findMembership(
      drizzle.db,
      projectId,
      targetUserId,
    );
    if (!target) throw new HTTPException(404, { message: "Member not found" });

    if (target.role === MemberRole.OWNER) {
      const owners = await countOwners(projectId);
      if (owners <= 1) {
        throw new HTTPException(400, {
          message: "Cannot remove the last OWNER",
        });
      }
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
  // =============================================================
  // POST /dashboard/projects/:projectId/members/leave
  // =============================================================
  //
  // Any role can leave — unless they're the last OWNER, in which
  // case they must first promote or add another OWNER.
  .post("/leave", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    const membership = await assertProjectAccess(
      projectId,
      user.id,
      MemberRole.VIEWER,
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
          action: "member.removed",
          resource: "member",
          resourceId: membership.id,
          before: { userId: user.id, role: membership.role },
          after: { self: true },
          ...extractRequestContext(c),
        },
        tx,
      );
      await drizzle.projectRepo.deleteProjectMember(tx, projectId, user.id);
    });

    return c.json(ok({ id: membership.id }));
  });
