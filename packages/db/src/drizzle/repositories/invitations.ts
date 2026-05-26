import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import type { DbOrTx } from "./projects";
import {
  invitationDeliveryStatus,
  projectInvitations,
  projects,
  user,
  type ProjectInvitation,
} from "../schema";

export type DeliveryStatus =
  (typeof invitationDeliveryStatus.enumValues)[number];

// ---------- create / lookup ----------

export interface CreateInvitationInput {
  projectId: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
  /** Set to short-circuit sending (e.g. cross-project suppression hit). */
  deliveryStatus?: DeliveryStatus;
  deliveryError?: string;
}

export async function createInvitation(
  db: DbOrTx,
  input: CreateInvitationInput,
): Promise<ProjectInvitation> {
  const rows = await db
    .insert(projectInvitations)
    .values({
      projectId: input.projectId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: input.tokenHash,
      invitedByUserId: input.invitedByUserId,
      expiresAt: input.expiresAt,
      deliveryStatus: input.deliveryStatus ?? "PENDING",
      deliveryError: input.deliveryError ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to insert invitation");
  return row;
}

export async function findInvitationById(
  db: Db,
  id: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findInvitationByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPendingInvitationByEmail(
  db: Db,
  projectId: string,
  email: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.email, email.toLowerCase()),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------- mutations ----------

export async function revokeInvitation(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}

export async function markAccepted(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ acceptedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}

export async function updateTokenHash(
  db: DbOrTx,
  id: string,
  tokenHash: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ tokenHash, updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}

export async function patchSendResult(
  db: DbOrTx,
  id: string,
  patch: { sesMessageId: string; lastSentAt: Date },
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({
      sesMessageId: patch.sesMessageId,
      lastSentAt: patch.lastSentAt,
      updatedAt: new Date(),
    })
    .where(eq(projectInvitations.id, id));
}

export async function setDeliveryStatus(
  db: DbOrTx,
  sesMessageId: string,
  status: DeliveryStatus,
  error: string | null,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({
      deliveryStatus: status,
      deliveryError: error,
      updatedAt: new Date(),
    })
    .where(eq(projectInvitations.sesMessageId, sesMessageId));
}

// ---------- list / detail with derived status ----------

export interface InvitationListRow {
  id: string;
  email: string;
  role: ProjectInvitation["role"];
  status: "pending" | "accepted" | "revoked" | "expired";
  deliveryStatus: DeliveryStatus;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date;
}

export async function listInvitations(
  db: Db,
  projectId: string,
): Promise<InvitationListRow[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({
      id: projectInvitations.id,
      email: projectInvitations.email,
      role: projectInvitations.role,
      acceptedAt: projectInvitations.acceptedAt,
      revokedAt: projectInvitations.revokedAt,
      expiresAt: projectInvitations.expiresAt,
      deliveryStatus: projectInvitations.deliveryStatus,
      deliveryError: projectInvitations.deliveryError,
      lastSentAt: projectInvitations.lastSentAt,
      createdAt: projectInvitations.createdAt,
      invitedByName: user.name,
    })
    .from(projectInvitations)
    .innerJoin(user, eq(user.id, projectInvitations.invitedByUserId))
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        or(
          and(
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
          gte(projectInvitations.createdAt, thirtyDaysAgo),
        ),
      ),
    )
    .orderBy(desc(projectInvitations.createdAt));

  const now = new Date();
  return rows.map((r) => {
    let status: InvitationListRow["status"];
    if (r.acceptedAt) status = "accepted";
    else if (r.revokedAt) status = "revoked";
    else if (r.expiresAt <= now) status = "expired";
    else status = "pending";
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      status,
      deliveryStatus: r.deliveryStatus,
      deliveryError: r.deliveryError,
      invitedByName: r.invitedByName,
      expiresAt: r.expiresAt,
      lastSentAt: r.lastSentAt,
      createdAt: r.createdAt,
    };
  });
}

export interface InvitationEmailLoad {
  invitation: {
    id: string;
    email: string;
    role: ProjectInvitation["role"];
    expiresAt: Date;
  };
  inviterName: string;
  projectName: string;
}

export async function findInvitationForEmailSend(
  db: Db,
  id: string,
): Promise<InvitationEmailLoad | null> {
  const rows = await db
    .select({
      id: projectInvitations.id,
      email: projectInvitations.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      acceptedAt: projectInvitations.acceptedAt,
      revokedAt: projectInvitations.revokedAt,
      deliveryStatus: projectInvitations.deliveryStatus,
      inviterName: user.name,
      projectName: projects.name,
    })
    .from(projectInvitations)
    .innerJoin(user, eq(user.id, projectInvitations.invitedByUserId))
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .where(eq(projectInvitations.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (r.acceptedAt || r.revokedAt) return null;
  if (r.deliveryStatus === "SUPPRESSED") return null;
  if (r.expiresAt <= new Date()) return null;
  return {
    invitation: { id: r.id, email: r.email, role: r.role, expiresAt: r.expiresAt },
    inviterName: r.inviterName,
    projectName: r.projectName,
  };
}

export async function findCrossProjectSuppression(
  db: Db,
  email: string,
): Promise<{ status: DeliveryStatus; error: string | null } | null> {
  const rows = await db
    .select({
      deliveryStatus: projectInvitations.deliveryStatus,
      deliveryError: projectInvitations.deliveryError,
    })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.email, email.toLowerCase()),
        sql`${projectInvitations.deliveryStatus} IN ('BOUNCED','COMPLAINED','SUPPRESSED')`,
      ),
    )
    .orderBy(desc(projectInvitations.updatedAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { status: r.deliveryStatus, error: r.deliveryError };
}
