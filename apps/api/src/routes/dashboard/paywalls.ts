import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  ExperimentType,
  MemberRole,
  drizzle,
  type Db,
  type Offering,
  type Paywall,
} from "@rovenue/db";
import {
  MAX_BUILDER_DEPTH,
  MAX_BUILDER_NODES,
  builderConfigSchema,
  collectMediaUrls,
  diffBuilderConfigs,
  isBlockingIssue,
  isPublishBlockingIssue,
  measureNodeTree,
  validateBuilderConfig,
} from "@rovenue/shared/paywall";
import { ERROR_CODE, placementRowsSchema, type PlacementRow } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { roviQuotaGuard } from "../../middleware/rovi-quota-guard";
import {
  AppStoreLookupError,
  buildImportTree,
  fetchAppStoreListing,
  parseAppStoreUrl,
} from "../../services/paywall-ai/app-store-import";
import {
  GenerationInvalidError,
  generatePaywallConfig,
} from "../../services/paywall-ai/generate";
import {
  TranslationInvalidError,
  translateEntries,
  TRANSLATE_MAX_ENTRIES,
} from "../../services/paywall-ai/translate";
import { RoviConfigError } from "../../services/copilot/providers";
import { generateClaimToken, hashToken } from "../../services/funnel/token";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { packagesSchema } from "../../lib/offering-hydration";
import { resolvePlacement, type ResolvedPlacementData } from "../../lib/placement-resolution";
import { fail, ok } from "../../lib/response";
import {
  createExperimentValidated,
  findOrCreateEveryoneAudience,
} from "../../services/experiment-create";
import { invalidateExperimentCache } from "../../services/experiment-engine";
import { parseAssetUrl } from "../../lib/asset-store";

// =============================================================
// Dashboard: Paywalls CRUD
// =============================================================
//
// A paywall is a named, versioned remote-config document rendered
// by the SDK against a specific offering (see /v1/placements). This
// mirrors offerings.ts: same auth (requireDashboardAuth +
// assertProjectAccess / assertProjectCapability("paywalls:write")),
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
    // Required whenever builderConfig is present: an un-migrated client
    // must fail closed rather than silently clobber a concurrent edit.
    draftRevision: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  })
  .refine(
    (b) => b.builderConfig === undefined || b.draftRevision !== undefined,
    { message: "draftRevision is required when builderConfig is present" },
  );

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
 * columns actually persisted. `null` clears it (revert to format 1); a
 * non-null value must pass both the Zod node-tree schema and
 * `validateBuilderConfig` against the paywall's (possibly new) offering.
 *
 * `validateBuilderConfig` issues come in three severity tiers (see
 * `IssueSeverity` in the shared validator) — `save`, `publish`, and
 * `warning`. This is the SAVE gate: only `save`-tier issues (`isBlockingIssue`)
 * become a 400 here, in the PAYWALL_IN_USE JSON-in-message HTTPException style
 * used by DELETE below. `publish`-tier issues — e.g. `EMPTY_LOC_VALUE`, a
 * legitimate work-in-progress like copy nobody has written yet — persist fine
 * and are instead caught by the publish route. `warning`-tier issues block
 * neither gate.
 */
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
  if (issues.some(isBlockingIssue)) {
    throw new HTTPException(400, {
      message: JSON.stringify({ code: "INVALID_BUILDER_CONFIG", issues }),
    });
  }

  return { builderConfig: parsed.data, configFormatVersion: 2 };
}

const versionLabelBodySchema = z.object({
  label: z.string().trim().min(1).max(120).nullable(),
});

// -------------------------------------------------------------
// P9 on-device preview — mint token lifetime (§6.16).
// -------------------------------------------------------------

/** How long a minted preview token stays redeemable before it must be
 * re-minted. Kept short — a preview session grants draft (unpublished)
 * access outside the dashboard. */
const PREVIEW_SESSION_TTL_MINUTES = 60;

/** Unit conversion for the TTL above — kept as a named constant rather
 * than an inline `60_000` per the project's no-magic-values convention. */
const MS_PER_MINUTE = 60_000;

