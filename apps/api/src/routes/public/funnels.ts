// =============================================================
// Public funnel runtime routes (no auth — browser-facing)
//
// GET  /public/funnels/:slug — published config (with cache)
//
// Branching rules (`next_rules` / `default_next`) are stripped
// from the published bundle so the client never sees the routing
// logic — `/advance` (added in Task 29) evaluates server-side
// using the canonical version stored in Postgres.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  invalidatePublishedConfig,
  readPublishedConfig,
  writePublishedConfig,
} from "../../services/funnel/runtime-cache";

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
  });

export { invalidatePublishedConfig };
