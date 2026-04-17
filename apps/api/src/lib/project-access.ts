import { HTTPException } from "hono/http-exception";
import prisma, { MemberRole } from "@rovenue/db";

// =============================================================
// Project membership guard
// =============================================================
//
// Every dashboard write path must verify that the authenticated
// user is a member of the target project before touching data.
// We fetch the membership row eagerly so downstream handlers can
// use the role for fine-grained checks (owner-only operations).

export interface ProjectMembership {
  id: string;
  role: MemberRole;
}

// Numeric ordering: higher = more privileged. OWNER ≥ ADMIN ≥ VIEWER.
const ROLE_RANK: Record<MemberRole, number> = {
  [MemberRole.OWNER]: 3,
  [MemberRole.ADMIN]: 2,
  [MemberRole.VIEWER]: 1,
};

export async function assertProjectAccess(
  projectId: string,
  userId: string,
  minimumRole: MemberRole = MemberRole.VIEWER,
): Promise<ProjectMembership> {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { id: true, role: true },
  });
  if (!membership) {
    throw new HTTPException(403, {
      message: "Not a member of this project",
    });
  }
  if (ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw new HTTPException(403, {
      message: `Requires role ${minimumRole} or higher`,
    });
  }
  return membership;
}