/**
 * Origin to build the preview URL against. `new URL(c.req.url).origin`
 * alone reflects the scheme the API process itself was reached on — behind
 * a TLS-terminating proxy (Caddy in front of the API container) that's
 * always plain `http://`, so a naive origin would hand a physical device an
 * `http://` preview URL despite the public edge being `https://`. Trust the
 * proxy's `X-Forwarded-Proto` for the scheme when present (Caddy always
 * sets it), keep the request's own host (proxies forward `Host` verbatim),
 * and fall back to the request URL's origin untouched when there's no
 * forwarded-proto header at all (bare `docker compose up`, local dev, unit
 * tests hitting the Hono app directly).
 */
function requestOrigin(c: { req: { url: string; header(name: string): string | undefined } }): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  return url.origin;
}

// -------------------------------------------------------------
// AI start tab — one-shot paywall generation (P8 AI-FAB, Task 4).
// -------------------------------------------------------------

const generateBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

/**
 * The strings arrive in the REQUEST, not read from the paywall row. The
 * builder autosaves on its own schedule, so the stored `builderConfig` is
 * stale by design — see the route below.
 */
const translateBodySchema = z
  .object({
    sourceLocale: z.string().trim().min(2).max(35),
    targetLocale: z.string().trim().min(2).max(35),
    entries: z
      .record(z.string().min(1), z.string())
      .refine(
        (e) => Object.keys(e).length > 0 && Object.keys(e).length <= TRANSLATE_MAX_ENTRIES,
        { message: `entries must hold 1..${TRANSLATE_MAX_ENTRIES} keys` },
      ),
  })
  .refine((b) => b.sourceLocale !== b.targetLocale, {
    message: "sourceLocale and targetLocale must differ",
  });

const DEFAULT_GENERATION_LOCALE = "en";

/** The paywall's own draft locale when set, else DEFAULT_GENERATION_LOCALE —
 *  `remoteConfig` is a loose jsonb column at the DB layer, so this reads it
 *  defensively rather than trusting the shape. */
function paywallDefaultLocale(remoteConfig: unknown): string {
  if (remoteConfig && typeof remoteConfig === "object" && "defaultLocale" in remoteConfig) {
    const locale = (remoteConfig as { defaultLocale?: unknown }).defaultLocale;
    if (typeof locale === "string" && locale.length > 0) return locale;
  }
  return DEFAULT_GENERATION_LOCALE;
}

// -------------------------------------------------------------
// §6.19 — atomic builder A/B launch
// -------------------------------------------------------------

/** Variant weights split evenly across the two-variant A/B this endpoint
 * always creates. */
const DEFAULT_VARIANT_SPLIT = 0.5;

/** Ceiling on the `-2`…`-N` de-dup suffix loop below — matches funnels'
 * bounded-retry convention for auto-generated identifiers (see
 * randomSuffix() usage in funnels.ts) rather than looping unbounded. */
const IDENTIFIER_SUFFIX_MAX = 20;

/** Headroom under `identifier`'s 160-char column limit (see
 * PAYWALL_IDENTIFIER_RE/createBodySchema above) so a `-NN` suffix never
 * pushes the candidate over the limit. */
const IDENTIFIER_SLUG_MAX_LEN = 150;

const launchBodySchema = z.object({
  name: z.string().trim().min(1),
  variantB: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), paywallId: z.string().min(1) }),
    z.object({ kind: z.literal("duplicate"), name: z.string().trim().min(1) }),
  ]),
  audienceId: z.string().min(1).optional(),
  placement: z
    .object({ placementId: z.string().min(1), rowIndex: z.number().int().min(0) })
    .optional(),
});

/** kebab-case a variant-B name into a PAYWALL_IDENTIFIER_RE-legal slug.
 * Mirrors funnels.ts's `kebabCase` helper (same normalize+strip-diacritics
 * approach) since paywalls have no shared slugify utility of their own. */
function slugifyPaywallName(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, IDENTIFIER_SLUG_MAX_LEN) || "paywall"
  );
}

// DB or Drizzle tx handle — this endpoint's whole handler body runs
// inside one drizzle.db.transaction(...), same convention as
// services/experiment-create.ts's DbOrTx.
type DbOrTx = Db;

/**
 * Find a free paywall identifier for a duplicated variant B: the bare
 * slugified name, then `-2`, `-3`, … up to IDENTIFIER_SUFFIX_MAX. Runs
 * inside the caller's tx so the precheck is consistent with the insert
 * that follows it.
 */
