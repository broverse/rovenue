import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  paywallPreviewSessions,
  type PaywallPreviewSession,
} from "../schema";

// =============================================================
// Paywall preview sessions — Drizzle repository
// =============================================================
//
// P9 on-device preview: a dashboard user mints a token
// (`createPreviewSession`) that a physical device redeems to fetch a
// paywall's DRAFT. Only the hash is ever stored/looked up
// (`tokenHash`) — the plaintext token lives only in the mint response.
// `findActiveByHash` is the redemption check: both not-revoked AND
// not-expired must hold, so an expired-but-not-yet-revoked row (or a
// revoked-but-not-yet-expired one) correctly fails to resolve.

export type PreviewSession = PaywallPreviewSession;

export interface CreatePreviewSessionInput {
  projectId: string;
  paywallId: string;
  tokenHash: string;
  createdBy: string;
  expiresAt: Date;
}

export async function createPreviewSession(
  db: Db,
  input: CreatePreviewSessionInput,
): Promise<PreviewSession> {
  const [inserted] = await db
    .insert(paywallPreviewSessions)
    .values({
      projectId: input.projectId,
      paywallId: input.paywallId,
      tokenHash: input.tokenHash,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt,
    })
    .returning();
  return inserted!;
}

export async function findActiveByHash(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<PreviewSession | null> {
  const rows = await db
    .select()
    .from(paywallPreviewSessions)
    .where(
      and(
        eq(paywallPreviewSessions.tokenHash, tokenHash),
        isNull(paywallPreviewSessions.revokedAt),
        gt(paywallPreviewSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Scoped to `projectId` so a session minted for one project can't be
 * revoked (or even discovered) by a caller in another. Returns null when no
 * matching row exists, so the route can 404 rather than 200 — including
 * when the row exists but is ALREADY revoked (`isNull(revokedAt)` below):
 * without that guard a double-DELETE would match the row again, overwrite
 * `revokedAt` with a second timestamp, return 200 twice, and leave the
 * caller writing a duplicate audit row for a revoke that already happened.
 */
export async function revokePreviewSession(
  db: Db,
  projectId: string,
  sessionId: string,
): Promise<PreviewSession | null> {
  const [row] = await db
    .update(paywallPreviewSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(paywallPreviewSessions.id, sessionId),
        eq(paywallPreviewSessions.projectId, projectId),
        isNull(paywallPreviewSessions.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}
