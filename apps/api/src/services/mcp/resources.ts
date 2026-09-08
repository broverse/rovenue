import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { drizzle } from "@rovenue/db";
// Deferred use only (inside read callbacks, long after module init), so
// this import cycle with ./server is safe by construction. The version is
// the server's identity, not a second constant.
import { MCP_SERVER_VERSION } from "./server";
import { sterilizeToolResult } from "../copilot/sterilize";
import { MCP_MAX_PAGE, capRows } from "./tools";

/**
 * The project-scoped identity every MCP resource reads as. Built per
 * request from the handler's `authInfo`, same as tools — resources are
 * never world-readable.
 */
export interface McpResourceContext {
  projectId: string;
  userId: string;
}

const JSON_MIME = "application/json";

function jsonContents(uri: { href: string }, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: JSON_MIME,
        text: JSON.stringify(sterilizeToolResult(value)),
      },
    ],
  };
}

/**
 * Register the reference surface. Resources serve data a model RE-READS
 * (structure snapshots, status snapshots, project wiring) — nothing
 * actionable lives only here; every entity resource is mirrored by a tool
 * (find_funnels / list_experiments), asserted by the mirror test.
 */
export function registerMcpResources(
  server: McpServer,
  ctx: McpResourceContext,
): void {
  // project://info — static reference context. Fixed key set, no
  // actionable payload: there is no plan/limits source to mirror, so this
  // carries only identity (id, name, server version).
  server.registerResource(
    "project-info",
    "project://info",
    {
      title: "Project info",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      const project = await drizzle.projectRepo.findProjectById(
        drizzle.db,
        ctx.projectId,
      );
      if (!project) {
        throw new Error("project not found for this token");
      }
      return jsonContents(uri, {
        projectId: project.id,
        projectName: project.name,
        mcpServerVersion: MCP_SERVER_VERSION,
      });
    },
  );

  // funnel://{id}/structure — page skeleton of the current version.
  // Funnel pages carry no typed-node graph (unlike paywall builder trees),
  // so the structure is {id, elementCount} per page; element internals
  // never ship (cap safety by construction, counts only).
  server.registerResource(
    "funnel-structure",
    new ResourceTemplate("funnel://{id}/structure", { list: undefined }),
    {
      title: "Funnel structure",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const id = variables.id;
      const row = await drizzle.funnelRepo.findById(
        drizzle.db,
        Array.isArray(id) ? (id[0] ?? "") : (id ?? ""),
      );
      // Same IDOR precedent as every handler: a verbatim id from another
      // project is a miss, and a miss is an error, never an empty shape
      // that a model could misread as "no structure".
      if (!row || row.projectId !== ctx.projectId) {
        throw new Error("funnel not found in this project");
      }
      let pages: unknown[] = [];
      if (row.currentVersionId) {
        const version = await drizzle.funnelVersionRepo.findById(
          drizzle.db,
          row.currentVersionId,
        );
        pages = Array.isArray(version?.pagesJson) ? version.pagesJson : [];
      }
      const skeleton = pages.map((p) => {
        const page = p as { id?: unknown; elements?: unknown };
        return {
          id: typeof page.id === "string" ? page.id : null,
          elementCount: Array.isArray(page.elements) ? page.elements.length : 0,
        };
      });
      const { rows, truncationNote } = capRows(skeleton, MCP_MAX_PAGE);
      return jsonContents(uri, {
        funnelId: row.id,
        slug: row.slug,
        defaultLocale: row.defaultLocale,
        pages: rows,
        truncationNote,
      });
    },
  );

  // experiment://{id}/status — status snapshot. Variants/metrics ship raw
  // (reference data, exactly what resources are for); no computed split —
  // the stored shapes vary and inventing one would be lying.
  server.registerResource(
    "experiment-status",
    new ResourceTemplate("experiment://{id}/status", { list: undefined }),
    {
      title: "Experiment status",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const id = variables.id;
      const row = await drizzle.experimentRepo.findByIdInProject(
        drizzle.db,
        Array.isArray(id) ? (id[0] ?? "") : (id ?? ""),
        ctx.projectId,
      );
      if (!row) {
        throw new Error("experiment not found in this project");
      }
      return jsonContents(uri, {
        id: row.id,
        key: row.key,
        status: row.status,
        type: row.type,
        variants: row.variants,
        metrics: row.metrics,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        winnerVariantId: row.winnerVariantId,
      });
    },
  );
}
