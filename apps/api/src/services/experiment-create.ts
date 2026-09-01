import { HTTPException } from "hono/http-exception";
import {
  ExperimentStatus,
  drizzle,
  type Db,
  type Experiment,
  type ExperimentType,
} from "@rovenue/db";
import {
  elementVariantValueSchema,
  experimentSchema as sharedExperimentSchema,
  type Variant as ExperimentVariant,
} from "@rovenue/shared";
import { OVERRIDABLE_PROP_KEYS, findNode, type BuilderConfig } from "@rovenue/shared/paywall";
import { HOLDOUT_COHORT_ID } from "../lib/experiment-constants";

// DB or Drizzle tx handle — every write here can run standalone or
// inside a caller's transaction (Task 2 wraps both createExperimentValidated
// and findOrCreateEveryoneAudience in one tx).
type DbOrTx = Db;

export const EVERYONE_AUDIENCE_NAME = "Everyone";

/**
 * Experiment keys are backend-assigned opaque `exp_<cuid2>` strings.
 * A collision is astronomically unlikely (see generateExperimentKey),
 * so a handful of precheck+retry attempts is plenty; if we still
 * haven't found a free key after this many, something is structurally
 * wrong (e.g. the key generator is broken) and we should fail loudly
 * rather than loop forever.
 */
export const EXPERIMENT_KEY_MAX_ATTEMPTS = 5;

export interface CreateExperimentInput {
  projectId: string;
  name: string;
  description?: string;
  type: ExperimentType;
  audienceId: string;
  variants: ExperimentVariant[];
  metrics?: string[];
  mutualExclusionGroup?: string;
}

/**
 * PAYWALL experiments reference paywalls by id rather than carrying an
 * inline config: every variant's `value` must be `{ paywallId }` and
 * that id must belong to the project. Enforced on both create and
 * DRAFT-update (variant `value` is immutable once RUNNING, so there is
 * nothing to re-check on the RUNNING weight-only update path).
 */
export async function assertPaywallVariantsValid(
  db: DbOrTx,
  projectId: string,
  type: ExperimentType,
  variants: ReadonlyArray<{ value?: unknown }>,
): Promise<void> {
  if (type !== "PAYWALL") return;

  const paywallIds: string[] = [];
  for (const variant of variants) {
    const value = variant.value as { paywallId?: unknown } | null | undefined;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.paywallId !== "string" ||
      value.paywallId.length === 0
    ) {
      throw new HTTPException(400, {
        message: "PAYWALL experiment variants must carry value: { paywallId }",
      });
    }
    paywallIds.push(value.paywallId);
  }

  const uniqueIds = [...new Set(paywallIds)];
  const found = await drizzle.paywallRepo.findPaywallsByIds(
    db,
    projectId,
    uniqueIds,
  );
  const foundIds = new Set(found.map((p) => p.id));
  const missing = uniqueIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new HTTPException(400, {
      message: `Unknown paywallId(s) in PAYWALL experiment variants: ${missing.join(", ")}`,
    });
  }
}

/**
 * Why this validates against the PUBLISHED tree only.
 *
 * `resolveTargetBuilderConfig` used to prefer the paywall's DRAFT
 * `builderConfig`, on the theory that a designer wires an ELEMENT
 * experiment up against changes not yet published. But
 * `hydratePaywall` (apps/api/src/lib/placement-resolution.ts) is explicit
 * that production serves the PUBLISHED snapshot and NEVER
 * `paywalls.builderConfig` — the draft is private to the builder. A node
 * that exists only in the draft would pass this check and then can never
 * apply in production: a successful save, a RUNNING experiment, and
 * silence. The experiment isn't re-validated at publish time either, so
 * validating against the draft accepts a configuration that cannot work.
 * Validate against what actually ships.
 *
 * Returns a `reason` (never both a config and a reason) so the caller can
 * give the operator an actionable rejection instead of a generic "no
 * builder config" — tell them to publish, and why.
 */
type TargetBuilderConfigResult =
  | { config: BuilderConfig; reason?: undefined }
  | { config?: undefined; reason: "NO_PUBLISHED_VERSION" | "PUBLISHED_VERSION_HAS_NO_BUILDER_CONFIG" };

