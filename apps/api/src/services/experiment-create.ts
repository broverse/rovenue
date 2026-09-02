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
  type ExperimentPrimaryMetric,
  type Variant as ExperimentVariant,
} from "@rovenue/shared";
import {
  OVERRIDABLE_PROP_KEYS,
  findNode,
  paywallNodeSchema,
  type BuilderConfig,
} from "@rovenue/shared/paywall";
import {
  BLOCKED_SUCCESSOR_GRACE_MS,
  HOLDOUT_COHORT_ID,
} from "../lib/experiment-constants";

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
  /** Decision-engine inputs. Omitted leaves the column defaults
   *  (CONVERSION, DEFAULT_MINIMUM_DETECTABLE_EFFECT). */
  primaryMetric?: ExperimentPrimaryMetric;
  minimumDetectableEffect?: number;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  startAfterExperimentId?: string | null;
  autoWinnerOnStop?: boolean;
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
    assertPatchedNodeParses(node, value.nodeId, value.props);
  }
}

/**
 * The allowlist above says WHICH props may be overridden. It says nothing
 * about what a valid VALUE for one is, and `applyTreeOp`'s `updateProps` is
 * a bare `{ ...node, ...patch }` with no re-parse — so before this check a
 * client could store `divider.thickness = "8"` (schema: `z.number()`) or
 * `divider.color = "[object Object]"` (schema: `ThemeColor`), and the
 * materialiser would ship that node verbatim into
 * `variants[].paywall.builderConfig` and out to the web, SwiftUI and
 * Android Views decoders. A key-only allowlist is a hand-maintained link
 * between two lists; re-parsing the PATCHED node against the same strict
 * union the builder config itself is built from is a structural guarantee
 * that moves with the schema.
 *
 * Failures are attributed to the patch, not to the node: only issues whose
 * path starts at a key this patch actually wrote are treated as this
 * caller's fault. A published tree that predates a schema change is a
 * separate problem and must not make an unrelated element experiment
 * unsaveable.
 */
function assertPatchedNodeParses(
  node: object,
  nodeId: string,
  props: Record<string, unknown>,
): void {
  if (paywallNodeSchema.safeParse({ ...node, ...props }).success) return;
  // Attribution, not blanket rejection: if the node did not parse BEFORE
  // the patch either, the published tree predates a schema change and this
  // caller is not at fault.
  if (!paywallNodeSchema.safeParse(node).success) return;

  throw new HTTPException(400, {
    message: `ELEMENT experiment variant sets an invalid value on node "${nodeId}" — ${describeInvalidProps(node, props)}`,
  });
}

/**
 * A per-prop diagnosis. `paywallNodeSchema` is a `z.union`, so a whole-node
 * failure surfaces as one opaque `invalid_union` issue with no path — of no
 * use to an operator. Re-parsing the node with ONE prop applied at a time
 * isolates which prop is at fault, and the node's declared `type` names the
 * expected shape.
 */
