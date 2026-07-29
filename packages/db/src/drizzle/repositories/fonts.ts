import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  fontFaces,
  fontFamilies,
  type FontFace,
  type FontFamily,
} from "../schema";

// =============================================================
// Paywall fonts — Drizzle repository
// =============================================================
//
// `fontFamilies` groups a project's named font upload (e.g. "Brand
// Sans"); `fontFaces` is one weight/style/format variant of it, with
// the actual bytes stored as `bytea` (no asset storage in this repo,
// and a mounted volume would break under API_REPLICAS — see design
// spec §2). `upsertFace` replaces the existing row for a repeated
// (familyId, weight, style) rather than duplicating it, backed by the
// `font_faces_family_weight_style_key` unique index.
//
// `listFamiliesWithFaces` is metadata-only and MUST NEVER select
// `bytes` — it backs the dashboard font list, which would otherwise
// pull every uploaded font's full byte content over the wire just to
// render a row. `findFaceBytes` is the one place bytes are read, and
// it is scoped to non-deleted families (spec §4.1: deleting a family a
// paywall still references is allowed, and this is what stops a
// deleted font from continuing to serve).

export interface CreateFamilyInput {
  projectId: string;
  name: string;
}

export async function createFamily(
  db: Db,
  input: CreateFamilyInput,
): Promise<FontFamily> {
  const [row] = await db.insert(fontFamilies).values(input).returning();
  return row!;
}

export interface UpsertFaceInput {
  familyId: string;
  weight: number;
  style: string;
  format: string;
  bytes: Buffer;
}

export async function upsertFace(
  db: Db,
  input: UpsertFaceInput,
): Promise<FontFace> {
  // One hash, one meaning (Task 7): SHA-256 of the face's bytes,
  // lowercase hex. The identical value is stored here, served as the
  // device route's ETag, and used as its URL segment.
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const [row] = await db
    .insert(fontFaces)
    .values({
      familyId: input.familyId,
      weight: input.weight,
      style: input.style,
      format: input.format,
      bytes: input.bytes,
      byteSize: input.bytes.byteLength,
      contentHash,
    })
    .onConflictDoUpdate({
      target: [fontFaces.familyId, fontFaces.weight, fontFaces.style],
      set: {
        format: input.format,
        bytes: input.bytes,
        byteSize: input.bytes.byteLength,
        // A re-upload that changed the bytes but left a stale hash
        // behind is exactly the bug Task 7 exists to prevent — this
        // must be in the UPDATE set-list, not only the INSERT values.
        contentHash,
      },
    })
    .returning();
  return row!;
}

export interface FaceMeta {
  id: string;
  weight: number;
  style: string;
  format: string;
  byteSize: number;
  contentHash: string;
}

export interface FamilyWithFaces extends FontFamily {
  faces: FaceMeta[];
}

/**
 * Metadata only, never the bytes — see module note above. A single
 * left join (rather than one faces query per family) keeps this cheap
 * regardless of how many fonts a project has uploaded. Faces of a
 * soft-deleted family never surface here because the family itself is
 * filtered out.
 */
export async function listFamiliesWithFaces(
  db: Db,
  projectId: string,
): Promise<FamilyWithFaces[]> {
  const rows = await db
    .select({
      family: fontFamilies,
      face: {
        id: fontFaces.id,
        weight: fontFaces.weight,
        style: fontFaces.style,
        format: fontFaces.format,
        byteSize: fontFaces.byteSize,
        contentHash: fontFaces.contentHash,
      },
    })
    .from(fontFamilies)
    .leftJoin(fontFaces, eq(fontFaces.familyId, fontFamilies.id))
    .where(
      and(eq(fontFamilies.projectId, projectId), isNull(fontFamilies.deletedAt)),
    );

  const byFamilyId = new Map<string, FamilyWithFaces>();
  for (const row of rows) {
    let entry = byFamilyId.get(row.family.id);
    if (!entry) {
      entry = { ...row.family, faces: [] };
      byFamilyId.set(row.family.id, entry);
    }
    if (row.face?.id) entry.faces.push(row.face);
  }
  return [...byFamilyId.values()];
}

