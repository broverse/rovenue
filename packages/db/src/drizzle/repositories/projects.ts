import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  memberRole,
  projectMembers,
  projects,
  user,
  type Project,
  type ProjectMember,
} from "../schema";

// `Db` covers both the top-level drizzle client AND the tx handle
// passed to `db.transaction(async (tx) => ...)`. Callers can pass
// either — the query surface is identical for ordinary CRUD.
export type DbOrTx = Db;

// =============================================================
// Project + membership reads — Drizzle repository
// =============================================================
//
// Covers the middleware + dashboard + lib paths that currently
// call prisma.project.findUnique / prisma.projectMember.findUnique.
// Every dashboard request hits one of these at least once so we
// want them clean and single-row.

// --- projects ---

export async function findProjectById(
  db: Db,
  id: string,
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Scoped read for webhook-processor — only webhookUrl. */
export async function findProjectWebhookUrl(
  db: Db,
  id: string,
): Promise<string | null> {
  const rows = await db
    .select({ webhookUrl: projects.webhookUrl })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows[0]?.webhookUrl ?? null;
}

export interface ProjectCredentialsFields {
  appleCredentials: unknown;
  googleCredentials: unknown;
  stripeCredentials: unknown;
}

/**
 * Scoped read for the credential loaders in lib/project-
 * credentials.ts — returns only the encrypted JSONB columns so
 * the rest of the project row isn't dragged into every webhook
 * verification.
 */
export async function findProjectCredentials(
  db: Db,
  id: string,
  store: "apple" | "google" | "stripe",
): Promise<{ value: unknown } | null> {
  const column =
    store === "apple"
      ? projects.appleCredentials
      : store === "google"
        ? projects.googleCredentials
        : projects.stripeCredentials;
  const rows = await db
    .select({ value: column })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// --- project members ---

export async function findMembership(
  db: Db,
  projectId: string,
  userId: string,
): Promise<Pick<ProjectMember, "id" | "role"> | null> {
  const rows = await db
    .select({ id: projectMembers.id, role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findMembershipsForUser(
  db: Db,
  userId: string,
): Promise<
  Array<{
    id: string;
    role: (typeof memberRole.enumValues)[number];
    createdAt: Date;
    project: Project;
  }>
> {
  const rows = await db
    .select({
      id: projectMembers.id,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      project: projects,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(desc(projectMembers.createdAt));
  return rows;
}

export interface ProjectMemberWithUser {
  id: string;
  userId: string;
  role: (typeof memberRole.enumValues)[number];
  createdAt: Date;
  user: {
    email: string;
    name: string;
    image: string | null;
  };
}

export async function listProjectMembers(
  db: Db,
  projectId: string,
): Promise<ProjectMemberWithUser[]> {
  const rows = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      userEmail: user.email,
      userName: user.name,
      userImage: user.image,
    })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt));

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    role: r.role,
    createdAt: r.createdAt,
    user: {
      email: r.userEmail,
      name: r.userName,
      image: r.userImage,
    },
  }));
}

export async function countProjectOwners(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, "OWNER"),
      ),
    );
  return rows.length;
}

// --- credential writes ---

/**
 * Write an encrypted credential blob to the store-specific JSONB
 * column. Called from the dashboard credentials PUT route inside a
 * Drizzle transaction alongside an audit write.
 */
export async function writeProjectCredential(
  db: DbOrTx,
  projectId: string,
  store: "apple" | "google" | "stripe",
  encrypted: unknown,
): Promise<void> {
  const column =
    store === "apple"
      ? "appleCredentials"
      : store === "google"
        ? "googleCredentials"
        : "stripeCredentials";
  await db
    .update(projects)
    .set({ [column]: encrypted } as Partial<typeof projects.$inferInsert>)
    .where(eq(projects.id, projectId));
}

/**
 * Null out the store-specific credential JSONB column (Prisma
 * `JsonNull` equivalent). Uses a sql literal because Drizzle's
 * .set({ col: null }) writes SQL NULL for the row value, which is
 * what we want — the JSONB column is nullable by schema.
 */
export async function clearProjectCredential(
  db: DbOrTx,
  projectId: string,
  store: "apple" | "google" | "stripe",
): Promise<void> {
  const column =
    store === "apple"
      ? "appleCredentials"
      : store === "google"
        ? "googleCredentials"
        : "stripeCredentials";
  await db
    .update(projects)
    .set({ [column]: sql`NULL` } as Partial<typeof projects.$inferInsert>)
    .where(eq(projects.id, projectId));
}
