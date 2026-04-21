import { Hono } from "hono";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { dashboardUserRateLimit } from "../../middleware/rate-limit";
import { audiencesRoute } from "./audiences";
import { auditLogsRoute } from "./audit-logs";
import { credentialsRoute } from "./credentials";
import { experimentsRoute } from "./experiments";
import { featureFlagsRoute } from "./feature-flags";
import { membersRoute } from "./members";
import { metricsRoute } from "./metrics";
import { projectsRoute } from "./projects";
import { subscribersRoute } from "./subscribers";
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
  .route("/projects", projectsRoute)
  .route("/projects/:projectId/credentials", credentialsRoute)
  .route("/projects/:projectId/members", membersRoute)
  .route("/projects/:projectId/metrics", metricsRoute)
  .route("/projects/:projectId/subscribers", subscribersRoute)
  .route("/webhooks", webhooksDashboardRoute);
