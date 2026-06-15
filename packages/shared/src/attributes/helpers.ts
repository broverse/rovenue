import type {
  AttributeEntry,
  AttributeMap,
  AttributeMutationMap,
  AttributeSource,
  SubscriberAttributes,
} from "./types";
import { isReservedKey, validateReservedValue } from "./catalog";

export const ATTRIBUTE_LIMITS = {
  keyMax: 40,
  valueMax: 500,
  /** Max custom (non-reserved) keys per subscriber. */
  customMax: 50,
} as const;

export const CUSTOM_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isNestedEntry(x: unknown): x is AttributeEntry {
  return (
    isPlainObject(x) &&
    typeof x.value === "string" &&
    typeof x.updatedAt === "string" &&
    typeof x.source === "string"
  );
}

/**
 * Read the stored jsonb into the nested shape, tolerating BOTH the new
 * nested form and the legacy flat `{key: value}` form (so reads are safe
 * before/after the backfill migration). Legacy scalar values are coerced
 * to string and tagged source="legacy" with an epoch updatedAt.
 */
export function normalizeStored(raw: unknown): SubscriberAttributes {
  if (!isPlainObject(raw)) return {};
  const out: SubscriberAttributes = {};
  for (const [key, val] of Object.entries(raw)) {
    if (isNestedEntry(val)) {
      out[key] = val;
    } else if (val === null || val === undefined) {
      continue;
    } else {
      out[key] = {
        value: typeof val === "string" ? val : String(val),
        updatedAt: "1970-01-01T00:00:00.000Z",
        source: "legacy",
      };
    }
  }
  return out;
}

/** Project nested storage (or a legacy flat map) to flat {key: value}. */
export function flattenAttributes(raw: unknown): AttributeMap {
  const nested = normalizeStored(raw);
  const out: AttributeMap = {};
  for (const [key, entry] of Object.entries(nested)) out[key] = entry.value;
  return out;
}

/**
 * Apply a mutation map to the current nested attributes. value=null
 * deletes the key; any other value sets it with the server-supplied
 * `now` and `source`. Returns a new object (input is not mutated).
 */
export function applyMutations(
  current: SubscriberAttributes,
  mutations: AttributeMutationMap,
  source: AttributeSource,
  now: string,
): SubscriberAttributes {
  const out: SubscriberAttributes = { ...current };
  for (const [key, value] of Object.entries(mutations)) {
    if (value === null) {
      delete out[key];
    } else {
      out[key] = { value, updatedAt: now, source };
    }
  }
  return out;
}

export interface AttributeValidationError {
  key: string;
  reason: string;
}

/**
 * Validate an incoming mutation map against the catalog + custom rules,
 * given the subscriber's current attributes (for the count limit).
 * Returns one error per offending key; empty array when valid.
 */
export function validateAttributeInput(
  input: AttributeMutationMap,
  current: SubscriberAttributes,
): AttributeValidationError[] {
  const errors: AttributeValidationError[] = [];

  // Project the post-apply custom-key set to enforce the count cap.
  const customAfter = new Set(
    Object.keys(current).filter((k) => !isReservedKey(k)),
  );

  for (const [key, value] of Object.entries(input)) {
    const deleting = value === null;

    if (isReservedKey(key)) {
      if (!deleting) {
        const err = validateReservedValue(key, value as string);
        if (err) errors.push({ key, reason: err });
      }
      continue; // reserved keys never count toward the custom cap
    }

    // custom key rules
    if (!CUSTOM_KEY_RE.test(key)) {
      errors.push({
        key,
        reason: `custom key must match ${CUSTOM_KEY_RE.source}`,
      });
      continue;
    }
    if (deleting) {
      customAfter.delete(key);
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ key, reason: "value must be a string or null" });
      continue;
    }
    if (value.length > ATTRIBUTE_LIMITS.valueMax) {
      errors.push({ key, reason: `value must be ≤ ${ATTRIBUTE_LIMITS.valueMax} characters` });
      continue;
    }
    customAfter.add(key);
  }

  if (customAfter.size > ATTRIBUTE_LIMITS.customMax) {
    errors.push({
      key: "*",
      reason: `too many custom attributes (max ${ATTRIBUTE_LIMITS.customMax})`,
    });
  }

  return errors;
}
