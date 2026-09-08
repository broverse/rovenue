import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { loadTools } from "../copilot/tools";
import { sterilizeToolResult } from "../copilot/sterilize";
import {
  MCP_MAX_PAGE,
  capRows,
  runChatTool,
  toToolContext,
  type McpToolContext,
} from "./tools";

const JSON_MIME = "application/json";

function jsonContents(uri: { href: string }, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: JSON_MIME,
        // Handlers sterilize their own results; this second pass is
        // idempotent (pure key-drop walk) and keeps the resource boundary
        // safe even if a handler ever forgets.
        text: JSON.stringify(sterilizeToolResult(value)),
      },
    ],
  };
}

/**
 * Register the spec-D4 resource surface. Three resources ship, each a thin
 * read over the SAME chat handler its mirror tool calls — catalog/products
 * and experiments over the list handlers, paywall/{id} over
 * query_paywall_tree — so the mirror relation is structural, not asserted.
 * `rovenue://schema/clickhouse` ships only with `run_analytics_query`
 * (spec D4 + D7) and stays out while that tool does.
 */
export function registerMcpResources(
  server: McpServer,
  ctx: McpToolContext,
): void {
  // One load per request, same as tools: every read below runs inside the
  // caller's project scope, never world-readable.
  const loaded = loadTools(toToolContext(ctx));
  const run = (
    name: Parameters<typeof runChatTool>[1],
    args: Record<string, unknown>,
  ) => runChatTool(loaded, name, args);

  // rovenue://catalog/products — full catalog snapshot (unfiltered: no
  // search, inactive excluded, the list_catalog default call).
  server.registerResource(
    "catalog-products",
    "rovenue://catalog/products",
    {
      title: "Catalog products",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      const probe = MCP_MAX_PAGE + 1;
      const [productsResult, groupsResult] = (await Promise.all([
        run("query_products_list", { includeInactive: false, limit: probe }),
        run("query_productGroups_list", { limit: probe }),
      ])) as [{ products: unknown[] }, { productGroups: unknown[] }];
      const products = capRows(productsResult.products, MCP_MAX_PAGE);
      const productGroups = capRows(groupsResult.productGroups, MCP_MAX_PAGE);
      const notes = [products.truncationNote, productGroups.truncationNote].filter(
        (n): n is string => n !== null,
      );
      return jsonContents(uri, {
        products: products.rows,
        productGroups: productGroups.rows,
        truncationNote: notes.length > 0 ? notes.join(" ") : null,
      });
    },
  );

  // rovenue://experiments — full experiment-list snapshot (unfiltered, the
  // list_experiments default call).
  server.registerResource(
    "experiments",
    "rovenue://experiments",
    {
      title: "Experiments",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      const result = (await run("query_experiments_list", {
        limit: MCP_MAX_PAGE + 1,
      })) as { experiments: unknown[] };
      const { rows, truncationNote } = capRows(
        result.experiments,
        MCP_MAX_PAGE,
      );
      return jsonContents(uri, { experiments: rows, truncationNote });
    },
  );

  // rovenue://paywall/{id} — paywall builder-tree summary. The handler
  // returns null on a miss (same IDOR precedent as every handler: a
  // verbatim id from another project is a miss, never an empty shape),
  // and a miss is an error, never a resource-shaped lie.
  server.registerResource(
    "paywall",
    new ResourceTemplate("rovenue://paywall/{id}", { list: undefined }),
    {
      title: "Paywall",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      const id = variables.id;
      const paywallId = Array.isArray(id) ? (id[0] ?? "") : (id ?? "");
      const result = (await run("query_paywall_tree", {
        paywallId,
      })) as Record<string, unknown> | null;
      if (!result) {
        throw new Error(`paywall "${paywallId}" not found in this project`);
      }
      const nodes = Array.isArray(result.nodes) ? result.nodes : [];
      const { rows, truncationNote } = capRows(nodes, MCP_MAX_PAGE);
      return jsonContents(uri, { ...result, nodes: rows, truncationNote });
    },
  );
}
