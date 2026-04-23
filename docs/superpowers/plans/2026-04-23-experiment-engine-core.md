# Alan 5 — Experiment Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the in-tree experiment engine against spec §13 addendum: migrate the bucketer from murmur3 to SHA-256, relocate `bucketing` + `targeting` from `apps/api/src/lib/` to `packages/shared/src/experiments/` so SDK consumers can share the same correctness-critical code, add a `hashVersion` column to `experiment_assignments`, and rewire the two engines that call both modules. No behaviour changes beyond the hash swap; no new features; no dashboard UI.

**Architecture:** Spec §13.2 locks a split — `bucketing.ts` + `targeting.ts` are correctness-critical and move to `@rovenue/shared`; `flag-engine.ts`, `experiment-engine.ts`, and `experiment-stats.ts` stay in `apps/api` because they own DB orchestration and server-only analysis. Spec §13.4 replaces `murmurhash-js.murmur3` with SHA-256 (first 4 bytes → 10,000-bucket space) so iOS/Android/Node/browser runtimes can all reach the same bucket without a native binding. The public API (`assignBucket`, `selectVariant`, `isInRollout`) stays identical; only the hash function changes. Spec §13.7 notes the project is pre-launch with no live assignments, so we migrate in place and burn a single `hashVersion = 1` onto every new row rather than running a dual-write cutover.

**Tech Stack:** `packages/shared` (Node `node:crypto`, Zod, Vitest), `packages/db` (Drizzle ORM 0.45, hand-authored SQL migrations, drizzle-kit 0.31), `apps/api` (Hono, Vitest, service layer consumers). No new runtime dependencies — SHA-256 ships in `node:crypto`; `murmurhash-js` is removed.

**Scope note — what is intentionally NOT in this plan:**
- SDK-RN integration (`packages/sdk-rn`). The `node:crypto` import in the new shared bucketing targets the server today. When Plan C (SDK) lands, either shared migrates to an injected hasher or ships a second pure-JS entrypoint (§13.4 decision). Deferred — no SDK consumer exists yet, so the choice has no cost today.
- SSE endpoint, exposure buffer, `exposure_events` hypertable, stats endpoint, results UI, `size-limit` CI. All live in Plan B (delivery), Plan C (SDK), Plan D (dashboard UI).
- `packages/shared` build/bundle split for tree-shaking (sideEffects: false, per-export entrypoints). That's a Plan C concern — today `@rovenue/shared` is consumed as TS source via `main: src/index.ts`, which is fine for server.
- Dashboard CRUD UI. Plan D. API-side `dashboard/experiments.ts` and `dashboard/feature-flags.ts` already exist and need no changes for the reconciliation.

---

## Testing conventions

- Shared package tests live alongside source in `packages/shared/src/` (pattern set by `crypto.test.ts`, `experiments.test.ts`). New tests for `bucketing` and `targeting` move into `packages/shared/src/experiments/`.
- No vitest config file in `packages/shared` — use defaults. Run via `pnpm --filter @rovenue/shared test`.
- API package tests stay in `apps/api/tests/`. `bucketing.test.ts` + `targeting.test.ts` get **deleted** from there after their shared counterparts pass — they exist to test the in-tree modules this plan removes.
- Drizzle migrations are hand-authored SQL files appended to `packages/db/drizzle/migrations/` with a manual entry in `_journal.json`. The rovenue convention (established by Alan 4) is to NEVER run `drizzle-kit generate` — see `2026-04-23-timescaledb.md` testing conventions for why.
- Run `pnpm --filter @rovenue/db db:migrate` against the docker-compose Postgres after the migration is authored; verify with `psql` or `drizzle-kit studio`.

---

## File structure

### Create

- `packages/shared/src/experiments/bucketing.ts` — SHA-256 bucketer with the same three-function surface as the in-tree version
- `packages/shared/src/experiments/bucketing.test.ts` — ported + extended from `apps/api/tests/bucketing.test.ts`, adds parity vector test
- `packages/shared/src/experiments/bucketing-parity-vectors.json` — frozen SHA-256 bucket outputs for 32 canonical inputs; any drift fails the parity test
- `packages/shared/src/experiments/targeting.ts` — verbatim copy of `apps/api/src/lib/targeting.ts`, no behaviour change
- `packages/shared/src/experiments/targeting.test.ts` — ported from `apps/api/tests/targeting.test.ts` with imports rewritten
- `packages/shared/src/experiments/index.ts` — barrel export for the three bucketing functions + the two targeting functions
- `packages/db/drizzle/migrations/0008_experiment_assignments_hash_version.sql` — adds `hashVersion smallint NOT NULL DEFAULT 1` to `experiment_assignments`

### Modify

- `packages/shared/src/index.ts` — add `export * from "./experiments/index";` (placed alongside the existing `./experiments` export, which already re-exports `experiments.ts`; the new module is a directory sibling, not a conflict — see Task 1.0 for the import-path detail)
- `packages/db/src/drizzle/schema.ts:698-735` — add `hashVersion` column to the `experimentAssignments` table definition
- `packages/db/src/drizzle/repositories/experiment-assignments.ts` — teach `insertAssignmentsSkipDuplicates` to accept an optional `hashVersion`, default 1
- `packages/db/src/drizzle/drizzle-foundation.test.ts` — pin the new column (shape + default)
- `packages/db/drizzle/migrations/meta/_journal.json` — append the 0008 entry
- `apps/api/src/services/flag-engine.ts:2,5` — import `isInRollout` and `matchesAudience` from `@rovenue/shared/experiments` (via the barrel) instead of `../lib/bucketing` and `../lib/targeting`
- `apps/api/src/services/experiment-engine.ts:19,22` — same two imports rewritten; `insertAssignmentsSkipDuplicates` call passes `hashVersion: 1` on new assignments

### Delete

- `apps/api/src/lib/bucketing.ts` — superseded by the shared module
- `apps/api/src/lib/targeting.ts` — superseded
- `apps/api/tests/bucketing.test.ts` — superseded
- `apps/api/tests/targeting.test.ts` — superseded

### Dependency cleanup

- `apps/api/package.json` — remove `murmurhash-js` from dependencies if no other file imports it

---

## Reference: existing in-tree bindings this plan depends on

These compile today and must keep compiling after this plan runs. If they've drifted when you reach those tasks, stop and reconcile before continuing.

