// =============================================================
// Public funnel runtime routes (no auth — browser-facing)
//
// GET  /public/funnels/:slug                              — published config
// POST /public/funnels/:slug/sessions                     — start a session
// POST /public/funnel-sessions/:sessionId/answers         — upsert an answer
// POST /public/funnel-sessions/:sessionId/advance         — evaluate next page
//
// Branching rules (`next_rules` / `default_next`) are stripped
// from the published bundle so the client never sees the routing
// logic — `/advance` evaluates server-side using the canonical
// version stored in Postgres.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  invalidatePublishedConfig,
  readPublishedConfig,
  writePublishedConfig,
} from "../../services/funnel/runtime-cache";
import {
  evaluateNext,
  type AnswerMap,
  type AnswerValue,
  type EvalPage,
  type PageGraph,
} from "../../services/funnel/branching-evaluator";

interface PublishedRuntimeConfig {
  id: string;
  slug: string;
  version_id: string;
  pages: Array<Record<string, unknown>>;
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
}

function stripBranchingRules(
  pages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return pages.map((p) => {
    const copy = { ...p };
    delete copy.next_rules;
    delete copy.default_next;
    return copy;
  });
}

async function loadPublishedConfigFromDb(
  slug: string,
): Promise<PublishedRuntimeConfig | null> {
  const funnel = await drizzle.db
    .select()
    .from(drizzle.funnels)
    .where(eq(drizzle.funnels.slug, slug))
    .limit(1)
    .then((rows) => rows[0]);
  if (!funnel || funnel.status !== "published" || !funnel.currentVersionId) {
    return null;
  }
  const version = await drizzle.funnelVersionRepo.findById(
    drizzle.db,
    funnel.currentVersionId,
  );
  if (!version) return null;

  const pagesArr = Array.isArray(version.pagesJson)
    ? (version.pagesJson as Array<Record<string, unknown>>)
    : [];

  return {
    id: funnel.id,
    slug: funnel.slug,
    version_id: version.id,
    pages: stripBranchingRules(pagesArr),
    theme: version.themeJson as Record<string, unknown>,
    settings: version.settingsJson as Record<string, unknown>,
  };
}

export const publicFunnelsRoute = new Hono()
  .use(
    "*",
    cors({ origin: "*", allowMethods: ["GET", "POST"], maxAge: 86400 }),
  )

  // ---------------------------------------------------------------
  // GET /funnels/:slug — published runtime bundle
  // ---------------------------------------------------------------
  .get("/funnels/:slug", async (c) => {
    const slug = c.req.param("slug");
    const cached = await readPublishedConfig<PublishedRuntimeConfig>(slug);
    if (cached) return c.json({ data: cached });

    const config = await loadPublishedConfigFromDb(slug);
    if (!config) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }
    await writePublishedConfig(slug, config);
    return c.json({ data: config });
  })

  // ---------------------------------------------------------------
  // POST /funnels/:slug/sessions — create a session, set cookie
  // ---------------------------------------------------------------
  .post(
    "/funnels/:slug/sessions",
    zValidator(
      "json",
      z.object({
        utm: z.record(z.string(), z.string()).optional(),
        referrer: z.string().optional(),
      }),
    ),
    async (c) => {
      const slug = c.req.param("slug");
      let config = await readPublishedConfig<PublishedRuntimeConfig>(slug);

      if (!config) {
        config = await loadPublishedConfigFromDb(slug);
        if (!config) {
          throw new HTTPException(404, { message: "Funnel not found" });
        }
        await writePublishedConfig(slug, config);
      }

      const funnel = await drizzle.funnelRepo.findById(drizzle.db, config.id);
      if (!funnel) {
        throw new HTTPException(404, { message: "Funnel not found" });
      }

      const body = c.req.valid("json");
      const ipHeader =
        c.req.header("x-forwarded-for") ??
        c.req.header("cf-connecting-ip") ??
        "";
      const ua = c.req.header("user-agent") ?? "";
      const firstPage = config.pages[0] as { id: string } | undefined;
      if (!firstPage) {
        throw new HTTPException(500, {
          message: "Published funnel has no pages",
        });
      }
      const firstPageId = firstPage.id;

      const session = await drizzle.funnelSessionRepo.insert(drizzle.db, {
        funnelId: config.id,
        funnelVersionId: config.version_id,
        projectId: funnel.projectId,
        utmJson: body.utm ?? {},
        ipHash: ipHeader
          ? createHash("sha256").update(ipHeader).digest("hex")
          : null,
        userAgent: ua.slice(0, 256),
        currentPageId: firstPageId,
      });

      setCookie(c, "rv_funnel_sid", session.id, {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 30 * 24 * 60 * 60,
        path: "/",
      });

      return c.json(
        { data: { session_id: session.id, first_page_id: firstPageId } },
        201,
      );
    },
  )

  // ---------------------------------------------------------------
  // POST /funnel-sessions/:sessionId/answers — upsert an answer
  // ---------------------------------------------------------------
  .post(
    "/funnel-sessions/:sessionId/answers",
    zValidator(
      "json",
      z.object({
        page_id: z.string(),
        question_id: z.string(),
        answer: z.unknown(),
      }),
    ),
    async (c) => {
      const sid = c.req.param("sessionId");
      const body = c.req.valid("json");
      const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
      if (!session) {
        throw new HTTPException(404, { message: "Session not found" });
      }
      if (session.state !== "in_progress") {
        throw new HTTPException(409, { message: "Session is closed" });
      }
      await drizzle.funnelAnswerRepo.upsert(drizzle.db, {
        sessionId: sid,
        pageId: body.page_id,
        questionId: body.question_id,
        answerJson: { value: body.answer },
      });
      await drizzle.funnelSessionRepo.setCurrentPage(
        drizzle.db,
        sid,
        body.page_id,
      );
      return c.json({ data: { ok: true } });
    },
  )

  // ---------------------------------------------------------------
  // POST /funnel-sessions/:sessionId/advance — evaluate next page
  // ---------------------------------------------------------------
  .post(
    "/funnel-sessions/:sessionId/advance",
    zValidator("json", z.object({ from_page_id: z.string() })),
    async (c) => {
      const sid = c.req.param("sessionId");
      const body = c.req.valid("json");
      const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
      if (!session) {
        throw new HTTPException(404, { message: "Session not found" });
      }
      const version = await drizzle.funnelVersionRepo.findById(
        drizzle.db,
        session.funnelVersionId,
      );
      if (!version) {
        throw new HTTPException(500, { message: "Version missing" });
      }
      const pages = (version.pagesJson as EvalPage[]) ?? [];
      const answers = await drizzle.funnelAnswerRepo.listBySession(
        drizzle.db,
        sid,
      );
      const answerMap: AnswerMap = new Map(
        answers.map((a) => [
          a.questionId,
          (a.answerJson as { value: AnswerValue }).value,
        ]),
      );
      const pagesById: PageGraph = new Map(pages.map((p) => [p.id, p]));
      const pagesOrder = pages.map((p) => p.id);
      const page = pagesById.get(body.from_page_id);
      if (!page) {
        throw new HTTPException(400, { message: "Unknown from_page_id" });
      }
      const result = evaluateNext({
        page,
        pagesOrder,
        answers: answerMap,
        pagesById,
      });
      if (result.next === "page") {
        await drizzle.funnelSessionRepo.setCurrentPage(
          drizzle.db,
          sid,
          result.pageId,
        );
        return c.json({ data: { next: "page", page_id: result.pageId } });
      }
      return c.json({ data: { next: result.next } });
    },
  );

export { invalidatePublishedConfig };
