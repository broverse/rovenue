import { querySubscribersTools, type ToolContext } from "./query-subscribers";
import { querySubscriptionsTools } from "./query-subscriptions";
import { queryProductsTools } from "./query-products";
import { queryMetricsTools } from "./query-metrics";
import { queryAudiencesTools } from "./query-audiences";
import { queryExperimentsTools } from "./query-experiments";
import { queryFeatureFlagsTools } from "./query-feature-flags";

export function loadTools(ctx: ToolContext) {
  return {
    ...querySubscribersTools(ctx),
    ...querySubscriptionsTools(ctx),
    ...queryProductsTools(ctx),
    ...queryMetricsTools(ctx),
    ...queryAudiencesTools(ctx),
    ...queryExperimentsTools(ctx),
    ...queryFeatureFlagsTools(ctx),
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
] as const;

export function listToolNames(): string[] {
  return [...STATIC_NAMES];
}

export type { ToolContext };
