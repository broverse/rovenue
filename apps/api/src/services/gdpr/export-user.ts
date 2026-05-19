import { drizzle } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { logger } from "../../lib/logger";

// =============================================================
// GDPR Art. 15 right-to-access — user self-export
// =============================================================
//
// Bundles every row this deployment holds *about the user* into
// a single JSON dump. Companion to the project-scoped subscriber
// export — this is the operator's own copy, served from
// /dashboard/me/export.
//
// What's included:
//
//   - The Better Auth `user` row (id / name / email / image / verify
//     state / locale / timezone / timestamps).
//   - Active `session` rows with ip + userAgent — no tokens.
//   - Linked OAuth `account` rows with provider + accountId — no
//     access / refresh / id tokens.
//   - Personal access tokens — metadata (name, prefix, last used,
//     expires) only; never the plaintext or hash.
//   - Project memberships (projectId + role + joined-at).
//
// Audit-log rows authored by the user are intentionally left out
// of v1: they form a per-project hash chain that downstream
// compliance auditors need to be able to verify independently of
// any single user's export. A future iteration can include a
// signed snapshot.

const log = logger.child("gdpr:user-export");

export interface ExportUserInput {
  userId: string;
}

export interface UserExport {
  user: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  personalAccessTokens: Array<Record<string, unknown>>;
  projectMemberships: Array<Record<string, unknown>>;
  exportedAt: string;
}

export async function exportUser(input: ExportUserInput): Promise<UserExport> {
  const {
    user,
    session,
    account,
    personalAccessTokens,
    projectMembers,
  } = drizzle.schema;

  const [userRow] = await drizzle.db
    .select()
    .from(user)
    .where(eq(user.id, input.userId));

  if (!userRow) {
    throw new HTTPException(404, {
      message: `User not found: ${input.userId}`,
    });
  }

  const [sessionRows, accountRows, patRows, membershipRows] = await Promise.all([
    drizzle.db
      .select({
        id: session.id,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .from(session)
      .where(eq(session.userId, input.userId)),
    drizzle.db
      .select({
        id: account.id,
        providerId: account.providerId,
        accountId: account.accountId,
        scope: account.scope,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })
      .from(account)
      .where(eq(account.userId, input.userId)),
    drizzle.db
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        prefix: personalAccessTokens.prefix,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        expiresAt: personalAccessTokens.expiresAt,
        createdAt: personalAccessTokens.createdAt,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, input.userId)),
    drizzle.db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .where(eq(projectMembers.userId, input.userId)),
  ]);

  log.info("user.exported", {
    userId: input.userId,
    sessions: sessionRows.length,
    accounts: accountRows.length,
    pats: patRows.length,
    memberships: membershipRows.length,
  });

  return {
    user: userRow as Record<string, unknown>,
    sessions: sessionRows as Array<Record<string, unknown>>,
    accounts: accountRows as Array<Record<string, unknown>>,
    personalAccessTokens: patRows as Array<Record<string, unknown>>,
    projectMemberships: membershipRows as Array<Record<string, unknown>>,
    exportedAt: new Date().toISOString(),
  };
}
