import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { MemberRole, drizzle } from "@rovenue/db";
import { pagesArraySchema, type Page } from "@rovenue/shared/funnel";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";
import { validateFunnelGraph } from "../../services/funnel/branching-validator";
import { invalidatePublishedConfig } from "../../services/funnel/runtime-cache";
import { chargesEnabled } from "../../lib/stripe-platform";

// =============================================================
// Dashboard: Funnels CRUD + publish/duplicate/versions/revert
// =============================================================
//
// Sub-project A's onboarding funnel builder. Mutations are gated
// behind the project membership middleware (DEVELOPER or above for
// writes, baseline read access for everything else). Publish runs
// the same validator the SDK relies on for graph correctness and
// invalidates the runtime cache (stubbed in Phase 5; wired in
// Phase 6 Task 27).

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(len = 4): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  }
  return out;
}

function kebabCase(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "funnel"
  );
}

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: "slug must be kebab-case",
  });

// -------------------------------------------------------------
// Body schemas
// -------------------------------------------------------------

const createFunnelBodySchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema.optional(),
});

// Draft JSON columns are owned by the dashboard's working-copy schema
// (which uses different field names than the SDK-runtime schemas in
// `@rovenue/shared/funnel`). We persist them as opaque JSON here and
// re-validate against the strict SDK schemas at publish time, when the
// draft actually crosses the boundary into a runtime version. Validating
// with the strict schema on every PATCH would silently strip every field
// the dashboard sends and write `{}` to the column.
const draftPagesJsonSchema = z.array(z.record(z.unknown()));
const draftJsonObjectSchema = z.record(z.unknown());

// BCP47 (e.g. "en", "pt-BR", "zh-Hant"). Matches the client-side regex.
const bcp47Schema = z
  .string()
  .min(2)
  .max(15)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/, {
    message: "must be a BCP47 tag",
  });
const localesSchema = z.array(bcp47Schema).min(1).max(50);

const updateFunnelBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: slugSchema.optional(),
    draft_pages_json: draftPagesJsonSchema.optional(),
    draft_theme_json: draftJsonObjectSchema.optional(),
    draft_settings_json: draftJsonObjectSchema.optional(),
    default_locale: bcp47Schema.optional(),
    locales: localesSchema.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.slug !== undefined ||
      v.draft_pages_json !== undefined ||
      v.draft_theme_json !== undefined ||
      v.draft_settings_json !== undefined ||
      v.default_locale !== undefined ||
      v.locales !== undefined,
    { message: "At least one field must be provided" },
  )
  .refine(
    (v) =>
      v.default_locale === undefined ||
      v.locales === undefined ||
      v.locales.includes(v.default_locale),
    { message: "default_locale must be included in locales" },
  );

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// -------------------------------------------------------------
// Route
// -------------------------------------------------------------

