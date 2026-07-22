import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole, drizzle, type Offering } from "@rovenue/db";
import { builderConfigSchema, validateBuilderConfig } from "@rovenue/shared/paywall";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { packagesSchema } from "../../lib/offering-hydration";
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

// configFormatVersion is intentionally NOT a client-settable field here —
// it's server-derived from whether builderConfig is present (see
// prepareBuilderConfigPatch below). Any configFormatVersion sent by the
// client is silently stripped by zod's default object parsing.
const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160).regex(PAYWALL_IDENTIFIER_RE),
  name: z.string().trim().min(1).max(200),
  offeringId: z.string().min(1),
  remoteConfig: remoteConfigSchema,
  builderConfig: z.unknown().nullable().optional(),
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
    builderConfig: z.unknown().nullable().optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });

async function loadOffering(
  projectId: string,
  offeringId: string,
): Promise<Offering> {
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
  return offering;
}

/** Package slot identifiers from an offering's `packages` jsonb — see
 * apps/api/src/lib/offering-hydration.ts for how the hydration path
 * reads the same column. */
function extractOfferingPackageIds(offering: { packages: unknown }): string[] {
  const parsed = packagesSchema.safeParse(offering.packages);
  return parsed.success ? parsed.data.map((p) => p.identifier) : [];
}

/**
 * Validate + shape a client-supplied `builderConfig` into the pair of
 * columns actually persisted. `null` clears it (revert to format 1);
 * a non-null value must pass both the Zod node-tree schema and
 * validateBuilderConfig against the paywall's (possibly new) offering
 * — any issue whose code isn't in `WARNING_CODES` is a 400, mirroring
 * the PAYWALL_IN_USE JSON-in-message HTTPException convention used by
 * DELETE below.
 */
const MAX_BUILDER_DEPTH = 32;
const MAX_BUILDER_NODES = 500;

// BuilderIssue codes that don't block a builderConfig PATCH — the config
// still saves (200) and the dashboard renders these as warnings rather
// than errors. Kept as `Set<string>`, not `Set<BuilderIssue["code"]>`:
// INTRO_VARIABLE_UNGUARDED is spec'd (Phase D variable-guard warning) but
// not yet emitted by validateBuilderConfig — forward-tolerant so this gate
// doesn't need touching again the moment the validator adds it. Manually
// kept in sync with the dashboard VM's identical WARNING_CODES set
// (apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts)
// — there's no shared export for it.
const WARNING_CODES = new Set<string>([
  "LOCALE_KEY_GAP",
  "OVERRIDE_SELECTED_OUTSIDE_CELL",
  "INTRO_VARIABLE_UNGUARDED",
]);

/**
 * Iterative (explicit-stack) walk over a raw candidate builder-config,
 * counting node-ish objects and tracking depth via `children` arrays and
 * `fallback` objects. Runs on UNVALIDATED input, so it treats any object as
 * a potential node — an over-count is fine (limits are generous), the point
 * is that this function itself can never blow the call stack.
 */
function measureNodeTree(raw: unknown): { depth: number; nodes: number } {
  const root = (raw as { root?: unknown } | null)?.root;
  if (typeof root !== "object" || root === null) return { depth: 0, nodes: 0 };
  let nodes = 0;
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== "object" || value === null) continue;
    nodes += 1;
    if (depth > maxDepth) maxDepth = depth;
    if (nodes > MAX_BUILDER_NODES || depth > MAX_BUILDER_DEPTH) break;
    const node = value as { children?: unknown; fallback?: unknown };
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push({ value: child, depth: depth + 1 });
    }
    if (typeof node.fallback === "object" && node.fallback !== null) {
      stack.push({ value: node.fallback, depth: depth + 1 });
    }
  }
  return { depth: maxDepth, nodes };
}

