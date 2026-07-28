import {
  builderConfigSchema,
  isBlockingIssue,
  validateBuilderConfig,
  type BuilderConfig,
  type PaywallNode,
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

/** `true` when `value` parses as an absolute URL whose protocol is `http:`
 *  or `https:` — rejects `javascript:`, `data:`, `file:`, relative paths,
 *  and anything else `new URL()` either can't parse or resolves to a
 *  non-http(s) scheme. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Depth-first walk over every node reachable from `root`, mirroring
 * `validate.ts`'s private (unexported) `walkNodes`: recurses into
 * `children` for the three container types, `packageList.cellTemplate`,
 * and `fallback`. Duplicated rather than imported — `validate.ts` doesn't
 * export a node walker, and it's a parallel session's file this phase (see
 * module header); this is a small, self-contained traversal, not worth a
 * cross-session coordination for.
 */
function walkNodesForUrlCheck(node: PaywallNode, visit: (node: PaywallNode) => void): void {
  visit(node);
  if (node.type === "stack" || node.type === "stickyFooter" || node.type === "carousel") {
    for (const child of node.children) walkNodesForUrlCheck(child, visit);
  }
  if (node.type === "packageList" && node.cellTemplate) {
    walkNodesForUrlCheck(node.cellTemplate, visit);
  }
  if (node.fallback) walkNodesForUrlCheck(node.fallback, visit);
}

/**
 * Enforces the spec's "validated http(s) image URLs" posture (§1.1): every
 * image node's `url.light`/`url.dark` and every button node's `action.url`
 * (when `action.kind === "url"`) must be an absolute http(s) URL. Collects
 * one `"INVALID_URL_SCHEME"` issue per offending field — same bare-code
 * convention `assertSaveValid`'s blocking-issue branch already uses for
 * `DUPLICATE_NODE_ID` etc.
 *
 * Enforced HERE (one seam) rather than in the shared schema, since all
 * three AI-FAB producers — `generate.ts`, `app-store-import.ts`, and
 * `intent-handlers.ts`'s `editTree` dry-run — already funnel their result
 * through `assertSaveValid` before it can leave this module or be applied.
 * `generate.ts`'s compact generation schema (title/subtitle/cta/sections)
 * has no image or button URL surface at all — the model never produces
 * one — so it never reaches this check; it's still covered because it
 * assembles onto real builder nodes gated by this same function.
 *
 * `alt` is deliberately NOT checked here: it's a modeled leaf string field
 * (image alt text), not a URL, and `buildImportTree` populates it from the
 * listing name exactly like every other locale-value string — see the
 * design doc's §5 note recording this as an accepted exception, not an
 * oversight.
 */
function assertUrlSchemes(config: BuilderConfig): void {
  const issues: string[] = [];
  walkNodesForUrlCheck(config.root, (node) => {
    if (node.type === "image") {
      if (!isHttpUrl(node.url.light)) issues.push("INVALID_URL_SCHEME");
      if (node.url.dark !== undefined && !isHttpUrl(node.url.dark)) issues.push("INVALID_URL_SCHEME");
    }
    if (node.type === "button" && node.action.kind === "url" && !isHttpUrl(node.action.url)) {
      issues.push("INVALID_URL_SCHEME");
    }
  });
  if (issues.length > 0) throw new GeneratedConfigError(issues);
}

/**
 * Strict `builderConfigSchema` parse + the http(s)-URL-scheme gate
 * (`assertUrlSchemes`) + `validateBuilderConfig`'s save-tier check
 * (`isBlockingIssue`). Throws `GeneratedConfigError` listing codes
 * (schema-parse failures, URL-scheme violations) or issue codes (semantic
 * failures) when the config cannot even be saved. Returns the parsed,
 * typed `BuilderConfig` on success.
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

  assertUrlSchemes(parsed.data);

  const issues = validateBuilderConfig(parsed.data, { offeringPackageIds: [] });
  const blocking = issues.filter(isBlockingIssue);
  if (blocking.length > 0) {
    throw new GeneratedConfigError(blocking.map((issue) => issue.code));
  }

  return parsed.data;
}
