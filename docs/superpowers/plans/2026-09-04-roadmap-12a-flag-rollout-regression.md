# §12.1 Feature-flag rollout + kill switch: regression test

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the two behavioural properties that make ROADMAP §12's
"percentage rollout + kill switch" checkbox true, so a future refactor of the
flag engine cannot silently break them, then tick the checkbox.

**Architecture:** No production code changes. The capability already exists —
`feature_flags.isEnabled` is the kill switch and per-rule `rolloutPercentage`
is the rollout — but no test asserts either property end-to-end through the
evaluation engine. One new test file closes that gap.

**Tech Stack:** Vitest, `apps/api/tests/` (mocked `@rovenue/db` + Redis, the
pattern already used by `apps/api/tests/flag-engine.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-04-roadmap-12-feature-breadth-design.md`
(Sub-project 1)

## Global Constraints

- TDD: the test is the deliverable here, so it is written first and must be
  seen to pass against unmodified production code. If it fails, that is a
  real bug — stop and report it, do not adjust the test to match.
- No magic values. Population size, the rollout percentages under test and the
  uniformity tolerance are named constants at the top of the file.
- Throttled test runs: `nice -n 19 npx vitest run --maxWorkers=2`.
- Do not modify `apps/api/src/services/flag-engine.ts` or
  `packages/shared/src/experiments/bucketing.ts`.

---

### Task 1: Kill-switch and rollout-monotonicity regression test

**Files:**
- Create: `apps/api/tests/flag-engine.rollout-kill.test.ts`
- Modify: `ROADMAP.md` (tick the §12 checkbox)
- Reference only (do not edit): `apps/api/tests/flag-engine.test.ts` for the
  mock scaffolding, `apps/api/src/services/flag-engine.ts` for behaviour

**Interfaces:**
- Consumes: `evaluateFlag(projectId, env, flagKey, subscriberId, attributes)`
  and `evaluateAllFlags(projectId, env, subscriberId, attributes)` from
  `apps/api/src/services/flag-engine`. Both are `async` and return `unknown` /
  `Record<string, unknown>` respectively.
- Consumes: the flag row shape the engine reads —
  `{ id, key, isEnabled, defaultValue, rules }` where each rule is
  `{ audienceId?, conditions?, value, rolloutPercentage? }` and
  `rolloutPercentage` is a fraction in `0..1` (not a percent).
- Produces: nothing other tasks depend on. This plan is a single task.

**Background the implementer needs:**

The engine salts each rule's rollout seed with the rule's index:
`isInRollout(subscriberId, \`${flag.key}:${ruleIndex}\`, rule.rolloutPercentage)`.
That matters for the monotonicity test — comparing a 30% rule against a 60%
rule only tests monotonicity if both sit at the **same rule index**, i.e. in
separate flags with the same key, not as two rules of one flag.

`isInRollout` is `assignBucket(...) < percentage * 10_000` over a SHA-256 hash,
so the admitted set at a higher percentage is a strict superset by
construction. The test asserts that property rather than re-deriving the hash.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/flag-engine.rollout-kill.test.ts`. The hoisted-mock
block mirrors `flag-engine.test.ts`; it is repeated here in full rather than
imported, because vitest's `vi.hoisted` + `vi.mock` must be declared in the
file that uses them.

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks — db + redis (mirrors flag-engine.test.ts)
// =============================================================

const { dbMock, drizzleMock, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();

  const redisMock = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    publish: vi.fn(async () => 1),
  };

  const dbMock = {
    featureFlag: { findMany: vi.fn(async () => [] as unknown[]) },
    audience: { findMany: vi.fn(async () => [] as unknown[]) },
  };

  const drizzleMock = {
    db: {} as unknown,
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => dbMock.featureFlag.findMany()),
      findAudiencesByProject: vi.fn(async () => dbMock.audience.findMany()),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>): Promise<T> => primary(),
    ),
  };

  return { dbMock, drizzleMock, redisMock, redisStore: store };
});

vi.mock("@rovenue/db", () => ({
  default: dbMock,
  drizzle: drizzleMock,
  FeatureFlagEnv: {
    PROD: "PROD",
    STAGING: "STAGING",
    DEVELOPMENT: "DEVELOPMENT",
  },
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

import {
  evaluateAllFlags,
  evaluateFlag,
  invalidateFlagCache,
} from "../src/services/flag-engine";

// =============================================================
// Constants
// =============================================================

const PROJECT_ID = "prj_rollout_kill";
const ENV = "PROD" as const;
const FLAG_KEY = "staged_feature";
const DEFAULT_VALUE = "off";
const RULE_VALUE = "on";

/** Population large enough that a subset relation is meaningful rather
 *  than coincidental at 10,000-bucket precision. */
const POPULATION_SIZE = 500;

/** Ascending rollout fractions. Each admitted set must contain the one
 *  before it. */
const ROLLOUT_STEPS = [0.3, 0.6, 1] as const;

function subscriberIds(): string[] {
  return Array.from(
    { length: POPULATION_SIZE },
    (_unused, i) => `sub_${i.toString().padStart(4, "0")}`,
  );
}

function flagRow(overrides: {
  isEnabled?: boolean;
  rolloutPercentage?: number | null;
}) {
  return {
    id: "flg_1",
    key: FLAG_KEY,
    isEnabled: overrides.isEnabled ?? true,
    defaultValue: DEFAULT_VALUE,
    rules: [
      {
        value: RULE_VALUE,
        rolloutPercentage: overrides.rolloutPercentage ?? null,
      },
    ],
  };
}

function seedFlag(row: ReturnType<typeof flagRow>): void {
  dbMock.featureFlag.findMany.mockResolvedValue([row]);
  dbMock.audience.findMany.mockResolvedValue([]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await invalidateFlagCache(PROJECT_ID);
});

// =============================================================
// 1. Kill switch dominates every rule
// =============================================================

describe("kill switch", () => {
  test("evaluateFlag returns the default when the flag is disabled, even though a rule matches at 100%", async () => {
    seedFlag(flagRow({ isEnabled: false, rolloutPercentage: 1 }));

    const result = await evaluateFlag(
      PROJECT_ID,
      ENV,
      FLAG_KEY,
      "sub_0000",
      {},
    );

    expect(result).toBe(DEFAULT_VALUE);
  });

  test("evaluateFlag returns the rule value once the same flag is enabled", async () => {
    seedFlag(flagRow({ isEnabled: true, rolloutPercentage: 1 }));

    const result = await evaluateFlag(
      PROJECT_ID,
      ENV,
      FLAG_KEY,
      "sub_0000",
      {},
    );

    // Guards against the disabled assertion above passing for the wrong
    // reason (e.g. the rule never matching at all).
    expect(result).toBe(RULE_VALUE);
  });

  test("evaluateAllFlags omits a disabled flag entirely", async () => {
    seedFlag(flagRow({ isEnabled: false, rolloutPercentage: 1 }));

    const all = await evaluateAllFlags(PROJECT_ID, ENV, "sub_0000", {});

    // A separate code path from evaluateFlag: it skips disabled flags
    // rather than returning their default.
    expect(all).not.toHaveProperty(FLAG_KEY);
  });
});

// =============================================================
// 2. Rollout is monotone — raising the percentage only ever adds
// =============================================================

describe("rollout monotonicity", () => {
  async function admittedAt(percentage: number): Promise<Set<string>> {
    seedFlag(flagRow({ isEnabled: true, rolloutPercentage: percentage }));
    await invalidateFlagCache(PROJECT_ID);

    const admitted = new Set<string>();
    for (const id of subscriberIds()) {
      const value = await evaluateFlag(PROJECT_ID, ENV, FLAG_KEY, id, {});
      if (value === RULE_VALUE) admitted.add(id);
    }
    return admitted;
  }

  test("each rollout step is a superset of the one below it", async () => {
    const sets: Set<string>[] = [];
    for (const step of ROLLOUT_STEPS) {
      sets.push(await admittedAt(step));
    }

    for (let i = 1; i < sets.length; i += 1) {
      const smaller = sets[i - 1]!;
      const larger = sets[i]!;
      const evicted = [...smaller].filter((id) => !larger.has(id));

      // The property that makes a staged rollout safe: nobody who has
      // already seen the feature loses it when the percentage goes up.
      expect(evicted).toEqual([]);
      expect(larger.size).toBeGreaterThanOrEqual(smaller.size);
    }
  });

  test("100% admits the whole population and 0% admits nobody", async () => {
    const all = await admittedAt(1);
    expect(all.size).toBe(POPULATION_SIZE);

    const none = await admittedAt(0);
    expect(none.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
nice -n 19 npx vitest run apps/api/tests/flag-engine.rollout-kill.test.ts --maxWorkers=2
```

Expected: **PASS**, all five tests.

This is the one place in this repo where a passing test on the first run is the
correct outcome — the capability already exists and the test documents it. If
anything **fails**, do not edit the test to make it green. A failure means the
kill switch or the rollout is genuinely broken; stop and report which
assertion failed and what it returned.

- [ ] **Step 3: Tick the ROADMAP checkbox**

In `ROADMAP.md`, under `## 12. Feature breadth (85 → 95)`, change:

```markdown
- [ ] Feature flags: percentage rollout + kill switch
```

to:

```markdown
- [x] Feature flags: percentage rollout + kill switch — already implemented
      (`isEnabled` kill switch + per-rule `rolloutPercentage` through
      `isInRollout`); regression-tested in
      `apps/api/tests/flag-engine.rollout-kill.test.ts` (2026-09-04)
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/flag-engine.rollout-kill.test.ts ROADMAP.md
git commit -m "test(flags): pin kill-switch dominance and rollout monotonicity

ROADMAP §12's rollout + kill-switch item was already implemented but
neither property was asserted end-to-end through the evaluation engine.
Closes the checkbox with the test that keeps it true."
```