async function resolveTargetBuilderConfig(
  db: DbOrTx,
  paywall: { publishedVersionId: string | null },
): Promise<TargetBuilderConfigResult> {
  if (!paywall.publishedVersionId) {
    return { reason: "NO_PUBLISHED_VERSION" };
  }
  const version = await drizzle.paywallVersionRepo.findById(db, paywall.publishedVersionId);
  if (!version || version.builderConfig === null || typeof version.builderConfig !== "object") {
    return { reason: "PUBLISHED_VERSION_HAS_NO_BUILDER_CONFIG" };
  }
  return { config: version.builderConfig as BuilderConfig };
}

/**
 * ELEMENT experiments patch one node's props per variant against a single
 * shared paywall — "the experiment's target paywall"
 * (packages/shared/src/experiments/types.ts `elementVariantValueSchema`).
 * Every variant's `value` must be `{ paywallId, nodeId, props }`, every
 * variant of the SAME experiment must name the SAME `paywallId` (there is
 * exactly one target per experiment), `nodeId` must exist in that
 * paywall's PUBLISHED builder-config tree, and every key in `props` must be in
 * `OVERRIDABLE_PROP_KEYS[node.type]` — the same allowlist all three
 * renderers already honour for the (unrelated, condition-evaluated)
 * `overrides` field, so an ELEMENT variant can never target a prop some
 * platform would silently ignore.
 *
 * Checked at both create and DRAFT-update — like `assertPaywallVariantsValid`,
 * there is nothing left to re-check on the RUNNING weight-only update path
 * (variant `value` is immutable once RUNNING).
 */
export async function assertElementVariantsValid(
  db: DbOrTx,
  projectId: string,
  type: ExperimentType,
  variants: ReadonlyArray<{ value?: unknown }>,
): Promise<void> {
  if (type !== "ELEMENT") return;

  const parsed = variants.map((variant) => {
    const result = elementVariantValueSchema.safeParse(variant.value);
    if (!result.success) {
      throw new HTTPException(400, {
        message:
          "ELEMENT experiment variants must carry value: { paywallId, nodeId, props }",
      });
    }
    return result.data;
  });

  const paywallIds = new Set(parsed.map((v) => v.paywallId));
  if (paywallIds.size > 1) {
    throw new HTTPException(400, {
      message: `ELEMENT experiment variants must all target the same paywallId (got: ${[...paywallIds].join(", ")})`,
    });
  }
  const [paywallId] = paywallIds;
  if (!paywallId) return; // no variants — sharedExperimentSchema's min(2) already rejects this

  const paywall = await drizzle.paywallRepo.findPaywallById(db, projectId, paywallId);
  if (!paywall) {
    throw new HTTPException(400, {
      message: `Unknown paywallId in ELEMENT experiment variants: ${paywallId}`,
    });
  }

  const target = await resolveTargetBuilderConfig(db, paywall);
  if (!target.config) {
    const detail =
      target.reason === "NO_PUBLISHED_VERSION"
        ? `paywall ${paywallId} has no published version`
        : `the published version of paywall ${paywallId} has no builder config`;
    throw new HTTPException(400, {
      message: `ELEMENT experiments target the PUBLISHED paywall, not the draft — ${detail}. Publish the paywall first, then create or edit the experiment.`,
    });
  }
  const builderConfig = target.config;

  for (const value of parsed) {
    const node = findNode(builderConfig.root, value.nodeId);
    if (!node) {
      throw new HTTPException(400, {
        message: `Unknown nodeId in ELEMENT experiment variant (checked against the PUBLISHED paywall, not the draft): ${value.nodeId}. If this node only exists in an unpublished draft, publish the paywall first.`,
      });
    }
    const allowed: readonly string[] = OVERRIDABLE_PROP_KEYS[node.type];
    for (const propKey of Object.keys(value.props)) {
      if (!allowed.includes(propKey)) {
        throw new HTTPException(400, {
          message: `Prop "${propKey}" is not overridable on node "${value.nodeId}" (type ${node.type})`,
        });
      }
    }
  }
}

