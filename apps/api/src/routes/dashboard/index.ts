import { Hono } from "hono";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { dashboardUserRateLimit } from "../../middleware/rate-limit";
import { appsRoute } from "./apps";
import { audiencesRoute } from "./audiences";
import { auditLogsRoute } from "./audit-logs";
import { chartsRoute } from "./charts";
import { cohortsRoute } from "./cohorts";
import { credentialsRoute } from "./credentials";
import { creditsRoute } from "./credits";
import { eventsStreamRoute } from "./events-stream";
import { experimentsRoute } from "./experiments";
import { featureFlagsRoute } from "./feature-flags";
import { leaderboardsRoute } from "./leaderboards";
import { meRoute } from "./me";
import { membersRoute } from "./members";
import { metricsRoute } from "./metrics";
import { overviewRoute } from "./overview";
import { productGroupsDashboardRoute } from "./product-groups";
import { productsDashboardRoute } from "./products";
import { projectsRoute } from "./projects";
import { queriesRoute } from "./queries";
import { subscribersRoute } from "./subscribers";
import { subscriptionsRoute } from "./subscriptions";
import { transactionsRoute } from "./transactions";
import { webhooksDashboardRoute } from "./webhooks";

// =============================================================
// /dashboard route tree
// =============================================================
//
// Chained on a single expression so each sub-route's accumulated
// type surfaces through to AppType in apps/api/src/app.ts.
//
// Auth + per-user rate limit are mounted here at the tree level so
// `c.get("user")` is populated before the limiter reads it, giving
// us one bucket per human rather than one per IP. Children still
// call `requireDashboardAuth` internally as defense-in-depth — the
// session read is cheap and keeps each sub-route independently
// testable.

export const dashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .use("*", dashboardUserRateLimit())
  .route("/audiences", audiencesRoute)
  .route("/audit-logs", auditLogsRoute)
  .route("/experiments", experimentsRoute)
  .route("/feature-flags", featureFlagsRoute)
  .route("/me", meRoute)
  .route("/projects", projectsRoute)
  .route("/projects/:projectId/apps", appsRoute)
  .route("/projects/:projectId/charts", chartsRoute)
  .route("/projects/:projectId/cohorts", cohortsRoute)
  .route("/projects/:projectId/credentials", credentialsRoute)
  .route("/projects/:projectId/credits", creditsRoute)
  .route("/projects/:projectId/events", eventsStreamRoute)
  .route("/projects/:projectId/leaderboards", leaderboardsRoute)
  .route("/projects/:projectId/members", membersRoute)
  .route("/projects/:projectId/metrics", metricsRoute)
  .route("/projects/:projectId/overview", overviewRoute)
  .route("/projects/:projectId/product-groups", productGroupsDashboardRoute)
  .route("/projects/:projectId/products", productsDashboardRoute)
  .route("/projects/:projectId/queries", queriesRoute)
  .route("/projects/:projectId/subscribers", subscribersRoute)
  .route("/projects/:projectId/subscriptions", subscriptionsRoute)
  .route("/projects/:projectId/transactions", transactionsRoute)
  .route("/webhooks", webhooksDashboardRoute);
