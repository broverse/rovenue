import { HTTPException } from "hono/http-exception";
import { MemberRole, drizzle } from "@rovenue/db";

export type Capability =
  | "project:read"
  | "project:delete"
  | "project:transfer"
  | "project:settings:write"
  | "members:manage"
  | "products:write"
  | "paywalls:write"
  | "funnels:write"
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
  | "refunds:write"
  | "fonts:write"
  | "assets:write"
  | "subscribers:import";

const CAPABILITY_ROLES: Record<Capability, ReadonlyArray<MemberRole>> = {
  "project:read":           ["OWNER", "ADMIN", "DEVELOPER", "GROWTH", "CUSTOMER_SUPPORT"],
  "project:delete":         ["OWNER"],
  "project:transfer":       ["OWNER"],
  "project:settings:write": ["OWNER", "ADMIN"],
  "members:manage":         ["OWNER", "ADMIN"],
  "products:write":         ["OWNER", "ADMIN", "DEVELOPER"],
  // Paywall builder writes. Same set as products:write, which is what
  // PATCH /paywalls/:id already enforced; naming it separately lets the
  // intent-execute path share ONE gate with the REST route instead of
  // approximating it with a rank (see design spec, D3).
  "paywalls:write":         ["OWNER", "ADMIN", "DEVELOPER"],
  // Funnel writes. Exactly the set the DEVELOPER *rank* gate already
  // admits — ROLE_RANK gives GROWTH the same rank as DEVELOPER — so this
  // is a faithful restatement, not a policy change. The resulting
  // asymmetry (GROWTH may author a funnel but not a paywall) is a known
  // product question, recorded in the design spec.
  "funnels:write":          ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
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
  // Font uploads are a project asset like products/webhooks — DEVELOPER and
  // above, not GROWTH (matches products:write / sdk:write, not the
  // marketing-tooling row below it).
  "fonts:write":            ["OWNER", "ADMIN", "DEVELOPER"],
  // Asset uploads are a project asset like fonts and products —
  // DEVELOPER and above, not GROWTH.
  "assets:write":           ["OWNER", "ADMIN", "DEVELOPER"],
  // Bulk-importing subscriber/purchase history (data-import tool, design
  // spec §4) is at least as consequential as the GDPR export/anonymize
  // pair above — it bulk-creates subscribers and purchases from an
  // operator-supplied file, and a mistaken mapping can misattribute
  // revenue or grant access at scale. Kept at the same ADMIN-and-above
  // tier as `subscribers:gdpr` rather than the everyday
  // `subscribers:write` (attribute edits) CS may perform.
  "subscribers:import":     ["OWNER", "ADMIN"],
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
