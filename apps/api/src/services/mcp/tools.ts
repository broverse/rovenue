import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/server";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import {
  loadTools,
  type ToolContext,
} from "../copilot/tools/index";
import { SearchArgs } from "../copilot/tools/query-subscribers";
import { ListArgs as SubscriptionsListArgs } from "../copilot/tools/query-subscriptions";
import { ListProductsArgs } from "../copilot/tools/query-products";
import { ListArgs as AudiencesListArgs } from "../copilot/tools/query-audiences";
import { ListArgs as ExperimentsListArgs } from "../copilot/tools/query-experiments";
import { ListArgs as FeatureFlagsListArgs } from "../copilot/tools/query-feature-flags";
import { GetArgs as PaywallGetArgs } from "../copilot/tools/query-paywall";
import { sterilizeToolResult } from "../copilot/sterilize";

/**
 * The project-scoped identity every MCP tool runs as. Built per request
 * from the handler's `authInfo` (which the route fills from the verified
 * token) — never from a shared singleton, never cached across requests.
 */
export interface McpToolContext {
  projectId: string;
  userId: string;
  role: string;
}

/**
 * Response caps (design D4): 50 rows per page, 200 maximum, 256 KB
 * ceiling — whichever comes first. Truncation is stated, never silent.
 */
export const MCP_DEFAULT_PAGE = 50;
export const MCP_MAX_PAGE = 200;
export const MCP_MAX_RESPONSE_BYTES = 256 * 1024;

const McpLimit = z.number().int().positive().max(MCP_MAX_PAGE).default(MCP_DEFAULT_PAGE);

/**
 * Bridge a zod (v3) object schema to the SDK's `StandardSchemaWithJSON`.
 *
 * Why the bridge exists: the installed `@modelcontextprotocol/server@2.0.0`
 * types require JSON-Schema-emitting schemas for SEP-2243 (tools/list shape
 * + pre-dispatch `Mcp-Param-*` validation), and apps/api resolves zod
 * 3.25, whose `~standard` carries `validate` but no `jsonSchema`. The
 * runtime behavior stays zod-identical: VALIDATION delegates to zod (so
 * `.default()`/refinements behave exactly as on the chat path — the SDK's
 * own `fromJsonSchema` was probed and does NOT apply defaults, so it would
 * silently change semantics), while the generated JSON Schema serves only
 * the display + pre-dispatch slots it agrees with by construction.
 */
function asMcpInputSchema(schema: z.ZodTypeAny): StandardSchemaWithJSON {
  // zod-to-json-schema@3.25.2 types declare a Promise, but the installed
  // build returns the schema synchronously (verified at runtime:
  // constructor Object, no .then). Cast with a loud guard so a future
  // version that truly asyncs fails fast instead of registering garbage.
  const jsonSchema = zodToJsonSchema(schema, { target: "jsonSchema7" }) as unknown as Record<
    string,
    unknown
  >;
  if (
    !jsonSchema ||
    typeof jsonSchema !== "object" ||
    typeof (jsonSchema as { then?: unknown }).then === "function"
  ) {
    throw new Error("mcp: JSON Schema generation went async — revisit the bridge");
  }
  return {
    "~standard": {
      version: 1 as const,
      vendor: "rovenue-mcp",
      validate: (value: unknown) => schema["~standard"].validate(value),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}

const FindSubscribersArgs = z.object({
  id: z.string().min(1).optional(),
  filter: SearchArgs.shape.filter,
  limit: McpLimit,
});

// MCP-owned limit caps over the reused chat shapes: same filters (single
// source of truth), MCP's own 200-row maximum.
const ListSubscriptionsArgs = SubscriptionsListArgs.extend({ limit: McpLimit });
const ListCatalogArgs = ListProductsArgs.extend({ limit: McpLimit });
const ListAudiencesArgs = AudiencesListArgs.extend({ limit: McpLimit });
const ListFeatureFlagsArgs = FeatureFlagsListArgs.extend({ limit: McpLimit });
const ListExperimentsArgs = ExperimentsListArgs.extend({ limit: McpLimit });

function toToolContext(ctx: McpToolContext): ToolContext {
  return {
    projectId: ctx.projectId,
    userId: ctx.userId,
    role: ctx.role,
    // MCP has no chat thread: query executes only read projectId (verified
    // by grep — threadId/messageId appear solely in the type and in chat
    // test fixtures), so empty strings are inert, not lies.
    threadId: "",
    messageId: "",
    surface: "mcp",
  };
}

interface PagedRows {
  rows: unknown[];
  truncationNote: string | null;
}

/**
 * Enforce the page cap with a has-more probe: callers fetch one row past
 * the cap, so a full page proves there is more without needing a total
 * count no repository provides. The "+" in "200 of 200+ rows" is doing
 * real work — it marks the unknown, unlike a silently cut list.
 */
function capRows(all: unknown[], limit: number): PagedRows {
  const cap = Math.min(Math.max(limit, 1), MCP_MAX_PAGE);
  const window = all.slice(0, cap + 1);
  let rows = window.length > cap ? window.slice(0, cap) : window;
  let truncationNote: string | null =
    window.length > cap
      ? `${cap} of ${cap}+ rows — page capped at the ${MCP_MAX_PAGE}-row maximum; narrow the query for the rest`
      : null;

  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > MCP_MAX_RESPONSE_BYTES) {
    rows = rows.slice(0, Math.max(rows.length - 1, 1));
    while (
      rows.length > 1 &&
      Buffer.byteLength(JSON.stringify(rows), "utf8") > MCP_MAX_RESPONSE_BYTES
    ) {
      rows = rows.slice(0, -1);
    }
    truncationNote =
      `${rows.length} of ${all.length}+ rows shown — response capped at 256 KB; ` +
      `narrow the query for the rest`;
  }
  return { rows, truncationNote };
}

function okPayload(payload: Record<string, unknown>) {
  const sterile = sterilizeToolResult(payload) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(sterile) }],
    structuredContent: sterile,
  };
}

