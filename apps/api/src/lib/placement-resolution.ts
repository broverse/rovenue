import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { elementVariantValueSchema, placementRowsSchema } from "@rovenue/shared";
// matchesAudience depends on node:crypto and is deliberately excluded from
// the top-level @rovenue/shared barrel (which the dashboard's browser
// bundle also consumes) — server callers import it via the subpath below,
// mirroring services/experiment-engine.ts.
import { isInRollout, matchesAudience } from "@rovenue/shared/experiments";
import { applyTreeOp, TreeOpError, type BuilderConfig } from "@rovenue/shared/paywall";
import { hydrateOffering } from "./offering-hydration";
import { HOLDOUT_BUCKET_SEED } from "./experiment-constants";
import { eventBus } from "../services/event-bus";
import { logger } from "./logger";

const log = logger.child("placement-resolution");

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

// The subset of fields the shared hydration body needs, whichever table
// they come from (a `paywall_versions` row for the published path, or
// the `paywalls` row itself for the draft path below).
interface HydrationSource {
  offeringId: string;
  remoteConfig: unknown;
  configFormatVersion: number;
  // null is expected here (a draft paywall with no builder tree yet) and
  // is handled below by omitting the field; see hydrateDraftPaywall, which
  // returns null outright instead of hydrating a builderConfig-less draft.
  builderConfig: unknown;
}

/**
 * Shared hydration body for both the PUBLISHED path (`hydratePaywall`,
 * fed a `paywall_versions` row) and the draft-preview path
 * (`hydrateDraftPaywall` below, fed `paywalls` itself). Identifier and
 * name always come from the live `paywall` row (identifier is
 * immutable, name is cosmetic); everything the device actually renders
 * comes from `source`, including `offeringId`, so which config source
 * is passed in is the ENTIRE difference between "serve published" and
 * "serve draft" — callers must get that choice right.
 */
async function hydratePaywallBody(
  projectId: string,
  paywall: PaywallRow,
  source: HydrationSource,
  requestedLocale?: string,
) {
  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    projectId,
    source.offeringId,
  );
  const { locale, data } = resolveLocale(source.remoteConfig, requestedLocale);
  return {
    id: paywall.id,
    identifier: paywall.identifier,
    name: paywall.name,
    configFormatVersion: source.configFormatVersion,
    remoteConfig: locale ? { locale, data } : null,
    // builderConfig ships whole (all localizations) — ?locale only slices
    // remoteConfig above. Field is present ONLY when non-null: the Rust
    // SDK wire fixtures decode this payload, and adding a field is safe
    // (serde ignores unknown fields) but an always-present `null` isn't
    // worth the wire-size cost for paywalls that don't use the builder.
    ...(source.builderConfig !== null && { builderConfig: source.builderConfig }),
    offering: offering ? await hydrateOffering(projectId, offering) : null,
  };
}

export type HydratedPaywall = Awaited<ReturnType<typeof hydratePaywallBody>>;

/**
 * Hydrate the PUBLISHED snapshot, never `paywalls.builderConfig`.
 *
 * `paywalls.builderConfig` is the builder's private draft — serving it
 * here is exactly the P0 defect this split fixed. The ONE sanctioned
 * exception is `hydrateDraftPaywall` below (P9 on-device preview): it
 * is reachable only through a minted, token-gated, revocable preview
 * session (`previewSessionRepo` / `paywall_preview_sessions`), never
 * through `/v1/placements` or the fallback-file export, both of which
 * continue to call this function exclusively.
 */
async function hydratePaywall(
  projectId: string,
  paywall: PaywallRow,
  version: PaywallVersionRow,
  requestedLocale?: string,
): Promise<HydratedPaywall> {
  return hydratePaywallBody(projectId, paywall, version, requestedLocale);
}

/**
 * P9 on-device preview: hydrate `paywalls.builderConfig` (the DRAFT)
 * instead of a published `paywall_versions` snapshot. Reachable only
 * from the token-gated preview endpoint (Task 3) — never from
 * `/v1/placements` or the fallback-file export. Returns null when the
 * paywall has no draft builder config to preview.
 */
