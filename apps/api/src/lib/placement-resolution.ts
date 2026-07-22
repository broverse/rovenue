import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { placementRowsSchema } from "@rovenue/shared";
// matchesAudience depends on node:crypto and is deliberately excluded from
// the top-level @rovenue/shared barrel (which the dashboard's browser
// bundle also consumes) — server callers import it via the subpath below,
// mirroring services/experiment-engine.ts.
import { matchesAudience } from "@rovenue/shared/experiments";
import { hydrateOffering } from "./offering-hydration";

// =============================================================
// Placement row-walk — shared between /v1/placements/:identifier
// (live, per-subscriber resolution) and the dashboard fallback-file
// export (every ACTIVE placement, anonymous resolution). Extracted
// so both call sites share EXACTLY the same targeting semantics —
// see apps/api/src/routes/v1/placements.ts for the SDK-facing route
// and apps/api/src/routes/dashboard/paywalls.ts for the export.
// =============================================================

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

type PaywallVersionRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.paywallVersionRepo.findById>>
>;

/**
 * Hydrate the PUBLISHED snapshot, never `paywalls.builderConfig`.
 *
 * `paywalls.builderConfig` is the builder's private draft — serving it
 * here is exactly the P0 defect this split fixed. Identifier and name
 * come from the live row (identifier is immutable, name is cosmetic);
 * everything the device actually renders comes from `version`, including
 * `offeringId`, so re-pointing the draft at another offering can't
 * retroactively change what a published version resolves against.
 */
async function hydratePaywall(
  projectId: string,
  paywall: PaywallRow,
  version: PaywallVersionRow,
  requestedLocale?: string,
) {
  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    projectId,
    version.offeringId,
  );
  const { locale, data } = resolveLocale(version.remoteConfig, requestedLocale);
  return {
    id: paywall.id,
    identifier: paywall.identifier,
    name: paywall.name,
    configFormatVersion: version.configFormatVersion,
    remoteConfig: locale ? { locale, data } : null,
    // builderConfig ships whole (all localizations) — ?locale only slices
    // remoteConfig above. Field is present ONLY when non-null: the Rust
    // SDK wire fixtures decode this payload, and adding a field is safe
    // (serde ignores unknown fields) but an always-present `null` isn't
    // worth the wire-size cost for paywalls that don't use the builder.
    ...(version.builderConfig !== null && { builderConfig: version.builderConfig }),
    offering: offering ? await hydrateOffering(projectId, offering) : null,
  };
}

type PlacementRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.placementRepo.findPlacementByIdentifier>>
>;

export interface ResolvedPlacementData {
  placement: { identifier: string; revision: number } | null;
  paywall: Awaited<ReturnType<typeof hydratePaywall>> | null;
  experiment: {
    id: string;
    key: string;
    variants: Array<{
      variantId: string;
      weight: number;
      paywall: Awaited<ReturnType<typeof hydratePaywall>>;
    }>;
  } | null;
}

/**
 * Resolve an (already-fetched, active) placement against the given
 * subscriber attributes: parses `rows`, walks them top-down evaluating
 * audience matches, and hydrates the winning paywall/experiment. Returns
 * the `/v1/placements/:identifier` envelope's `data` triple — callers
 * (the live route and the fallback-file export) wrap it in `ok()`
 * themselves.
 *
 * Never throws for a resolution failure — a dangling/inactive reference,
 * a deleted audience, or a non-RUNNING/non-PAYWALL experiment just falls
 * through to the next row, same semantics as the SDK-facing route.
 */