export interface FaceBytes {
  bytes: Buffer;
  format: string;
  projectId: string;
  contentHash: string;
}

/**
 * Returns null when the face doesn't exist OR its family has been
 * soft-deleted — that second case is what keeps a deleted font from
 * continuing to serve (design spec §4.1).
 */
export async function findFaceBytes(
  db: Db,
  faceId: string,
): Promise<FaceBytes | null> {
  const rows = await db
    .select({
      bytes: fontFaces.bytes,
      format: fontFaces.format,
      projectId: fontFamilies.projectId,
      contentHash: fontFaces.contentHash,
    })
    .from(fontFaces)
    .innerJoin(fontFamilies, eq(fontFaces.familyId, fontFamilies.id))
    .where(and(eq(fontFaces.id, faceId), isNull(fontFamilies.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function countFacesForProject(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ id: fontFaces.id })
    .from(fontFaces)
    .innerJoin(fontFamilies, eq(fontFaces.familyId, fontFamilies.id))
    .where(
      and(eq(fontFamilies.projectId, projectId), isNull(fontFamilies.deletedAt)),
    );
  return rows.length;
}

/**
 * Final-review Important 3: this repo stores font bytes directly in
 * Postgres (no asset storage in this system, by design — see module
 * note above), which makes retention this function's own
 * responsibility. Soft-deleting only the family left the `bytea` face
 * rows resident forever — invisible to every read path (all of them
 * join through non-deleted families), uncounted by `countFacesForProject`
 * (same join), and unreferenced by any cleanup job anywhere in this
 * repo. There is no undelete path for a family, so nothing needs those
 * bytes preserved: the face rows are hard-deleted here, while the
 * family row itself stays soft-deleted (`deletedAt` set, never
 * removed) for audit-log continuity. Runs as two statements against
 * whatever `db` handle the caller passes in — the dashboard delete
 * route already wraps this call in a transaction alongside the audit
 * entry, so both statements land or roll back together with it.
 */
export async function softDeleteFamily(db: Db, familyId: string): Promise<void> {
  await db.delete(fontFaces).where(eq(fontFaces.familyId, familyId));
  await db
    .update(fontFamilies)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(fontFamilies.id, familyId));
}

export interface FindFaceByKeyInput {
  familyId: string;
  weight: number;
  style: string;
}

/**
 * Final-review Important 2: the dashboard upload route's quota-skip
 * check ("does a face already exist at this (familyId, weight,
 * style)?") used to be an inline `select` in the route, pinned by a
 * test mock whose `from`/`where`/`limit` all discarded their
 * arguments — any predicate agreed with it. Moved here, same remedy as
 * `findLiveFamilyForProject` above, so every predicate (weight, style)
 * gets its own case against a real database
 * (fonts.integration.test.ts). A wrong/dropped predicate here silently
 * lets a project sail past `FONT_FACES_MAX_PER_PROJECT` by treating
 * every upload into a family that has any face as "already exists".
 */
export async function findFaceByKey(
  db: Db,
  input: FindFaceByKeyInput,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: fontFaces.id })
    .from(fontFaces)
    .where(
      and(
        eq(fontFaces.familyId, input.familyId),
        eq(fontFaces.weight, input.weight),
        eq(fontFaces.style, input.style),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface FindLiveFamilyForProjectInput {
  projectId: string;
  familyId: string;
}

/**
 * Task 3 review, fix round 2: the dashboard upload route accepts a
 * client-supplied `familyId` and must reject one that belongs to
 * another project or has been soft-deleted — `upsertFace` has no such
 * check of its own (Task 1 review finding #2). That query used to
 * live inline in the route; it moved here so it can be pinned against
 * a real database (see fonts.integration.test.ts) instead of a mock
 * that could agree with either predicate being silently dropped.
 */
export async function findLiveFamilyForProject(
  db: Db,
  input: FindLiveFamilyForProjectInput,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: fontFamilies.id })
    .from(fontFamilies)
    .where(
      and(
        eq(fontFamilies.id, input.familyId),
        eq(fontFamilies.projectId, input.projectId),
        isNull(fontFamilies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
