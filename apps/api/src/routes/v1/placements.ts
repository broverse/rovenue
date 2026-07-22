import { Hono } from "hono";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { flattenAttributes, placementRowsSchema } from "@rovenue/shared";
// matchesAudience depends on node:crypto and is deliberately excluded from
// the top-level @rovenue/shared barrel (which the dashboard's browser
// bundle also consumes) — server callers import it via the subpath below,
// mirroring services/experiment-engine.ts.
import { matchesAudience } from "@rovenue/shared/experiments";
import { hydrateOffering } from "../../lib/offering-hydration";
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

const SUBSCRIBER_HEADER = "x-rovenue-user-id";

// remoteConfig column shape: { defaultLocale?: string, locales?: { [locale]: object } }
const remoteConfigSchema = z
  .object({
    defaultLocale: z.string().min(1),
    locales: z.record(z.record(z.unknown())),
  })
  .partial({ defaultLocale: true, locales: true });

function resolveLocale(remoteConfig: unknown, requested: string | undefined) {
  const parsed = remoteConfigSchema.safeParse(remoteConfig);
  if (!parsed.success || !parsed.data.locales) return { locale: null, data: null };
  const locales = parsed.data.locales;
  const fallback = parsed.data.defaultLocale ?? Object.keys(locales)[0] ?? null;
  const pick = requested && locales[requested] ? requested : fallback;
  return pick && locales[pick] ? { locale: pick, data: locales[pick] } : { locale: null, data: null };
}

type PaywallRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.paywallRepo.findPaywallById>>
>;

async function hydratePaywall(projectId: string, paywall: PaywallRow, requestedLocale?: string) {
  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    projectId,
    paywall.offeringId,
  );
  const { locale, data } = resolveLocale(paywall.remoteConfig, requestedLocale);
  return {
    id: paywall.id,
    identifier: paywall.identifier,
    name: paywall.name,
    configFormatVersion: paywall.configFormatVersion,
    remoteConfig: locale ? { locale, data } : null,
    offering: offering ? await hydrateOffering(projectId, offering) : null,
  };
}

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

  const placementInfo = { identifier: placement.identifier, revision: placement.revision };
  const rows = placementRowsSchema.safeParse(placement.rows);
  if (!rows.success) {
    return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));
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

  // Batch-load referenced audiences once, walk rows top-down.
  const audienceIds = rows.data.map((r) => r.audienceId).filter((x): x is string => !!x);
  const audiences = await drizzle.audienceRepo.findByIds(drizzle.db, project.id, audienceIds);
  const audienceById = new Map(audiences.map((a) => [a.id, a] as const));

  for (const row of rows.data) {
    if (row.audienceId !== null) {
      const audience = audienceById.get(row.audienceId);
      if (!audience) continue; // deleted audience → skip row
      if (!matchesAudience(attributes, audience.rules as Record<string, unknown>)) continue;
    }
    // Row matched — resolve target.
    if (row.target.type === "none") {
      return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));
    }
    if (row.target.type === "paywall") {
      const paywall = await drizzle.paywallRepo.findPaywallById(
        drizzle.db,
        project.id,
        row.target.paywallId,
      );
      if (!paywall || !paywall.isActive) continue; // dangling ref → next row
      return c.json(
        ok({
          placement: placementInfo,
          paywall: await hydratePaywall(project.id, paywall, requestedLocale),
          experiment: null,
        }),
      );
    }
    // target.type === "experiment"
    const experiment = await drizzle.experimentRepo.findByIdInProject(
      drizzle.db,
      row.target.experimentId,
      project.id,
    );
    if (!experiment || experiment.type !== "PAYWALL" || experiment.status !== "RUNNING") continue;
    const variants = (experiment.variants as Array<{ id: string; weight: number; value: unknown }>) ?? [];
    const hydrated: Array<{ variantId: string; weight: number; paywall: Awaited<ReturnType<typeof hydratePaywall>> }> = [];
    for (const v of variants) {
      const paywallId = (v.value as { paywallId?: string } | null)?.paywallId;
      if (!paywallId) continue;
      const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, project.id, paywallId);
      if (!paywall || !paywall.isActive) continue;
      hydrated.push({
        variantId: v.id,
        weight: v.weight,
        paywall: await hydratePaywall(project.id, paywall, requestedLocale),
      });
    }
    if (hydrated.length === 0) continue; // legacy inline-config experiment → next row
    return c.json(
      ok({
        placement: placementInfo,
        paywall: null,
        experiment: { id: experiment.id, key: experiment.key, variants: hydrated },
      }),
    );
  }
  return c.json(ok({ placement: placementInfo, paywall: null, experiment: null }));
});