async function findFreePaywallIdentifier(
  tx: DbOrTx,
  projectId: string,
  name: string,
): Promise<string> {
  const base = slugifyPaywallName(name);
  const candidates = [base, ...Array.from({ length: IDENTIFIER_SUFFIX_MAX - 1 }, (_, i) => `${base}-${i + 2}`)];
  for (const candidate of candidates) {
    const hit = await drizzle.paywallRepo.findPaywallByIdentifier(tx, projectId, candidate);
    if (!hit) return candidate;
  }
  throw new HTTPException(409, {
    message: `Could not find a free paywall identifier for "${name}"`,
  });
}

/** Parse a `:versionNo` path segment, 400ing on anything that is not a
 * canonical positive integer (rejects "", "0", negatives, "1.5", "1e2",
 * "0x10", and whitespace-padded values — a bare Number() would admit the
 * last three). */
function parseVersionNo(raw: string | undefined): number {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new HTTPException(400, { message: "versionNo must be a positive integer" });
  }
  return Number(raw);
}

/** Metadata-only projection of a version row, shared by list and detail. */
function toVersionRow(
  v: {
    id: string;
    versionNo: number;
    label: string | null;
    offeringId: string;
    configFormatVersion: number;
    publishedAt: Date;
    publishedBy: string | null;
  },
  livePublishedVersionId: string | null,
) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    label: v.label,
    offeringId: v.offeringId,
    configFormatVersion: v.configFormatVersion,
    publishedAt: v.publishedAt.toISOString(),
    publishedBy: v.publishedBy,
    isLive: v.id === livePublishedVersionId,
  };
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
  // ===========================================================
  // App Store listing import (P8 §6.14). Builds and RETURNS a
  // draft tree — creates nothing, writes nothing: the dashboard
  // applies the config client-side through the builder VM (the
  // autosave race rules out server-side builderConfig writes,
  // spec §2). Read-gated like the list endpoint above: the
  // caller only receives derived data.
  // ===========================================================
  .post(
    "/from-app-store",
    validate("json", z.object({ url: z.string().min(1) })),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const { url } = c.req.valid("json");
      const parsedUrl = parseAppStoreUrl(url);
      if (!parsedUrl) {
        throw new HTTPException(400, { message: "Not an App Store listing URL" });
      }

      let listing;
      try {
        listing = await fetchAppStoreListing(parsedUrl);
      } catch (err) {
        if (err instanceof AppStoreLookupError) {
          // Typed envelope code, not a generic HTTPException: the
          // errorHandler maps unknown statuses to HTTP_ERROR, which
          // would bury the code in `message` (STORE_API_ERROR
          // precedent — see subscriptions.ts's fail() usage).
          return c.json(
            fail(
              err.code,
              err.code === "APP_NOT_FOUND"
                ? "No app found for that App Store link"
                : "App Store lookup failed — try again",
            ),
            422,
          );
        }
        throw err;
      }

      // Paywall drafts default their locale to "en" until the author picks
      // one (remoteConfig.defaultLocale) — the import seeds the same way.
      const config = buildImportTree(listing, "en");
      return c.json(
        ok({ config, metadata: { name: listing.name, iconUrl: listing.iconUrl } }),
      );
    },
  )
  // ===========================================================
  // Bundled fallback file export (spec D1) — every ACTIVE placement,
  // resolved anonymously (attributes = {}, no locale — the honest
  // offline approximation a first-launch SDK with no network/cache
  // would fall back to). Read-level access, mirroring the GET list
  // route above. NOTE: registered before `/:id` so the literal
  // "fallback-export" segment can never be swallowed by that param
  // route.
  // ===========================================================
  .get("/fallback-export", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const allPlacements = await drizzle.placementRepo.listPlacements(drizzle.db, projectId);

    // Resolve every active placement concurrently — each resolution is an
    // independent read fan-out (audiences, paywalls, offerings), so a
    // project with many placements shouldn't pay for them serially.
    const active = allPlacements.filter((p) => p.isActive);
    const resolved = await Promise.all(
      active.map((placement) => resolvePlacement(projectId, placement, {})),
    );
    const placementsMap: Record<string, ResolvedPlacementData> = {};
    active.forEach((placement, i) => {
      placementsMap[placement.identifier] = resolved[i]!;
    });

    const exportBody = {
      formatVersion: 1,
      generatedAt: Date.now(),
      projectId,
      placements: placementsMap,
    };

    c.header(
      "Content-Disposition",
      'attachment; filename="rovenue-fallback.json"',
    );
    return c.json(exportBody);
  })
  .post("/", validate("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");
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
  // ===========================================================
  // AI start tab — one-shot paywall generation (P8 AI-FAB, Task 4).
  // Read-gated like GET /:id above: generation writes nothing — the
  // dashboard applies the returned config client-side through the
  // builder VM, same as /from-app-store. `roviQuotaGuard()` is
  // composed per-route (not `.use("*", ...)` like copilot/chat.ts —
  // every other paywalls route is unrelated to Rovi usage).
  // ===========================================================
  .post(
    "/:id/paywall-generate",
    roviQuotaGuard(),
    validate("json", generateBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
      if (!paywall) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }

      const { prompt } = c.req.valid("json");

      try {
        const config = await generatePaywallConfig({
          projectId,
          prompt,
          defaultLocale: paywallDefaultLocale(paywall.remoteConfig),
        });
        return c.json(ok({ config }));
      } catch (err) {
        if (err instanceof RoviConfigError) {
          // Same envelope shape the copilot chat route uses for this code
          // (see copilot/chat.ts) — a typed code, not a generic HTTPException.
          return c.json(fail("ROVI_NOT_CONFIGURED", err.message), 412);
        }
        if (err instanceof GenerationInvalidError) {
          return c.json(fail("GENERATION_INVALID", err.message), 422);
        }
        throw err;
      }
    },
  )
  // ===========================================================
  // Auto-translate (ROADMAP §3). Read-gated and WRITE-FREE, exactly like
  // /paywall-generate and /from-app-store above: the translations go back
  // in the response and the dashboard merges them client-side through the
  // builder VM's `setLocalizations` op. A server-side builderConfig write
  // here would be clobbered by the builder's next autosave tick, which
  // still holds the pre-translation client state.
  //
  // The source strings come from the BODY for the same reason: the row
  // this route could read is stale by design.
  //
  // `roviQuotaGuard()` is composed per-route (every other paywalls route
  // is unrelated to Rovi usage), and the service feeds the counter the
  // guard reads — guarding without feeding would make translation free.
  // ===========================================================
  .post(
    "/:id/translate",
    roviQuotaGuard(),
    validate("json", translateBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
      if (!paywall) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }

      const { sourceLocale, targetLocale, entries } = c.req.valid("json");

      try {
        const result = await translateEntries({
          projectId,
          sourceLocale,
          targetLocale,
          entries,
        });
        return c.json(ok(result));
      } catch (err) {
        if (err instanceof RoviConfigError) {
          return c.json(fail("ROVI_NOT_CONFIGURED", err.message), 412);
        }
        if (err instanceof TranslationInvalidError) {
          return c.json(fail("TRANSLATION_INVALID", err.message), 422);
        }
        throw err;
      }
    },
  )
  .patch("/:id", validate("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");
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

    const nonDraftPatch = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.offeringId !== undefined && { offeringId: body.offeringId }),
      ...(body.remoteConfig !== undefined && {
        remoteConfig: body.remoteConfig,
      }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    };

    let row: Paywall | null;
    if (builderPatch !== null) {
      // Capture the narrowed (non-null) value for the transaction closure
      // below — `builderPatch` itself is a `let`, and TS does not carry a
      // narrowing across a captured mutable binding.
      const patch = builderPatch;
      const expectedRevision = body.draftRevision;
      if (expectedRevision === undefined) {
        // updateBodySchema's refine already requires draftRevision
        // whenever builderConfig is present, so this is unreachable in
        // practice — but it keeps `undefined` from ever reaching
        // `eq(paywalls.draftRevision, undefined)` below if that refine is
        // ever relaxed, rather than depending on validation ~600 lines
        // away to guarantee a non-null value here.
        throw new HTTPException(400, {
          message: "draftRevision is required when builderConfig is present",
        });
      }
      // The non-draft fields (if any) and the compare-and-swapped draft
      // write happen in ONE transaction: a revision mismatch throws
      // inside it, rolling back both statements, so a caller told "your
      // write failed" never has half of it silently persisted.
      row = await drizzle.db.transaction(async (tx) => {
        if (Object.keys(nonDraftPatch).length > 0) {
          await drizzle.paywallRepo.updatePaywall(tx, projectId, id, nonDraftPatch);
        }
        const updated = await drizzle.paywallRepo.updatePaywallDraft(
          tx,
          projectId,
          id,
          expectedRevision,
          { builderConfig: patch.builderConfig, configFormatVersion: patch.configFormatVersion },
        );
        if (!updated) {
          throw new HTTPException(409, {
            message: "Paywall draft changed since it was read; reload and retry",
          });
        }
        return updated;
      });
    } else {
      row = await drizzle.paywallRepo.updatePaywall(drizzle.db, projectId, id, nonDraftPatch);
    }
    if (!row) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ paywall: row }));
  })
  // -----------------------------------------------------------
  // Versioning — publish / versions / revert / discard / label / diff
  //
  // `paywalls.builderConfig` is THE DRAFT. Publishing snapshots it into
  // paywall_versions and repoints `publishedVersionId`; /v1/placements
  // serves that snapshot, never the draft.
  // -----------------------------------------------------------

  .post("/:id/publish", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    if (paywall.builderConfig === null) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_EMPTY_DRAFT",
          message: "This paywall has no builder config to publish.",
        }),
      });
    }

    // Re-validate at publish time rather than trusting what PATCH let
    // through: the offering's packages can change after the draft was
    // last saved, which can turn a previously-clean draft into one with
    // FOREIGN_PACKAGE_ID issues.
    const offering = await loadOffering(projectId, paywall.offeringId);
    const parsed = builderConfigSchema.safeParse(paywall.builderConfig);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_NOT_PUBLISHABLE",
          issues: parsed.error.issues.map((issue) => ({
            code: "SCHEMA_INVALID",
            message: `${issue.path.join(".")}: ${issue.message}`,
          })),
        }),
      });
    }
    const issues = validateBuilderConfig(parsed.data, {
      offeringPackageIds: extractOfferingPackageIds(offering),
    });
    if (issues.some(isPublishBlockingIssue)) {
      throw new HTTPException(400, {
        message: JSON.stringify({ code: "PAYWALL_NOT_PUBLISHABLE", issues }),
      });
    }

    // Asset existence check (Task 9, 2026-08-23 store-billing plan):
    // any of THIS project's asset URLs whose row is soft-deleted or
    // nonexistent would 404 on device — the asset DELETE route hard-
    // deletes the S3 object — so refuse to publish the tree at all.
    // External URLs and other projects' asset URLs pass untouched (the
    // same boundary the usage resolver below always had). ONE walk of
    // the tree: the (url -> assetId) map built here is also what the
    // usage-recording resolver reads, so `parseAssetUrl` runs once per
    // URL, not once per consumer.
    const assetIdByUrl = new Map<string, string>();
    for (const url of collectMediaUrls(parsed.data)) {
      const resolved = parseAssetUrl(url);
      // A URL that parses but names another project's asset is just as
      // "not ours" here as an external URL — never check or record
      // usage against an asset this project doesn't own.
      if (resolved && resolved.projectId === projectId) {
        assetIdByUrl.set(url, resolved.assetId);
      }
    }
    if (assetIdByUrl.size > 0) {
      const liveIds = await drizzle.assetRepo.findLiveAssetIds(
        drizzle.db,
        projectId,
        [...new Set(assetIdByUrl.values())],
      );
      const missingUrls = [...assetIdByUrl.entries()]
        .filter(([, assetId]) => !liveIds.has(assetId))
        .map(([url]) => url);
      if (missingUrls.length > 0) {
        throw new HTTPException(400, {
          message: `Builder config references deleted or unknown asset(s): ${missingUrls.join(", ")}`,
          cause: ERROR_CODE.ASSET_MISSING,
        });
      }
    }

    const result = await drizzle.db.transaction(async (tx) => {
      // Serialize concurrent publishes of THIS paywall. nextVersionNo is
      // read-then-insert, so without this two publishes could read the same
      // MAX(versionNo) and both insert N+1 — the unique (paywallId,
      // versionNo) index would then 500 the loser. The advisory lock is
      // transaction-scoped (auto-released on commit/rollback) and keyed on
      // the paywall id, so it blocks only same-paywall publishes; other
      // paywalls are unaffected.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
      const versionNo = await drizzle.paywallVersionRepo.nextVersionNo(tx, id);
      const version = await drizzle.paywallVersionRepo.insert(tx, {
        paywallId: id,
        versionNo,
        builderConfig: paywall.builderConfig,
        remoteConfig: paywall.remoteConfig,
        offeringId: paywall.offeringId,
        configFormatVersion: paywall.configFormatVersion,
        publishedBy: user.id,
      });
      const updated = await drizzle.paywallRepo.setPublishedVersion(
        tx,
        projectId,
        id,
        version.id,
        {
          config: parsed.data,
          // Reads the pre-checked map built above — same cross-project
          // guard as before (foreign/external URLs never entered the
          // map), and every id it can return has just been verified
          // live, so a usage row can no longer violate the FK to
          // `paywall_assets.id` on a never-existed asset URL.
          resolveAssetUrl: (url) => assetIdByUrl.get(url) ?? null,
        },
      );
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.published",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, versionId: version.id, warnings: issues.length },
          ...extractRequestContext(c),
        },
        tx,
      );
      return { version, paywall: updated };
    });

    purgeProjectCatalogCache(projectId);
    return c.json(ok(result));
  })
  // -----------------------------------------------------------
  // §6.19 — atomic builder A/B launch. Paywall `id` becomes variant A;
  // variant B is either an existing paywall or a fresh duplicate of A
  // (same offering/config, unpublished draft). Everything — the optional
  // paywall duplicate, the DRAFT PAYWALL experiment, and the optional
  // placement-row repoint — happens in one tx: a mid-flight failure
  // (e.g. a stale placement row target) leaves nothing behind.
  // -----------------------------------------------------------
  .post("/:id/experiments", validate("json", launchBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "experiments:write");
    const body = c.req.valid("json");
    const requestContext = extractRequestContext(c);

    const result = await drizzle.db.transaction(async (tx) => {
      const paywallA = await drizzle.paywallRepo.findPaywallById(tx, projectId, id);
      if (!paywallA) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }

      let paywallB: Paywall;
      let createdPaywallId: string | null = null;

      if (body.variantB.kind === "existing") {
        if (body.variantB.paywallId === paywallA.id) {
          throw new HTTPException(400, {
            message: "variantB.paywallId must be a different paywall than the one being launched",
          });
        }
        const existing = await drizzle.paywallRepo.findPaywallById(
          tx,
          projectId,
          body.variantB.paywallId,
        );
        if (!existing) {
          throw new HTTPException(400, {
            message: `Unknown variantB.paywallId: ${body.variantB.paywallId}`,
          });
        }
        paywallB = existing;
      } else {
        const identifier = await findFreePaywallIdentifier(tx, projectId, body.variantB.name);
        paywallB = await drizzle.paywallRepo.createPaywall(tx, {
          projectId,
          identifier,
          name: body.variantB.name,
          offeringId: paywallA.offeringId,
          remoteConfig: paywallA.remoteConfig,
          builderConfig: paywallA.builderConfig,
          configFormatVersion: paywallA.configFormatVersion,
          isActive: true,
          status: "draft",
          publishedVersionId: null,
        });
        createdPaywallId = paywallB.id;
        await audit(
          {
            projectId,
            userId: user.id,
            action: "create",
            resource: "paywall",
            resourceId: paywallB.id,
            after: {
              identifier: paywallB.identifier,
              name: paywallB.name,
              duplicatedFrom: paywallA.id,
            },
            ...requestContext,
          },
          tx,
        );
      }

      const audienceId =
        body.audienceId ?? (await findOrCreateEveryoneAudience(tx, projectId)).id;

      const experiment = await createExperimentValidated(tx, {
        projectId,
        name: body.name,
        type: ExperimentType.PAYWALL,
        audienceId,
        variants: [
          {
            id: "a",
            name: paywallA.name,
            value: { paywallId: paywallA.id },
            weight: DEFAULT_VARIANT_SPLIT,
          },
          {
            id: "b",
            name: paywallB.name,
            value: { paywallId: paywallB.id },
            weight: DEFAULT_VARIANT_SPLIT,
          },
        ],
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "create",
          resource: "experiment",
          resourceId: experiment.id,
          after: {
            key: experiment.key,
            type: experiment.type,
            paywallA: paywallA.id,
            paywallB: paywallB.id,
          },
          ...requestContext,
        },
        tx,
      );

      let placementRepointed = false;
      if (body.placement) {
        const placementSpec = body.placement;
        const placement = await drizzle.placementRepo.findPlacementById(
          tx,
          projectId,
          placementSpec.placementId,
        );
        if (!placement) {
          throw new HTTPException(404, { message: "Placement not found" });
        }
        const rows = placementRowsSchema.parse(placement.rows);
        const row = rows[placementSpec.rowIndex];
        if (!row || row.target.type !== "paywall" || row.target.paywallId !== paywallA.id) {
          throw new HTTPException(409, {
            message: "Placement row no longer targets this paywall",
          });
        }
        const beforeTarget = row.target;
        const afterTarget = { type: "experiment" as const, experimentId: experiment.id };
        const nextRows: PlacementRow[] = rows.map((r, i) =>
          i === placementSpec.rowIndex ? { ...r, target: afterTarget } : r,
        );
        await drizzle.placementRepo.updatePlacement(tx, projectId, placement.id, {
          rows: nextRows,
        });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "update",
            resource: "placement",
            resourceId: placement.id,
            before: { rowIndex: placementSpec.rowIndex, target: beforeTarget },
            after: { rowIndex: placementSpec.rowIndex, target: afterTarget },
            ...requestContext,
          },
          tx,
        );
        placementRepointed = true;
      }

      return { experiment, createdPaywallId, placementRepointed };
    });

    await invalidateExperimentCache(projectId);
    if (result.placementRepointed) {
      purgeProjectCatalogCache(projectId);
    }

    return c.json(
      ok({ experiment: result.experiment, createdPaywallId: result.createdPaywallId }),
    );
  })
  .get("/:id/versions", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const rows = await drizzle.paywallVersionRepo.listByPaywall(drizzle.db, id);
    return c.json(
      ok({ versions: rows.map((v) => toVersionRow(v, paywall.publishedVersionId)) }),
    );
  })
  .get("/:id/versions/:versionNo", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const version = await drizzle.paywallVersionRepo.findByVersionNo(
      drizzle.db,
      id,
      versionNo,
    );
    if (!version) {
      throw new HTTPException(404, { message: "Version not found" });
    }
    return c.json(
      ok({
        version: {
          ...toVersionRow(version, paywall.publishedVersionId),
          builderConfig: version.builderConfig,
          remoteConfig: version.remoteConfig,
        },
      }),
    );
  })
  .post("/:id/versions/:versionNo/revert", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const version = await drizzle.paywallVersionRepo.findByVersionNo(
      drizzle.db,
      id,
      versionNo,
    );
    if (!version) {
      throw new HTTPException(404, { message: "Version not found" });
    }

    // Revert restores the DRAFT only. The live version is untouched until
    // the author publishes again — same semantics as funnels' revert.
    // This bypasses the compare-and-swap PATCH path entirely (it's a
    // server-initiated overwrite, not a race against a specific reader),
    // but it still bumps draftRevision: a builder tab open on the
    // pre-revert draft must 409 on its next autosave rather than
    // clobbering the revert.
    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallRepo.updatePaywall(tx, projectId, id, {
        builderConfig: version.builderConfig,
        remoteConfig: version.remoteConfig,
        offeringId: version.offeringId,
        configFormatVersion: version.configFormatVersion,
        draftRevision: drizzle.paywallRepo.BUMP_DRAFT_REVISION,
      });
      if (!row) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.reverted",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, versionId: version.id },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ paywall: updated }));
  })
  .post("/:id/discard-draft", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    if (!paywall.publishedVersionId) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_NO_PUBLISHED_VERSION",
          message: "Nothing has been published yet — there is no state to discard back to.",
        }),
      });
    }
    const live = await drizzle.paywallVersionRepo.findById(
      drizzle.db,
      paywall.publishedVersionId,
    );
    if (!live) {
      throw new HTTPException(404, { message: "Published version not found" });
    }

    // Same reasoning as revert above: no compare-and-swap here (this is a
    // server-initiated overwrite of the whole draft), but the bump still
    // invalidates a builder tab open on the pre-discard draft.
    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallRepo.updatePaywall(tx, projectId, id, {
        builderConfig: live.builderConfig,
        remoteConfig: live.remoteConfig,
        offeringId: live.offeringId,
        configFormatVersion: live.configFormatVersion,
        draftRevision: drizzle.paywallRepo.BUMP_DRAFT_REVISION,
      });
      if (!row) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.draft_discarded",
          resource: "paywall",
          resourceId: id,
          after: { versionNo: live.versionNo, versionId: live.id },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ paywall: updated }));
  })
  .patch("/:id/versions/:versionNo", validate("json", versionLabelBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");
    const { label } = c.req.valid("json");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    const version = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallVersionRepo.setLabel(tx, id, versionNo, label);
      if (!row) {
        throw new HTTPException(404, { message: "Version not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.version_labeled",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, label },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ version: toVersionRow(version, paywall.publishedVersionId) }));
  })
  .get("/:id/diff", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    /**
     * Resolve one side of the diff. `"draft"` (and the default for `to`)
     * means the live `paywalls.builderConfig`; a number means that
     * published version; the default for `from` is whatever is currently
     * live, which is the comparison the diff modal actually shows.
     */
    async function resolveSide(
      raw: string | undefined,
      fallback: "draft" | "live",
    ): Promise<{ versionNo: number | null; label: string | null; config: unknown }> {
      const spec = raw ?? fallback;
      if (spec === "draft") {
        return { versionNo: null, label: null, config: paywall!.builderConfig };
      }
      if (spec === "live") {
        if (!paywall!.publishedVersionId) {
          return { versionNo: null, label: null, config: null };
        }
        const live = await drizzle.paywallVersionRepo.findById(
          drizzle.db,
          paywall!.publishedVersionId,
        );
        if (!live) return { versionNo: null, label: null, config: null };
        return { versionNo: live.versionNo, label: live.label, config: live.builderConfig };
      }
      const versionNo = parseVersionNo(spec);
      const version = await drizzle.paywallVersionRepo.findByVersionNo(
        drizzle.db,
        id!,
        versionNo,
      );
      if (!version) {
        throw new HTTPException(404, { message: "Version not found" });
      }
      return {
        versionNo: version.versionNo,
        label: version.label,
        config: version.builderConfig,
      };
    }

    const from = await resolveSide(c.req.query("from"), "live");
    const to = await resolveSide(c.req.query("to"), "draft");

    // Both sides are already schema-validated (PATCH and publish both
    // parse before persisting), so a plain cast is safe here; a defensive
    // re-parse would double the work on a read-only endpoint.
    const entries = diffBuilderConfigs(
      (from.config as Parameters<typeof diffBuilderConfigs>[0]) ?? null,
      (to.config as Parameters<typeof diffBuilderConfigs>[1]) ?? null,
    );

    return c.json(
      ok({
        from: { versionNo: from.versionNo, label: from.label },
        to: { versionNo: to.versionNo, label: to.label },
        entries,
      }),
    );
  })
  // -----------------------------------------------------------
  // P9 — on-device paywall preview mint/revoke (§6.16). A dashboard user
  // mints a short-lived token that a physical device redeems (via
  // GET /v1/preview/paywalls/:token, Task 3) to fetch this paywall's DRAFT
  // builderConfig rather than the published snapshot /v1/placements
  // normally serves. Gated on paywalls:write (not the read-only
  // CUSTOMER_SUPPORT role above): minting hands draft access to a device
  // outside the dashboard, the same trust level as a builder write. Only
  // the token's hash is ever persisted (Task 1's previewSessionRepo) — the
  // plaintext appears exactly once, in this response, and must never be
  // logged.
  // -----------------------------------------------------------
  .post("/:id/preview-sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    const token = generateClaimToken();
    const expiresAt = new Date(Date.now() + PREVIEW_SESSION_TTL_MINUTES * MS_PER_MINUTE);

    const session = await drizzle.db.transaction(async (tx) => {
      const created = await drizzle.previewSessionRepo.createPreviewSession(tx, {
        projectId,
        paywallId: id,
        tokenHash: hashToken(token),
        createdBy: user.id,
        expiresAt,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "create",
          resource: "paywall_preview_session",
          resourceId: created.id,
          after: { paywallId: id, expiresAt: expiresAt.toISOString() },
          ...extractRequestContext(c),
        },
        tx,
      );
      return created;
    });

    const previewUrl = `${requestOrigin(c)}/v1/preview/paywalls/${token}`;
    return c.json(
      ok({
        sessionId: session.id,
        token,
        expiresAt: expiresAt.toISOString(),
        previewUrl,
        qrPayload: previewUrl,
      }),
    );
  })
  .delete("/:id/preview-sessions/:sid", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const sid = c.req.param("sid");
    if (!projectId || !id || !sid) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    await drizzle.db.transaction(async (tx) => {
      const revoked = await drizzle.previewSessionRepo.revokePreviewSession(tx, projectId, sid);
      if (!revoked) {
        throw new HTTPException(404, { message: "Preview session not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "delete",
          resource: "paywall_preview_session",
          resourceId: sid,
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ revoked: true }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "paywalls:write");

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
