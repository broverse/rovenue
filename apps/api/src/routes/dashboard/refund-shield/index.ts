import { Hono } from "hono";
import { refundShieldMetricsRoute } from "./metrics";
import { refundShieldResponsesRoute } from "./responses";
import { refundShieldSettingsRoute } from "./settings";

// =============================================================
// Dashboard: Refund Shield router (T16-T18)
// =============================================================
//
// Mounted at /dashboard/projects/:projectId/refund-shield. Each
// sub-router enforces its own role guard so handlers stay
// independently testable and the chained type surfaces flow into
// AppType for end-to-end client typing.

export const refundShieldRoute = new Hono()
  .route("/settings", refundShieldSettingsRoute)
  .route("/responses", refundShieldResponsesRoute)
  .route("/metrics", refundShieldMetricsRoute);
