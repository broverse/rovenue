# Subscriber Attributes — Backend Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the free-form `subscribers.attributes` jsonb into a typed feature — a reserved-attribute catalog (`$`-prefixed, validated) plus free-form custom string attributes — stored as nested per-key `{value, updatedAt, source}` (single source of truth), with all read/write consumers updated.

**Architecture:** Pure catalog + helpers live in `@rovenue/shared` (already a dependency of both `@rovenue/db` and `apps/api`). Storage moves from flat `{key: value}` to nested `{key: {value, updatedAt, source}}`. A tolerant normalizer (`normalizeStored`) reads BOTH the legacy flat shape and the new nested shape, so the deploy is safe even before the backfill migration runs. Every outward surface (API responses, audience evaluation, offerings, dashboard) keeps seeing a flat `{key: value}` map via `flattenAttributes`. `updatedAt` is server-only; conflict resolution is per-key last-flush-wins.

**Tech Stack:** TypeScript (strict), Drizzle ORM + Postgres jsonb, Zod, Hono, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-subscriber-attributes-design.md`

**Scope of THIS plan:** backend only (shared + db + api). SDK (Rust core + Swift/Kotlin/RN) and dashboard rendering are plans 2 and 3.

---

## File Structure

**Create:**
- `packages/shared/src/attributes/types.ts` — `AttributeSource`, `AttributeEntry`, `SubscriberAttributes` (nested), `AttributeMap` (flat).
- `packages/shared/src/attributes/catalog.ts` — reserved key catalog + per-key validators.
- `packages/shared/src/attributes/helpers.ts` — `normalizeStored`, `flattenAttributes`, `applyMutations`, `validateAttributeInput`, limits.
- `packages/shared/src/attributes/index.ts` — barrel.
- `packages/shared/src/attributes/catalog.test.ts`
- `packages/shared/src/attributes/helpers.test.ts`
- `packages/db/drizzle/migrations/0070_subscriber_attributes_nested.sql` — idempotent backfill.

**Modify:**
- `packages/shared/src/index.ts` — re-export `./attributes`.
- `packages/db/src/drizzle/repositories/subscribers.ts:534` — country filter reads nested value.
- `apps/api/src/routes/v1/me.ts:28-30,137-174` — validated attributes schema + nested write.
- `apps/api/src/routes/v1/subscribers.ts:51-53,165-216` — same.
- `apps/api/src/routes/v1/offerings.ts:167-172` — flatten before evaluation.
- `apps/api/src/routes/v1/config.ts:62,88-127` — flatten for eval, nested-merge for store.

**Test (new):**
- `apps/api/src/routes/v1/me-attributes.integration.test.ts`

---

## Task 1: Attribute types

**Files:**
- Create: `packages/shared/src/attributes/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// Internal nested storage shape + public flat projection for subscriber
// attributes. The DB column stores SubscriberAttributes; every outward
// surface exposes AttributeMap. `updatedAt` is an ISO-8601 UTC string,
// stamped server-side only.

export type AttributeSource = "sdk" | "server" | "dashboard" | "legacy";

export interface AttributeEntry {
  value: string;
  /** ISO-8601 UTC, e.g. "2026-06-15T10:00:00.000Z". Server-set only. */
  updatedAt: string;
  source: AttributeSource;
}

/** Internal nested storage: what lives in subscribers.attributes jsonb. */
export type SubscriberAttributes = Record<string, AttributeEntry>;

/** Public flat projection: what every API surface returns/accepts. */
export type AttributeMap = Record<string, string>;

/** Request mutation map: value=string to set, value=null to delete. */
export type AttributeMutationMap = Record<string, string | null>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/attributes/types.ts
git commit -m "feat(shared): subscriber attribute types (nested + flat)"
```

---

## Task 2: Reserved attribute catalog

**Files:**
- Create: `packages/shared/src/attributes/catalog.ts`
- Test: `packages/shared/src/attributes/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  RESERVED_ATTRIBUTES,
  isReservedKey,
  getReservedDef,
  validateReservedValue,
} from "./catalog";

