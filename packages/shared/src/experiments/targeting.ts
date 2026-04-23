import sift from "sift";

// =============================================================
// Audience rule evaluation
// =============================================================
//
// Rules are stored as a MongoDB-style query document on the
// Audience model. `matchesAudience` evaluates them against a
// subscriber's runtime attributes and returns a boolean.
//
// Operators are restricted at WRITE time (validateAudienceRules)
// so sift's full operator surface never sees adversarial input.
// `$regex`, `$where`, `$expr`, `$function` are all rejected — a
// regex operator on a user-supplied pattern opens the door to
// ReDoS-style catastrophic backtracking on the SDK hot path, and
// the other three allow arbitrary JavaScript execution. The
// operator surface below is what we need for real targeting use
// cases (country/platform/version/custom attributes), nothing
// more.

const ALLOWED_OPERATORS = new Set<string>([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$and",
  "$or",
  "$nor",
  "$not",
  "$all",
  "$size",
]);

const MAX_DEPTH = 8;
const MAX_NODES = 256;
const MAX_ARRAY_LEN = 500;

type Rules = Record<string, unknown> | null | undefined;
type Attributes = Record<string, unknown>;

/**
 * Validate an audience rule document before storing it. Throws
 * `Error` with a user-readable message on the first violation.
 * Non-object rules (arrays, primitives at the root) are rejected.
 */
export function validateAudienceRules(
  rules: unknown,
): asserts rules is Record<string, unknown> {
  if (rules === null || rules === undefined) return;
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("Audience rules must be a JSON object");
  }
  let nodeCount = 0;
  walk(rules as Record<string, unknown>, 0);

  function walk(value: unknown, depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new Error(`Audience rules exceed max depth (${MAX_DEPTH})`);
    }
    if (++nodeCount > MAX_NODES) {
      throw new Error(`Audience rules exceed max node count (${MAX_NODES})`);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LEN) {
        throw new Error(`Audience rules array exceeds ${MAX_ARRAY_LEN} items`);
      }
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("$")) {
        if (!ALLOWED_OPERATORS.has(key)) {
          throw new Error(`Operator ${key} is not allowed`);
        }
      }
      walk(v, depth + 1);
    }
  }
}

export function matchesAudience(
  attributes: Attributes,
  rules: Rules,
): boolean {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return true;
  if (Object.keys(rules).length === 0) return true;
  const filter = sift(rules as Parameters<typeof sift>[0]);
  return filter(attributes);
}
