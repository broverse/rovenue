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

// Numeric ordering: higher = more privileged.
// OWNER(4) > ADMIN(3) > DEVELOPER(2) ≈ GROWTH(2) > CUSTOMER_SUPPORT(1)
// CUSTOMER_SUPPORT is intentionally lower than DEVELOPER so that
// intents with requiresRole="DEVELOPER" are denied to CS users.
const ROLE_RANK: Record<MemberRole, number> = {
  [MemberRole.OWNER]: 4,
  [MemberRole.ADMIN]: 3,
  [MemberRole.DEVELOPER]: 2,
  [MemberRole.GROWTH]: 2,
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
