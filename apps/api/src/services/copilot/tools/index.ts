import { querySubscribersTools, type ToolContext } from "./query-subscribers";
import { querySubscriptionsTools } from "./query-subscriptions";
import { queryProductsTools } from "./query-products";
import { queryMetricsTools } from "./query-metrics";
import { queryAudiencesTools } from "./query-audiences";
import { queryExperimentsTools } from "./query-experiments";
import { queryFeatureFlagsTools } from "./query-feature-flags";
import { queryFunnelsTools } from "./query-funnels";
import { actionSubscriptionsTools } from "./action-subscriptions";
import { actionSubscribersTools } from "./action-subscribers";
import { actionProductsTools } from "./action-products";
import { actionAudiencesTools } from "./action-audiences";
import { actionFeatureFlagsTools } from "./action-feature-flags";
import { actionExperimentsTools } from "./action-experiments";
import { uiTools } from "./ui";
import { queryPaywallTools } from "./query-paywall";
import { actionPaywallTools } from "./action-paywall";

// The paywall builder tools are only useful — and only safe to spend tokens
// advertising — while the user is actually looking at a paywall's builder
// canvas, so they're gated on `ctx.route` rather than always loaded like
// every other domain's tools. `:paywallId` is opaque here on purpose (any
// non-slash segment); the tools themselves re-scope by `ctx.projectId` and
// re-validate the `paywallId` argument, so a route match alone grants no
// access.
export const BUILDER_ROUTE_RE = /\/paywalls\/[^/]+\/builder/;

function isBuilderRoute(route: string | undefined): boolean {
  return typeof route === "string" && BUILDER_ROUTE_RE.test(route);
}

export function loadTools(ctx: ToolContext) {
  return {
    ...querySubscribersTools(ctx),
    ...querySubscriptionsTools(ctx),
    ...queryProductsTools(ctx),
    ...queryMetricsTools(ctx),
    ...queryAudiencesTools(ctx),
    ...queryExperimentsTools(ctx),
    ...queryFeatureFlagsTools(ctx),
    ...queryFunnelsTools(ctx),
    ...actionSubscriptionsTools(ctx),
    ...actionSubscribersTools(ctx),
    ...actionProductsTools(ctx),
    ...actionAudiencesTools(ctx),
    ...actionFeatureFlagsTools(ctx),
    ...actionExperimentsTools(ctx),
    ...uiTools(ctx),
    // Paywall tools are the one surface split, and the split lives HERE,
    // not in the factories: the builder-route gate is a chat concept
    // (BUILDER_ROUTE_RE also feeds system-prompt), while MCP has no route —
    // so MCP always gets the read side and never the edit side.
    // (ui_*, metric, and action_* factories self-guard their own surface;
    // queryPaywallTools does not — this spread is its only gate.)
    // Two binary spreads (never a nested ternary): spreading `X | {}` keeps
    // the old optional-prop shape, while a 3-way union spread breaks
    // indexing for registry.test.ts and the ToolSet assignment in chat.ts.
    ...(ctx.surface === "mcp" ? { ...queryPaywallTools(ctx) } : {}),
    ...(ctx.surface !== "mcp" && isBuilderRoute(ctx.route)
      ? { ...queryPaywallTools(ctx), ...actionPaywallTools(ctx) }
      : {}),
  };
}

const STATIC_NAMES = [
  "query_subscribers_search",
  "query_subscribers_get",
  "query_subscriptions_list",
  "query_products_list",
  "query_productGroups_list",
  "query_metrics_mrr",
  "query_metrics_churn",
  "query_metrics_conversion",
  "query_audiences_list",
  "query_experiments_list",
  "query_featureFlags_list",
  "find_funnels",
  "action_subscriptions_cancel",
  "action_subscriptions_refund",
  "action_subscribers_grantAccess",
  "action_subscribers_transfer",
  "action_products_updatePrice",
  "action_audiences_create",
  "action_audiences_update",
  "action_featureFlags_toggle",
  "action_featureFlags_updateRules",
  "action_experiments_start",
  "action_experiments_stop",
  "ui_navigate",
  "ui_filter",
  "ui_openSubscriber",
  // Paywall builder tools — this list pins the full tool-NAME universe, not
  // what `loadTools()` actually returns for a given ctx: these two are only
  // present when `ctx.route` matches `BUILDER_ROUTE_RE` above.
  "query_paywall_tree",
  "action_paywall_editTree",
] as const;

export function listToolNames(): string[] {
  return [...STATIC_NAMES];
}

export type { ToolContext };