/**
 * Task 8 — `HOLDOUT_COHORT_ID` is the reserved synthetic variantId a
 * held-out subscriber's exposure is stamped with (evaluateExperiments /
 * resolvePlacement). If a user could create a real variant with that same
 * id, a held-out exposure and a real assignment to that variant would be
 * indistinguishable in downstream per-variant analytics. Called at every
 * site that can introduce a NEW variant id — create (below) and the DRAFT
 * update path (routes/dashboard/experiments.ts). The RUNNING weight-only
 * update path can't add ids (it rejects any id outside the existing set),
 * so there is nothing to check there.
 */
export function assertNoReservedVariantId(
  variants: ReadonlyArray<{ id: string }>,
): void {
  if (variants.some((v) => v.id === HOLDOUT_COHORT_ID)) {
    throw new HTTPException(400, {
      message: `variant id "${HOLDOUT_COHORT_ID}" is reserved for the holdout cohort`,
    });
  }
}

/**
 * Generates a free experiment key for a project: generate → SELECT-precheck,
 * up to EXPERIMENT_KEY_MAX_ATTEMPTS. This works inside a caller's transaction
 * where an insert-then-catch-unique-violation retry loop cannot — a unique
 * violation aborts the enclosing tx, so there is nothing left to retry into.
 * The (projectId, key) unique index stays in place as the backstop for the
 * astronomically-unlikely race between the precheck SELECT and the INSERT
 * the caller performs with the returned key.
 */
export async function generateFreeExperimentKey(
  db: DbOrTx,
  projectId: string,
): Promise<string> {
  for (let attempt = 0; attempt < EXPERIMENT_KEY_MAX_ATTEMPTS; attempt += 1) {
    const key = drizzle.experimentRepo.generateExperimentKey();
    const existing = await drizzle.experimentRepo.findExperimentByKey(
      db,
      projectId,
      key,
    );
    if (existing) continue;
    return key;
  }

  throw new Error(
    `Failed to generate a unique experiment key after ${EXPERIMENT_KEY_MAX_ATTEMPTS} attempts`,
  );
}

/**
 * Validates (shared schema + audience membership + paywall variants)
 * and inserts a new experiment as DRAFT with a server-assigned key.
 *
 * Key strategy: see generateFreeExperimentKey.
 */
export async function createExperimentValidated(
  db: DbOrTx,
  input: CreateExperimentInput,
): Promise<Experiment> {
  // Validate the variant weight sum + id-uniqueness via the shared
  // schema with a throwaway placeholder key (the refinements never
  // inspect the key itself — it is backend-assigned below).
  sharedExperimentSchema.parse({
    type: input.type,
    key: "_",
    variants: input.variants,
  });
  assertNoReservedVariantId(input.variants);

  const audience = await drizzle.audienceRepo.findAudienceInProject(
    db,
    input.projectId,
    input.audienceId,
  );
  if (!audience) {
    throw new HTTPException(400, {
      message: "audienceId does not belong to this project",
    });
  }

  await assertPaywallVariantsValid(db, input.projectId, input.type, input.variants);
  await assertElementVariantsValid(db, input.projectId, input.type, input.variants);

  const key = await generateFreeExperimentKey(db, input.projectId);

  return drizzle.experimentRepo.createExperiment(db, {
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    type: input.type,
    key,
    audienceId: input.audienceId,
    status: ExperimentStatus.DRAFT,
    variants: input.variants,
    metrics: input.metrics,
    mutualExclusionGroup: input.mutualExclusionGroup,
  });
}

/**
 * Spec §3.2 preference order for the audience new experiments default
 * to: the project's isDefault audience → an existing audience whose
 * rules already match everyone (`{}`), preferring one literally named
 * "Everyone" → creating a fresh { name: "Everyone", rules: {} }.
 */
export async function findOrCreateEveryoneAudience(
  db: DbOrTx,
  projectId: string,
): Promise<{ id: string }> {
  const defaultAudience = await drizzle.audienceRepo.findDefaultAudience(
    db,
    projectId,
  );
  if (defaultAudience) return { id: defaultAudience.id };

  const matchAll = await drizzle.audienceRepo.findMatchAllAudiences(db, projectId);
  if (matchAll.length > 0) {
    const named = matchAll.find((a) => a.name === EVERYONE_AUDIENCE_NAME);
    return { id: (named ?? matchAll[0])!.id };
  }

  const created = await drizzle.audienceRepo.createAudience(db, {
    projectId,
    name: EVERYONE_AUDIENCE_NAME,
    rules: {},
  });
  return { id: created.id };
}
