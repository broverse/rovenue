import { Hono } from "hono";
import { audiencesRoute } from "./audiences";
import { auditLogsRoute } from "./audit-logs";
import { experimentsRoute } from "./experiments";
import { featureFlagsRoute } from "./feature-flags";
import { projectsRoute } from "./projects";
import { webhooksDashboardRoute } from "./webhooks";

export const dashboardRoute = new Hono();

dashboardRoute.route("/audiences", audiencesRoute);
dashboardRoute.route("/audit-logs", auditLogsRoute);
dashboardRoute.route("/experiments", experimentsRoute);
dashboardRoute.route("/feature-flags", featureFlagsRoute);
dashboardRoute.route("/projects", projectsRoute);
dashboardRoute.route("/webhooks", webhooksDashboardRoute);
