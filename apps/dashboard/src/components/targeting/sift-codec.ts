// =============================================================
// Targeting condition ↔ sift document codec
// =============================================================
//
// Shared between feature-flag rules and audience definitions —
// both store MongoDB-style filter documents that are evaluated
// by `matchesAudience` (packages/shared) at SDK eval time.

export type ConditionKind =
  | "customAttribute"
  | "country"
  | "app"
  | "appVersion"
  | "platform"
  | "sdkVersion";

export type ListOp = "$in" | "$nin";
export type CompareOp = "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte";

export interface DraftCondition {
  kind: ConditionKind;
  attribute: string;
  scalarOp: CompareOp;
  scalarValue: string;
  listOp: ListOp;
  listValues: string[];
}

export function makeCondition(kind: ConditionKind): DraftCondition {
  return {
    kind,
    attribute: kind === "customAttribute" ? "" : kind,
    scalarOp: "$gte",
    scalarValue: "",
    listOp: "$in",
    listValues: [],
  };
}

function conditionToFragment(
  c: DraftCondition,
): Record<string, unknown> | null {
  const trimmedAttr = c.attribute.trim();
  switch (c.kind) {
    case "customAttribute": {
      if (!trimmedAttr) return null;
      const parsed = parseScalar(c.scalarValue);
      return { [trimmedAttr]: { [c.scalarOp]: parsed } };
    }
    case "country":
    case "app":
    case "platform": {
      const field = c.kind;
      const values = c.listValues
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length === 0) return null;
      return { [field]: { [c.listOp]: values } };
    }
    case "appVersion":
    case "sdkVersion": {
      const field = c.kind;
      const v = c.scalarValue.trim();
      if (v.length === 0) return null;
      return { [field]: { [c.scalarOp]: v } };
    }
  }
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.length > 0 && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return raw;
}

export function conditionsToSift(
  conds: ReadonlyArray<DraftCondition>,
): Record<string, unknown> | undefined {
  const fragments: Record<string, unknown>[] = [];
  for (const c of conds) {
    const frag = conditionToFragment(c);
    if (frag) fragments.push(frag);
  }
  if (fragments.length === 0) return undefined;
  if (fragments.length === 1) return fragments[0]!;
  return { $and: fragments };
}

export function siftToConditions(
  sift: Record<string, unknown> | undefined,
): DraftCondition[] {
  if (!sift) return [];
  const fragments: Record<string, unknown>[] = Array.isArray(sift.$and)
    ? (sift.$and as Record<string, unknown>[])
    : [sift];

  const out: DraftCondition[] = [];
  for (const frag of fragments) {
    const entries = Object.entries(frag);
    if (entries.length !== 1) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: "_raw",
        scalarOp: "$eq",
        scalarValue: JSON.stringify(frag),
      });
      continue;
    }
    const [field, ops] = entries[0]!;
    if (typeof ops !== "object" || ops === null || Array.isArray(ops)) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: field,
        scalarOp: "$eq",
        scalarValue: String(ops),
      });
      continue;
    }
    const opEntries = Object.entries(ops as Record<string, unknown>);
    if (opEntries.length !== 1) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: field,
        scalarOp: "$eq",
        scalarValue: JSON.stringify(ops),
      });
      continue;
    }
    const [op, raw] = opEntries[0]!;
    if (field === "country" || field === "app" || field === "platform") {
      out.push({
        ...makeCondition(field),
        listOp: op === "$nin" ? "$nin" : "$in",
        listValues: Array.isArray(raw)
          ? raw.map((v) => String(v))
          : [String(raw)],
      });
      continue;
    }
    if (field === "appVersion" || field === "sdkVersion") {
      out.push({
        ...makeCondition(field),
        scalarOp: normaliseCompareOp(op),
        scalarValue: String(raw),
      });
      continue;
    }
    out.push({
      ...makeCondition("customAttribute"),
      attribute: field,
      scalarOp: normaliseCompareOp(op),
      scalarValue:
        typeof raw === "object" ? JSON.stringify(raw) : String(raw),
    });
  }
  return out;
}

function normaliseCompareOp(op: string): CompareOp {
  const allowed: ReadonlyArray<CompareOp> = [
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
  ];
  return allowed.includes(op as CompareOp) ? (op as CompareOp) : "$eq";
}
