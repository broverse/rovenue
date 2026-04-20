import { Hono } from "hono";
import { audiencesRoute } from "./audiences";
import { auditLogsRoute } from "./audit-logs";
import { credentialsRoute } from "./credentials";
import { experimentsRoute } from "./experiments";
import { featureFlagsRoute } from "./feature-flags";
import { membersRoute } from "./members";
import { projectsRoute } from "./projects";
import { subscribersRoute } from "./subscribers";
import { webhooksDashboardRoute } from "./webhooks";

// =============================================================
// /dashboard route tree
// =============================================================
//
// Chained on a single expression so each sub-route's accumulated
// type surfaces through to AppType in apps/api/src/app.ts. All
// children run `requireDashboardAuth` internally, so the top-level
// middleware list here is empty on purpose.

export const dashboardRoute = new Hono()
  .route("/audiences", audiencesRoute)
  .route("/audit-logs", auditLogsRoute)
  .route("/experiments", experimentsRoute)
  .route("/feature-flags", featureFlagsRoute)
  .route("/projects", projectsRoute)
  .route("/projects/:projectId/credentials", credentialsRoute)
  .route("/projects/:projectId/members", membersRoute)
  .route("/projects/:projectId/subscribers", subscribersRoute)
  .route("/webhooks", webhooksDashboardRoute);
