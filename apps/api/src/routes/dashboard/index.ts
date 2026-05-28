import { Hono } from "hono";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { dashboardUserRateLimit } from "../../middleware/rate-limit";
import { accessRoute } from "./access";
import { appsRoute } from "./apps";
import { audiencesRoute } from "./audiences";
import { auditLogsRoute } from "./audit-logs";
import { billingSubRouter } from "./billing";
import { chartsRoute } from "./charts";
import { cohortsRoute } from "./cohorts";
import { credentialsRoute } from "./credentials";
import { customDomainsRoute } from "./custom-domains";
import { creditsRoute } from "./credits";
import { eventsStreamRoute } from "./events-stream";
import { experimentsRoute } from "./experiments";
import { featureFlagsRoute } from "./feature-flags";
import { funnelTemplatesRoute } from "./funnel-templates";
import { funnelsRoute } from "./funnels";
import { integrationsRoute } from "./integrations";
import { leaderboardsRoute } from "./leaderboards";
import { meRoute } from "./me";
import { invitationsRoute } from "./invitations";
import { notificationsRoute } from "./notifications";
import { projectNotificationDefaultsRoute } from "./project-notification-defaults";
import { pushDevicesRoute } from "./push-devices";
import { membersRoute } from "./members";
import { metricsRoute } from "./metrics";
import { overviewRoute } from "./overview";
import { offeringsDashboardRoute } from "./offerings";
import { productsDashboardRoute } from "./products";
import { projectsRoute } from "./projects";
import { queriesRoute } from "./queries";
import { subscribersRoute } from "./subscribers";
import { subscriptionsRoute } from "./subscriptions";
import { transactionsRoute } from "./transactions";
import { webhooksDashboardRoute } from "./webhooks";
import { copilotRoute } from "./copilot";

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
  .route("/funnel-templates", funnelTemplatesRoute)
  .route("/me", meRoute)
  .route("/notifications", notificationsRoute)
  .route("/push-devices", pushDevicesRoute)
  .route("/projects", projectsRoute)
  .route("/projects/:projectId/access", accessRoute)
  .route("/projects/:projectId/apps", appsRoute)
  .route("/projects/:projectId/billing", billingSubRouter)
  .route("/projects/:projectId/charts", chartsRoute)
  .route("/projects/:projectId/cohorts", cohortsRoute)
  .route("/projects/:projectId/credentials", credentialsRoute)
  .route("/projects/:projectId/credits", creditsRoute)
  .route("/projects/:projectId/custom-domains", customDomainsRoute)
  .route("/projects/:projectId/events", eventsStreamRoute)
  .route("/projects/:projectId/funnels", funnelsRoute)
  .route("/projects/:projectId/integrations", integrationsRoute)
  .route("/projects/:projectId/leaderboards", leaderboardsRoute)
  .route("/projects/:projectId/invitations", invitationsRoute)
  .route("/projects/:projectId/members", membersRoute)
  .route(
    "/projects/:projectId/notification-defaults",
    projectNotificationDefaultsRoute,
  )
  .route("/projects/:projectId/metrics", metricsRoute)
  .route("/projects/:projectId/overview", overviewRoute)
  .route("/projects/:projectId/offerings", offeringsDashboardRoute)
  .route("/projects/:projectId/products", productsDashboardRoute)
  .route("/projects/:projectId/queries", queriesRoute)
  .route("/projects/:projectId/subscribers", subscribersRoute)
  .route("/projects/:projectId/subscriptions", subscriptionsRoute)
  .route("/projects/:projectId/transactions", transactionsRoute)
  .route("/projects/:projectId/copilot", copilotRoute)
  .route("/webhooks", webhooksDashboardRoute);
