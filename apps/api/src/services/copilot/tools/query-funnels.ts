import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

type FunnelRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.funnelRepo.findById>>
>;

export const FindFunnelsArgs = z.object({
  id: z.string().min(1).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

function toFunnelSummary(f: FunnelRow) {
  return { id: f.id, slug: f.slug, name: f.name, status: f.status };
}

/**
 * Published page count: the current version's pagesJson length, or 0 when
 * nothing is published yet. The raw pages JSON never ships — it would blow
 * the response cap on a large funnel, and an agent needs something to act
 * on (id, slug, count), not the blob.
 */
async function publishedPageCount(funnel: FunnelRow): Promise<number> {
  if (!funnel.currentVersionId) return 0;
  const version = await drizzle.funnelVersionRepo.findById(
    drizzle.db,
    funnel.currentVersionId,
  );
  const pages = version?.pagesJson;
  return Array.isArray(pages) ? pages.length : 0;
}

export function queryFunnelsTools(ctx: ToolContext) {
  // Both surfaces, no gate: funnels are ordinary project content with no
  // chat-only route concept and no builder-canvas restriction.
  return {
    "find_funnels": tool({
      description:
        "Find funnels in the current project. Pass id for one funnel's detail (slug and published page count), or status/limit to list. Never returns page JSON.",
      inputSchema: FindFunnelsArgs,
      execute: async ({ id, status, limit }) => {
        if (id) {
          const row = await drizzle.funnelRepo.findById(drizzle.db, id);
          // IDOR precedent: a verbatim id from another project is a miss.
          if (!row || row.projectId !== ctx.projectId) {
            return sterilizeToolResult(null);
          }
          return sterilizeToolResult({
            funnel: {
              ...toFunnelSummary(row),
              defaultLocale: row.defaultLocale,
              pageCount: await publishedPageCount(row),
            },
          });
        }
        const rows = await drizzle.funnelRepo.listByProject(
          drizzle.db,
          ctx.projectId,
          { status, limit: limit + 1 },
        );
        return sterilizeToolResult({
          funnels: rows.slice(0, limit).map(toFunnelSummary),
        });
      },
    }),
  };
}
