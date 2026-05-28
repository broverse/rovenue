import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { evaluateExperiments } from "../../services/experiment-engine";
import { ok } from "../../lib/response";

// =============================================================
// /v1/offerings
// =============================================================
//
// Catalog surface for the SDK's paywall rendering path. Callers
// hit GET / to list every offering the project exposes (optionally
// filtered by `accessId`), then GET /:identifier to hydrate the
// full product list for the paywall they're about to render. The
// per-identifier path also runs the experiment engine so OFFERING
// experiments can override the requested identifier — the
// substitution is annotated on the response via
// `X-Rovenue-Experiment: <key>:<variantId>` so the SDK can log
// the exposure back.

const SUBSCRIBER_HEADER = "x-rovenue-user-id";
const EXPERIMENT_HEADER = "x-rovenue-experiment";

// Shape of each item in Offering.products JSON array
const productMembershipSchema = z.object({
  productId: z.string(),
  order: z.number().int().nonnegative().default(0),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
const productMembershipsSchema = z.array(productMembershipSchema);

interface OfferingProductEntry {
  identifier: string;
  type: string;
  displayName: string;
  order: number;
  isPromoted: boolean;
  creditAmount: number | null;
  accessIds: string[];
  metadata: unknown;
}

export const offeringsRoute = new Hono()
  // =============================================================
  // GET /v1/offerings[?accessId=...]
  // =============================================================
  .get("/", async (c) => {
    const project = c.get("project");
    const accessId = c.req.query("accessId");

    const offerings = accessId
      ? await drizzle.offeringRepo.listOfferingsByAccess(
          drizzle.db,
          project.id,
          accessId,
        )
      : await drizzle.offeringRepo.listOfferings(drizzle.db, project.id);

    return c.json(
      ok({
        offerings: offerings.map((offering) => {
          const products = productMembershipsSchema.safeParse(offering.products);
          return {
            identifier: offering.identifier,
            accessId: offering.accessId,
            isDefault: offering.isDefault,
            productCount: products.success ? products.data.length : 0,
          };
        }),
      }),
    );
  })
  // =============================================================
  // GET /v1/offerings/:identifier
  // =============================================================
  .get("/:identifier", async (c) => {
    const project = c.get("project");
    const identifier = c.req.param("identifier");

    // If the caller identifies a subscriber, run active experiments
    // first — an OFFERING experiment can override the requested
    // identifier with the variant's target offering. We annotate the
    // response with X-Rovenue-Experiment: key:variantId so the SDK
    // can log the exposure back.
    const subscriberAppUserId =
      c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER);

    let effectiveIdentifier = identifier;
    let appliedExperiment: { key: string; variantId: string } | null = null;

    if (subscriberAppUserId) {
      const subscriber = await drizzle.subscriberRepo.findSubscriberByAppUserId(
        drizzle.db,
        { projectId: project.id, appUserId: subscriberAppUserId },
      );
      if (subscriber) {
        const attributes =
          (subscriber.attributes as Record<string, unknown> | null) ?? {};
        const experiments = await evaluateExperiments(
          project.id,
          subscriber.id,
          attributes,
        );
        const override = Object.values(experiments).find(
          (r) => r.type === "OFFERING" && typeof r.value === "string",
        );
        if (override) {
          effectiveIdentifier = override.value as string;
          appliedExperiment = {
            key: override.key,
            variantId: override.variantId,
          };
        }
      }
    }

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

    const memberships = productMembershipsSchema.safeParse(offering.products);
    if (!memberships.success) {
      return c.json(
        ok({
          identifier: offering.identifier,
          accessId: offering.accessId,
          isDefault: offering.isDefault,
          products: [] as OfferingProductEntry[],
          metadata: offering.metadata,
        }),
      );
    }

    const productIds = memberships.data.map((m) => m.productId);
    const products = await drizzle.offeringRepo.findProductsByIds(
      drizzle.db,
      project.id,
      productIds,
    );
    const productById = new Map(products.map((p) => [p.id, p] as const));

    const sorted = [...memberships.data].sort((a, b) => a.order - b.order);
    const payload: OfferingProductEntry[] = sorted
      .map((entry): OfferingProductEntry | null => {
        const product = productById.get(entry.productId);
        if (!product || !product.isActive) return null;
        return {
          identifier: product.identifier,
          type: product.type,
          displayName: product.displayName,
          order: entry.order,
          isPromoted: entry.isPromoted,
          creditAmount: product.creditAmount,
          accessIds: product.accessIds,
          metadata: entry.metadata ?? {},
        };
      })
      .filter((p): p is OfferingProductEntry => p !== null);

    return c.json(
      ok({
        identifier: offering.identifier,
        accessId: offering.accessId,
        isDefault: offering.isDefault,
        products: payload,
        metadata: offering.metadata,
      }),
    );
  });
