import { HTTPException } from "hono/http-exception";
import { MemberRole, drizzle } from "@rovenue/db";

export type Capability =
  | "project:read"
  | "project:delete"
  | "project:transfer"
  | "project:settings:write"
  | "members:manage"
  | "products:write"
  | "sdk:write"
  | "webhooks:write"
  | "experiments:write"
  | "flags:write"
  | "audiences:write"
  | "leaderboards:write"
  | "subscribers:write"
  | "subscribers:gdpr"
  | "credits:write"
  | "virtual-currency:manage"
  | "refunds:write";

const CAPABILITY_ROLES: Record<Capability, ReadonlyArray<MemberRole>> = {
  "project:read":           ["OWNER", "ADMIN", "DEVELOPER", "GROWTH", "CUSTOMER_SUPPORT"],
  "project:delete":         ["OWNER"],
  "project:transfer":       ["OWNER"],
  "project:settings:write": ["OWNER", "ADMIN"],
  "members:manage":         ["OWNER", "ADMIN"],
  "products:write":         ["OWNER", "ADMIN", "DEVELOPER"],
  "sdk:write":              ["OWNER", "ADMIN", "DEVELOPER"],
  "webhooks:write":         ["OWNER", "ADMIN", "DEVELOPER"],
  "experiments:write":      ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "flags:write":            ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "audiences:write":        ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "leaderboards:write":     ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "subscribers:write":      ["OWNER", "ADMIN", "DEVELOPER", "CUSTOMER_SUPPORT"],
  // Irreversible GDPR anonymize + full PII/ledger export — ADMIN-and-above
  // only, matching the intent documented on the handlers. Kept distinct from
  // the everyday `subscribers:write` (attribute edits) which CS may perform.
  "subscribers:gdpr":       ["OWNER", "ADMIN"],
  // Granting spendable virtual currency is a money-equivalent action, gated
  // like refunds. Managing currency *definitions* (below) is configuration.
  "credits:write":          ["OWNER", "ADMIN"],
  "virtual-currency:manage": ["OWNER", "ADMIN", "DEVELOPER"],
  "refunds:write":          ["OWNER", "ADMIN"],
};

export function roleHasCapability(role: MemberRole, cap: Capability): boolean {
  return CAPABILITY_ROLES[cap].includes(role);
}

export async function assertProjectCapability(
  projectId: string,
  userId: string,
  cap: Capability,
): Promise<{ id: string; role: MemberRole }> {
  const membership = await drizzle.projectRepo.findMembership(
    drizzle.db,
    projectId,
    userId,
  );
  if (!membership) {
    throw new HTTPException(403, { message: "Not a member of this project" });
  }
  if (!roleHasCapability(membership.role, cap)) {
    throw new HTTPException(403, {
      message: `Role ${membership.role} lacks capability ${cap}`,
    });
  }
  return membership;
}
