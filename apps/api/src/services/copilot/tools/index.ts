import { querySubscribersTools, type ToolContext } from "./query-subscribers";
import { querySubscriptionsTools } from "./query-subscriptions";
import { queryProductsTools } from "./query-products";
import { queryMetricsTools } from "./query-metrics";
import { queryAudiencesTools } from "./query-audiences";
import { queryExperimentsTools } from "./query-experiments";
import { queryFeatureFlagsTools } from "./query-feature-flags";
import { actionSubscriptionsTools } from "./action-subscriptions";
import { actionSubscribersTools } from "./action-subscribers";
import { actionProductsTools } from "./action-products";
import { actionAudiencesTools } from "./action-audiences";
import { actionFeatureFlagsTools } from "./action-feature-flags";
import { actionExperimentsTools } from "./action-experiments";
import { uiTools } from "./ui";

export function loadTools(ctx: ToolContext) {
  return {
    ...querySubscribersTools(ctx),
    ...querySubscriptionsTools(ctx),
    ...queryProductsTools(ctx),
    ...queryMetricsTools(ctx),
    ...queryAudiencesTools(ctx),
    ...queryExperimentsTools(ctx),
    ...queryFeatureFlagsTools(ctx),
    ...actionSubscriptionsTools(ctx),
    ...actionSubscribersTools(ctx),
    ...actionProductsTools(ctx),
    ...actionAudiencesTools(ctx),
    ...actionFeatureFlagsTools(ctx),
    ...actionExperimentsTools(ctx),
    ...uiTools(ctx),
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
] as const;

export function listToolNames(): string[] {
  return [...STATIC_NAMES];
}

export type { ToolContext };