function describeInvalidProps(
  node: object,
  props: Record<string, unknown>,
): string {
  const nodeType = (node as { type?: unknown }).type;
  const bad = Object.entries(props)
    .filter(
      ([key, value]) =>
        !paywallNodeSchema.safeParse({ ...node, [key]: value }).success,
    )
    .map(([key, value]) => `${key} (got ${JSON.stringify(value) ?? typeof value})`);
  const which = bad.length > 0 ? bad.join(", ") : Object.keys(props).join(", ");
  return `${which} is not a valid value for node type "${String(nodeType)}"`;
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
 * Task 9 — `startAfterExperimentId` chains DRAFT experiments into a
 * sequence the scheduler advances as each predecessor reaches COMPLETED.
 * A cycle (A after B after A) would leave every member permanently DRAFT,
 * each waiting on a predecessor that is itself waiting on it — and the
 * spec requires this be rejected at WRITE time, not discovered at run
 * time, where the scheduler's only options would be starting nothing or
 * corrupting bookkeeping. Called from both create and the DRAFT-update
 * path whenever `startAfterExperimentId` is being set to a non-null value.
 *
 * `experimentId` is `null` at create time (the row doesn't exist yet, so
 * it cannot already be part of a cycle — nothing points at it) and the
 * new experiment's own id thereafter.
 */
export async function assertNoScheduleCycle(
  db: DbOrTx,
  projectId: string,
  experimentId: string | null,
  startAfterExperimentId: string | null | undefined,
): Promise<void> {
  if (!startAfterExperimentId) return;

  if (startAfterExperimentId === experimentId) {
    throw new HTTPException(400, {
      message: "startAfterExperimentId cannot reference the experiment itself",
    });
  }

  const predecessor = await drizzle.experimentRepo.findByIdInProject(
    db,
    startAfterExperimentId,
    projectId,
  );
  if (!predecessor) {
    throw new HTTPException(400, {
      message: `startAfterExperimentId ${startAfterExperimentId} does not belong to this project`,
    });
  }

  const chain = await drizzle.experimentRepo.findScheduleChainByProject(
    db,
    projectId,
  );
  const nextOf = new Map(chain.map((e) => [e.id, e.startAfterExperimentId]));

  let cursor: string | null = startAfterExperimentId;
  const visited = new Set<string>();
  while (cursor) {
    if (experimentId !== null && cursor === experimentId) {
      throw new HTTPException(400, {
        message: "startAfterExperimentId would create a scheduling cycle",
      });
    }
    // A cycle already present in unrelated existing data (which this
    // function would itself have prevented, but data can predate it) —
    // stop walking rather than loop forever; not this write's problem.
    if (visited.has(cursor)) break;
    visited.add(cursor);
    cursor = nextOf.get(cursor) ?? null;
  }
}

/**
 * `scheduledEndAt`, when both scheduling bounds are set, must actually be
 * after `scheduledStartAt` — otherwise the scheduler would see an
 * experiment already past its end the moment it starts.
 */
export function assertValidScheduleWindow(
  scheduledStartAt: Date | null | undefined,
  scheduledEndAt: Date | null | undefined,
): void {
  if (!scheduledStartAt || !scheduledEndAt) return;
  if (scheduledEndAt.getTime() <= scheduledStartAt.getTime()) {
    throw new HTTPException(400, {
      message: "scheduledEndAt must be after scheduledStartAt",
    });
  }
}

export type SchedulingBlockedReason = "PREDECESSOR_DELETED" | "OVERDUE";

/**
 * Read-time "blocked successor" surfacing (spec §4.5 / Task 9 step 5). Only
 * DRAFT experiments can be blocked — once RUNNING there is nothing left to
 * wait on. Two independent triggers:
 *
 *  - OVERDUE: still waiting more than `BLOCKED_SUCCESSOR_GRACE_MS` past its
 *    own `scheduledStartAt` — typically because a predecessor it is
 *    chained after has not reached COMPLETED (the scheduler's claim
 *    requires that before it will start the row).
 *  - PREDECESSOR_DELETED: `startAfterExperimentId` is null now, but a
 *    durable `experiment.predecessor_deleted` audit marker says it became
 *    null because the predecessor was deleted (see `findSuccessors` /
 *    the DELETE route) rather than never having been set. This check is
 *    read-time-computed rather than a stored flag because the FK's
 *    `ON DELETE SET NULL` gives no other way to distinguish the two once
 *    the delete has landed.
 */
export async function computeSchedulingBlocked(
  db: DbOrTx,
  experiment: Pick<
    Experiment,
    "id" | "status" | "scheduledStartAt" | "startAfterExperimentId"
  >,
  now: Date = new Date(),
): Promise<{ blocked: boolean; reason: SchedulingBlockedReason | null }> {
  if (experiment.status !== "DRAFT") {
    return { blocked: false, reason: null };
  }

  if (
    experiment.scheduledStartAt &&
    now.getTime() - experiment.scheduledStartAt.getTime() > BLOCKED_SUCCESSOR_GRACE_MS
  ) {
    return { blocked: true, reason: "OVERDUE" };
  }

  if (experiment.startAfterExperimentId === null) {
    const hadPredecessorDeleted = await drizzle.auditLogRepo.existsAuditEntry(db, {
      resource: "experiment",
      resourceId: experiment.id,
      action: "experiment.predecessor_deleted",
    });
    if (hadPredecessorDeleted) {
      return { blocked: true, reason: "PREDECESSOR_DELETED" };
    }
  }

  return { blocked: false, reason: null };
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

  assertValidScheduleWindow(input.scheduledStartAt, input.scheduledEndAt);
  await assertNoScheduleCycle(
    db,
    input.projectId,
    null,
    input.startAfterExperimentId,
  );

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
    primaryMetric: input.primaryMetric,
    // `numeric` is string-mode in Drizzle — one explicit conversion at the
    // boundary, the same house pattern `resolveCommissionRate` follows.
    minimumDetectableEffect:
      input.minimumDetectableEffect === undefined
        ? undefined
        : String(input.minimumDetectableEffect),
    scheduledStartAt: input.scheduledStartAt,
    scheduledEndAt: input.scheduledEndAt,
    startAfterExperimentId: input.startAfterExperimentId,
    autoWinnerOnStop: input.autoWinnerOnStop,
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
