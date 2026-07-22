import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Paywalls CRUD
// =============================================================
//
// A paywall is a named, versioned remote-config document rendered
// by the SDK against a specific offering (see /v1/placements). This
// mirrors offerings.ts: same auth (requireDashboardAuth +
// assertProjectAccess / assertProjectCapability("products:write")),
// validate()/ok() envelope, and purgeProjectCatalogCache on every
// mutation — paywalls are edge-cached under /v1/placements.

const PAYWALL_IDENTIFIER_RE = /^[a-z0-9-_]+$/;

// remoteConfig: { defaultLocale: string, locales: { [locale]: object } }
// — every locale value must be an object, and defaultLocale must be
// one of the locale keys.
const remoteConfigSchema = z
  .object({
    defaultLocale: z.string().min(1),
    locales: z.record(z.record(z.unknown())),
  })
  .superRefine((v, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(v.locales, v.defaultLocale)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultLocale must be a key of locales",
        path: ["defaultLocale"],
      });
    }
  });

const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160).regex(PAYWALL_IDENTIFIER_RE),
  name: z.string().trim().min(1).max(200),
  offeringId: z.string().min(1),
  remoteConfig: remoteConfigSchema,
  configFormatVersion: z.number().int().min(1).optional(),
  builderConfig: z.unknown().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = z
  .object({
    identifier: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(PAYWALL_IDENTIFIER_RE)
      .optional(),
    name: z.string().trim().min(1).max(200).optional(),
    offeringId: z.string().min(1).optional(),
    remoteConfig: remoteConfigSchema.optional(),
    configFormatVersion: z.number().int().min(1).optional(),
    builderConfig: z.unknown().optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });

async function assertOfferingExists(
  projectId: string,
  offeringId: string,
): Promise<void> {
  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    projectId,
    offeringId,
  );
  if (!offering) {
    throw new HTTPException(400, {
      message: `Unknown offeringId: ${offeringId}`,
    });
  }
}

export const paywallsDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.paywallRepo.listPaywalls(drizzle.db, projectId);
    return c.json(ok({ paywalls: rows }));
  })
  .post("/", validate("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    const existing = await drizzle.paywallRepo.findPaywallByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Paywall identifier already in use: ${body.identifier}`,
      });
    }
    await assertOfferingExists(projectId, body.offeringId);

    const row = await drizzle.paywallRepo.createPaywall(drizzle.db, {
      projectId,
      identifier: body.identifier,
      name: body.name,
      offeringId: body.offeringId,
      remoteConfig: body.remoteConfig,
      ...(body.configFormatVersion !== undefined && {
        configFormatVersion: body.configFormatVersion,
      }),
      ...(body.builderConfig !== undefined && {
        builderConfig: body.builderConfig,
      }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      metadata: body.metadata ?? {},
    });
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ paywall: row }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    return c.json(ok({ paywall: row }));
  })
  .patch("/:id", validate("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    const existingPaywall = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      id,
    );
    if (!existingPaywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    if (body.identifier && body.identifier !== existingPaywall.identifier) {
      throw new HTTPException(400, {
        message: "identifier is immutable once set",
      });
    }
    if (body.offeringId) {
      await assertOfferingExists(projectId, body.offeringId);
    }

    const row = await drizzle.paywallRepo.updatePaywall(drizzle.db, projectId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.offeringId !== undefined && { offeringId: body.offeringId }),
      ...(body.remoteConfig !== undefined && {
        remoteConfig: body.remoteConfig,
      }),
      ...(body.configFormatVersion !== undefined && {
        configFormatVersion: body.configFormatVersion,
      }),
      ...(body.builderConfig !== undefined && {
        builderConfig: body.builderConfig,
      }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    });
    if (!row) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ paywall: row }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const existing = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    try {
      await drizzle.paywallRepo.deletePaywall(drizzle.db, projectId, id);
    } catch (err) {
      // deletePaywall throws a plain Error when the paywall is still
      // referenced by a placement row or a PAYWALL experiment variant.
      throw new HTTPException(409, {
        message: JSON.stringify({
          code: "PAYWALL_IN_USE",
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ deleted: true }));
  });