- `apps/api/src/services/flag-engine.ts` — reads flags from `drizzle.featureFlagRepo`, calls `isInRollout(subscriberId, flagKey, pct)` and `matchesAudience(attrs, rules)`. Rules consumed: first-match wins, with an optional rollout gate per rule.
- `apps/api/src/services/experiment-engine.ts` — reads experiments from `drizzle.experimentRepo`, calls `assignBucket(subscriberId, experimentKey)` → `selectVariant(bucket, variants)`. Writes new assignments via `drizzle.experimentAssignmentRepo.insertAssignmentsSkipDuplicates` (array of `{experimentId, subscriberId, variantId}` — Task 3.5 extends the shape).
- `packages/db/src/drizzle/schema.ts:698` — `experimentAssignments` has `UNIQUE(experimentId, subscriberId)` via `experimentIdSubscriberIdKey` uniqueIndex. This sticky-assignment guarantee is what makes the bucketer swap safe: the same subscriber always reads its frozen variant on repeat calls, regardless of which hash produced the first assignment.
- `apps/api/tests/experiment-engine.test.ts`, `apps/api/tests/flag-engine.test.ts` — end-to-end tests that exercise the engines against the in-tree bucketing/targeting. After Tasks 1.4 and 2.4 these tests consume the shared modules transitively via the engines; they should not need edits beyond what Task 4.1 verifies.

---

## Phase 0 — Pre-flight

### Task 0.1: Confirm the baseline test suite is green

**Files:** none

- [ ] **Step 1: Run the shared package tests**

Run: `pnpm --filter @rovenue/shared test`
Expected: all tests pass. This is the harness we'll extend in Phase 1.

- [ ] **Step 2: Run the db package tests**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass. Phase 3 extends `drizzle-foundation.test.ts`.

- [ ] **Step 3: Run the api package tests**

Run: `pnpm --filter @rovenue/api test`
Expected: all tests pass, including `bucketing.test.ts`, `targeting.test.ts`, `flag-engine.test.ts`, `experiment-engine.test.ts`. A flaky baseline will hide regressions later.

- [ ] **Step 4: Confirm the local Postgres is running**

Run: `docker compose ps db`
Expected: `db` service shows `healthy`. Phase 3 Task 3.7 runs a real migration against it.

---

## Phase 1 — Relocate targeting to shared

Targeting has no behaviour change in this plan — it moves verbatim. Doing it first keeps the SHA-256 migration (Phase 2) focused on a single concern.

### Task 1.1: Scaffold `packages/shared/src/experiments/` and wire the barrel

**Files:**
- Create: `packages/shared/src/experiments/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the directory and empty barrel**

Create `packages/shared/src/experiments/index.ts` with this content:

```typescript
// =============================================================
// Experiments — shared bucketing and targeting primitives
// =============================================================
//
// These are the correctness-critical modules that server, SDK,
// and dashboard all consume to reach the same answer for a given
// (subscriberId, seed) or (attributes, rules) pair. See
// docs/superpowers/specs/2026-04-20-tech-stack-upgrade/
//   05-experiment-engine.md §13.2 for the location decision.

export {
  assignBucket,
  isInRollout,
  selectVariant,
} from "./bucketing";

export {
  matchesAudience,
  validateAudienceRules,
} from "./targeting";
```

- [ ] **Step 2: Extend the top-level shared barrel**

The existing `packages/shared/src/index.ts:86` exports `./experiments` (the singular file `experiments.ts` that holds experiment types). The new directory is a sibling, so we add a separate line pointing at the subdir:

Open `packages/shared/src/index.ts` and replace:

```typescript
// =============================================================
// Experiment types (Flag / ProductGroup / Paywall / Element)
// =============================================================

export * from "./experiments";
```

with:

```typescript
// =============================================================
// Experiment types (Flag / ProductGroup / Paywall / Element)
// =============================================================

export * from "./experiments";

// =============================================================
// Experiments runtime — bucketing + targeting
// =============================================================

export * from "./experiments/index";
```

Note: the two lines resolve to different modules — `./experiments` picks up `experiments.ts`, `./experiments/index` picks up `experiments/index.ts`. TypeScript resolves file siblings before directories, so this is unambiguous.

- [ ] **Step 3: Verify the scaffold compiles (it won't link yet — bucketing.ts/targeting.ts don't exist)**

Run: `pnpm --filter @rovenue/shared build`
Expected: tsc fails with "Cannot find module './bucketing'" and "'./targeting'". That's fine — Tasks 1.2 and 2.1 write those files. Do NOT commit this step yet; the commit comes after Task 1.2 produces working code.

### Task 1.2: Copy targeting.ts into shared

**Files:**
- Create: `packages/shared/src/experiments/targeting.ts`

- [ ] **Step 1: Create the shared targeting module**

Create `packages/shared/src/experiments/targeting.ts` with this **exact** content (verbatim copy of `apps/api/src/lib/targeting.ts`):

```typescript
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
```

- [ ] **Step 2: Add `sift` to the shared package dependencies**

`sift` currently lives in `apps/api`. The shared package needs it too. Open `packages/shared/package.json` and add `sift` to `dependencies`. Pick the version that matches the `apps/api` pin — confirm with:

Run: `node -e "console.log(require('./apps/api/package.json').dependencies.sift)"` from the repo root.
Expected: a string like `"^17.1.3"` or similar. Use that exact version specifier in `packages/shared/package.json`.

After editing, run: `pnpm install`
Expected: pnpm resolves the dependency and updates the lockfile. No errors.

- [ ] **Step 3: Verify the shared package still builds (bucketing stub still missing)**

Run: `pnpm --filter @rovenue/shared build`
Expected: tsc fails with "Cannot find module './bucketing'" only — the targeting import from the barrel should now resolve.

Task 1.2 has no commit step. Its deliverable is picked up by Task 1.3's commit.

### Task 1.3: Port the targeting tests into shared

**Files:**
- Create: `packages/shared/src/experiments/targeting.test.ts`

- [ ] **Step 1: Write the shared targeting test**

Create `packages/shared/src/experiments/targeting.test.ts` with this exact content (ported from `apps/api/tests/targeting.test.ts` — only the import path on line 2 changes):

```typescript
import { describe, expect, test } from "vitest";
import { matchesAudience, validateAudienceRules } from "./targeting";

// =============================================================
// Empty rules — "All Users"
// =============================================================

describe("matchesAudience — empty rules", () => {
  test("matches every subscriber when rules is an empty object", () => {
    expect(matchesAudience({ country: "TR" }, {})).toBe(true);
    expect(matchesAudience({}, {})).toBe(true);
  });

  test("matches when rules is null/undefined (All Users fallback)", () => {
    expect(
      matchesAudience({ country: "TR" }, null as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      matchesAudience({ country: "TR" }, undefined as unknown as Record<string, unknown>),
    ).toBe(true);
  });
});

// =============================================================
// $in / $nin
// =============================================================

describe("matchesAudience — $in / $nin", () => {
  test("$in accepts values present in the list", () => {
    const rules = { country: { $in: ["TR", "AZ"] } };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "AZ" }, rules)).toBe(true);
    expect(matchesAudience({ country: "DE" }, rules)).toBe(false);
  });

  test("$nin rejects values in the list", () => {
    const rules = { country: { $nin: ["US"] } };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "US" }, rules)).toBe(false);
  });
});