function errPayload(message: string) {
  // A tool that ran and failed: model-readable, never a protocol error.
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

type LoadedTools = ReturnType<typeof loadTools>;

async function runChatTool(
  loaded: LoadedTools,
  name: keyof LoadedTools,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = loaded[name] as unknown as {
    execute?: (args: unknown) => unknown | Promise<unknown>;
  };
  if (!tool || typeof tool.execute !== "function") {
    throw new Error(`chat tool "${String(name)}" is not available on the mcp surface`);
  }
  return tool.execute(args);
}

/**
 * Register the consolidated read surface on a per-request server.
 * Consolidation (not mirroring): the copilot registry is chat-shaped, and
 * mirroring its seventeen tools would be the context-bloat anti-pattern.
 * Each MCP tool below merges 1–2 chat tools behind one agent-shaped call.
 *
 * NOT served here: get_metrics (blocked on the R1 sandbox fix — the metric
 * chat tools stay chat-only), every ui_* tool, and every action_* tool
 * (writes arrive in Task 9 through the intent flow).
 */
export function registerMcpTools(server: McpServer, ctx: McpToolContext): void {
  const toolCtx = toToolContext(ctx);
  const loaded = loadTools(toolCtx);
  const run = (name: keyof LoadedTools, args: Record<string, unknown>) =>
    runChatTool(loaded, name, args);

  // find_subscribers ← query_subscribers_search + _get.
  server.registerTool(
    "find_subscribers",
    {
      description:
        "Find subscribers in the current project. Pass id for one subscriber, or filter/limit to search. At most 200 rows per call; the response states when it is truncated.",
      inputSchema: asMcpInputSchema(FindSubscribersArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      // The SDK validates against the bridged schema before dispatch, so
      // this cast restates what registration guarantees.
      const { id, filter, limit } = rawArgs as z.infer<typeof FindSubscribersArgs>;
      try {
        if (id) {
          const row = (await run("query_subscribers_get", { id })) as
            | Record<string, unknown>
            | null;
          if (!row) {
            return errPayload(
              `subscriber "${id}" not found in this project; call find_subscribers without id to search`,
            );
          }
          return okPayload({ subscriber: row });
        }
        const result = (await run("query_subscribers_search", {
          filter,
          limit: Math.min(limit, MCP_MAX_PAGE) + 1,
        })) as { subscribers: unknown[] };
        const { rows, truncationNote } = capRows(result.subscribers, limit);
        return okPayload({ rows, truncationNote });
      } catch (err) {
        return errPayload(
          `find_subscribers failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // list_subscriptions ← query_subscriptions_list.
  server.registerTool(
    "list_subscriptions",
    {
      description:
        "List subscriptions in the current project, with store, product, status, expiry, and subscriber id. At most 200 rows per call; the response states when it is truncated.",
      inputSchema: asMcpInputSchema(ListSubscriptionsArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { scope, search, limit, productId } = rawArgs as z.infer<
        typeof ListSubscriptionsArgs
      >;
      try {
        const result = (await run("query_subscriptions_list", {
          scope,
          search,
          limit: Math.min(limit, MCP_MAX_PAGE) + 1,
          productId,
        })) as { rows: unknown[] };
        const { rows, truncationNote } = capRows(result.rows, limit);
        return okPayload({ rows, truncationNote });
      } catch (err) {
        return errPayload(
          `list_subscriptions failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // list_catalog ← query_products_list + query_productGroups_list in one call.
  server.registerTool(
    "list_catalog",
    {
      description:
        "Products and product groups (offerings) in the current project, in one call. At most 200 rows per list; the response states when either is truncated.",
      inputSchema: asMcpInputSchema(ListCatalogArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { search, includeInactive, limit } = rawArgs as z.infer<
        typeof ListCatalogArgs
      >;
      try {
        const probe = Math.min(limit, MCP_MAX_PAGE) + 1;
        const [productsResult, groupsResult] = (await Promise.all([
          run("query_products_list", { search, includeInactive, limit: probe }),
          run("query_productGroups_list", { limit: probe }),
        ])) as [{ products: unknown[] }, { productGroups: unknown[] }];
        const products = capRows(productsResult.products, limit);
        const productGroups = capRows(groupsResult.productGroups, limit);
        const notes = [products.truncationNote, productGroups.truncationNote].filter(
          (n): n is string => n !== null,
        );
        return okPayload({
          products: products.rows,
          productGroups: productGroups.rows,
          truncationNote: notes.length > 0 ? notes.join(" ") : null,
        });
      } catch (err) {
        return errPayload(
          `list_catalog failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // list_audiences ← query_audiences_list.
  server.registerTool(
    "list_audiences",
    {
      description:
        "List audiences defined in the current project. At most 200 rows per call; the response states when it is truncated.",
      inputSchema: asMcpInputSchema(ListAudiencesArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { limit } = rawArgs as z.infer<typeof ListAudiencesArgs>;
      try {
        const result = (await run("query_audiences_list", {
          limit: Math.min(limit, MCP_MAX_PAGE) + 1,
        })) as { audiences: unknown[] };
        const { rows, truncationNote } = capRows(result.audiences, limit);
        return okPayload({ rows, truncationNote });
      } catch (err) {
        return errPayload(
          `list_audiences failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // list_feature_flags ← query_featureFlags_list.
  server.registerTool(
    "list_feature_flags",
    {
      description:
        "List feature flags in the current project. At most 200 rows per call; the response states when it is truncated.",
      inputSchema: asMcpInputSchema(ListFeatureFlagsArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { env, limit } = rawArgs as z.infer<typeof ListFeatureFlagsArgs>;
      try {
        const result = (await run("query_featureFlags_list", {
          env,
          limit: Math.min(limit, MCP_MAX_PAGE) + 1,
        })) as { featureFlags: unknown[] };
        const { rows, truncationNote } = capRows(result.featureFlags, limit);
        return okPayload({ rows, truncationNote });
      } catch (err) {
        return errPayload(
          `list_feature_flags failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // list_experiments ← query_experiments_list.
  server.registerTool(
    "list_experiments",
    {
      description:
        "List experiments in the current project. At most 200 rows per call; the response states when it is truncated.",
      inputSchema: asMcpInputSchema(ListExperimentsArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { status, type, limit } = rawArgs as z.infer<
        typeof ListExperimentsArgs
      >;
      try {
        const result = (await run("query_experiments_list", {
          status,
          type,
          limit: Math.min(limit, MCP_MAX_PAGE) + 1,
        })) as { experiments: unknown[] };
        const { rows, truncationNote } = capRows(result.experiments, limit);
        return okPayload({ rows, truncationNote });
      } catch (err) {
        return errPayload(
          `list_experiments failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // get_paywall ← query_paywall_tree. Chat route-gates this behind the
  // builder canvas; MCP has no route, so it is always available here.
  server.registerTool(
    "get_paywall",
    {
      description:
        "Get a compact structural summary of a paywall's builder-config tree: every node's id, type, parent id, and default-locale copy. Never returns the raw config JSON.",
      inputSchema: asMcpInputSchema(PaywallGetArgs),
      annotations: { readOnlyHint: true },
    },
    async (rawArgs: unknown) => {
      const { paywallId } = rawArgs as z.infer<typeof PaywallGetArgs>;
      try {
        const result = (await run("query_paywall_tree", { paywallId })) as Record<
          string,
          unknown
        > | null;
        if (!result) {
          return errPayload(`paywallId "${paywallId}" not found in this project`);
        }
        return okPayload(result);
      } catch (err) {
        return errPayload(
          `get_paywall failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
