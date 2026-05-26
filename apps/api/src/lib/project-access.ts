import { HTTPException } from "hono/http-exception";
import { MemberRole, drizzle } from "@rovenue/db";

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

// Numeric ordering: higher = more privileged. OWNER ≥ ADMIN ≥ {DEVELOPER,GROWTH,CUSTOMER_SUPPORT}.
// Fine-grained capability gates are introduced in Task 2.x; for now the three
// non-admin roles are treated as equivalent for backwards compatibility.
const ROLE_RANK: Record<MemberRole, number> = {
  [MemberRole.OWNER]: 3,
  [MemberRole.ADMIN]: 2,
  [MemberRole.DEVELOPER]: 1,
  [MemberRole.GROWTH]: 1,
  [MemberRole.CUSTOMER_SUPPORT]: 1,
};

export async function assertProjectAccess(
  projectId: string,
  userId: string,
  minimumRole: MemberRole = MemberRole.CUSTOMER_SUPPORT,
): Promise<ProjectMembership> {
  const membership = await drizzle.projectRepo.findMembership(
    drizzle.db,
    projectId,
    userId,
  );
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