// =============================================================
// Equality + combined filters
// =============================================================

describe("matchesAudience — platform + version", () => {
  test("AND across multiple top-level keys", () => {
    const rules = {
      platform: "ios",
      appVersion: { $gte: "2.0" },
    };
    expect(
      matchesAudience({ platform: "ios", appVersion: "2.1" }, rules),
    ).toBe(true);
    expect(
      matchesAudience({ platform: "android", appVersion: "2.1" }, rules),
    ).toBe(false);
    expect(
      matchesAudience({ platform: "ios", appVersion: "1.9" }, rules),
    ).toBe(false);
  });

  test("$gte on numeric totalRevenue", () => {
    const rules = { totalRevenue: { $gte: 50 } };
    expect(matchesAudience({ totalRevenue: 50 }, rules)).toBe(true);
    expect(matchesAudience({ totalRevenue: 100 }, rules)).toBe(true);
    expect(matchesAudience({ totalRevenue: 49.99 }, rules)).toBe(false);
  });
});

// =============================================================
// Nested custom attributes (dot notation)
// =============================================================

describe("matchesAudience — nested attributes", () => {
  test("dot-notation dives into nested objects", () => {
    const attributes = {
      country: "TR",
      attributes: {
        totalRevenue: 150,
        plan: "enterprise",
      },
    };
    const rules = {
      "attributes.totalRevenue": { $gte: 100 },
      "attributes.plan": "enterprise",
    };
    expect(matchesAudience(attributes, rules)).toBe(true);
  });

  test("fails when nested attribute is missing", () => {
    const rules = { "attributes.customField": "x" };
    expect(matchesAudience({ attributes: {} }, rules)).toBe(false);
  });
});

// =============================================================
// $and / $or / $not composition
// =============================================================

describe("matchesAudience — logical operators", () => {
  test("$or accepts when any branch matches", () => {
    const rules = {
      $or: [{ country: "TR" }, { country: "DE" }],
    };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "DE" }, rules)).toBe(true);
    expect(matchesAudience({ country: "US" }, rules)).toBe(false);
  });

  test("$and requires every branch", () => {
    const rules = {
      $and: [{ platform: "ios" }, { appVersion: { $gte: "2.0" } }],
    };
    expect(
      matchesAudience({ platform: "ios", appVersion: "2.5" }, rules),
    ).toBe(true);
    expect(
      matchesAudience({ platform: "ios", appVersion: "1.0" }, rules),
    ).toBe(false);
  });
});

// =============================================================
// $exists
// =============================================================

describe("matchesAudience — $exists", () => {
  test("true when the field is present", () => {
    const rules = { email: { $exists: true } };
    expect(matchesAudience({ email: "a@b.c" }, rules)).toBe(true);
    expect(matchesAudience({}, rules)).toBe(false);
  });
});

// =============================================================
// validateAudienceRules — operator allowlist
// =============================================================

