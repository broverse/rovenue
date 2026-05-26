import type {
  CohortFilter,
  CohortFilterField,
  CohortOperator,
  CohortRule,
} from "@rovenue/shared";

const FIELD_OPS: Record<CohortFilterField, ReadonlyArray<CohortOperator>> = {
  country: ["eq", "in"],
  store: ["eq", "in"],
  productId: ["eq", "in"],
  purchaseType: ["eq", "in"],
  firstSeenAfter: ["gte"],
  firstSeenBefore: ["lte"],
};

export const ALL_FIELDS: ReadonlyArray<CohortFilterField> = [
  "country",
  "store",
  "productId",
  "purchaseType",
  "firstSeenAfter",
  "firstSeenBefore",
];

export function allowedOps(
  field: CohortFilterField,
): ReadonlyArray<CohortOperator> {
  return FIELD_OPS[field];
}

export function defaultValueForOp(op: CohortOperator): CohortFilter["value"] {
  switch (op) {
    case "in":
      return [];
    case "between":
      return { min: 0, max: 0 };
    case "eq":
    case "gte":
    case "lte":
    default:
      return "";
  }
}

export function defaultFilter(field: CohortFilterField): CohortFilter {
  const op = allowedOps(field)[0]!;
  // Prefer `in` for multi-value fields so users land on chip-pickers
  // without an extra click.
  const preferred: CohortOperator =
    field === "country" ||
    field === "store" ||
    field === "productId" ||
    field === "purchaseType"
      ? "in"
      : op;
  return {
    field,
    op: preferred,
    value: defaultValueForOp(preferred),
  };
}

export function isFilterValid(f: CohortFilter): boolean {
  switch (f.op) {
    case "in":
      return Array.isArray(f.value) && f.value.length > 0;
    case "eq":
      return typeof f.value === "string" && f.value.trim().length > 0;
    case "gte":
    case "lte":
      return typeof f.value === "string" && f.value.trim().length > 0;
    case "between":
      return (
        typeof f.value === "object" &&
        f.value !== null &&
        "min" in f.value &&
        "max" in f.value
      );
    default:
      return false;
  }
}

export function sanitiseRule(rule: CohortRule): CohortRule {
  return {
    match: rule.match,
    filters: rule.filters.filter(isFilterValid),
  };
}
