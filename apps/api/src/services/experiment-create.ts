import { HTTPException } from "hono/http-exception";
import {
  ExperimentStatus,
  drizzle,
  type Db,
  type Experiment,
  type ExperimentType,
} from "@rovenue/db";
import {
  experimentSchema as sharedExperimentSchema,
  type Variant as ExperimentVariant,
} from "@rovenue/shared";

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