describe("validateAudienceRules — rejects dangerous operators", () => {
  test("rejects $regex (ReDoS risk)", () => {
    expect(() => validateAudienceRules({ email: { $regex: "^a+b" } })).toThrow(
      /\$regex is not allowed/,
    );
  });

  test("rejects $where (arbitrary JS)", () => {
    expect(() =>
      validateAudienceRules({ $where: "this.country === 'TR'" }),
    ).toThrow(/\$where is not allowed/);
  });

  test("rejects $expr (aggregation expressions)", () => {
    expect(() =>
      validateAudienceRules({ $expr: { $eq: ["$a", "$b"] } }),
    ).toThrow(/\$expr is not allowed/);
  });

  test("rejects $function", () => {
    expect(() =>
      validateAudienceRules({
        $function: { body: "function(){}", args: [], lang: "js" },
      }),
    ).toThrow(/\$function is not allowed/);
  });

  test("accepts the standard operator set", () => {
    expect(() =>
      validateAudienceRules({
        $and: [
          { country: { $in: ["TR", "AZ"] } },
          { totalRevenue: { $gte: 50 } },
          { email: { $exists: true } },
        ],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the shared targeting tests (bucketing will still fail to import — skip it for now)**

Run: `pnpm --filter @rovenue/shared test targeting`
Expected: all 10+ targeting tests pass. Vitest's CLI filter (`test <pattern>`) runs files whose name matches the pattern, so `test targeting` runs only `targeting.test.ts` and skips the still-broken bucketing module.

- [ ] **Step 3: Commit — shared targeting module in place, engines not yet rewired**

```bash
git add packages/shared/src/experiments/index.ts \
        packages/shared/src/experiments/targeting.ts \
        packages/shared/src/experiments/targeting.test.ts \
        packages/shared/src/index.ts \
        packages/shared/package.json \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
refactor(shared): relocate audience targeting into shared experiments module

Prepares bucketing + targeting to become SDK-shared primitives per
spec §13.2. Targeting is copied verbatim; behaviour is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.4: Rewire the engines to import targeting from shared, delete the in-tree module

**Files:**
- Modify: `apps/api/src/services/flag-engine.ts:5`
- Modify: `apps/api/src/services/experiment-engine.ts:22`
- Delete: `apps/api/src/lib/targeting.ts`
- Delete: `apps/api/tests/targeting.test.ts`

- [ ] **Step 1: Rewrite the flag-engine import**

Open `apps/api/src/services/flag-engine.ts`. Replace line 5:

```typescript
import { matchesAudience } from "../lib/targeting";
```

with:

```typescript
import { matchesAudience } from "@rovenue/shared";
```

`matchesAudience` is exported from the new `packages/shared/src/experiments/index.ts` barrel (Task 1.1 Step 1) and re-exported through `packages/shared/src/index.ts` (Task 1.1 Step 2), so the package-root import path is sufficient — no deep path needed.

- [ ] **Step 2: Rewrite the experiment-engine import**

Open `apps/api/src/services/experiment-engine.ts`. Replace line 22:

```typescript
import { matchesAudience } from "../lib/targeting";
```

with:

```typescript
import { matchesAudience } from "@rovenue/shared";
```

- [ ] **Step 3: Delete the in-tree targeting module and its tests**

Run:
```bash
rm apps/api/src/lib/targeting.ts apps/api/tests/targeting.test.ts
```

- [ ] **Step 4: Run the api test suite to confirm the engines still work**

Run: `pnpm --filter @rovenue/api test`
Expected: all tests pass. `flag-engine.test.ts` and `experiment-engine.test.ts` exercise `matchesAudience` transitively through the engines — they must go green against the shared import, which proves the import-path rewrite is correct and nothing else breaks.

If this step fails with "Cannot find module '@rovenue/shared'", it means the api package's `package.json` doesn't list shared as a workspace dependency. Verify with `grep rovenue/shared apps/api/package.json`; if absent, add `"@rovenue/shared": "workspace:*"` under `dependencies` and re-run `pnpm install`. This is unlikely — shared is already used elsewhere in api — but worth checking.

- [ ] **Step 5: Commit — api now consumes shared targeting**

```bash
git add apps/api/src/services/flag-engine.ts \
        apps/api/src/services/experiment-engine.ts \
        apps/api/src/lib/targeting.ts \
        apps/api/tests/targeting.test.ts
git commit -m "$(cat <<'EOF'
refactor(api): consume shared targeting, drop in-tree copy

Both engines now import matchesAudience from @rovenue/shared. The
apps/api copies of targeting.ts and targeting.test.ts are removed —
shared is the single source of truth (spec §13.2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Bucketing migration (murmur3 → SHA-256)

The public surface (`assignBucket`, `selectVariant`, `isInRollout`) stays identical — only the hash function inside `assignBucket` changes. `selectVariant` and `isInRollout` use `assignBucket` transitively, so they inherit the new hash automatically. Parity vectors freeze the exact outputs so a future algorithm shift can be caught.

### Task 2.1: Write the SHA-256 bucketing tests first (TDD)

**Files:**
- Create: `packages/shared/src/experiments/bucketing.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/shared/src/experiments/bucketing.test.ts` with this content (ported from `apps/api/tests/bucketing.test.ts` with the import path changed AND a new parity vector test added at the end):

```typescript
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assignBucket,
  isInRollout,
  selectVariant,
} from "./bucketing";

// =============================================================
// assignBucket — deterministic SHA-256 bucketing
// =============================================================

describe("assignBucket", () => {
  test("returns the same bucket for the same (subscriberId, seed)", () => {
    const a = assignBucket("sub_abc", "paywall-summer");
    const b = assignBucket("sub_abc", "paywall-summer");
    expect(a).toBe(b);
  });

  test("returns a bucket in [0, 9999]", () => {
    for (let i = 0; i < 100; i += 1) {
      const bucket = assignBucket(`sub_${i}`, "any-seed");
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(10_000);
    }
  });

  test("different seeds produce different buckets for the same subscriber", () => {
    const a = assignBucket("sub_same", "seed-a");
    const b = assignBucket("sub_same", "seed-b");
    expect(a).not.toBe(b);
  });

  test("100k random ids are uniformly distributed across 10 bins (±5%)", () => {
    const bins = new Array<number>(10).fill(0);
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      const bucket = assignBucket(randomUUID(), "uniformity-check");
      bins[Math.floor(bucket / 1000)]! += 1;
    }

    const expected = N / 10;
    for (const count of bins) {
      const drift = Math.abs(count - expected) / expected;
      expect(drift).toBeLessThan(0.05);
    }
  });
});

// =============================================================
// selectVariant — weight-based pick
// =============================================================

describe("selectVariant", () => {
  const variants = [
    { id: "control", weight: 0.5 },
    { id: "variant_a", weight: 0.5 },
  ] as const;

  test("bucket 0 falls in the first variant", () => {
    expect(selectVariant(0, variants).id).toBe("control");
  });

  test("bucket just below the split goes to control", () => {
    expect(selectVariant(4999, variants).id).toBe("control");
  });

  test("bucket at the split goes to variant_a", () => {
    expect(selectVariant(5000, variants).id).toBe("variant_a");
  });

  test("bucket 9999 goes to the final variant", () => {
    expect(selectVariant(9999, variants).id).toBe("variant_a");
  });

  test("three-way split with uneven weights picks proportionally", () => {
    const three = [
      { id: "a", weight: 0.34 },
      { id: "b", weight: 0.33 },
      { id: "c", weight: 0.33 },
    ];

    expect(selectVariant(0, three).id).toBe("a");
    expect(selectVariant(3399, three).id).toBe("a");
    expect(selectVariant(3400, three).id).toBe("b");
    expect(selectVariant(6699, three).id).toBe("b");
    expect(selectVariant(6700, three).id).toBe("c");
    expect(selectVariant(9999, three).id).toBe("c");
  });

  test("N samples land in weight-proportional counts (±2%)", () => {
    const variants3 = [
      { id: "a", weight: 0.7 },
      { id: "b", weight: 0.3 },
    ];
    const counts = { a: 0, b: 0 } as Record<string, number>;
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      const bucket = assignBucket(randomUUID(), "variant-drift");
      const picked = selectVariant(bucket, variants3);
      counts[picked.id] = (counts[picked.id] ?? 0) + 1;
    }

    expect(Math.abs(counts.a! / N - 0.7)).toBeLessThan(0.02);
    expect(Math.abs(counts.b! / N - 0.3)).toBeLessThan(0.02);
  });
});

// =============================================================
// isInRollout — percentage gate
// =============================================================

describe("isInRollout", () => {
  test("percentage 0 never passes", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isInRollout(`sub_${i}`, "seed", 0)).toBe(false);
    }
  });

  test("percentage 1 always passes", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isInRollout(`sub_${i}`, "seed", 1)).toBe(true);
    }
  });

  test("10% rollout hits ~10k out of 100k subscribers (±0.5%)", () => {
    let hits = 0;
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      if (isInRollout(randomUUID(), "rollout-seed", 0.1)) hits += 1;
    }

    const drift = Math.abs(hits / N - 0.1);
    expect(drift).toBeLessThan(0.005);
  });

  test("deterministic — same subscriber gets the same answer", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = `stable_${i}`;
      expect(isInRollout(id, "seed", 0.1)).toBe(
        isInRollout(id, "seed", 0.1),
      );
    }
  });
});

// =============================================================
// Parity vectors — frozen SHA-256 outputs
// =============================================================
//
// The on-disk JSON is regenerated only when the algorithm changes
// intentionally (schema bump via `hashVersion`). Until then, every
// input must produce the recorded bucket. If this test fails and
// no algorithm change was made, a real assignment regression has
// slipped in.

interface ParityVector {
  subscriberId: string;
  seed: string;
  bucket: number;
}

describe("assignBucket — parity vectors", () => {
  const vectors: ParityVector[] = JSON.parse(
    readFileSync(
      new URL("./bucketing-parity-vectors.json", import.meta.url),
      "utf8",
    ),
  );

  test("JSON loaded and non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors)(
    "$subscriberId / $seed → bucket $bucket",
    ({ subscriberId, seed, bucket }) => {
      expect(assignBucket(subscriberId, seed)).toBe(bucket);
    },
  );
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @rovenue/shared test bucketing`
Expected: FAIL with "Cannot find module './bucketing'" (and no parity JSON). That's the red bar — we're about to write the minimal implementation.

### Task 2.2: Implement the SHA-256 bucketing module

**Files:**
- Create: `packages/shared/src/experiments/bucketing.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/shared/src/experiments/bucketing.ts` with this exact content:

```typescript
import { createHash } from "node:crypto";

// =============================================================
// Deterministic bucketing for experiments and feature flags
// =============================================================
//
// Every assignment decision uses the same primitive: hash the
// subscriberId with an experiment/flag-specific seed into one of
// 10,000 buckets. 10k buckets give 0.01% precision — enough for
// a 1% canary rollout without drift.
//
// Algorithm choice: SHA-256 over the concatenation `${subId}:${seed}`,
// first 4 bytes of the digest taken as a big-endian uint32, then
// modulo BUCKET_COUNT. SHA-256 is available in Node, browsers
// (WebCrypto), iOS (CryptoKit), Android (MessageDigest) and RN
// (react-native-quick-crypto / built-in from 0.73+) without any
// custom native binding — that's the property that made us walk
// away from murmurhash and xxhash (spec §13.4). 2^32 mod 10000
// leaves a ~2.4e-6 relative bias on the last 2496 pre-image values,
// which is well below the ±5% uniformity tolerance in the test.
//
// All three helpers are stateless and side-effect free so the
// SDK, the API, and the dashboard can reach the exact same answer
// from any context.

const BUCKET_COUNT = 10_000;

/**
 * Hash `(subscriberId, seed)` to a bucket in `[0, 9999]`.
 * Same inputs always produce the same bucket — this is the
 * stickiness guarantee that keeps a user in one variant across
 * every config fetch.
 */
export function assignBucket(subscriberId: string, seed: string): number {
  const digest = createHash("sha256")
    .update(`${subscriberId}:${seed}`)
    .digest();
  // First 4 bytes as big-endian u32 → mod into the bucket space.
  // readUInt32BE on a Buffer is how Node exposes the read — it
  // returns a plain number in [0, 2^32).
  const hash = digest.readUInt32BE(0);
  return hash % BUCKET_COUNT;
}

/**
 * Pick a variant from a weighted list given a pre-computed bucket
 * in `[0, 9999]`. Weights are treated as fractions (summing to 1)
 * and mapped onto the bucket space in order. Assumes weights are
 * pre-validated upstream (see @rovenue/shared experimentSchema).
 */
export function selectVariant<T extends { weight: number }>(
  bucket: number,
  variants: readonly T[],
): T {
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight * BUCKET_COUNT;
    // Round the boundary because JS FP makes `0.34 * 10000` equal
    // `3400.0000000000005`, which would push bucket 3400 into the
    // previous slot. Boundaries must be discrete integers.
    if (bucket < Math.round(cumulative)) return variant;
  }
  // Fall through — floating-point round-off on the final variant.
  return variants[variants.length - 1]!;
}

/**
 * True if a subscriber is inside the given rollout fraction.
 * `percentage` is `0..1` (e.g. `0.1` = 10%).
 */
export function isInRollout(
  subscriberId: string,
  seed: string,
  percentage: number,
): boolean {
  if (percentage <= 0) return false;
  if (percentage >= 1) return true;
  const bucket = assignBucket(subscriberId, seed);
  return bucket < percentage * BUCKET_COUNT;
}
```

- [ ] **Step 2: Run the non-parity tests to confirm the determinism/uniformity/variant-split tests pass**

Run: `pnpm --filter @rovenue/shared test bucketing -t "assignBucket|selectVariant|isInRollout"`
Expected: the determinism, boundary, uniformity, and rollout-percentage tests pass. The parity-vector `test.each` still fails because the JSON file doesn't exist yet — that's expected. The `-t` filter matches on describe/test names so the parity block (titled "assignBucket — parity vectors") is skipped.

If the "uniformly distributed" or "weight-proportional counts" tests fail, the modulo bias on SHA-256's first 32 bits is showing through — but the ±5% and ±2% tolerances in the tests were chosen for exactly this algorithm, so a failure means the implementation is genuinely wrong. Verify `readUInt32BE(0)` (not `readUInt32LE`) and `% BUCKET_COUNT` (not `/`).

### Task 2.3: Generate and commit parity vectors

**Files:**
- Create: `packages/shared/src/experiments/bucketing-parity-vectors.json`

- [ ] **Step 1: Write a one-off generator script**

The parity vectors are whatever the new implementation produces for a fixed input set. Rather than computing them by hand, use the implementation we just wrote to generate them — the file becomes a snapshot of the algorithm's output at this point in time.

Create a throwaway script at `packages/shared/scripts/generate-parity-vectors.ts` with this content:

```typescript
import { writeFileSync } from "node:fs";
import { assignBucket } from "../src/experiments/bucketing";

// Fixed input set covering:
//   - Short + long subscriber ids
//   - UUID-shaped ids
//   - Unicode ids (RN apps send these — e.g. appUserId from device name)
//   - Empty-ish edge cases
//   - Multiple seeds per subscriber (proves seed varies the output)
const inputs: Array<{ subscriberId: string; seed: string }> = [
  { subscriberId: "sub_1", seed: "paywall-summer" },
  { subscriberId: "sub_2", seed: "paywall-summer" },
  { subscriberId: "sub_3", seed: "paywall-summer" },
  { subscriberId: "sub_4", seed: "trial-length-v2" },
  { subscriberId: "sub_5", seed: "trial-length-v2" },
  { subscriberId: "anon_01234567-89ab-cdef-0123-456789abcdef", seed: "onboarding-flow" },
  { subscriberId: "anon_fedcba98-7654-3210-fedc-ba9876543210", seed: "onboarding-flow" },
  { subscriberId: "user_short", seed: "a" },
  { subscriberId: "user_short", seed: "b" },
  { subscriberId: "user_short", seed: "c" },
  { subscriberId: "user_with_email_like_id@example.com", seed: "paywall-summer" },
  { subscriberId: "🔥🚀", seed: "emoji-bucket" },
  { subscriberId: "用户_中文", seed: "i18n-bucket" },
  { subscriberId: "x", seed: "single-char-id" },
  { subscriberId: "a".repeat(256), seed: "long-id" },
  { subscriberId: "same_sub", seed: "seed_1" },
  { subscriberId: "same_sub", seed: "seed_2" },
  { subscriberId: "same_sub", seed: "seed_3" },
  { subscriberId: "same_sub", seed: "seed_4" },
  { subscriberId: "same_sub", seed: "seed_5" },
  { subscriberId: "rollout_test_a", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_b", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_c", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_d", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_e", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_f", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_g", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_h", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_i", seed: "flag-rollout-50" },
  { subscriberId: "rollout_test_j", seed: "flag-rollout-50" },
  { subscriberId: "", seed: "empty-subscriber-id" },
  { subscriberId: "no-seed", seed: "" },
];

const vectors = inputs.map((i) => ({
  subscriberId: i.subscriberId,
  seed: i.seed,
  bucket: assignBucket(i.subscriberId, i.seed),
}));

const outPath = new URL("../src/experiments/bucketing-parity-vectors.json", import.meta.url);
writeFileSync(outPath, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`Wrote ${vectors.length} vectors to ${outPath.pathname}`);
```

- [ ] **Step 2: Run the generator**

From the repo root:

```bash
pnpm --filter @rovenue/shared exec tsx scripts/generate-parity-vectors.ts
```

Expected: `Wrote 32 vectors to /.../packages/shared/src/experiments/bucketing-parity-vectors.json`. The JSON file now exists on disk.

If `tsx` is not installed in the shared package, `pnpm --filter @rovenue/shared exec` will fall back to the workspace root's tsx — it's already available via `apps/api` (used by `packages/db/scripts/verify-timescale.ts`). If the command errors with "tsx: command not found", run `pnpm exec tsx packages/shared/scripts/generate-parity-vectors.ts` from the repo root instead.

- [ ] **Step 3: Delete the generator script — it's a one-off**

```bash
rm packages/shared/scripts/generate-parity-vectors.ts
rmdir packages/shared/scripts
```

The JSON file is the durable artifact; the generator is disposable. Keeping it in-tree would tempt a future reader to re-run it, which would silently regenerate the vectors and defeat the entire point of the parity test.

- [ ] **Step 4: Run the full bucketing test suite**

Run: `pnpm --filter @rovenue/shared test bucketing`
Expected: every test passes — determinism, uniformity, variant split, rollout percentage, and all 32 parity vectors.

- [ ] **Step 5: Commit — shared bucketing implementation plus frozen parity vectors**

```bash
git add packages/shared/src/experiments/bucketing.ts \
        packages/shared/src/experiments/bucketing.test.ts \
        packages/shared/src/experiments/bucketing-parity-vectors.json
git commit -m "$(cat <<'EOF'
feat(shared): add SHA-256 bucketing with frozen parity vectors

Implements spec §13.4 — SHA-256 over ${subId}:${seed} into a 10,000
bucket space, same API surface as the legacy murmur3 module. 32
parity vectors lock the exact outputs so any future hash change has
to bump hashVersion instead of silently drifting assignments.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4: Rewire the engines to import bucketing from shared, delete the in-tree module

**Files:**
- Modify: `apps/api/src/services/flag-engine.ts:2`
- Modify: `apps/api/src/services/experiment-engine.ts:19`
- Delete: `apps/api/src/lib/bucketing.ts`
- Delete: `apps/api/tests/bucketing.test.ts`
- Modify: `apps/api/package.json` (remove `murmurhash-js` dependency if unused)

- [ ] **Step 1: Rewrite the flag-engine import**

Open `apps/api/src/services/flag-engine.ts`. Replace line 2:

```typescript
import { isInRollout } from "../lib/bucketing";
```

with:

```typescript
import { isInRollout } from "@rovenue/shared";
```

- [ ] **Step 2: Rewrite the experiment-engine import**

Open `apps/api/src/services/experiment-engine.ts`. Replace line 19:

```typescript
import { assignBucket, selectVariant } from "../lib/bucketing";
```

with:

```typescript
import { assignBucket, selectVariant } from "@rovenue/shared";
```

- [ ] **Step 3: Delete the in-tree bucketing module and its tests**

```bash
rm apps/api/src/lib/bucketing.ts apps/api/tests/bucketing.test.ts
```

- [ ] **Step 4: Check whether `murmurhash-js` has any remaining importers in apps/api**

Run: `grep -rn "murmurhash" apps/api/src apps/api/tests`
Expected: no matches. If matches appear, they're a surprise — investigate and resolve before removing the dep. The only known importer was the bucketing.ts we just deleted.

- [ ] **Step 5: Remove `murmurhash-js` from apps/api dependencies**

Open `apps/api/package.json` and delete the `"murmurhash-js": "..."` line from `dependencies`. Then:

```bash
pnpm install
```

Expected: pnpm updates the lockfile to drop `murmurhash-js`. If the lockfile still references it under some other package's transitive deps, that's fine — we're only cleaning up the direct dependency.

- [ ] **Step 6: Run the full api test suite**

Run: `pnpm --filter @rovenue/api test`
Expected: all tests pass. `flag-engine.test.ts` and `experiment-engine.test.ts` are the ones that exercise the new shared bucketing transitively. Note that **any test that hardcoded a murmur3 bucket value will fail** — the new SHA-256 outputs are different. If such tests exist, they're evidence of a test pinning implementation details rather than behaviour; update them to compare bucket equality (`expect(assignBucket(...)).toBe(assignBucket(...))`) rather than absolute values.

Pre-check: before running the full suite, grep for hardcoded bucket numbers in the engine tests:

Run: `grep -rn "assignBucket\|bucket.*=.*[0-9]\{3,4\}" apps/api/tests/flag-engine.test.ts apps/api/tests/experiment-engine.test.ts`
Expected: no lines that assert a specific integer bucket value against `assignBucket(...)`. Spot-reviewing the engine tests confirms they test routing decisions (which variant/rule matched, what was written to the DB) rather than the numeric bucket — that was the whole point of `selectVariant` being deterministic given a bucket input. If a test *does* assert a numeric bucket, flag it before Step 7 and update it.

- [ ] **Step 7: Commit — api now consumes shared bucketing, murmurhash dropped**

```bash
git add apps/api/src/services/flag-engine.ts \
        apps/api/src/services/experiment-engine.ts \
        apps/api/src/lib/bucketing.ts \
        apps/api/tests/bucketing.test.ts \
        apps/api/package.json \
        pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
refactor(api): consume shared SHA-256 bucketing, drop murmurhash-js

Both engines now import assignBucket / selectVariant / isInRollout
from @rovenue/shared. The apps/api copies are removed and the
murmurhash-js direct dependency is dropped. Sticky assignment is
unaffected — the experimentAssignments UNIQUE index means existing
assignments keep returning through the sticky lookup path; new
assignments use the SHA-256 bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Schema: `hashVersion` column

The column records which bucketing algorithm produced each assignment. Every row written by this plan gets `hashVersion = 1`. Future algorithm changes bump the version so the engine can fall back to the old algorithm (when that work lands) without corrupting live assignments.

### Task 3.1: Write the failing schema test

**Files:**
- Modify: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Locate the existing test for experimentAssignments**

Run: `grep -n "experimentAssignments" packages/db/src/drizzle/drizzle-foundation.test.ts`
Expected: at least one reference. This is where the new pinning test goes — right next to the existing column shape assertions.

If the file has no existing `experimentAssignments` test, add a new `describe("experimentAssignments schema")` block at the end of the file (before the final closing brace). If it does, extend the existing block.

- [ ] **Step 2: Add the column pinning test**

Inside the appropriate `describe` block, add:

```typescript
test("experimentAssignments has hashVersion column with default 1", () => {
  const col = experimentAssignments.hashVersion;
  expect(col).toBeDefined();
  // Pin the Postgres column name — snake_case in SQL, camelCase in TS.
  expect(col.name).toBe("hashVersion");
  // smallint is the narrowest sensible width; default 1 means every
  // row written today reflects the SHA-256 algorithm chosen in
  // spec §13.4.
  expect((col as unknown as { notNull?: boolean }).notNull).toBe(true);
  expect((col as unknown as { hasDefault?: boolean }).hasDefault).toBe(true);
});
```

If `experimentAssignments` is not yet imported at the top of the test file, add:

```typescript
import { experimentAssignments } from "./schema";
```

(or extend an existing `./schema` import to include it.)

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm --filter @rovenue/db test -t "hashVersion"`
Expected: FAIL with "Cannot read properties of undefined (reading 'name')" or "col is undefined" — because the column doesn't exist in schema.ts yet. That's the red bar.

### Task 3.2: Add the column to the Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:698-735`

- [ ] **Step 1: Add `smallint` to the pg-core import**

At the top of `packages/db/src/drizzle/schema.ts`, find the import from `drizzle-orm/pg-core`. Add `smallint` to the named imports if not already present.

Run: `grep -n "smallint" packages/db/src/drizzle/schema.ts`
If no matches, the import needs to grow. The import is a multi-line named import list somewhere near the top — add `smallint` alphabetically (between `serial` and `text` typically).

- [ ] **Step 2: Add the column to the table definition**

In the `experimentAssignments` definition (around line 698-735), add the new column right after `variantId` so the logical grouping (experiment-side fields before assignment-lifecycle fields) stays clean:

```typescript
variantId: text("variantId").notNull(),
hashVersion: smallint("hashVersion").notNull().default(1),
assignedAt: timestamp("assignedAt", { withTimezone: true })
  .notNull()
  .defaultNow(),
```

- [ ] **Step 3: Run the pinning test again**

Run: `pnpm --filter @rovenue/db test -t "hashVersion"`
Expected: PASS.

- [ ] **Step 4: Run the full db test suite to confirm nothing else broke**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass.

### Task 3.3: Author the SQL migration

**Files:**
- Create: `packages/db/drizzle/migrations/0008_experiment_assignments_hash_version.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

- [ ] **Step 1: Write the SQL migration**

Create `packages/db/drizzle/migrations/0008_experiment_assignments_hash_version.sql` with this content:

```sql
-- Records which bucketing algorithm produced each row. Spec §13.7:
-- pre-launch cutover from murmur3 to SHA-256 means every row
-- written today is SHA-256, hence the default. Future algorithm
-- changes ship a new version number; the engine keeps a fallback
-- table {version → hash fn} so live assignments don't break.
--
-- smallint fits us for ~32k distinct hash versions, which is many
-- more than anyone will ever introduce.
--
-- No backfill needed: rovenue is pre-launch, experiment_assignments
-- is empty.

ALTER TABLE "experiment_assignments"
  ADD COLUMN "hashVersion" smallint NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Append the journal entry**

Open `packages/db/drizzle/migrations/meta/_journal.json`. The `entries` array currently ends at index 7. Add a new object at the end of the array (immediately before the closing `]`) matching the established shape:

```json
    {
      "idx": 8,
      "version": "7",
      "when": <CURRENT_MS_TIMESTAMP>,
      "tag": "0008_experiment_assignments_hash_version",
      "breakpoints": true
    }
```

Replace `<CURRENT_MS_TIMESTAMP>` with the actual ms-since-epoch value. Get it from:

Run: `node -e "console.log(Date.now())"`

And paste the output (e.g. `1777234567890`). The value only needs to be larger than the previous entry's `when`; that's how `_journal.json` orders migrations.

Do NOT run `drizzle-kit generate`. It will try to regenerate the full migration history from the schema, which would diverge from the hand-authored hypertable migrations and corrupt the journal. This is the same constraint the TimescaleDB plan called out — see `docs/superpowers/plans/2026-04-23-timescaledb.md` testing conventions.

- [ ] **Step 3: Apply the migration to the local database**

Run: `pnpm --filter @rovenue/db db:migrate`
Expected: `0008_experiment_assignments_hash_version` runs without error and appears in the `__drizzle_migrations` table.

- [ ] **Step 4: Verify with psql**

Run: `docker compose exec db psql -U rovenue -d rovenue -c "\d experiment_assignments"`
Expected output includes:

```
 hashVersion | smallint | not null | 1
```

(or similar — the exact format varies by psql version, but `hashVersion`, `smallint`, `not null`, default `1` must all be visible.)

If the connect string (`-U rovenue -d rovenue`) doesn't match your docker-compose.yml, adjust to match the actual service + database names used in `deploy/docker-compose.yml`.

### Task 3.4: Extend the repository to write `hashVersion`

**Files:**
- Modify: `packages/db/src/drizzle/repositories/experiment-assignments.ts`
- Modify: `apps/api/src/services/experiment-engine.ts:247-251`

- [ ] **Step 1: Read the current repo function signature**

Run: `grep -n "insertAssignmentsSkipDuplicates" packages/db/src/drizzle/repositories/experiment-assignments.ts`

Read the function body starting at the matched line. Expected shape: takes `(db, assignments: Array<{experimentId, subscriberId, variantId}>)`, does `db.insert(experimentAssignments).values(...).onConflictDoNothing()` or similar. Confirm the exact shape — the next step depends on it.

- [ ] **Step 2: Extend the input type to accept an optional hashVersion**

Modify the function so the input shape includes `hashVersion?: number`, defaulting to 1 inside the function body before the insert. The existing callers (only `experiment-engine.ts`) will then be updated to pass `hashVersion: 1` explicitly once in Step 4 — not required for correctness (the default handles it) but worth doing so the caller documents the invariant.

The precise edit depends on the file's existing shape, which you confirmed in Step 1. Example shape if the function looks like:

```typescript
export async function insertAssignmentsSkipDuplicates(
  db: Database,
  rows: Array<{
    experimentId: string;
    subscriberId: string;
    variantId: string;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(experimentAssignments)
    .values(rows)
    .onConflictDoNothing();
}
```

Change to:

```typescript
export async function insertAssignmentsSkipDuplicates(
  db: Database,
  rows: Array<{
    experimentId: string;
    subscriberId: string;
    variantId: string;
    hashVersion?: number;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(experimentAssignments)
    .values(
      rows.map((r) => ({
        ...r,
        hashVersion: r.hashVersion ?? 1,
      })),
    )
    .onConflictDoNothing();
}
```

If the real function signature differs (e.g. uses a typed import alias, different conflict handling), adapt the edit to preserve all existing behaviour and only add the `hashVersion` pass-through. Do not refactor unrelated logic.

- [ ] **Step 3: Update the experiment-engine caller to pass `hashVersion: 1` explicitly**

Open `apps/api/src/services/experiment-engine.ts`. Find the block around line 247-251 that builds the `newAssignments` array:

```typescript
newAssignments.push({
  experimentId: exp.id,
  subscriberId,
  variantId: variant.id,
});
```

Change to:

```typescript
newAssignments.push({
  experimentId: exp.id,
  subscriberId,
  variantId: variant.id,
  hashVersion: 1,
});
```

The `1` is a literal, not a constant, on purpose — there's exactly one hash version today, so importing a named constant for it is over-engineering. When a second version lands, introduce the constant and migrate the call site in the same change.

- [ ] **Step 4: Run the db and api test suites**

Run: `pnpm --filter @rovenue/db test && pnpm --filter @rovenue/api test`
Expected: both pass. `experiment-engine.test.ts` is the live check that the caller change holds together; the db-layer pinning test from Task 3.1 covers the schema side.

- [ ] **Step 5: Commit — schema + migration + repo + engine caller together**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/src/drizzle/drizzle-foundation.test.ts \
        packages/db/src/drizzle/repositories/experiment-assignments.ts \
        packages/db/drizzle/migrations/0008_experiment_assignments_hash_version.sql \
        packages/db/drizzle/migrations/meta/_journal.json \
        apps/api/src/services/experiment-engine.ts
git commit -m "$(cat <<'EOF'
feat(db): tag experiment_assignments rows with hashVersion

Adds a smallint hashVersion column (default 1 = SHA-256) so future
hash algorithm changes can ship a new version without corrupting
live assignments. Engine writes the version explicitly on every new
assignment. Spec §13.7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Full-loop verification

No new code — this phase proves the three earlier phases compose without regression.

### Task 4.1: Run every package test

**Files:** none

- [ ] **Step 1: Shared**

Run: `pnpm --filter @rovenue/shared test`
Expected: all tests pass, including the 32 parity vectors and the existing crypto/experiments/dashboard suites.

- [ ] **Step 2: DB**

Run: `pnpm --filter @rovenue/db test`
Expected: all tests pass, including the new `hashVersion` pin.

- [ ] **Step 3: API**

Run: `pnpm --filter @rovenue/api test`
Expected: all tests pass. The big ones to watch are `flag-engine.test.ts` and `experiment-engine.test.ts` — they're the integration surface for the migrated bucketing/targeting. The in-tree `bucketing.test.ts` and `targeting.test.ts` no longer exist; their replacements live in `packages/shared/src/experiments/`.

### Task 4.2: Manual smoke of the engine path

**Files:** none

- [ ] **Step 1: Start the local api in dev mode**

Run: `pnpm dev` (or `pnpm --filter @rovenue/api dev` if the turbo fan-out is too noisy)
Expected: Hono server starts on the configured port without errors.

- [ ] **Step 2: Inspect the `experiment_assignments` table after a test evaluation**

Pick one of the integration test routes that exercises the experiment engine — `apps/api/tests/config-endpoint.test.ts` is a good candidate since its setup creates real experiments and calls the engine. Run it with the live db by setting `DATABASE_URL` to point at docker-compose and running a single test:

Run: `pnpm --filter @rovenue/api test config-endpoint -t "<one of the engine-hitting test names>"`

Then query the local db:

Run: `docker compose exec db psql -U rovenue -d rovenue -c "SELECT \"experimentId\", \"subscriberId\", \"variantId\", \"hashVersion\" FROM experiment_assignments LIMIT 5;"`

Expected: any rows present show `hashVersion = 1`. If no rows appear, the test setup didn't hit the assignment code path — that's fine, the engine tests cover it in isolation; this was just a belt-and-braces check.

If the test harness resets the db per-test (look for `TRUNCATE` or `db.delete(...)` in the global setup), rows may not persist long enough to query. In that case, skip the psql check — Task 4.1's green engine tests are sufficient evidence that the wire is intact.

### Task 4.3: Final commit check — no stray in-tree references

**Files:** none

- [ ] **Step 1: Confirm the in-tree modules are gone**

Run: `ls apps/api/src/lib/bucketing.ts apps/api/src/lib/targeting.ts apps/api/tests/bucketing.test.ts apps/api/tests/targeting.test.ts 2>&1`
Expected: every path returns "No such file or directory". If any still exist, Tasks 1.4 Step 3 or 2.4 Step 3 didn't apply cleanly.

- [ ] **Step 2: Confirm no apps/api import of `../lib/bucketing` or `../lib/targeting` remains**

Run: `grep -rn "from.*lib/bucketing\|from.*lib/targeting" apps/api/src apps/api/tests`
Expected: no matches.

- [ ] **Step 3: Confirm `murmurhash-js` has no importers**

Run: `grep -rn "murmurhash" apps/api packages/shared packages/db`
Expected: no matches.

- [ ] **Step 4: Confirm the shared barrel exposes the five expected functions**

Run: `node -e "const s = require('./packages/shared/src/index.ts'); console.log(Object.keys(s).filter(k => ['assignBucket','selectVariant','isInRollout','matchesAudience','validateAudienceRules'].includes(k)));"`

Expected: `[ 'assignBucket', 'selectVariant', 'isInRollout', 'matchesAudience', 'validateAudienceRules' ]` (order may vary).

If Node complains about importing a TS file directly, run the check through tsx instead: `pnpm exec tsx -e "..."` with the same body.

The branch is ready for review when all four steps pass.

---

## Post-merge followups (informational, not in this plan)

These get tracked as their own plans but are worth noting at the end of this one so the reader understands what's next:

- **Plan B — Delivery backend.** SSE endpoint + Redis pub/sub for config streaming, exposure buffer + `exposure_events` hypertable, stats endpoint (`GET /experiments/:id/results` reshaped to return CUPED + mSPRT + sample-size data). Server-only.
- **Plan C — SDK-RN.** Identity merge (anonymous → authenticated), SSE client with backoff, `getVariant` / `isEnabled`, MMKV offline exposure queue, `size-limit` CI guard. This is where the `@rovenue/shared` bucketing may grow a platform adapter or a parallel pure-JS SHA-256 entrypoint (§13.4 decision).
- **Plan D — Dashboard UI.** Flag editor, experiment editor, targeting rule editor (using the shared `validateAudienceRules`), exclusion group visual allocator, variant weight UI, results view (stratified country/platform breakdown, SRM warning, sample-size progress). UI is intentionally last — all backend contracts must be stable first.
