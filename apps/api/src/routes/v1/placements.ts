import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { flattenAttributes } from "@rovenue/shared";
import { resolvePlacement } from "../../lib/placement-resolution";
import { ok } from "../../lib/response";

// =============================================================
// /v1/placements/:identifier
// =============================================================
//
// Resolves a placement identifier + optional subscriber into the
// paywall (or experiment) the caller should render. This is the
// SDK's paywall-targeting hot path: rows are audience-targeted and
// evaluated top-down, so the FIRST row whose audience matches (or
// whose audienceId is null, matching everyone including anonymous
// callers) wins. A dangling/inactive reference, a deleted audience,
// or a non-RUNNING/non-PAYWALL experiment does NOT fail the request
// — it just falls through to the next row, same as an unmatched
// audience.
//
// Unknown or inactive placements return the EMPTY envelope with 200
// (never 404) — a shipped app must never crash because a placement
// was retired server-side.
//
// The row-walk itself (audience matching, target resolution, paywall
// hydration) lives in ../../lib/placement-resolution — shared with the
// dashboard fallback-file export, which resolves every ACTIVE placement
// anonymously (see routes/dashboard/paywalls.ts).

const SUBSCRIBER_HEADER = "x-rovenue-user-id";

export const placementsRoute = new Hono().get("/:identifier", async (c) => {
  const project = c.get("project");
  const identifier = c.req.param("identifier");
  const requestedLocale = c.req.query("locale");

  const placement = await drizzle.placementRepo.findPlacementByIdentifier(
    drizzle.db,
    project.id,
    identifier,
  );
  // Unknown/inactive placements return the empty envelope, NOT 404 — a
  // shipped app must never crash because a placement was retired.
  if (!placement || !placement.isActive) {
    return c.json(ok({ placement: null, paywall: null, experiment: null }));
  }

  // Subscriber attributes for audience matching ({} when anonymous — only
  // audienceId:null rows can match then).
  const appUserId = c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER);
  let attributes: Record<string, unknown> = {};
  if (appUserId) {
    const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(
      drizzle.db,
      { projectId: project.id, key: appUserId },
    );
    if (subscriber) attributes = flattenAttributes(subscriber.attributes);
  }

  const data = await resolvePlacement(project.id, placement, attributes, requestedLocale);
  return c.json(ok(data));
});
