// Mapping validation for the data-import tool.
//
// A "mapping" is whatever the customer ends up with after either
// accepting a detected preset (presets.ts) or hand-assigning source
// columns themselves: a Record<sourceColumn, CanonicalField>. This
// module is the single gate an import run must pass before any row is
// processed, regardless of how the mapping was produced.
import {
  type CanonicalField,
  type ImportJobKind,
  REQUIRED_FIELDS_BY_KIND,
} from "./canonical";

export type MappingValidationResult =
  | { ok: true }
  | { ok: false; missingRequired: CanonicalField[] };

/**
 * Validates a source-column → canonical-field mapping. Fails if any
 * field required for the given job `kind` (per REQUIRED_FIELDS_BY_KIND)
 * has no source column mapped to it, or if two source columns are
 * mapped onto the same canonical field (ambiguous — we'd have to
 * silently pick one and discard the other's data).
 *
 * `kind` defaults to "HISTORY" so every pre-existing single-argument
 * call site keeps compiling unchanged.
 */
export function validateMapping(
  mapping: Record<string, CanonicalField>,
  kind: ImportJobKind = "HISTORY",
): MappingValidationResult {
  const mappedFields = Object.values(mapping);
  const mappedFieldSet = new Set(mappedFields);

  const missingRequired = REQUIRED_FIELDS_BY_KIND[kind].filter(
    (key) => !mappedFieldSet.has(key),
  );

  const seen = new Set<CanonicalField>();
  let hasDuplicateTarget = false;
  for (const field of mappedFields) {
    if (seen.has(field)) {
      hasDuplicateTarget = true;
      break;
    }
    seen.add(field);
  }

  if (missingRequired.length > 0 || hasDuplicateTarget) {
    return { ok: false, missingRequired };
  }
  return { ok: true };
}
