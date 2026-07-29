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
// GET /v1/fonts/:faceId/:contentHash/file — device-facing font byte
// serving
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
// itself. Face/family missing, cross-project, AND a `:contentHash`
// segment that doesn't match the stored hash all collapse onto the
// identical 404: this is a binary endpoint, and a 403 (or a 200 that
// leaks whether the id exists) would tell a caller who cannot have the
// face that it exists somewhere.
//
// Task 7: the URL is versioned by content hash instead of `immutable`
// resting on a false premise. `fontRepo.upsertFace` (Task 1) replaces
// the bytes of the existing row in place for a repeated (familyId,
// weight, style) — Task 1's own test mandates exactly that, and this
// task does not touch it — so a re-upload changes the STORED hash,
// which changes the URL a client must use, which is what makes
// `immutable` honest: the URL for a re-uploaded face's bytes is a
// different URL, never the same one serving different bytes. The one
// hash is stored at write time, served as the ETag, and compared
// against the URL segment here — there is only ever the one value.
// The ETag header wraps it in RFC 7232's required quoted-string
// (`"<hash>"`); the stored column, the URL segment, and the comparison
// above all stay the raw unquoted hex — quoting is header encoding
// only, applied once, at the one place the value leaves as a header.

const FACE_NOT_FOUND_MESSAGE = "Font face not found";

export const fontsRoute = new Hono().get(
  "/:faceId/:contentHash/file",
  async (c) => {
    const faceId = c.req.param("faceId");
    const contentHash = c.req.param("contentHash");
    const project = c.get("project");

    const face = await drizzle.fontRepo.findFaceBytes(drizzle.db, faceId);
    if (
      !face ||
      face.projectId !== project.id ||
      face.contentHash !== contentHash
    ) {
      return c.json(fail(ERROR_CODE.NOT_FOUND, FACE_NOT_FOUND_MESSAGE), 404);
    }

    c.header(
      "Cache-Control",
      `public, max-age=${FONT_FILE_CACHE_MAX_AGE_SECONDS}, immutable`,
    );
    c.header("ETag", `"${face.contentHash}"`);
    c.header(
      "Content-Type",
      FONT_CONTENT_TYPES[face.format as FontFormat] ?? "application/octet-stream",
    );

    return c.body(new Uint8Array(face.bytes));
  },
);
