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
  "query.subscribers.search",
  "query.subscribers.get",
  "query.subscriptions.list",
  "query.products.list",
  "query.productGroups.list",
  "query.metrics.mrr",
  "query.metrics.churn",
  "query.metrics.conversion",
  "query.audiences.list",
  "query.experiments.list",
  "query.featureFlags.list",
  "action.subscriptions.cancel",
  "action.subscriptions.refund",
  "action.subscribers.grantAccess",
  "action.subscribers.transfer",
  "action.products.updatePrice",
  "action.audiences.create",
  "action.audiences.update",
  "action.featureFlags.toggle",
  "action.featureFlags.updateRules",
  "action.experiments.start",
  "action.experiments.stop",
  "ui.navigate",
  "ui.filter",
  "ui.openSubscriber",
] as const;

export function listToolNames(): string[] {
  return [...STATIC_NAMES];
}

export type { ToolContext };
