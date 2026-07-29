import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import {
  ERROR_CODE,
  FONT_FACE_MAX_BYTES,
  FONT_FACES_MAX_PER_PROJECT,
  detectFontFormat,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import { validate } from "../../lib/validate";

// =============================================================
// Dashboard: Fonts — upload a project font face
// =============================================================
//
// First multipart endpoint in the product (design spec §3). The server
// never parses the font: family name / weight / style are declared by
// the uploader, and `detectFontFormat` — a magic-byte shape check, not
// a real parse — decides the stored `format`. The filename is never
// consulted; a `.ttf`-named file carrying OTF bytes is stored as OTF.
//
// Two size gates, not one, and the order matters. `validate("form",
// ...)` is `zValidator("form", ...)`, which calls `c.req.parseBody()`
// -> Hono's `formData()`, and that FULLY BUFFERS the request body —
// file bytes included — before the handler runs at all. A `file.size`
// check inside the handler is too late to stop that buffering; it
// only ever saved the quota query. `hono/body-limit` is bound BEFORE
// `validate()` below so an oversized body is rejected while it is
// still streaming in (body-limit reads and counts chunks itself,
// or — when a `Content-Length` header is present — rejects off the
// header alone without reading any of the body), never reaching
// parseBody's full-buffer step. The in-handler `file.size` check
// stays as a second, redundant gate: by the time it runs the bytes
// are already resident in memory regardless (parseBody already ran),
// so it buys no memory saving, but it is what returns the typed
// `FONT_FILE_TOO_LARGE` envelope for the ordinary "the file itself is
// too big" case, and body-limit's own `onError` below returns the
// identical code for the body-level rejection, so a caller sees one
// consistent error either way.
//
// What follows body size is the rest of cheapest-first: magic-byte
// format (bytes already resident from parseBody, no DB call) ->
// familyId ownership/liveness (a DB call, only paid by the familyId
// branch) -> the per-project face quota (a second DB call, and
// SKIPPED when the upload targets a `(familyId, weight, style)` that
// already exists — `upsertFace` REPLACES that row rather than
// inserting a new one, so gating it on the quota would make a project
// at the cap unable to update a weight it already has without
// deleting something first).
//
// A client-supplied `familyId` is verified to belong to this project
// AND be un-deleted before it is ever handed to `upsertFace` — that
// repository function has no such check of its own (Task 1 review
// finding #2), so this route is the only place guarding against a
// caller aiming a face at an already soft-deleted family. (The window
// between this read and the write inside the transaction below is a
// known, accepted TOCTOU — consistent with how this codebase handles
// read-then-write sequences elsewhere; deliberately left open.)

const FONT_WEIGHT_MIN = 100;
const FONT_WEIGHT_MAX = 900;
const FONT_STYLES = ["normal", "italic"] as const;
const FONT_FAMILY_NAME_MAX_LENGTH = 120;
const FONT_FILE_TOO_LARGE_MESSAGE = `File exceeds the ${FONT_FACE_MAX_BYTES}-byte limit`;
const FONT_FAMILY_NOT_FOUND_MESSAGE =
  "familyId does not reference an active font family in this project";

const uploadFormSchema = z
  .object({
    familyName: z.string().min(1).max(FONT_FAMILY_NAME_MAX_LENGTH).optional(),
    familyId: z.string().min(1).optional(),
    weight: z.coerce.number().int().min(FONT_WEIGHT_MIN).max(FONT_WEIGHT_MAX),
    style: z.enum(FONT_STYLES),
  })
  // `.passthrough()` keeps the raw `file` key (a `File`, not a string)
  // in the validated object untouched — Zod validates only the
  // "non-file fields", per the brief; the file itself is checked by
  // hand below (size, then magic bytes), never by the schema.
  .passthrough()
  .refine((v) => Boolean(v.familyName) !== Boolean(v.familyId), {
    message: "Provide exactly one of familyName or familyId",
  });

type UploadForm = z.infer<typeof uploadFormSchema> & { file?: unknown };

export const fontsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- POST /dashboard/projects/:projectId/fonts -----
  .post(
    "/",
    // Gate 1 (see module comment): rejects an oversized body before
    // parseBody ever buffers it. Bound ahead of validate() on purpose.
    bodyLimit({
      maxSize: FONT_FACE_MAX_BYTES,
      onError: (c) =>
        c.json(
          fail(ERROR_CODE.FONT_FILE_TOO_LARGE, FONT_FILE_TOO_LARGE_MESSAGE),
          400,
        ),
    }),
    validate("form", uploadFormSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "fonts:write");

      const form = c.req.valid("form") as UploadForm;

      const file = form.file;
      if (!(file instanceof File)) {
        return c.json(
          fail(ERROR_CODE.VALIDATION_ERROR, "A font file is required"),
          400,
        );
      }

      // Gate 2 (see module comment): `bodyLimit({ maxSize: FONT_FACE_MAX_BYTES })`
      // above measures the ENTIRE multipart body — boundary, part
      // headers, and the four other form fields, not just `file`'s
      // bytes — so the total is always strictly larger than the file
      // part alone. That makes this branch currently unreachable: any
      // body whose file part exceeds `FONT_FACE_MAX_BYTES` was already
      // rejected by body-limit before parseBody, let alone this
      // handler, ever ran. Kept anyway as defensive redundancy in case
      // that relationship ever stops holding (e.g. body-limit's
      // accounting logic changes upstream), and because it's what
      // returns the typed `FONT_FILE_TOO_LARGE` envelope instead of
      // body-limit's onError doing so alone. The real consequence of
      // this ordering is that the effective per-file cap is
      // `FONT_FACE_MAX_BYTES` minus multipart overhead — a font of
      // exactly 2 MB is rejected despite this constant's docstring.
      if (file.size > FONT_FACE_MAX_BYTES) {
        return c.json(
          fail(ERROR_CODE.FONT_FILE_TOO_LARGE, FONT_FILE_TOO_LARGE_MESSAGE),
          400,
        );
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      // Magic bytes only — a shape check, never a parse. The filename is
      // never consulted; the bytes decide the format, full stop.
      const format = detectFontFormat(bytes);
      if (!format) {
        return c.json(
          fail(
            ERROR_CODE.FONT_FORMAT_UNSUPPORTED,
            "File bytes do not match any allowed font format",
          ),
          400,
        );
      }

      const familyId = form.familyId;
      // Whether this upload replaces a face that already exists at
      // (familyId, weight, style) — if so, the quota gate below must
      // be skipped, since upsertFace won't grow the row count.
      let targetsExistingFace = false;
      if (familyId) {
        // upsertFace has no aliveness/ownership check of its own — verify
        // here so a deleted or foreign familyId is rejected loudly instead
        // of silently attaching a face nothing will ever read back. This
        // query lives in fontRepo (not inline here) so it can be pinned
        // against a real database — see fix round 2 in the task report.
        const existingFamily = await drizzle.fontRepo.findLiveFamilyForProject(
          drizzle.db,
          { projectId, familyId },
        );
        if (!existingFamily) {
          return c.json(
            fail(ERROR_CODE.FONT_FAMILY_NOT_FOUND, FONT_FAMILY_NOT_FOUND_MESSAGE),
            404,
          );
        }

        const existingFace = await drizzle.fontRepo.findFaceByKey(
          drizzle.db,
          { familyId, weight: form.weight, style: form.style },
        );
        targetsExistingFace = Boolean(existingFace);
      }

      if (!targetsExistingFace) {
        const faceCount = await drizzle.fontRepo.countFacesForProject(
          drizzle.db,
          projectId,
        );
        if (faceCount >= FONT_FACES_MAX_PER_PROJECT) {
          return c.json(
            fail(
              ERROR_CODE.FONT_QUOTA_EXCEEDED,
              `This project has reached its ${FONT_FACES_MAX_PER_PROJECT}-face limit`,
            ),
            400,
          );
        }
      }

      const face = await drizzle.db.transaction(async (tx) => {
        let resolvedFamilyId = familyId;
        if (!resolvedFamilyId) {
          const family = await drizzle.fontRepo.createFamily(tx, {
            projectId,
            name: form.familyName!,
          });
          resolvedFamilyId = family.id;
        }

        const upserted = await drizzle.fontRepo.upsertFace(tx, {
          familyId: resolvedFamilyId,
          weight: form.weight,
          style: form.style,
          format,
          bytes,
        });

        await audit(
          {
            projectId,
            userId: user.id,
            action: "font.uploaded",
            resource: "font_face",
            resourceId: upserted.id,
            after: {
              familyId: resolvedFamilyId,
              weight: upserted.weight,
              style: upserted.style,
              format: upserted.format,
              byteSize: upserted.byteSize,
            },
            ...extractRequestContext(c),
          },
          tx,
        );

        return upserted;
      });

      return c.json(
        ok({
          id: face.id,
          familyId: face.familyId,
          weight: face.weight,
          style: face.style,
          format: face.format,
          byteSize: face.byteSize,
          contentHash: face.contentHash,
        }),
      );
    },
  )
  // ----- GET /dashboard/projects/:projectId/fonts -----
  //
  // Read-only, so this only needs `assertProjectAccess` (any project
  // member), not the `fonts:write` capability the upload route above
  // requires. `listFamiliesWithFaces` never selects the `bytes` column
  // (see packages/db/src/drizzle/repositories/fonts.ts) — this route
  // is a straight pass-through of that repo shape, no re-shaping.
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const families = await drizzle.fontRepo.listFamiliesWithFaces(
      drizzle.db,
      projectId,
    );

    return c.json(ok(families));
  })
  // ----- DELETE /dashboard/projects/:projectId/fonts/:familyId -----
  //
  // Destructive, so this is gated the same as the upload route above —
  // `fonts:write`, not the bare `assertProjectAccess` the read-only GET
  // route uses. A live paywall renders with these bytes; letting a
  // CUSTOMER_SUPPORT/GROWTH member remove a family they aren't allowed
  // to upload in the first place would make delete weaker than the
  // constructive action it undoes (sibling convention:
  // virtual-currencies.ts uses `assertProjectAccess` for its GET and
  // `assertProjectCapability(..., "virtual-currency:manage")` for its
  // DELETE).
  //
  // Deleting a family a paywall still references is allowed on purpose
  // (design spec §4.1) — there is deliberately no "font is in use"
  // guard here. `findLiveFamilyForProject` scopes the lookup to THIS
  // project, so a familyId belonging to another project (or already
  // soft-deleted) resolves to the same 404 a nonexistent id would —
  // never a 403, which would confirm to a caller who cannot have it
  // that the id exists somewhere. Soft-delete + the audit entry share
  // the caller's transaction so a rollback undoes both together.
  .delete("/:familyId", async (c) => {
    const projectId = c.req.param("projectId");
    const familyId = c.req.param("familyId");
    if (!projectId || !familyId) {
      throw new HTTPException(400, { message: "Missing projectId or familyId" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "fonts:write");

    const family = await drizzle.fontRepo.findLiveFamilyForProject(
      drizzle.db,
      { projectId, familyId },
    );
    if (!family) {
      return c.json(
        fail(ERROR_CODE.FONT_FAMILY_NOT_FOUND, FONT_FAMILY_NOT_FOUND_MESSAGE),
        404,
      );
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.fontRepo.softDeleteFamily(tx, familyId);

      await audit(
        {
          projectId,
          userId: user.id,
          action: "font.deleted",
          resource: "font_family",
          resourceId: familyId,
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ deleted: true }));
  });