export async function hydrateDraftPaywall(
  projectId: string,
  paywall: PaywallRow,
  requestedLocale: string | null,
): Promise<HydratedPaywall | null> {
  if (paywall.builderConfig === null) return null;
  return hydratePaywallBody(projectId, paywall, paywall, requestedLocale ?? undefined);
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

interface MaterializedVariant {
  variantId: string;
  weight: number;
  paywall: HydratedPaywall;
}

/**
 * The outcome of materialising one experiment's variants. THREE cases, not
 * two, and the difference between the last two is a monetisation hole.
 *
 * `complete`  every declared variant hydrated — run the experiment.
 * `partial`   some hydrated, not all. The EXPERIMENT is unusable, but a
 *             paywall is not: serve `fallback` as a plain paywall and do
 *             not run the experiment (no variant menu, no exposure).
 * `none`      nothing hydrated — there is no paywall to serve, so the
 *             caller walks to the next placement row.
 *
 * Why `partial` may not simply become `none`: the caller's fall-through is
 * `continue`, which walks to the NEXT placement row, and an experiment row
 * is very often the LAST row (it is typically the all-users row, which
 * `placementRowsSchema` requires to be last). So `continue` on a partially
 * broken experiment exits the placement with NO PAYWALL AT ALL — the device
 * shows nothing, the operator sees a RUNNING experiment, and nobody learns.
 * This is the same argument the holdout path already accepts: a subscriber
 * excluded from an experiment gets CONTROL, not nothing.
 */
type VariantMaterialisation =
  | { kind: "complete"; variants: MaterializedVariant[] }
  | { kind: "partial"; fallback: HydratedPaywall; hydratedCount: number }
  | { kind: "none" };

/**
 * Classifies a per-variant hydration attempt. `hydrated` is index-aligned
 * with the experiment's DECLARED variants, so `fallback` is the first
 * declared variant that survived — control whenever control survived, and
 * the best available paywall when it did not. Same first-declared
 * convention `resolveControl` (services/experiment-results.ts) uses.
 */
function classifyMaterialisation(
  hydrated: Array<MaterializedVariant | null>,
  declaredCount: number,
): VariantMaterialisation {
  const survivors = hydrated.filter((v): v is MaterializedVariant => v !== null);
  if (survivors.length === 0) return { kind: "none" };
  if (survivors.length === declaredCount) {
    return { kind: "complete", variants: survivors };
  }
  return {
    kind: "partial",
    fallback: survivors[0]!.paywall,
    hydratedCount: survivors.length,
  };
}

/**
 * ELEMENT experiments: every variant's `value` is
 * `{ paywallId, nodeId, props }` (packages/shared/src/experiments/types.ts
 * `elementVariantValueSchema`) and all variants of one experiment target
 * the SAME paywallId — save-time validation
 * (apps/api/src/services/experiment-create.ts `assertElementVariantsValid`)
 * enforces both that shape and that `nodeId`/`props` are legal against that
 * paywall's PUBLISHED builder-config tree. Here we hydrate that target
 * paywall exactly ONCE, then apply each variant's patch via
 * `applyTreeOp({ kind: "updateProps" })` — a PURE tree op — to build an
 * independent patched copy per variant. Patching immutably (never
 * mutating the shared hydrated snapshot) is load-bearing: a shared mutable
 * base would let variant B's patch stick to variant A's copy too.
 *
 * ALL-OR-NOTHING, not per-variant: if ANY variant fails to materialise (a
 * `nodeId` that has since vanished from the published paywall), the
 * experiment does not run. Shipping the survivors as a variant menu would
 * be worse than not running it: the placement variant draw is CLIENT-SIDE
 * (`selectVariant`, packages/shared/src/experiments/bucketing.ts), and it
 * falls through to the LAST variant for any bucket past the cumulative
 * weight total. Ship variant A alone after dropping variant B (weight 0.5
 * each) and every bucket — including B's 5000-9999 — lands on A: 100% of
 * traffic sees A, every exposure is logged as a normal split, and the
 * experiment looks like it's running instead of looking broken. SRM
 * eventually catches that, but only after the data is poisoned. A partial
 * variant set must never reach a client AS A VARIANT SET.
 *
 * It may still reach one as a PAYWALL — see `VariantMaterialisation`. The
 * structural failures below (bad shape, a disagreeing `paywallId`, a
 * dangling or unpublished target, no builder config to patch) return
 * `none` rather than `partial`, because in every one of them there is no
 * hydrated paywall to fall back to.
 */
/**
 * PAYWALL experiment variants: each variant's `value` is `{ paywallId }`
 * and the paywall must be active with a published version. Same
 * all-or-nothing rule and same three-way outcome as
 * `materializeElementVariants` above — one rule, both experiment types.
 *
 * A legacy inline-config experiment (no `paywallId` on any variant) yields
 * `none`, since no ref survives the flatMap. A variant that carries no
 * `paywallId` while its siblings do is itself a failed variant, so a mixed
 * set is `partial`, not `complete`.
 */
async function materializePaywallVariants(
  projectId: string,
  variants: Array<{ id: string; weight: number; value: unknown }>,
  requestedLocale: string | undefined,
): Promise<VariantMaterialisation> {
  // Batch the variant paywall lookups (SDK hot path — the per-variant
  // sequential fetches were an N+1 flagged in the whole-phase review),
  // then hydrate in parallel. Order follows the variants array.
  const variantRefs = variants.flatMap((v) => {
    const paywallId = (v.value as { paywallId?: string } | null)?.paywallId;
    return paywallId ? [{ variantId: v.id, weight: v.weight, paywallId }] : [];
  });
  if (variantRefs.length === 0) return { kind: "none" };

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

  const hydrated = await Promise.all(
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
  );
  // Counted against the DECLARED variant count, not against `variantRefs`:
  // a variant carrying no `paywallId` at all never became a ref, and is
  // just as missing as one whose paywall was archived.
  return classifyMaterialisation(hydrated, variants.length);
}

async function materializeElementVariants(
  projectId: string,
  variants: Array<{ id: string; weight: number; value: unknown }>,
  requestedLocale: string | undefined,
): Promise<VariantMaterialisation> {
  if (variants.length === 0) return { kind: "none" };

  const parsedResults = variants.map((v) => elementVariantValueSchema.safeParse(v.value));
  // A malformed value leaves no trustworthy target paywall to fall back
  // to — we cannot even be sure which paywall the experiment meant.
  if (parsedResults.some((r) => !r.success)) return { kind: "none" };
  const parsed = variants.map((v, i) => ({
    variantId: v.id,
    weight: v.weight,
    value: (parsedResults[i] as { success: true; data: z.infer<typeof elementVariantValueSchema> })
      .data,
  }));

  // Every variant of one ELEMENT experiment targets the same paywallId —
  // enforced at save time, but not trusted blindly here: a variant that
  // disagrees means the data is inconsistent, which is drop-the-whole-
  // experiment territory just like everything else in this function.
  const paywallId = parsed[0]!.value.paywallId;
  // Inconsistent data: which of the disagreeing paywalls would "control"
  // even be? Nothing to fall back to.
  if (parsed.some((p) => p.value.paywallId !== paywallId)) return { kind: "none" };

  const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
  if (!paywall || !paywall.isActive) return { kind: "none" }; // dangling ref → next row
  // No published version → nothing to serve, same as the "paywall" target branch.
  if (!paywall.publishedVersionId) return { kind: "none" };
  const version = await drizzle.paywallVersionRepo.findById(
    drizzle.db,
    paywall.publishedVersionId,
  );
  if (!version) return { kind: "none" };

  const base = await hydratePaywall(projectId, paywall, version, requestedLocale);
  const baseConfig = (base as { builderConfig?: unknown }).builderConfig;
  if (typeof baseConfig !== "object" || baseConfig === null) {
    return { kind: "none" }; // nothing to patch
  }

  // Index-aligned with `parsed` (and so with the declared variants): a
  // variant whose nodeId vanished since save-time validation becomes a
  // `null` hole rather than an early return, so `classifyMaterialisation`
  // can tell "some survived" from "none did".
  const hydrated: Array<MaterializedVariant | null> = parsed.map(
    ({ variantId, weight, value }) => {
      try {
        const patchedConfig = applyTreeOp(baseConfig as BuilderConfig, {
          kind: "updateProps",
          nodeId: value.nodeId,
          patch: value.props,
        });
        return { variantId, weight, paywall: { ...base, builderConfig: patchedConfig } };
      } catch (err) {
        if (err instanceof TreeOpError && err.code === "TARGET_NOT_FOUND") return null;
        throw err;
      }
    },
  );
  return classifyMaterialisation(hydrated, parsed.length);
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
 *
 * `subscriberId` (Task 8) is the resolved DB subscriber id, when the
 * caller has one — omitted entirely for anonymous resolution (no
 * `subscriberId` header/query param) and for the dashboard's fallback-
 * file export, which resolves every ACTIVE placement anonymously. A
 * held-out DECISION requires a real subscriber to hash, so without one
 * the row-walk behaves exactly as it always has: an experiment row
 * serves its full variant menu for the client to draw from.
 */
export async function resolvePlacement(
  projectId: string,
  placement: PlacementRow,
  attributes: Record<string, unknown>,
  requestedLocale?: string,
  subscriberId?: string | null,
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
    if (!experiment || experiment.status !== "RUNNING") continue;
    if (experiment.type !== "PAYWALL" && experiment.type !== "ELEMENT") continue;

    const variants = (experiment.variants as Array<{ id: string; weight: number; value: unknown }>) ?? [];

    const materialised =
      experiment.type === "ELEMENT"
        ? await materializeElementVariants(projectId, variants, requestedLocale)
        : await materializePaywallVariants(projectId, variants, requestedLocale);

    // Nothing hydrated — a legacy inline-config experiment, a dangling
    // target, or an unpublished one. No paywall exists to serve, so the
    // row genuinely has nothing to offer: walk on.
    if (materialised.kind === "none") continue;

    // Some hydrated, not all. The experiment cannot run (a partial variant
    // set corrupts the client-side draw — see `materializeElementVariants`),
    // but the surviving control paywall is perfectly serviceable. Falling
    // through instead would usually mean serving NOTHING, because an
    // experiment row is typically the last row in the placement. Serve
    // control as a plain paywall, run no experiment, record no exposure —
    // and say so in the log, since the operator's dashboard will still show
    // a RUNNING experiment that is not actually running.
    if (materialised.kind === "partial") {
      log.warn("experiment variants partially unavailable; serving control", {
        projectId,
        experimentId: experiment.id,
        placementId: placement.id,
        declaredVariants: variants.length,
        hydratedVariants: materialised.hydratedCount,
      });
      return {
        placement: placementInfo,
        paywall: materialised.fallback,
        experiment: null,
      };
    }

    const hydrated = materialised.variants;

    // Task 8 — project-level holdout. The variant draw is client-side
    // (selectVariant, packages/shared/src/experiments/bucketing.ts), so
    // the server must decide holdout HERE rather than shipping a menu and
    // asking the client to compute membership itself.
    //
    // A held-out subscriber gets the CONTROL treatment, not nothing.
    // `placementRowsSchema` allows at most one all-users row and requires
    // it to be last, so in the normal configuration — one all-users row
    // targeting a RUNNING experiment — falling through to the next row
    // means falling out of the placement entirely: the holdout cohort
    // would be shown no paywall at all. That is a monetisation hole, and
    // statistically it is worse: the cohort whose revenue is the baseline
    // for "what is experimentation worth?" would be measured on users who
    // were shown no offer, so the comparison would measure paywall vs no
    // paywall. Control is the FIRST DECLARED variant — the same convention
    // `resolveControl` (services/experiment-results.ts) uses, and
    // `hydrated` preserves the declared order.
    //
    // The exposure is still recorded, against the reserved
    // HOLDOUT_COHORT_ID, and the envelope carries no `experiment`: the
    // subscriber must not be drawn into an arm. Same reserved-seed
    // reasoning as evaluateExperiments: HOLDOUT_BUCKET_SEED is never an
    // experiment's own `key`.
    const holdoutPercentage = subscriberId
      ? await drizzle.projectRepo.findProjectHoldoutPercentage(drizzle.db, projectId)
      : 0;
    if (
      subscriberId &&
      holdoutPercentage > 0 &&
      isInRollout(subscriberId, HOLDOUT_BUCKET_SEED, holdoutPercentage / 100)
    ) {
      try {
        await drizzle.db.transaction((tx) =>
          eventBus.publishHoldoutExposure(tx, {
            experimentId: experiment.id,
            projectId,
            subscriberId,
            placementId: placement.id,
          }),
        );
      } catch (err) {
        log.warn("holdout exposure publish failed", {
          projectId,
          experimentId: experiment.id,
          subscriberId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        placement: placementInfo,
        paywall: hydrated[0]!.paywall,
        experiment: null,
      };
    }

    return {
      placement: placementInfo,
      paywall: null,
      experiment: { id: experiment.id, key: experiment.key, variants: hydrated },
    };
  }
  return { placement: placementInfo, paywall: null, experiment: null };
}
