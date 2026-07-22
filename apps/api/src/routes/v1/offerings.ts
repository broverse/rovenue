import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { flattenAttributes } from "@rovenue/shared";
import { evaluateExperiments } from "../../services/experiment-engine";
import { ok } from "../../lib/response";
import {
  packagesSchema,
  parseStoreIds,
  type OfferingProductEntry,
  type PackageSlot,
  hydrateProducts,
} from "../../lib/offering-hydration";

// =============================================================
// /v1/offerings
// =============================================================
//
// Catalog surface for the SDK's paywall rendering path. The SDK's
// getOfferings() hits GET / to list every offering plus the
// "current" one; GET /:identifier hydrates a single paywall.
//
// BOTH paths run the experiment engine so OFFERING experiments
// apply on the SDK's primary getOfferings() flow, not only on
// direct per-identifier fetches. On the list path the variant's
// target offering is marked `isDefault` (the SDK derives `current`
// from that flag); on the per-identifier path it substitutes the
// requested identifier. Either way the substitution is annotated
// via `X-Rovenue-Experiment: <key>:<variantId>` so the SDK can log
// the exposure back. The flag flip is response-only — never a DB write.

const SUBSCRIBER_HEADER = "x-rovenue-user-id";
const EXPERIMENT_HEADER = "x-rovenue-experiment";

interface OfferingExperimentOverride {
  targetIdentifier: string;
  key: string;
  variantId: string;
}

/**
 * Resolve a per-subscriber OFFERING experiment override. Shared by the list
 * and per-identifier handlers so both apply the same A/B substitution.
 * Returns null when no subscriber is identified (header/query absent), the
 * subscriber can't be resolved, or no RUNNING OFFERING experiment applies.
 */
async function resolveOfferingExperimentOverride(
  c: Context,
  projectId: string,
): Promise<OfferingExperimentOverride | null> {
  const subscriberAppUserId =
    c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER);
  if (!subscriberAppUserId) return null;

  const subscriber =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(
      drizzle.db,
      { projectId, key: subscriberAppUserId },
    );
  if (!subscriber) return null;

  const attributes = flattenAttributes(subscriber.attributes);
  const experiments = await evaluateExperiments(
    projectId,
    subscriber.id,
    attributes,
  );
  const override = Object.values(experiments).find(
    (r) => r.type === "OFFERING" && typeof r.value === "string",
  );
  if (!override) return null;
  return {
    targetIdentifier: override.value as string,
    key: override.key,
    variantId: override.variantId,
  };
}

export const offeringsRoute = new Hono()
  // =============================================================
  // GET /v1/offerings
  // =============================================================
  .get("/", async (c) => {
    const project = c.get("project");

    const offerings = await drizzle.offeringRepo.listOfferings(drizzle.db, project.id);

    // Parse packages for all offerings up-front so we can batch-fetch products
    const parsedByOffering = offerings.map((o) => ({
      offering: o,
      packageSlots: packagesSchema.safeParse(o.packages),
    }));

    // Collect unique product ids across all offerings for a single DB round-trip
    const allIds = Array.from(
      new Set(
        parsedByOffering.flatMap((p) =>
          p.packageSlots.success ? p.packageSlots.data.map((m) => m.productId) : [],
        ),
      ),
    );

    const products = await drizzle.offeringRepo.findProductsByIds(
      drizzle.db,
      project.id,
      allIds,
    );
    const productById = new Map(products.map((p) => [p.id, p] as const));

    const responseOfferings = parsedByOffering.map(({ offering, packageSlots }) => ({
      identifier: offering.identifier,
      isDefault: offering.isDefault,
      packages: packageSlots.success
        ? hydrateProducts(packageSlots.data, productById as any)
        : [],
      metadata: offering.metadata,
    }));

    // A per-subscriber OFFERING experiment overrides which offering is
    // "current". The SDK derives `current` from is_default, so flip the flag
    // (response-only) onto the variant's target and annotate the exposure
    // header. Only applied when the target is actually present in the list;
    // otherwise the natural default stands.
    const override = await resolveOfferingExperimentOverride(c, project.id);
    if (
      override &&
      responseOfferings.some((o) => o.identifier === override.targetIdentifier)
    ) {
      for (const o of responseOfferings) {
        o.isDefault = o.identifier === override.targetIdentifier;
      }
      c.header(EXPERIMENT_HEADER, `${override.key}:${override.variantId}`);
    }

    return c.json(ok({ offerings: responseOfferings }));
  })
  // =============================================================
  // GET /v1/offerings/:identifier
  // =============================================================
  .get("/:identifier", async (c) => {
    const project = c.get("project");
    const identifier = c.req.param("identifier");

    // If the caller identifies a subscriber, an OFFERING experiment can
    // override the requested identifier with the variant's target offering.
    const appliedExperiment = await resolveOfferingExperimentOverride(
      c,
      project.id,
    );
    const effectiveIdentifier =
      appliedExperiment?.targetIdentifier ?? identifier;

    const offering =
      effectiveIdentifier === "default"
        ? await drizzle.offeringRepo.findDefaultOffering(drizzle.db, project.id)
        : await drizzle.offeringRepo.findOfferingByIdentifier(
            drizzle.db,
            project.id,
            effectiveIdentifier,
          );

    if (!offering) {
      throw new HTTPException(404, {
        message: `Offering ${effectiveIdentifier} not found`,
      });
    }

    if (appliedExperiment) {
      c.header(
        EXPERIMENT_HEADER,
        `${appliedExperiment.key}:${appliedExperiment.variantId}`,
      );
    }

    const packageSlots = packagesSchema.safeParse(offering.packages);
    if (!packageSlots.success) {
      return c.json(
        ok({
          identifier: offering.identifier,
          isDefault: offering.isDefault,
          packages: [] as OfferingProductEntry[],
          metadata: offering.metadata,
        }),
      );
    }

    const productIds = packageSlots.data.map((m) => m.productId);
    const products = await drizzle.offeringRepo.findProductsByIds(
      drizzle.db,
      project.id,
      productIds,
    );
    const productById = new Map(products.map((p) => [p.id, p] as const));
    const payload: OfferingProductEntry[] = hydrateProducts(packageSlots.data, productById as any);

    return c.json(
      ok({
        identifier: offering.identifier,
        isDefault: offering.isDefault,
        packages: payload,
        metadata: offering.metadata,
      }),
    );
  });