describe("reserved attribute catalog", () => {
  it("recognises catalogued reserved keys", () => {
    expect(isReservedKey("$email")).toBe(true);
    expect(isReservedKey("$campaign")).toBe(true);
    expect(isReservedKey("favoriteTeam")).toBe(false);
  });

  it("treats an unknown $-prefixed key as reserved (so it can be rejected)", () => {
    expect(isReservedKey("$nope")).toBe(true);
    expect(getReservedDef("$nope")).toBeUndefined();
  });

  it("validates $email format", () => {
    expect(validateReservedValue("$email", "a@b.com")).toBeNull();
    expect(validateReservedValue("$email", "not-an-email")).toMatch(/email/i);
  });

  it("validates $attConsentStatus enum", () => {
    expect(validateReservedValue("$attConsentStatus", "authorized")).toBeNull();
    expect(validateReservedValue("$attConsentStatus", "bogus")).toMatch(/one of/i);
  });

  it("rejects over-long reserved values", () => {
    expect(validateReservedValue("$displayName", "x".repeat(501))).toMatch(/500/);
  });

  it("covers all four reserved groups", () => {
    for (const k of [
      "$email", "$displayName", "$phoneNumber",
      "$fcmTokens", "$apnsTokens",
      "$mediaSource", "$campaign", "$adGroup", "$keyword", "$creative", "$ad",
      "$idfa", "$idfv", "$gpsAdId", "$attConsentStatus",
    ]) {
      expect(RESERVED_ATTRIBUTES[k]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- catalog`
Expected: FAIL — `Cannot find module './catalog'`.

- [ ] **Step 3: Write the catalog**

```typescript
// Reserved subscriber attributes. All keys are `$`-prefixed and
// validated. A `$`-prefixed key NOT in this map is still "reserved"
// (isReservedKey === true) so the input validator can reject it rather
// than silently storing an unknown namespaced key.

const VALUE_MAX = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose E.164: optional leading +, 7..15 digits.
const PHONE_RE = /^\+?[0-9]{7,15}$/;
const ATT_CONSENT = ["notDetermined", "restricted", "denied", "authorized"];

export interface ReservedAttributeDef {
  key: string;
  /** Returns an error message, or null when the value is valid. */
  validate: (value: string) => string | null;
}

function maxLen(value: string): string | null {
  return value.length > VALUE_MAX ? `must be ≤ ${VALUE_MAX} characters` : null;
}

function def(key: string, validate: (v: string) => string | null): ReservedAttributeDef {
  return { key, validate: (v) => maxLen(v) ?? validate(v) };
}

const ok = () => null;

export const RESERVED_ATTRIBUTES: Record<string, ReservedAttributeDef> = {
  // --- identity ---
  $email: def("$email", (v) => (EMAIL_RE.test(v) ? null : "must be a valid email address")),
  $displayName: def("$displayName", ok),
  $phoneNumber: def("$phoneNumber", (v) =>
    PHONE_RE.test(v) ? null : "must be a phone number (7-15 digits, optional +)"),
  // --- push tokens ---
  $fcmTokens: def("$fcmTokens", ok),
  $apnsTokens: def("$apnsTokens", ok),
  // --- attribution / campaign ---
  $mediaSource: def("$mediaSource", ok),
  $campaign: def("$campaign", ok),
  $adGroup: def("$adGroup", ok),
  $keyword: def("$keyword", ok),
  $creative: def("$creative", ok),
  $ad: def("$ad", ok),
  // --- device / consent ---
  $idfa: def("$idfa", ok),
  $idfv: def("$idfv", ok),
  $gpsAdId: def("$gpsAdId", ok),
  $attConsentStatus: def("$attConsentStatus", (v) =>
    ATT_CONSENT.includes(v) ? null : `must be one of: ${ATT_CONSENT.join(", ")}`),
};

export function isReservedKey(key: string): boolean {
  return key.startsWith("$");
}

export function getReservedDef(key: string): ReservedAttributeDef | undefined {
  return RESERVED_ATTRIBUTES[key];
}

/**
 * Validate a reserved key's value. Returns an error message, or null
 * when valid. An unknown `$`-prefixed key returns a rejection message.
 */
export function validateReservedValue(key: string, value: string): string | null {
  const d = RESERVED_ATTRIBUTES[key];
  if (!d) return `unknown reserved attribute "${key}"`;
  return d.validate(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- catalog`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/attributes/catalog.ts packages/shared/src/attributes/catalog.test.ts
git commit -m "feat(shared): reserved attribute catalog + validators"
```

---

## Task 3: Attribute helpers (normalize / flatten / apply / validate)

**Files:**
- Create: `packages/shared/src/attributes/helpers.ts`
- Test: `packages/shared/src/attributes/helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_LIMITS,
  normalizeStored,
  flattenAttributes,
  applyMutations,
  validateAttributeInput,
} from "./helpers";

const NOW = "2026-06-15T10:00:00.000Z";

describe("normalizeStored", () => {
  it("passes through already-nested entries", () => {
    const nested = { $email: { value: "a@b.com", updatedAt: NOW, source: "sdk" as const } };
    expect(normalizeStored(nested)).toEqual(nested);
  });

  it("upgrades a legacy flat map to nested (source=legacy)", () => {
    const out = normalizeStored({ country: "US", age: 30 });
    expect(out.country.value).toBe("US");
    expect(out.country.source).toBe("legacy");
    // non-string legacy scalars are coerced to string
    expect(out.age.value).toBe("30");
  });

  it("returns {} for null / non-object", () => {
    expect(normalizeStored(null)).toEqual({});
    expect(normalizeStored("x")).toEqual({});
  });
});

describe("flattenAttributes", () => {
  it("projects nested storage to a flat {key: value} map", () => {
    const nested = {
      $email: { value: "a@b.com", updatedAt: NOW, source: "sdk" as const },
      country: { value: "US", updatedAt: NOW, source: "legacy" as const },
    };
    expect(flattenAttributes(nested)).toEqual({ $email: "a@b.com", country: "US" });
  });

  it("tolerates a legacy flat map directly", () => {
    expect(flattenAttributes({ country: "US" })).toEqual({ country: "US" });
  });
});

describe("applyMutations", () => {
  it("sets new keys with server now + source", () => {
    const out = applyMutations({}, { $email: "a@b.com" }, "sdk", NOW);
    expect(out.$email).toEqual({ value: "a@b.com", updatedAt: NOW, source: "sdk" });
  });

  it("deletes a key when value is null", () => {
    const cur = { country: { value: "US", updatedAt: NOW, source: "sdk" as const } };
    expect(applyMutations(cur, { country: null }, "sdk", NOW)).toEqual({});
  });

  it("overwrites existing key and re-stamps updatedAt", () => {
    const cur = { country: { value: "US", updatedAt: "2020-01-01T00:00:00.000Z", source: "sdk" as const } };
    const out = applyMutations(cur, { country: "TR" }, "server", NOW);
    expect(out.country).toEqual({ value: "TR", updatedAt: NOW, source: "server" });
  });
});

describe("validateAttributeInput", () => {
  it("accepts a valid mix of reserved + custom", () => {
    expect(validateAttributeInput({ $email: "a@b.com", favoriteTeam: "GS" }, {})).toEqual([]);
  });

  it("rejects unknown reserved key", () => {
    const errs = validateAttributeInput({ $nope: "x" }, {});
    expect(errs[0]).toMatchObject({ key: "$nope" });
  });

  it("rejects malformed custom key", () => {
    const errs = validateAttributeInput({ "bad key!": "x" }, {});
    expect(errs[0].key).toBe("bad key!");
  });

  it("rejects over-long custom value", () => {
    const errs = validateAttributeInput({ note: "x".repeat(501) }, {});
    expect(errs[0].reason).toMatch(/500/);
  });

  it("enforces the custom-key count limit (deletes & reserved exempt)", () => {
    const current: Record<string, { value: string; updatedAt: string; source: "sdk" }> = {};
    for (let i = 0; i < ATTRIBUTE_LIMITS.customMax; i++) {
      current[`k${i}`] = { value: "v", updatedAt: NOW, source: "sdk" };
    }
    // adding one more NEW custom key exceeds the cap
    expect(validateAttributeInput({ extra: "v" }, current).length).toBe(1);
    // overwriting an existing custom key is fine
    expect(validateAttributeInput({ k0: "v2" }, current)).toEqual([]);
    // deleting is always fine
    expect(validateAttributeInput({ extra: null }, current)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- helpers`
Expected: FAIL — `Cannot find module './helpers'`.

- [ ] **Step 3: Write the helpers**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/attributes/helpers.ts packages/shared/src/attributes/helpers.test.ts
git commit -m "feat(shared): attribute normalize/flatten/apply/validate helpers"
```

---

## Task 4: Barrel exports

**Files:**
- Create: `packages/shared/src/attributes/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the attributes barrel**

```typescript
export * from "./types";
export * from "./catalog";
export * from "./helpers";
```

- [ ] **Step 2: Re-export from the package root**

Add this line to `packages/shared/src/index.ts` (next to the other `export *` lines, after the `./funnel` block around line 114):

```typescript
export * from "./attributes";
```

- [ ] **Step 3: Verify the package type-checks and builds**

Run: `pnpm --filter @rovenue/shared build`
Expected: build succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/attributes/index.ts packages/shared/src/index.ts
git commit -m "feat(shared): export attributes module"
```

---

## Task 5: Backfill migration (flat → nested)

**Files:**
- Create: `packages/db/drizzle/migrations/0070_subscriber_attributes_nested.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

> The column type does NOT change (still jsonb), so `db:migrate:generate`
> produces nothing. This is a hand-authored data migration. It is
> idempotent: rows already in nested shape are left untouched. The
> tolerant `normalizeStored` reader means the app works correctly even if
> this migration has not yet run — this just cleans the at-rest data.

- [ ] **Step 1: Write the migration SQL**

```sql
-- Migrate subscribers.attributes from flat {key: value} to nested
-- {key: {value, updatedAt, source}}. Idempotent: entries that already
-- have value/updatedAt/source are preserved as-is. Legacy scalar values
-- are coerced to text. Empty maps are skipped.
UPDATE subscribers s
SET attributes = (
  SELECT COALESCE(
    jsonb_object_agg(
      kv.key,
      CASE
        WHEN jsonb_typeof(kv.value) = 'object'
             AND kv.value ? 'value'
             AND kv.value ? 'updatedAt'
             AND kv.value ? 'source'
          THEN kv.value
        ELSE jsonb_build_object(
          'value',
            CASE
              WHEN jsonb_typeof(kv.value) = 'string'
                THEN kv.value
              ELSE to_jsonb(trim(both '"' from kv.value::text))
            END,
          'updatedAt',
            to_jsonb(to_char(now() AT TIME ZONE 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          'source', to_jsonb('legacy'::text)
        )
      END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(s.attributes) AS kv
)
WHERE s.attributes IS NOT NULL
  AND s.attributes <> '{}'::jsonb;
```

- [ ] **Step 2: Register the migration in the journal**

Open `packages/db/drizzle/migrations/meta/_journal.json`. Append a new entry to the `entries` array mirroring the previous one (the last entry is `0069_damp_kingpin`). Set `idx` to the next integer, `tag` to `"0070_subscriber_attributes_nested"`, `when` to the current epoch-millis, and copy `version`/`breakpoints` from the prior entry. Example shape:

```json
{
  "idx": 70,
  "version": "7",
  "when": 1750000000000,
  "tag": "0070_subscriber_attributes_nested",
  "breakpoints": true
}
```

(Confirm `idx`/`version` by matching the format of the existing last entry in the file — do not invent fields.)

- [ ] **Step 3: Run the migration against a local Postgres**

Run: `pnpm db:migrate`
Expected: applies `0070_subscriber_attributes_nested` with no error.

- [ ] **Step 4: Verify idempotency — run again**

Run: `pnpm db:migrate`
Expected: no pending migrations (already applied); re-running the UPDATE manually would be a no-op because nested entries are preserved.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/migrations/0070_subscriber_attributes_nested.sql \
        packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): backfill subscriber attributes to nested shape"
```

---

## Task 6: Fix the country filter to read nested value

**Files:**
- Modify: `packages/db/src/drizzle/repositories/subscribers.ts:531-536`
- Test: extend `packages/db/src/drizzle/repositories/subscribers.test.ts` (or the integration suite that already exercises `listSubscribers`)

The `listSubscribers` country filter currently reads `attributes->>'country'`. With nested storage the value moved to `attributes->'country'->>'value'`.

- [ ] **Step 1: Write the failing test**

Add to the existing subscribers repo test file (integration suite with a real Postgres). Seed two subscribers — one with nested `attributes = {"country": {"value":"US","updatedAt":"...","source":"sdk"}}`, one with `"TR"` — then filter:

```typescript
it("filters by nested country attribute value", async () => {
  // arrange: insert two subscribers with nested country attributes
  await db.insert(subscribers).values([
    { projectId, rovenueId: "r-us", attributes: { country: { value: "US", updatedAt: "2026-06-15T00:00:00.000Z", source: "sdk" } } },
    { projectId, rovenueId: "r-tr", attributes: { country: { value: "TR", updatedAt: "2026-06-15T00:00:00.000Z", source: "sdk" } } },
  ]);

  const rows = await listSubscribers(db, { projectId, limit: 50, country: "us" });
  const ids = rows.map((r) => r.appUserId ?? r.id);
  expect(rows.some((r) => r.attributes && (r.attributes as any).country?.value === "US")).toBe(true);
  expect(rows.every((r) => (r.attributes as any)?.country?.value !== "TR")).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/db test -- subscribers`
Expected: FAIL — the old `->>'country'` returns the nested JSON object text, never equal to `"US"`, so the US row is excluded.

- [ ] **Step 3: Update the country filter**

In `packages/db/src/drizzle/repositories/subscribers.ts`, change the country clause:

```typescript
  // --- country (nested attribute value) -----------------------
  if (args.country) {
    whereClauses.push(
      sql`UPPER(${subscribers.attributes}->'country'->>'value') = ${args.country.toUpperCase()}`,
    );
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rovenue/db test -- subscribers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/subscribers.ts packages/db/src/drizzle/repositories/subscribers.test.ts
git commit -m "fix(db): read nested attribute value in country filter"
```

---

## Task 7: Validated attributes body schema (shared)

**Files:**
- Modify: `packages/shared/src/attributes/helpers.ts` (add the Zod schema next to the helpers)
- Test: extend `packages/shared/src/attributes/helpers.test.ts`

We replace the routes' `z.record(z.unknown())` with a shared schema that accepts `{key: string | null}`. Catalog/limit validation still runs via `validateAttributeInput` inside the route (it needs the current attributes for the count cap), so the schema only enforces the value shape.

- [ ] **Step 1: Add the failing test**

```typescript
import { attributesBodySchema } from "./helpers";

describe("attributesBodySchema", () => {
  it("accepts strings and nulls", () => {
    const r = attributesBodySchema.safeParse({ attributes: { a: "x", b: null } });
    expect(r.success).toBe(true);
  });
  it("rejects non-string/non-null values", () => {
    const r = attributesBodySchema.safeParse({ attributes: { a: 5 } });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- helpers`
Expected: FAIL — `attributesBodySchema` is not exported.

- [ ] **Step 3: Add the schema**

At the top of `packages/shared/src/attributes/helpers.ts` add the import and, after `ATTRIBUTE_LIMITS`, the schema:

```typescript
import { z } from "zod";

export const attributesBodySchema = z.object({
  attributes: z.record(z.union([z.string(), z.null()])),
});
export type AttributesBody = z.infer<typeof attributesBodySchema>;
```

(Place the `import { z }` with the other imports at the top of the file.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/attributes/helpers.ts packages/shared/src/attributes/helpers.test.ts
git commit -m "feat(shared): zod attributes body schema (string|null values)"
```

---

## Task 8: `/me/attributes` — validated nested write

**Files:**
- Modify: `apps/api/src/routes/v1/me.ts:1-15` (imports), `:28-30` (schema), `:137-174` (route)
- Test: `apps/api/src/routes/v1/me-attributes.integration.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/routes/v1/me-attributes.integration.test.ts`. Follow the existing `*.integration.test.ts` pattern in `apps/api/src/routes/v1` for harness setup (testcontainers Postgres + app instance + a seeded project/public key/subscriber). Assert:

```typescript
// (setup: app, publicKey, an existing subscriber with appUserId "u1")

it("merges reserved + custom attributes and returns a flat map", async () => {
  const res = await app.request("/v1/me/attributes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publicKey}`,
      "X-Rovenue-App-User-Id": "u1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attributes: { $email: "a@b.com", favoriteTeam: "GS" } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.subscriber.attributes).toEqual({ $email: "a@b.com", favoriteTeam: "GS" });
});

it("deletes a key when value is null and preserves others", async () => {
  await post({ $email: "a@b.com", favoriteTeam: "GS" });
  const res = await post({ favoriteTeam: null });
  const body = await res.json();
  expect(body.data.subscriber.attributes).toEqual({ $email: "a@b.com" });
});

it("rejects an unknown reserved key with 400 INVALID_ARGUMENT", async () => {
  const res = await post({ $nope: "x" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe("INVALID_ARGUMENT");
});

it("stores nested shape with server-set updatedAt + source", async () => {
  await post({ $email: "a@b.com" });
  // read the row directly
  const row = await db.select().from(subscribers).where(eq(subscribers.appUserId, "u1")).limit(1);
  const stored = row[0].attributes as any;
  expect(stored.$email).toMatchObject({ value: "a@b.com", source: "sdk" });
  expect(typeof stored.$email.updatedAt).toBe("string");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- me-attributes`
Expected: FAIL — the route still stores the flat shape (no nested `value`/`source`) and does not reject `$nope`.

- [ ] **Step 3: Update imports + schema**

In `apps/api/src/routes/v1/me.ts`, extend the `@rovenue/shared` import (add a new import line near the top):

```typescript
import {
  attributesBodySchema,
  normalizeStored,
  applyMutations,
  flattenAttributes,
  validateAttributeInput,
} from "@rovenue/shared";
```

Replace the local schema (lines 28-30):

```typescript
export const meAttributesBodySchema = attributesBodySchema;
```

- [ ] **Step 4: Rewrite the route body (lines 139-174)**

```typescript
  .post(
    "/attributes",
    zValidator("json", meAttributesBodySchema),
    async (c) => {
      const project = c.get("project");
      const subscriber = c.get("subscriber");
      const body = c.req.valid("json");

      const current = normalizeStored(subscriber.attributes);
      const errors = validateAttributeInput(body.attributes, current);
      if (errors.length > 0) {
        throw new HTTPException(400, {
          message: errors.map((e) => `${e.key}: ${e.reason}`).join("; "),
        });
      }

      const now = new Date().toISOString();
      const merged = applyMutations(current, body.attributes, "sdk", now);

      const updated = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        {
          projectId: project.id,
          rovenueId: subscriber.rovenueId,
          createAttributes: merged,
          updateAttributes: merged,
        },
      );

      return c.json(
        ok({
          subscriber: {
            id: updated.id,
            appUserId: updated.rovenueId,
            attributes: flattenAttributes(updated.attributes),
          },
        }),
      );
    },
  );
```

> The error path throws `HTTPException(400, …)`. Confirm the global error
> handler maps a 400 `HTTPException` to `{ error: { code: "INVALID_ARGUMENT", message } }`
> (it should — check `apps/api/src/middleware/error-handler` or equivalent).
> If the handler keys off a different mechanism, match how other routes
> raise `INVALID_ARGUMENT` (grep `INVALID_ARGUMENT` in `apps/api/src`).

- [ ] **Step 5: Also flatten the GET /me response**

In the `GET /` handler (line 68), wrap the attributes:

```typescript
          attributes: flattenAttributes(subscriber.attributes),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- me-attributes`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/v1/me.ts apps/api/src/routes/v1/me-attributes.integration.test.ts
git commit -m "feat(api): validated nested attribute write on /me/attributes"
```

---

## Task 9: `/v1/subscribers/:appUserId/attributes` — same treatment

**Files:**
- Modify: `apps/api/src/routes/v1/subscribers.ts:4` (import), `:51-53` (schema), `:165-216` (route)

- [ ] **Step 1: Write the failing test**

Add cases to the subscribers route integration test (the existing `apps/api/src/routes/v1/subscribers*.integration.test.ts`). Mirror the `/me/attributes` assertions but hit `POST /v1/subscribers/u1/attributes` with the appropriate key (this family uses the device-keyed path; use the same auth the existing attribute test for this route uses). Assert flat response, null-delete, `$nope` → 400, and nested storage with `source: "sdk"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- subscribers`
Expected: FAIL on the new nested/validation assertions.

- [ ] **Step 3: Update imports + schema**

This route already defines and uses a LOCAL `attributesBodySchema` (lines 51-53, referenced at line 169). Delete the local definition and import the shared one instead.

Remove lines 51-53:

```typescript
export const attributesBodySchema = z.object({
  attributes: z.record(z.unknown()),
});
```

Add a shared import near the top (after the `@rovenue/db` import at line 5):

```typescript
import {
  attributesBodySchema,
  normalizeStored,
  applyMutations,
  flattenAttributes,
  validateAttributeInput,
} from "@rovenue/shared";
```

The `zValidator("json", attributesBodySchema)` call at line 169 now resolves to the shared schema — no change needed there.

- [ ] **Step 4: Rewrite the route body (lines 170-215)**

Replace the handler body (the existing read-merge-upsert using `findSubscriberAttributesByRovenueId`). Keep the same rovenameId-keyed read; only change the merge to nested + validation:

```typescript
    async (c) => {
      const project = c.get("project");
      const appUserId = c.req.param("appUserId");
      const body = c.req.valid("json");

      // Path param is the device key (rovenueId); read the merge base
      // from the rovenueId-keyed row so it matches the upsert target.
      const existing =
        await drizzle.subscriberRepo.findSubscriberAttributesByRovenueId(
          drizzle.db,
          { projectId: project.id, rovenueId: appUserId },
        );
      const current = normalizeStored(existing?.attributes);
      const errors = validateAttributeInput(body.attributes, current);
      if (errors.length > 0) {
        throw new HTTPException(400, {
          message: errors.map((e) => `${e.key}: ${e.reason}`).join("; "),
        });
      }

      const now = new Date().toISOString();
      const merged = applyMutations(current, body.attributes, "sdk", now);

      const updated = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        {
          projectId: project.id,
          rovenueId: appUserId,
          createAttributes: merged,
          updateAttributes: merged,
        },
      );

      return c.json(
        ok({
          subscriber: {
            id: updated.id,
            appUserId: updated.appUserId,
            attributes: flattenAttributes(updated.attributes),
          },
        }),
      );
    },
```

> `HTTPException` is already imported in this file (line 2).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- subscribers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/subscribers.ts apps/api/src/routes/v1/subscribers*.integration.test.ts
git commit -m "feat(api): validated nested attribute write on subscribers/:appUserId/attributes"
```

---

## Task 10: Flatten attributes at audience/offerings read sites

**Files:**
- Modify: `apps/api/src/routes/v1/offerings.ts:167-172`
- Modify: `apps/api/src/routes/v1/config.ts:62,88-127`

The flag-engine (`flag-engine.ts:185,191`) and experiment-engine (`experiment-engine.ts:237`) call `matchesAudience(attributes, …)` with a flat `Record<string, unknown>`. They must keep receiving a FLAT map. The fix is at the read sites that pass `subscriber.attributes` into evaluation.

- [ ] **Step 1: Write/extend a failing test**

In the offerings integration test, seed a subscriber whose nested attributes include `{country: {value:"US",…}}` and an audience rule keyed on `country == "US"`. Assert the audience-targeted offering resolves. With nested storage passed raw, `matchesAudience` would compare an object to `"US"` and fail.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- offerings`
Expected: FAIL — audience rule does not match because the raw nested object is passed.

- [ ] **Step 3: Flatten in offerings.ts**

At `offerings.ts:167-172`, change:

```typescript
        const attributes = flattenAttributes(subscriber.attributes);
```

Add `flattenAttributes` to the `@rovenue/shared` import at the top of the file.

- [ ] **Step 4: Flatten + nested-merge in config.ts**

`handleConfig` both EVALUATES (needs flat) and PERSISTS the merged attributes (needs nested). Add the import at the top of `config.ts`:

```typescript
import { applyMutations, flattenAttributes, normalizeStored } from "@rovenue/shared";
```

Change `handleConfig`'s signature to accept the mutation map (string|null values) and rewrite the merge/store/eval block (lines 75-121):

```typescript
async function handleConfig(
  c: Context,
  requestAttributes: Record<string, string | null>,
) {
  const project = c.get("project");
  const appUserId = resolveSubscriberId(c);
  if (!appUserId) {
    throw new HTTPException(400, {
      message:
        "subscriberId is required (via query param or X-Rovenue-User-Id header)",
    });
  }

  // Read-then-merge: request fields are applied key-by-key onto the
  // stored nested attributes. We persist the nested shape and pass a
  // FLAT projection to flag/experiment evaluation.
  const existing =
    await drizzle.subscriberRepo.findSubscriberAttributesByRovenueId(
      drizzle.db,
      { projectId: project.id, rovenueId: appUserId },
    );
  const currentNested = normalizeStored(existing?.attributes);
  const hasNewAttributes = Object.keys(requestAttributes).length > 0;
  const now = new Date().toISOString();
  const mergedNested = applyMutations(currentNested, requestAttributes, "sdk", now);
  const evalAttributes = flattenAttributes(mergedNested);

  const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
    drizzle.db,
    {
      projectId: project.id,
      rovenueId: appUserId,
      createAttributes: mergedNested,
      ...(hasNewAttributes && { updateAttributes: mergedNested }),
    },
  );

  const env = resolveEnv(c);
  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(project.id, env, subscriber.id, evalAttributes),
    evaluateExperiments(project.id, subscriber.id, evalAttributes),
  ]);

  return c.json(ok({ flags, experiments }));
}
```

Update the body schema (line 62) to validate string|null values, and the POST caller (line 127) is already `body.attributes ?? {}` which now type-checks against the new signature:

```typescript
export const configBodySchema = z.object({
  attributes: attributesBodySchema.shape.attributes.optional(),
});
```

Add `attributesBodySchema` to the `@rovenue/shared` import. (The GET route `handleConfig(c, {})` still type-checks — `{}` is a valid `Record<string, string|null>`.)

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @rovenue/api test -- offerings config`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts apps/api/src/routes/v1/config.ts
git commit -m "feat(api): flatten nested attributes at offerings/config read sites"
```

---

## Task 11: Seed nested attributes

**Files:**
- Modify: `packages/db/seed.ts:293`

Seed currently writes a FLAT attributes map. With the nested model + the
country filter from Task 6 (`->'country'->>'value'`), flat seed data would not
match the dashboard country filter. Write nested entries.

> Anonymize (`anonymizeSubscriberRow`) and transfer reset attributes to `{}`,
> which is valid for the nested shape — no change needed there.

- [ ] **Step 1: Update the seed insert (line 293)**

Replace:

```typescript
        attributes: { country, platform, appVersion: "1.2.0" },
```

with a nested map (use a fixed ISO timestamp so seed runs are deterministic):

```typescript
        attributes: {
          country: { value: country, updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
          platform: { value: platform, updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
          appVersion: { value: "1.2.0", updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
        },
```

- [ ] **Step 2: Re-seed and spot-check**

Run: `pnpm db:seed`
Expected: no error. Then verify the country filter works against seeded data:

Run: `psql "$DATABASE_URL" -c "select count(*) from subscribers where attributes->'country'->>'value' = 'TR';"`
Expected: a non-zero count (matching the demo audience "country = TR").

- [ ] **Step 3: Commit**

```bash
git add packages/db/seed.ts
git commit -m "feat(db): seed subscriber attributes in nested shape"
```

---

## Task 12: Full backend type-check + test sweep

**Files:** none (verification task)

- [ ] **Step 1: Type-check the whole backend**

Run: `pnpm build`
Expected: all packages build (shared, db, api) with zero TS errors. Fix any remaining `attributes`-typed sites the compiler flags (e.g. a route still treating `attributes` as a flat string map) by wrapping reads in `flattenAttributes` / writes in `applyMutations`.

- [ ] **Step 2: Run the backend test suites**

Run: `pnpm --filter @rovenue/shared test && pnpm --filter @rovenue/db test && pnpm --filter @rovenue/api test`
Expected: all green. (DB/API integration suites need Docker/testcontainers available.)

- [ ] **Step 3: Grep for any missed flat-attribute reads**

Run: `grep -rn "\.attributes" apps/api/src packages/db/src | grep -v "flattenAttributes\|normalizeStored\|applyMutations\|\.test\."`
Expected: every remaining hit is either a write through `applyMutations`/`upsertSubscriber`, the dashboard list-response passthrough (handled in plan 3), or the `anonymize` `{}` reset (valid for nested too). Wrap anything that reads a value out of `attributes` as if it were flat.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore(api): wrap remaining attribute reads in flatten helper"
```

---

## Notes / handoffs to later plans

- **Plan 2 (SDK):** Rust core `setAttributes`/reserved setters/`flushAttributes`, `attribute_mutations` SQLite queue + flush triggers, Swift/Kotlin/RN façades. The API contract this plan ships (`POST /v1/me/attributes` accepting `{key: string|null}`, returning a flat map) is what the SDK targets.
- **Plan 3 (Dashboard):** `SubscriberDetailPanel.tsx` renders `data.attributes` as raw JSON today. With nested storage, the dashboard subscriber-detail API response should be flattened server-side (same `flattenAttributes` call) OR the panel updated to read `entry.value` and show `updatedAt`/`source` badges. Decide in plan 3; this plan leaves the dashboard list `attributes` passthrough untouched.
- **Known limitation (from spec §1):** deletes leave no tombstone; a late flush from another device can resurrect a just-deleted key (last-flush-wins). Acceptable for v1.
```
