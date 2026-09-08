import { HTTPException } from "hono/http-exception";
import { MemberRole } from "@rovenue/db";
import { assertProjectAccess } from "../../lib/project-access";
// Type-only: the context shape Task 4's verifier produces. Erased at
// runtime, so no runtime layering inversion (services → routes).
import type { McpTokenContext } from "../../routes/mcp/auth";

/** Token scopes. The mint side validates against the same two values. */
export const MCP_SCOPE_READ = "read";
export const MCP_SCOPE_READ_WRITE = "read_write";

export type ToolSurface = "read" | "write";

/**
 * The surface each MCP tool belongs to. Checked by `assertToolAllowed`
 * before any tool body runs, so a scope rejection can never create an
 * intent row or any other side effect.
 *
 * Populated as tools ship (Task 6: reads; Task 9: writes) — a tool
 * added WITHOUT an entry here is unreachable to `read` tokens by
 * construction (unknown tools fail closed below), so forgetting the
 * entry errs toward refusal, never toward leakage.
 */
export const TOOL_SURFACE: Record<string, ToolSurface> = {
  // Phase 2 Task 6: the consolidated read surface. Write tools (Task 9)
  // add their entries here as they ship — each "write".
  find_subscribers: "read",
  list_subscriptions: "read",
  list_catalog: "read",
  list_audiences: "read",
  list_feature_flags: "read",
  list_experiments: "read",
  get_paywall: "read",
  find_funnels: "read",
  // Phase 2 Task 9: the only writes in A. A `read` token is refused
  // before the tool body runs, so denial leaves no intent row behind.
  start_experiment: "write",
  stop_experiment: "write",
  // Catalog creates (products / offerings / entitlements): same gate —
  // a `read` token is refused before any intent row exists.
  create_product: "write",
  create_offering: "write",
  create_entitlement: "write",
  // Placement / audience creates: same gate — a `read` token is
  // refused before any intent row exists.
  create_placement: "write",
  create_audience: "write",
  // Asset delete: same gate — a `read` token is refused before any
  // intent row exists.
  delete_asset: "write",
  // Staged asset upload: same gate — a `read` token is refused before
  // any ticket is minted (minting itself is the propose step).
  stage_asset_upload: "write",
  // Staged font upload: same gate — a `read` token is refused before
  // any ticket is minted (minting itself is the propose step).
  stage_font_upload: "write",
  // Virtual currency create: same gate — a `read` token is refused
  // before any intent row exists.
  create_virtual_currency: "write",
  // Funnel create / edit: same gate — a `read` token is refused
  // before any intent row exists.
  create_funnel: "write",
  update_funnel: "write",
  // Paywall create / edit: same gate — a `read` token is refused
  // before any intent row exists.
  create_paywall: "write",
  update_paywall: "write",
};

/**
 * Resolve the live membership on EVERY request and return its role. No
 * caching across requests: a demotion or removal must take effect
 * immediately, and the server is stateless anyway. The token carries NO
 * baked-in role — if it did, a demoted user would keep old privileges
 * until the token expired.
 *
 * Throws 403 when the owner is no longer a member: the token dies with
 * the membership.
 */
export async function authorizeMcpRequest(
  ctx: McpTokenContext,
): Promise<{ role: MemberRole }> {
  const membership = await assertProjectAccess(ctx.projectId, ctx.userId);
  return { role: membership.role };
}

/**
 * Enforce least privilege on the TOKEN, not just the human: a `read` token
 * owned by an OWNER still cannot reach a write tool.
 *
 * Runs BEFORE the tool body (the route calls this before dispatch), so a
 * rejected call leaves no trace of a proposed mutation.
 *
 * Rules, all fail-closed:
 * - `read_write` scope reaches everything (including unknown tools, which
 *   the handler then answers with tool-not-found).
 * - `read` scope reaches only tools the surface marks `read`.
 * - Unknown tools are denied to `read` tokens: the surface map is the
 *   allow-list, and anything outside it is refused rather than guessed.
 * - Any other scope value is denied outright — only the two minted scopes
 *   exist, so an unknown one is either corruption or forgery.
 */
export function assertToolAllowed(
  ctx: McpTokenContext,
  tool: unknown,
): void {
  if (ctx.scope === MCP_SCOPE_READ_WRITE) return;
  if (ctx.scope !== MCP_SCOPE_READ) {
    throw new HTTPException(403, { message: "Unknown token scope" });
  }
  const surface =
    typeof tool === "string" ? TOOL_SURFACE[tool] : undefined;
  if (surface === "read") return;
  throw new HTTPException(403, {
    message: "This token is read-only",
  });
}