export const funnelsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/projects/:projectId/funnels -----
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const statusRaw = c.req.query("status");
    const status =
      statusRaw === "draft" || statusRaw === "published" || statusRaw === "archived"
        ? statusRaw
        : undefined;

    const funnels = await drizzle.funnelRepo.listByProject(drizzle.db, projectId, {
      status,
    });
    return c.json(ok({ funnels }));
  })

  // ----- POST /dashboard/projects/:projectId/funnels -----
  .post("/", validate("json", createFunnelBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const body = c.req.valid("json");
    const slug = body.slug ?? `${kebabCase(body.name)}-${randomSuffix()}`;

    const created = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.insert(tx, {
        projectId,
        slug,
        name: body.name,
        createdBy: user.id,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.created",
          resource: "funnel",
          resourceId: row.id,
          after: { name: row.name, slug: row.slug },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok(created), 201);
  })

  // ----- GET /dashboard/projects/:projectId/funnels/:funnelId -----
  .get("/:funnelId", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const funnel = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!funnel || funnel.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }
    return c.json(ok(funnel));
  })

  // ----- PATCH /dashboard/projects/:projectId/funnels/:funnelId -----
  .patch("/:funnelId", validate("json", updateFunnelBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const existing = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }

    const body = c.req.valid("json");
    const patch: Parameters<typeof drizzle.funnelRepo.updateById>[2] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = body.slug;
    if (body.draft_pages_json !== undefined) {
      patch.draftPagesJson = body.draft_pages_json;
    }
    if (body.draft_theme_json !== undefined) {
      patch.draftThemeJson = body.draft_theme_json;
    }
    if (body.draft_settings_json !== undefined) {
      patch.draftSettingsJson = body.draft_settings_json;
    }
    if (body.default_locale !== undefined) {
      patch.defaultLocale = body.default_locale;
    }
    if (body.locales !== undefined) {
      patch.locales = body.locales;
    }

    // Cross-field guard for the "only one of the two was sent" case —
    // the body-schema refine above only fires when both arrive together.
    const nextDefault = body.default_locale ?? existing.defaultLocale;
    const nextLocales = body.locales ?? existing.locales;
    if (!nextLocales.includes(nextDefault)) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "FUNNEL_LOCALE_MISMATCH",
          message: "default_locale must be one of locales",
        }),
      });
    }

    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.updateById(tx, funnelId, patch);
      if (!row) {
        throw new HTTPException(404, { message: "Funnel not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.updated",
          resource: "funnel",
          resourceId: funnelId,
          after: { fields: Object.keys(patch) },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok(updated));
  })

  // ----- DELETE /dashboard/projects/:projectId/funnels/:funnelId -----
  .delete("/:funnelId", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const existing = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.funnelRepo.archive(tx, funnelId);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.archived",
          resource: "funnel",
          resourceId: funnelId,
          before: { status: existing.status },
          after: { status: "archived" },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ id: funnelId, status: "archived" as const }));
  })

  // -----------------------------------------------------------
  // Task 23 — publish / duplicate / versions / revert
  // -----------------------------------------------------------

  // ----- POST /dashboard/projects/:projectId/funnels/:funnelId/publish -----
  .post("/:funnelId/publish", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const funnel = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!funnel || funnel.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }

    // Validate draft pages against the Zod schema first.
    const parsed = pagesArraySchema.safeParse(funnel.draftPagesJson);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "FUNNEL_VALIDATION",
          issues: parsed.error.issues,
        }),
      });
    }
    const pages: Page[] = parsed.data;

    // Graph validation (cycles, unknown refs, missing paywall/success).
    const graph = validateFunnelGraph(pages);
    if (!graph.ok) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "FUNNEL_VALIDATION",
          issues: graph.issues,
        }),
      });
    }

    // Paywall pages require an account that can actually take a card.
    // Connecting is not sufficient — Stripe withholds charges_enabled
    // and the card_payments capability until verification completes.
    if (pages.some((p) => p.type === "paywall")) {
      const canCharge = await chargesEnabled(projectId);
      if (!canCharge) {
        throw new HTTPException(400, {
          message: JSON.stringify({ code: "STRIPE_NOT_CONNECTED" }),
        });
      }
    }

    // Paywall pages MAY reference a project paywall (`paywallId`) to render
    // via the shared <PaywallRenderer> instead of the legacy flat fields.
    // Pages without a paywallId are untouched/legacy-valid and skip this
    // check entirely — no DB round trip for funnels that don't use it.
    const referencedPaywallIds = [
      ...new Set(
        pages
          .filter((p) => p.type === "paywall" && !!p.paywallId)
          .map((p) => p.paywallId as string),
      ),
    ];
    if (referencedPaywallIds.length > 0) {
      const referenced = await drizzle.paywallRepo.findPaywallsByIds(
        drizzle.db,
        projectId,
        referencedPaywallIds,
      );
      const byId = new Map(referenced.map((pw) => [pw.id, pw]));
      const renderable = referencedPaywallIds.every((id) => {
        const pw = byId.get(id);
        return pw != null && pw.builderConfig != null;
      });
      if (!renderable) {
        throw new HTTPException(400, {
          message: JSON.stringify({ code: "PAYWALL_NOT_RENDERABLE" }),
        });
      }
    }

    const result = await drizzle.db.transaction(async (tx) => {
      const versionNo = await drizzle.funnelVersionRepo.nextVersionNo(tx, funnelId);
      const version = await drizzle.funnelVersionRepo.insert(tx, {
        funnelId,
        versionNo,
        pagesJson: funnel.draftPagesJson,
        themeJson: funnel.draftThemeJson,
        settingsJson: funnel.draftSettingsJson,
        publishedBy: user.id,
      });
      await drizzle.funnelRepo.setCurrentVersion(tx, funnelId, version.id);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.published",
          resource: "funnel",
          resourceId: funnelId,
          after: { versionNo, warnings: graph.warnings.length },
          ...extractRequestContext(c),
        },
        tx,
      );
      return version;
    });

    await invalidatePublishedConfig(funnel.slug);

    return c.json(
      ok({ version_id: result.id, version_no: result.versionNo }),
    );
  })

  // ----- POST /dashboard/projects/:projectId/funnels/:funnelId/duplicate -----
  .post("/:funnelId/duplicate", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const src = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!src || src.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }

    const newSlug = `${src.slug}-copy-${randomSuffix()}`;
    const newName = `${src.name} (copy)`;

    const created = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.insert(tx, {
        projectId,
        slug: newSlug,
        name: newName,
        createdBy: user.id,
        draftPagesJson: src.draftPagesJson,
        draftThemeJson: src.draftThemeJson,
        draftSettingsJson: src.draftSettingsJson,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.duplicated",
          resource: "funnel",
          resourceId: row.id,
          after: { sourceId: src.id },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok(created), 201);
  })

  // ----- GET /dashboard/projects/:projectId/funnels/:funnelId/versions -----
  .get("/:funnelId/versions", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    if (!projectId || !funnelId) {
      throw new HTTPException(400, { message: "Missing projectId or funnelId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const funnel = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!funnel || funnel.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }

    const rows = await drizzle.funnelVersionRepo.listByFunnel(drizzle.db, funnelId);
    const versions = rows.map((v) => ({
      id: v.id,
      version_no: v.versionNo,
      published_at: v.publishedAt,
      published_by: v.publishedBy,
    }));
    return c.json(ok({ versions }));
  })

  // ----- POST /dashboard/projects/:projectId/funnels/:funnelId/revert/:versionId -----
  .post("/:funnelId/revert/:versionId", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    const versionId = c.req.param("versionId");
    if (!projectId || !funnelId || !versionId) {
      throw new HTTPException(400, {
        message: "Missing projectId, funnelId or versionId",
      });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const funnel = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
    if (!funnel || funnel.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }
    const version = await drizzle.funnelVersionRepo.findById(drizzle.db, versionId);
    if (!version || version.funnelId !== funnelId) {
      throw new HTTPException(404, { message: "Version not found" });
    }

    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.updateById(tx, funnelId, {
        draftPagesJson: version.pagesJson,
        draftThemeJson: version.themeJson,
        draftSettingsJson: version.settingsJson,
      });
      if (!row) {
        throw new HTTPException(404, { message: "Funnel not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.reverted",
          resource: "funnel",
          resourceId: funnelId,
          after: { versionId: version.id, versionNo: version.versionNo },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok(updated));
  })

  // -----------------------------------------------------------
  // Task 24 — create from template
  // -----------------------------------------------------------

  // ----- POST /dashboard/projects/:projectId/funnels/from-template/:templateId -----
  .post("/from-template/:templateId", async (c) => {
    const projectId = c.req.param("projectId");
    const templateId = c.req.param("templateId");
    if (!projectId || !templateId) {
      throw new HTTPException(400, {
        message: "Missing projectId or templateId",
      });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const template = await drizzle.funnelTemplateRepo.findById(
      drizzle.db,
      templateId,
    );
    if (!template) {
      throw new HTTPException(404, { message: "Template not found" });
    }
    // System templates are global; user-scoped templates must belong
    // to this project.
    if (template.scope === "user" && template.projectId !== projectId) {
      throw new HTTPException(404, { message: "Template not found" });
    }

    // Re-stamp page ids so editor edits don't collide with the
    // template's stable identifiers. We deliberately do NOT rewrite
    // next_rules / default_next refs — template authors maintain
    // those, and the publish validator catches dangling pointers.
    const templatePages = Array.isArray(template.pagesJson)
      ? (template.pagesJson as Array<Record<string, unknown>>)
      : [];
    const rewrittenPages = templatePages.map((p) => ({
      ...p,
      id: createId(),
    }));

    const slug = `${kebabCase(template.name)}-${randomSuffix()}`;

    const created = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.funnelRepo.insert(tx, {
        projectId,
        slug,
        name: template.name,
        createdBy: user.id,
        draftPagesJson: rewrittenPages,
        draftThemeJson: template.themeJson,
        draftSettingsJson: template.settingsJson,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "funnel.from_template",
          resource: "funnel",
          resourceId: row.id,
          after: { templateId: template.id, templateName: template.name },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok(created), 201);
  })

  // -----------------------------------------------------------
  // Task 25 — read-only session + answers
  // -----------------------------------------------------------

  // ----- GET /dashboard/projects/:projectId/funnels/:funnelId/sessions -----
  .get(
    "/:funnelId/sessions",
    validate("query", listSessionsQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const funnelId = c.req.param("funnelId");
      if (!projectId || !funnelId) {
        throw new HTTPException(400, {
          message: "Missing projectId or funnelId",
        });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id);

      const funnel = await drizzle.funnelRepo.findById(drizzle.db, funnelId);
      if (!funnel || funnel.projectId !== projectId) {
        throw new HTTPException(404, { message: "Funnel not found" });
      }

      const { limit, offset } = c.req.valid("query");
      const sessions = await drizzle.funnelSessionRepo.listByFunnel(
        drizzle.db,
        funnelId,
        limit,
        offset,
      );
      return c.json(ok({ sessions }));
    },
  )

  // ----- GET /dashboard/projects/:projectId/funnels/:funnelId/sessions/:sessionId -----
  .get("/:funnelId/sessions/:sessionId", async (c) => {
    const projectId = c.req.param("projectId");
    const funnelId = c.req.param("funnelId");
    const sessionId = c.req.param("sessionId");
    if (!projectId || !funnelId || !sessionId) {
      throw new HTTPException(400, {
        message: "Missing projectId, funnelId or sessionId",
      });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const session = await drizzle.funnelSessionRepo.findById(
      drizzle.db,
      sessionId,
    );
    if (
      !session ||
      session.funnelId !== funnelId ||
      session.projectId !== projectId
    ) {
      throw new HTTPException(404, { message: "Session not found" });
    }

    const answers = await drizzle.funnelAnswerRepo.listBySession(
      drizzle.db,
      sessionId,
    );
    return c.json(ok({ session, answers }));
  });
