// =============================================================
// Public funnel runtime routes (no auth — browser-facing)
//
// GET  /public/funnels/:slug                              — published config
// POST /public/funnels/:slug/sessions                     — start a session
// POST /public/funnel-sessions/:sessionId/answers         — upsert an answer
// POST /public/funnel-sessions/:sessionId/advance         — evaluate next page
// GET  /public/funnel-sessions/:sessionId/state           — poll status
// POST /public/funnel-sessions/:sessionId/claim-token     — issue claim token
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
import { generateClaimToken, hashToken } from "../../services/funnel/token";
import { emitFunnelEvent } from "../../services/funnel/outbox";
import { resolveHost } from "../../services/custom-domains/host-resolver";

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
  // GET /host/lookup — resolve the current Host header to a slug
  //
  // Lets the SDK discover its funnel slug when it's loaded from a
  // custom domain (no slug in the URL). Returns 404 if the Host is
  // unknown, unverified, or its cert isn't issued yet — anything
  // else would mean the edge is serving traffic that can't be
  // attributed to a funnel.
  // ---------------------------------------------------------------
  .get("/host/lookup", async (c) => {
    const host = c.req.header("host") ?? "";
    const resolved = await resolveHost(host);
    if (!resolved) {
      throw new HTTPException(404, { message: "Unknown host" });
    }
    return c.json({ data: resolved });
  })

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

      await emitFunnelEvent(drizzle.db, "funnel.session.started", session.id, {
        funnel_id: config.id,
        version_id: config.version_id,
        project_id: funnel.projectId,
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
        const prevPageId = session.currentPageId;
        await drizzle.funnelSessionRepo.setCurrentPage(
          drizzle.db,
          sid,
          result.pageId,
        );
        if (prevPageId !== result.pageId) {
          await emitFunnelEvent(
            drizzle.db,
            "funnel.session.advanced",
            sid,
            {
              funnel_id: session.funnelId,
              version_id: session.funnelVersionId,
              project_id: session.projectId,
              from_page_id: prevPageId,
              to_page_id: result.pageId,
            },
          );
        }
        return c.json({ data: { next: "page", page_id: result.pageId } });
      }
      return c.json({ data: { next: result.next } });
    },
  )

  // ---------------------------------------------------------------
  // GET /funnel-sessions/:sessionId/state — poll progress + token status
  // ---------------------------------------------------------------
  .get("/funnel-sessions/:sessionId/state", async (c) => {
    const sid = c.req.param("sessionId");
    const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
    if (!session) {
      throw new HTTPException(404, { message: "Session not found" });
    }
    const tokenRow = await drizzle.funnelClaimTokenRepo.findBySession(
      drizzle.db,
      sid,
    );
    return c.json({
      data: {
        current_page_id: session.currentPageId,
        state: session.state,
        has_claim_token: tokenRow !== null,
      },
    });
  })

  // ---------------------------------------------------------------
  // POST /funnel-sessions/:sessionId/claim-token — issue token
  //
  // In production the Stripe webhook (sub-project B) inserts the
  // funnel_purchases + funnel_claim_tokens rows out-of-band and the
  // client polls /state. This endpoint only mints a token
  // synchronously when the funnel version has `dev_mode: true` AND
  // NODE_ENV !== "production" — a developer convenience for
  // end-to-end testing without Stripe.
  // ---------------------------------------------------------------
  .post("/funnel-sessions/:sessionId/claim-token", async (c) => {
    const sid = c.req.param("sessionId");
    const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
    if (!session) {
      throw new HTTPException(404, { message: "Session not found" });
    }

    let plaintext: string | null = null;

    if (session.state === "in_progress") {
      const version = await drizzle.funnelVersionRepo.findById(
        drizzle.db,
        session.funnelVersionId,
      );
      const settings = (version?.settingsJson ?? {}) as { dev_mode?: boolean };
      if (settings.dev_mode && process.env.NODE_ENV !== "production") {
        plaintext = generateClaimToken();
        const tokenPlaintext = plaintext;
        await drizzle.db.transaction(async (tx) => {
          const purchase = await drizzle.funnelPurchaseRepo.insert(tx, {
            sessionId: sid,
            projectId: session.projectId,
            status: "paid",
            paidAt: new Date(),
            rawPayload: { stub: true },
          });
          await drizzle.funnelSessionRepo.setState(tx, sid, "paid");
          const tokenRow = await drizzle.funnelClaimTokenRepo.insert(tx, {
            tokenHash: hashToken(tokenPlaintext),
            sessionId: sid,
            projectId: session.projectId,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
          await emitFunnelEvent(tx, "funnel.session.paid", sid, {
            funnel_id: session.funnelId,
            version_id: session.funnelVersionId,
            project_id: session.projectId,
            purchase_id: purchase.id,
            token_id: tokenRow.id,
          });
          await emitFunnelEvent(tx, "funnel.claim_token.issued", sid, {
            funnel_id: session.funnelId,
            version_id: session.funnelVersionId,
            project_id: session.projectId,
            purchase_id: purchase.id,
            token_id: tokenRow.id,
          });
        });
      } else {
        throw new HTTPException(409, { message: "Session is not paid" });
      }
    } else if (session.state !== "paid" && session.state !== "completed") {
      throw new HTTPException(409, { message: "Session is not paid" });
    }

    if (plaintext === null) {
      // Non-stub path: token was issued by the Stripe webhook. We
      // intentionally don't recover plaintext — clients should pull
      // it from the URL the webhook handler emitted (sub-project B).
      const existing = await drizzle.funnelClaimTokenRepo.findBySession(
        drizzle.db,
        sid,
      );
      if (!existing) {
        throw new HTTPException(404, { message: "No claim token" });
      }
      throw new HTTPException(410, { message: "Token already issued" });
    }

    const version = await drizzle.funnelVersionRepo.findById(
      drizzle.db,
      session.funnelVersionId,
    );
    const settings = (version?.settingsJson ?? {}) as {
      deep_link_scheme?: string;
      universal_link_domain?: string;
    };
    const deepLink = settings.deep_link_scheme
      ? `${settings.deep_link_scheme}://onboarding-complete?token=${plaintext}&project=${session.projectId}`
      : null;
    const universalLink = settings.universal_link_domain
      ? `https://${settings.universal_link_domain}/universal/funnels/open/${plaintext}`
      : null;

    return c.json({
      data: {
        token: plaintext,
        deep_link_url: deepLink,
        universal_link_url: universalLink,
      },
    });
  });

export { invalidatePublishedConfig };
