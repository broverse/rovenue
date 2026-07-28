import { createHash } from "node:crypto";
import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import {
  ERROR_CODE,
  FONT_CONTENT_TYPES,
  FONT_FILE_CACHE_MAX_AGE_SECONDS,
  type FontFormat,
} from "@rovenue/shared";
import { fail } from "../../lib/response";

// =============================================================
// GET /v1/fonts/:faceId/file — device-facing font byte serving
// =============================================================
//
// The other half of the paywall fonts wave: Tasks 1-4 built the
// dashboard-facing upload/list/delete surface; this is what an SDK on
// a device calls to fetch the actual font bytes for paywall
// rendering. Authenticated like every other SDK read, via the /v1
// parent's `apiKeyAuth` (see routes/v1/index.ts) — a project's public
// key is enough.
//
// `findFaceBytes` already returns null for a face whose family has
// been soft-deleted (packages/db/src/drizzle/repositories/fonts.ts,
// pinned against real Postgres), so that filter needs no repeating
// here. What it does NOT filter is project ownership — it has no
// projectId argument to scope by — so this route compares the
// returned `projectId` against the authenticated caller's project
// itself. Both that mismatch and "face/family doesn't exist" collapse
// onto the identical 404: this is a binary endpoint, and a 403 would
// tell a caller who cannot have the face that the id exists somewhere.
//
// A face's bytes are meant to never change once uploaded, so the
// response is cached immutably for a year (design spec invariant).
// CAUTION: `fontRepo.upsertFace` (Task 1) actually REPLACES the bytes
// of the existing row for a repeated (familyId, weight, style) rather
// than inserting a new one — so the invariant this caching contract
// leans on does not hold today; a same-weight/style re-upload keeps
// the same faceId with different bytes, and an `immutable` response
// tells clients not to even revalidate for a year. See the task
// report for the full writeup. The ETag is a hash of the bytes
// themselves, not the faceId, so at least a client that DOES
// revalidate (a cache not honoring `immutable`) detects the change.

const FACE_NOT_FOUND_MESSAGE = "Font face not found";

export const fontsRoute = new Hono().get("/:faceId/file", async (c) => {
  const faceId = c.req.param("faceId");
  const project = c.get("project");

  const face = await drizzle.fontRepo.findFaceBytes(drizzle.db, faceId);
  if (!face || face.projectId !== project.id) {
    return c.json(fail(ERROR_CODE.NOT_FOUND, FACE_NOT_FOUND_MESSAGE), 404);
  }

  const etag = `"${createHash("sha256").update(face.bytes).digest("hex")}"`;

  c.header(
    "Cache-Control",
    `public, max-age=${FONT_FILE_CACHE_MAX_AGE_SECONDS}, immutable`,
  );
  c.header("ETag", etag);
  c.header("Content-Type", FONT_CONTENT_TYPES[face.format as FontFormat]);

  return c.body(new Uint8Array(face.bytes));
});
