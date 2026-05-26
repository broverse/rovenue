import { Hono } from "hono";
import { summaryRoute } from "./summary";
import { upgradeRoute } from "./upgrade";

// =============================================================
// /dashboard/projects/:projectId/billing sub-router
// =============================================================
//
// Each billing endpoint lives in its own file under
// `apps/api/src/routes/dashboard/billing/` and is chained here so
// the accumulated type surfaces through to AppType in app.ts.
// Subsequent tasks (T21-T22) will add `.route(...)` chains for
// payment-methods / invoices.

export const billingSubRouter = new Hono()
  .route("/", summaryRoute)
  .route("/upgrade", upgradeRoute);
