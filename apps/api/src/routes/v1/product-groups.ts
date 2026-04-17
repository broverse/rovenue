import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { type Prisma } from "@rovenue/db";
import { evaluateExperiments } from "../../services/experiment-engine";
import { ok } from "../../lib/response";

const SUBSCRIBER_HEADER = "x-rovenue-user-id";
const EXPERIMENT_HEADER = "x-rovenue-experiment";

export const productGroupsRoute = new Hono();

// Shape of each item in ProductGroup.products JSON array
const productMembershipSchema = z.object({
  productId: z.string(),
  order: z.number().int().nonnegative().default(0),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
const productMembershipsSchema = z.array(productMembershipSchema);

interface GroupProductEntry {
  identifier: string;
  type: string;
  displayName: string;
  order: number;
  isPromoted: boolean;
  creditAmount: number | null;
  entitlementKeys: string[];
  metadata: Prisma.JsonValue;
}

// =============================================================
// GET /v1/product-groups
// =============================================================

productGroupsRoute.get("/", async (c) => {
  const project = c.get("project");

  const groups = await prisma.productGroup.findMany({
    where: { projectId: project.id },
    orderBy: [{ isDefault: "desc" }, { identifier: "asc" }],
  });

  return c.json(
    ok({
      groups: groups.map((group) => {
        const products = productMembershipsSchema.safeParse(group.products);
        return {
          identifier: group.identifier,
          isDefault: group.isDefault,
          productCount: products.success ? products.data.length : 0,
        };
      }),
    }),
  );
});

// =============================================================
// GET /v1/product-groups/:identifier
// =============================================================

productGroupsRoute.get("/:identifier", async (c) => {
  const project = c.get("project");
  const identifier = c.req.param("identifier");

  // If the caller identifies a subscriber, run active experiments
  // first — a PRODUCT_GROUP experiment can override the requested
  // identifier with the variant's target group. We annotate the
  // response with X-Rovenue-Experiment: key:variantId so the SDK
  // can log the exposure back.
  const subscriberAppUserId =
    c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER);

  let effectiveIdentifier = identifier;
  let appliedExperiment: { key: string; variantId: string } | null = null;

  if (subscriberAppUserId) {
    const subscriber = await prisma.subscriber.findUnique({
      where: {
        projectId_appUserId: {
          projectId: project.id,
          appUserId: subscriberAppUserId,
        },
      },
      select: { id: true, attributes: true },
    });
    if (subscriber) {
      const attributes =
        (subscriber.attributes as Record<string, unknown> | null) ?? {};
      const experiments = await evaluateExperiments(
        project.id,
        subscriber.id,
        attributes,
      );
      const override = Object.values(experiments).find(
        (r) => r.type === "PRODUCT_GROUP" && typeof r.value === "string",
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

  const group =
    effectiveIdentifier === "default"
      ? await prisma.productGroup.findFirst({
          where: { projectId: project.id, isDefault: true },
        })
      : await prisma.productGroup.findUnique({
          where: {
            projectId_identifier: {
              projectId: project.id,
              identifier: effectiveIdentifier,
            },
          },
        });

  if (!group) {
    throw new HTTPException(404, {
      message: `Product group ${effectiveIdentifier} not found`,
    });
  }

  if (appliedExperiment) {
    c.header(
      EXPERIMENT_HEADER,
      `${appliedExperiment.key}:${appliedExperiment.variantId}`,
    );
  }

  const memberships = productMembershipsSchema.safeParse(group.products);
  if (!memberships.success) {
    return c.json(
      ok({
        identifier: group.identifier,
        isDefault: group.isDefault,
        products: [] as GroupProductEntry[],
        metadata: group.metadata,
      }),
    );
  }

  const productIds = memberships.data.map((m) => m.productId);
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { projectId: project.id, id: { in: productIds } },
      })
    : [];
  const productById = new Map(products.map((p) => [p.id, p] as const));

  const sorted = [...memberships.data].sort((a, b) => a.order - b.order);
  const payload: GroupProductEntry[] = sorted
    .map((entry): GroupProductEntry | null => {
      const product = productById.get(entry.productId);
      if (!product || !product.isActive) return null;
      return {
        identifier: product.identifier,
        type: product.type,
        displayName: product.displayName,
        order: entry.order,
        isPromoted: entry.isPromoted,
        creditAmount: product.creditAmount,
        entitlementKeys: product.entitlementKeys,
        metadata: (entry.metadata ?? {}) as Prisma.JsonValue,
      };
    })
    .filter((p): p is GroupProductEntry => p !== null);

  return c.json(
    ok({
      identifier: group.identifier,
      isDefault: group.isDefault,
      products: payload,
      metadata: group.metadata,
    }),
  );
});
