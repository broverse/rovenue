import {
  builderConfigSchema,
  isBlockingIssue,
  validateBuilderConfig,
  type BuilderConfig,
} from "@rovenue/shared/paywall";

// =============================================================
// Server-side gate for an AI-generated paywall builder config (P8
// AI-FAB): the intent handler dry-runs `applyTreeOp` against the
// current draft, then calls `assertSaveValid` on the result before it
// is allowed to persist. This is deliberately the SAVE gate, not the
// publish gate — `apps/api/src/routes/dashboard/paywalls.ts`'s
// `prepareBuilderConfigPatch` is the closest existing analogue and
// this mirrors its two-step shape (structural parse, then
// `validateBuilderConfig`'s save-tier check), but returns/throws
// instead of building an HTTPException, since this runs inside an AI
// tool-call loop, not directly inside a route handler.
// =============================================================

export class GeneratedConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Generated paywall config is not save-valid: ${issues.join("; ")}`);
    this.name = "GeneratedConfigError";
  }
}

/**
 * Strict `builderConfigSchema` parse + `validateBuilderConfig`'s save-tier
 * check (`isBlockingIssue`). Throws `GeneratedConfigError` listing codes
 * (schema-parse failures) or issue codes (semantic failures) when the
 * config cannot even be saved. Returns the parsed, typed `BuilderConfig`
 * on success.
 *
 * `offeringPackageIds: []` is CORRECT here, not a placeholder to fill in
 * later: `FOREIGN_PACKAGE_ID` is publish-tier (see `ISSUE_SEVERITY` in the
 * shared validator), so an empty offering set can never turn into a
 * save-blocking issue — a generated config is allowed to reference package
 * ids before any offering has even been chosen, exactly like a
 * hand-authored draft is.
 */
export function assertSaveValid(config: unknown): BuilderConfig {
  const parsed = builderConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new GeneratedConfigError(
      parsed.error.issues.map((issue) => `SCHEMA_INVALID: ${issue.path.join(".") || "(root)"} ${issue.message}`),
    );
  }

  const issues = validateBuilderConfig(parsed.data, { offeringPackageIds: [] });
  const blocking = issues.filter(isBlockingIssue);
  if (blocking.length > 0) {
    throw new GeneratedConfigError(blocking.map((issue) => issue.code));
  }

  return parsed.data;
}
