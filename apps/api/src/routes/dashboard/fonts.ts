import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  ERROR_CODE,
  FONT_FACE_MAX_BYTES,
  FONT_FACES_MAX_PER_PROJECT,
  detectFontFormat,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
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
const FONT_FILE_TOO_LARGE_MESSAGE = `File exceeds the ${FONT_FACE_MAX_BYTES}-byte limit`;

const uploadFormSchema = z
  .object({
    familyName: z.string().min(1).optional(),
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

      // Gate 2 (see module comment): redundant with body-limit above
      // for the common case, but still the one that returns the typed
      // code for a request whose total body slipped under body-limit's
      // accounting while the file part itself is still over the cap.
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
        // of silently attaching a face nothing will ever read back.
        const [existingFamily] = await drizzle.db
          .select({ id: drizzle.schema.fontFamilies.id })
          .from(drizzle.schema.fontFamilies)
          .where(
            and(
              eq(drizzle.schema.fontFamilies.id, familyId),
              eq(drizzle.schema.fontFamilies.projectId, projectId),
              isNull(drizzle.schema.fontFamilies.deletedAt),
            ),
          )
          .limit(1);
        if (!existingFamily) {
          return c.json(
            fail(
              ERROR_CODE.FONT_FAMILY_NOT_FOUND,
              "familyId does not reference an active font family in this project",
            ),
            404,
          );
        }

        const [existingFace] = await drizzle.db
          .select({ id: drizzle.schema.fontFaces.id })
          .from(drizzle.schema.fontFaces)
          .where(
            and(
              eq(drizzle.schema.fontFaces.familyId, familyId),
              eq(drizzle.schema.fontFaces.weight, form.weight),
              eq(drizzle.schema.fontFaces.style, form.style),
            ),
          )
          .limit(1);
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
        }),
      );
    },
  );
