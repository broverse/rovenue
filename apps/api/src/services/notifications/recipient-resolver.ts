import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import { getEvent } from "@rovenue/shared/notifications";

// =============================================================
// resolveRecipients — userId list for a notification event
// =============================================================
//
// Decision tree (matches event-catalog's recipientScope):
//
//   1. payload.recipients explicit → return as-is
//      (used by 'self' events: signin, invited, role_changed, …).
//   2. 'self' without explicit recipients → error (catalog bug).
//   3. 'project_members' → all members of the project.
//   4. 'project_roles' → members whose role ∈ scope.roles.
//   5. 'workspace_owner' → project OWNER(s) (today: same as project
//      OWNER; future SaaS billing may swap this for the org/workspace
//      owner row).

export interface ResolveRecipientsInput {
  eventKey: string;
  projectId?: string;
  recipients?: string[];
}

const { projectMembers } = drizzle.schema;

export async function resolveRecipients(
  db: Db,
  input: ResolveRecipientsInput,
): Promise<string[]> {
  if (input.recipients && input.recipients.length > 0) {
    return input.recipients;
  }

  const event = getEvent(input.eventKey);
  const scope = event.recipientScope;

  if (scope.kind === "self") {
    throw new Error(
      `event ${input.eventKey} has 'self' scope but no explicit recipients`,
    );
  }

  if (!input.projectId) {
    throw new Error(
      `event ${input.eventKey} is project-scoped but projectId missing`,
    );
  }

  if (scope.kind === "project_members") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, input.projectId));
    return rows.map((r) => r.userId);
  }

  if (scope.kind === "project_roles") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          inArray(projectMembers.role, scope.roles),
        ),
      );
    return rows.map((r) => r.userId);
  }

  if (scope.kind === "workspace_owner") {
    const rows = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.role, "OWNER"),
        ),
      );
    return rows.map((r) => r.userId);
  }

  return [];
}