export async function resolvePlacement(
  projectId: string,
  placement: PlacementRow,
  attributes: Record<string, unknown>,
  requestedLocale?: string,
): Promise<ResolvedPlacementData> {
  const placementInfo = { identifier: placement.identifier, revision: placement.revision };
  const rows = placementRowsSchema.safeParse(placement.rows);
  if (!rows.success) {
    return { placement: placementInfo, paywall: null, experiment: null };
  }

  // Batch-load referenced audiences once, walk rows top-down.
  const audienceIds = rows.data.map((r) => r.audienceId).filter((x): x is string => !!x);
  const audiences = await drizzle.audienceRepo.findByIds(drizzle.db, projectId, audienceIds);
  const audienceById = new Map(audiences.map((a) => [a.id, a] as const));

  for (const row of rows.data) {
    if (row.audienceId !== null) {
      const audience = audienceById.get(row.audienceId);
      if (!audience) continue; // deleted audience → skip row
      if (!matchesAudience(attributes, audience.rules as Record<string, unknown>)) continue;
    }
    // Row matched — resolve target.
    if (row.target.type === "none") {
      return { placement: placementInfo, paywall: null, experiment: null };
    }
    if (row.target.type === "paywall") {
      const paywall = await drizzle.paywallRepo.findPaywallById(
        drizzle.db,
        projectId,
        row.target.paywallId,
      );
      if (!paywall || !paywall.isActive) continue; // dangling ref → next row
      // No published version → treat exactly like an inactive paywall.
      // A draft must never resolve on a device.
      if (!paywall.publishedVersionId) continue;
      const version = await drizzle.paywallVersionRepo.findById(
        drizzle.db,
        paywall.publishedVersionId,
      );
      if (!version) continue;
      return {
        placement: placementInfo,
        paywall: await hydratePaywall(projectId, paywall, version, requestedLocale),
        experiment: null,
      };
    }
    // target.type === "experiment"
    const experiment = await drizzle.experimentRepo.findByIdInProject(
      drizzle.db,
      row.target.experimentId,
      projectId,
    );
    if (!experiment || experiment.type !== "PAYWALL" || experiment.status !== "RUNNING") continue;
    const variants = (experiment.variants as Array<{ id: string; weight: number; value: unknown }>) ?? [];
    // Batch the variant paywall lookups (SDK hot path — the per-variant
    // sequential fetches were an N+1 flagged in the whole-phase review),
    // then hydrate in parallel. Order follows the variants array.
    const variantRefs = variants.flatMap((v) => {
      const paywallId = (v.value as { paywallId?: string } | null)?.paywallId;
      return paywallId ? [{ variantId: v.id, weight: v.weight, paywallId }] : [];
    });
    const variantPaywalls = await drizzle.paywallRepo.findPaywallsByIds(
      drizzle.db,
      projectId,
      variantRefs.map((r) => r.paywallId),
    );
    const paywallById = new Map(variantPaywalls.map((p) => [p.id, p] as const));

    // Second batched lookup so the variant fan-out still costs two
    // queries, not one per variant.
    const versionIds = variantPaywalls
      .map((p) => p.publishedVersionId)
      .filter((v): v is string => v !== null);
    const versions = await drizzle.paywallVersionRepo.findByIds(drizzle.db, versionIds);
    const versionById = new Map(versions.map((v) => [v.id, v] as const));

    const hydrated = (
      await Promise.all(
        variantRefs.map(async (ref) => {
          const paywall = paywallById.get(ref.paywallId);
          if (!paywall || !paywall.isActive) return null;
          if (!paywall.publishedVersionId) return null;
          const version = versionById.get(paywall.publishedVersionId);
          if (!version) return null;
          return {
            variantId: ref.variantId,
            weight: ref.weight,
            paywall: await hydratePaywall(projectId, paywall, version, requestedLocale),
          };
        }),
      )
    ).filter((v): v is NonNullable<typeof v> => v !== null);
    if (hydrated.length === 0) continue; // legacy inline-config experiment → next row
    return {
      placement: placementInfo,
      paywall: null,
      experiment: { id: experiment.id, key: experiment.key, variants: hydrated },
    };
  }
  return { placement: placementInfo, paywall: null, experiment: null };
}
