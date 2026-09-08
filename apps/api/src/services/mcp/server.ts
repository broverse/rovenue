import { McpServer } from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  McpRequestContext,
} from "@modelcontextprotocol/server";
import { registerMcpResources } from "./resources";
import { registerMcpTools } from "./tools";

/** Server identity clients see in `server/discover`. */
export const MCP_SERVER_NAME = "rovenue-mcp";

/**
 * Mirrors `API_VERSION` (`apps/api/src/routes/health.ts`) without importing
 * it: services must not depend on routes, so the value is duplicated here
 * deliberately rather than through a backwards import.
 */
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * The only protocol revision this server speaks. Not exported by the SDK
 * as a runtime constant (its `WireEra` type names the union
 * `'2025-11-25' | '2026-07-28'`, and a probe against the installed
 * `@modelcontextprotocol/server@2.0.0` shows `server/discover` answering
 * with `supportedVersions: ["2026-07-28"]`), so it is hoisted here with
 * provenance instead of being inlined at call sites.
 */
export const MCP_PROTOCOL_REVISION = "2026-07-28";

/**
 * Part of the interface, not boilerplate: the one place to tell a client's
 * model how this server expects to be used.
 */
export const MCP_INSTRUCTIONS =
  "A Rovenue project assistant. Every token is scoped to exactly one " +
  "project: all data returned belongs to that project. Subscriber PII " +
  "(email, IP, device id) is stripped from results by default. Write tools " +
  "propose a change and require an explicit human confirmation step before " +
  "anything mutates.";

/**
 * A FRESH server per request. The SDK documents that sharing one instance
 * across concurrent clients collides their request ids, and the 2026-07-28
 * revision moved the protocol to a stateless core precisely so this is the
 * normal shape. It also matters operationally: apps/api may run several
 * replicas, and a session held in one process's memory breaks behind a
 * load balancer.
 *
 * Capabilities are declared explicitly (tools + resources, never prompts:
 * prompts are out of scope by design, D4a) rather than relying on the
 * SDK's auto-derivation, so the declared set is a decision in this file,
 * not an emergent property of whichever tools happen to be registered.
 */
/**
 * Project-scoped identity for tool execution, carried in the handler's
 * `authInfo.extra` (the SDK's designed slot for "additional data that
 * needs to be attached to the auth info"). The route fills it from the
 * verified token + live membership on every request.
 */
function toMcpToolContext(authInfo: AuthInfo | undefined): {
  projectId: string;
  userId: string;
  role: string;
} {
  const extra = authInfo?.extra as
    | { projectId?: unknown; role?: unknown }
    | undefined;
  const projectId = extra?.projectId;
  const userId = authInfo?.clientId;
  const role = extra?.role;
  if (
    typeof projectId !== "string" ||
    typeof userId !== "string" ||
    typeof role !== "string"
  ) {
    // Loud fail-closed: the route always attaches authInfo, so reaching
    // here is a wiring bug, and a tool running without a project scope
    // must never silently happen.
    throw new Error("mcp: missing auth context for tool execution");
  }
  return { projectId, userId, role };
}

export function buildMcpServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );
  const toolCtx = toMcpToolContext(ctx.authInfo);
  registerMcpTools(server, toolCtx);
  registerMcpResources(server, toolCtx);
  return server;
}