function prepareBuilderConfigPatch(
  rawBuilderConfig: unknown,
  offeringPackageIds: string[],
): { builderConfig: unknown; configFormatVersion: number } {
  if (rawBuilderConfig === null) {
    return { builderConfig: null, configFormatVersion: 1 };
  }

  // Iterative pre-scan BEFORE the recursive Zod parse: builderConfigSchema
  // recurses per node, so a hostile deeply-nested tree (~1000 stacks, ~45KB
  // of JSON) overflows the call stack inside safeParse — a RangeError that
  // safeParse does NOT contain — turning a validation 400 into a 500. Bound
  // depth and node count first, iteratively.
  const bounds = measureNodeTree(rawBuilderConfig);
  if (bounds.depth > MAX_BUILDER_DEPTH || bounds.nodes > MAX_BUILDER_NODES) {
    throw new HTTPException(400, {
      message: JSON.stringify({
        code: "INVALID_BUILDER_CONFIG",
        issues: [
          {
            code: "SCHEMA_INVALID",
            message: `config exceeds limits (max depth ${MAX_BUILDER_DEPTH}, max nodes ${MAX_BUILDER_NODES})`,
          },
        ],
      }),
    });
  }

  // Belt-and-braces: even within bounds, map any parser throw (e.g. an
  // engine-level RangeError) to a 400 rather than letting it 500.
  let parsed: ReturnType<typeof builderConfigSchema.safeParse>;
  try {
    parsed = builderConfigSchema.safeParse(rawBuilderConfig);
  } catch {
    throw new HTTPException(400, {
      message: JSON.stringify({
        code: "INVALID_BUILDER_CONFIG",
        issues: [{ code: "SCHEMA_INVALID", message: "config is not parseable" }],
      }),
    });
  }
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: JSON.stringify({
        code: "INVALID_BUILDER_CONFIG",
        issues: parsed.error.issues.map((issue) => ({
          code: "SCHEMA_INVALID",
          message: `${issue.path.join(".")}: ${issue.message}`,
        })),
      }),
    });
  }

  const issues = validateBuilderConfig(parsed.data, { offeringPackageIds });
  if (issues.some((issue) => !WARNING_CODES.has(issue.code))) {
    throw new HTTPException(400, {
      message: JSON.stringify({ code: "INVALID_BUILDER_CONFIG", issues }),
    });
  }

  return { builderConfig: parsed.data, configFormatVersion: 2 };
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
    const offering = await loadOffering(projectId, body.offeringId);

    const builderPatch =
      body.builderConfig !== undefined
        ? prepareBuilderConfigPatch(
            body.builderConfig,
            extractOfferingPackageIds(offering),
          )
        : null;

    const row = await drizzle.paywallRepo.createPaywall(drizzle.db, {
      projectId,
      identifier: body.identifier,
      name: body.name,
      offeringId: body.offeringId,
      remoteConfig: body.remoteConfig,
      ...(builderPatch !== null && {
        builderConfig: builderPatch.builderConfig,
        configFormatVersion: builderPatch.configFormatVersion,
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

    // If offeringId is also changing in this request, builderConfig
    // validation runs against the NEW offering, not the paywall's
    // current one.
    let newOffering: Offering | null = null;
    if (body.offeringId) {
      newOffering = await loadOffering(projectId, body.offeringId);
    }

    let builderPatch: ReturnType<typeof prepareBuilderConfigPatch> | null = null;
    if (body.builderConfig !== undefined) {
      if (body.builderConfig === null) {
        builderPatch = prepareBuilderConfigPatch(null, []);
      } else {
        const offeringForValidation =
          newOffering ?? (await loadOffering(projectId, existingPaywall.offeringId));
        builderPatch = prepareBuilderConfigPatch(
          body.builderConfig,
          extractOfferingPackageIds(offeringForValidation),
        );
      }
    }

    const row = await drizzle.paywallRepo.updatePaywall(drizzle.db, projectId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.offeringId !== undefined && { offeringId: body.offeringId }),
      ...(body.remoteConfig !== undefined && {
        remoteConfig: body.remoteConfig,
      }),
      ...(builderPatch !== null && {
        builderConfig: builderPatch.builderConfig,
        configFormatVersion: builderPatch.configFormatVersion,
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
