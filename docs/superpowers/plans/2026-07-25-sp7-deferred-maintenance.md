# SP7 — Deferred Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four items SP5 and SP6 deferred: repair stored numeric operands that now block publish, delete a dead third operator vocabulary, fix a diagnosed test flake, and make `duplicatePage` reachable.

**Architecture:** Four independent tasks. Task 1 is a versioned SQL data migration plus a repeatable audit script in `packages/db`; Task 2 is a type deletion in the dashboard verified by `tsc`; Task 3 removes a per-request module re-import in an API test; Task 4 adds the builder's first per-page action affordance.

**Tech Stack:** PostgreSQL 16 + Drizzle (raw SQL migration), TypeScript strict, Vitest (+ real Postgres for the migration test), React.

## Global Constraints

- **Stay on branch `main`. Never create, switch, or delete branches or worktrees.**
- A parallel author commits to `main`. Run `git status --short` before every commit and `git add` **only** the files that task names. Never `git add -A`, `git add .`, or `git commit -a`.
- `.superpowers/` is gitignored — never force-add it.
- TypeScript strict. Zod for API input. Postgres via Drizzle only; raw SQL only in migrations or via the `sql` template.
- **No magic values** — thresholds and repeated literals become named constants. Structured data tables and SQL literals inside a migration are not magic values.
- **Mutation-check every behavioural change:** after the test passes, revert the production change **by hand-editing it back**, confirm the test goes red, then hand-edit it forward. Never use `git checkout` or `git stash` to revert — that has destroyed uncommitted work on this project.
- Run all suites in the **FOREGROUND** with a generous timeout. Never background a suite and then wait on it.
- Known pre-existing red, **not** this work's fault: `FunnelPreviewViewModel > jumps via 'paywall' literal goto` in the dashboard.
- `@rovenue/db` tests need `DATABASE_URL` exported in the shell.
- Line numbers in this plan may have drifted (a parallel author is editing these files). **Locate code by content, not by line number**, and say so in your report if it moved.

---

### Task 1: Coerce stored numeric operands, and ship a repeatable audit

**Why this exists:** SP5 added a schema guard requiring `gt`/`gte`/`lt`/`lte` operands to be numbers, but the defect SP5 fixed was that the editor *always wrote them as strings*. `pagesArraySchema.safeParse` runs on the **publish** path over the **stored** draft (`apps/api/src/routes/dashboard/funnels.ts:338`), so every pre-SP5 funnel with a numeric comparison rule now fails to publish. Coercing the stored value both unblocks publish and makes the rule finally do what its author wrote.

**Files:**
- Create: `packages/db/drizzle/migrations/0095_coerce_funnel_numeric_operands.sql`
- Create: `packages/db/scripts/audit-funnel-clause-operands.ts`
- Create: `packages/db/src/drizzle/repositories/funnel-operand-coercion.integration.test.ts`
- Modify: `packages/db/package.json` (add the `db:audit:funnel-operands` script)

**Interfaces:**
- Consumes: `funnels.draft_pages_json` and `funnel_versions.pages_json` (both `jsonb`), and `pagesArraySchema` from `@rovenue/shared/funnel` for the publishability assertion.
- Produces: migration `0095`, and the npm script `db:audit:funnel-operands`.

**Rule shape being rewritten** (needed to follow the SQL): each element of the pages array may carry `next_rules: NextRule[]`; each rule has `condition.clauses: Clause[]`; each clause has `op` and `value`. So the JSON path to a value is
`pages[pi] → next_rules[ri] → condition → clauses[ci] → value`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/funnel-operand-coercion.integration.test.ts`:

```ts
// =============================================================
// Migration 0095 — coerce stored numeric clause operands.
// Real Postgres. The test EXECUTES THE MIGRATION FILE ITSELF so the
// assertion and the shipped SQL cannot drift apart.
// =============================================================

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, funnels, funnelVersions } from "../schema";
import { pagesArraySchema } from "@rovenue/shared/funnel";

const RUN_ID = Date.now();
const db = getDb();

const MIGRATION = readFileSync(
  join(__dirname, "../../../drizzle/migrations/0095_coerce_funnel_numeric_operands.sql"),
  "utf8",
);

/** One page carrying four clauses, each a distinct case the migration must handle. */
function pagesFixture() {
  return [
    {
      id: "pg_1",
      type: "number_input",
      question_id: "q_num",
      next_rules: [
        {
          id: "r_1",
          condition: {
            op: "all",
            clauses: [
              // 1. the regression case: numeric operand stored as a string
              { question_id: "q_num", op: "gt", value: "5" },
              // 2. between with string bounds
              { question_id: "q_num", op: "between", value: ["1", "10"] },
              // 3. NOT coercible — must be left exactly as-is, never dropped
              { question_id: "q_num", op: "lt", value: "abc" },
              // 4. already correct — must come back byte-identical
              { question_id: "q_num", op: "gte", value: 3 },
            ],
          },
          goto: "pg_2",
        },
      ],
    },
    { id: "pg_2", type: "info", title: { en: "Done" } },
  ];
}

let projectId: string;
let funnelId: string;

beforeAll(async () => {
  const [project] = await db.insert(projects).values({ name: `sp7-${RUN_ID}` }).returning();
  projectId = project!.id;

  const [funnel] = await db
    .insert(funnels)
    .values({
      projectId,
      slug: `sp7-${RUN_ID}`,
      name: "SP7 operand coercion",
      draftPagesJson: pagesFixture(),
    })
    .returning();
  funnelId = funnel!.id;

  await db.insert(funnelVersions).values({
    funnelId,
    versionNo: 1,
    pagesJson: pagesFixture(),
    themeJson: {},
    settingsJson: {},
  });
});

afterAll(async () => {
  await db.delete(funnelVersions).where(eq(funnelVersions.funnelId, funnelId));
  await db.delete(funnels).where(eq(funnels.id, funnelId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

function clausesOf(pages: unknown) {
  const page = (pages as Array<Record<string, never>>)[0]!;
  return (page as never as { next_rules: Array<{ condition: { clauses: Array<{ op: string; value: unknown }> } }> })
    .next_rules[0]!.condition.clauses;
}

describe("migration 0095 — numeric operand coercion", () => {
  it("the pre-migration draft FAILS pagesArraySchema — the reason this migration exists", async () => {
    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    expect(pagesArraySchema.safeParse(row!.draftPagesJson).success).toBe(false);
  });

  it("coerces numeric strings, leaves non-numeric alone, and makes the draft publishable", async () => {
    await db.execute(sql.raw(MIGRATION));

    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    const clauses = clausesOf(row!.draftPagesJson);

    expect(clauses[0]!.value, "gt string was not coerced").toBe(5);
    expect(clauses[1]!.value, "between bounds were not coerced").toEqual([1, 10]);
    // Guessing at intent is worse than leaving it: untouched, and NOT dropped.
    expect(clauses[2]!.value, "non-numeric operand must be left as-is").toBe("abc");
    expect(clauses[3]!.value, "already-numeric operand must be untouched").toBe(3);
    expect(clauses, "a clause was dropped").toHaveLength(4);

    // The whole point of the item: publish is unblocked for the coercible part.
    // Clause 3 is still invalid, which is correct — nobody can know what "abc" meant.
    const stillInvalid = pagesArraySchema.safeParse(row!.draftPagesJson);
    expect(stillInvalid.success).toBe(false);

    // Remove only the un-guessable clause; now it must parse.
    const repaired = structuredClone(row!.draftPagesJson) as never as ReturnType<typeof pagesFixture>;
    const rules = (repaired[0] as never as { next_rules: Array<{ condition: { clauses: unknown[] } }> }).next_rules;
    rules[0]!.condition.clauses.splice(2, 1);
    expect(pagesArraySchema.safeParse(repaired).success, "coerced clauses still fail").toBe(true);
  });

  it("also coerces the PUBLISHED store, not just the draft", async () => {
    const [ver] = await db
      .select()
      .from(funnelVersions)
      .where(eq(funnelVersions.funnelId, funnelId));
    const clauses = clausesOf(ver!.pagesJson);
    expect(clauses[0]!.value).toBe(5);
    expect(clauses[1]!.value).toEqual([1, 10]);
  });

  it("is idempotent — running it twice changes nothing", async () => {
    const [before] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    await db.execute(sql.raw(MIGRATION));
    const [after] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    expect(after!.draftPagesJson).toEqual(before!.draftPagesJson);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export DATABASE_URL="postgres://rovenue:rovenue@localhost:5432/rovenue"
pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/funnel-operand-coercion.integration.test.ts
```
Expected: FAIL — `ENOENT` on `0095_coerce_funnel_numeric_operands.sql`, because the migration does not exist yet.

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/migrations/0095_coerce_funnel_numeric_operands.sql`:

```sql
-- =============================================================
-- Coerce stored numeric clause operands from string to number.
--
-- WHY: the rule editor used to write every operand as a string, while
-- the evaluator requires `typeof value === "number"` for gt/gte/lt/lte.
-- Those rules could never fire. When the branching schema gained a
-- numeric operand guard, the same rows also began FAILING PUBLISH
-- (pagesArraySchema runs over the stored draft on the publish path), so
-- a previously-publishable funnel became unpublishable.
--
-- Coercing repairs both: publish unblocks, and the rule finally does
-- what its author wrote. Consequence, stated rather than buried: a rule
-- that never fired starts firing, so a live funnel's routing changes —
-- toward the authored intent.
--
-- Only strings that are plainly finite numbers are touched. Anything
-- else ("abc", null, "1e5") is left EXACTLY as it is and never dropped:
-- guessing at intent is worse than leaving a row for the audit script
-- (`pnpm --filter @rovenue/db db:audit:funnel-operands`) to report.
--
-- Idempotent: already-numeric values are not matched, so re-running is
-- a no-op.
-- =============================================================

-- Conservative "is this a plain finite number" test. Deliberately
-- excludes exponent form, whitespace and Infinity/NaN so that anything
-- ambiguous falls through to the audit instead of being guessed at.
CREATE OR REPLACE FUNCTION rovenue_sp7_numeric_str(v jsonb) RETURNS boolean AS $$
  SELECT jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$';
$$ LANGUAGE sql IMMUTABLE;

-- Rewrites every clause operand inside one pages-JSON document.
CREATE OR REPLACE FUNCTION rovenue_sp7_coerce_pages(pages jsonb) RETURNS jsonb AS $$
DECLARE
  pi int; ri int; ci int;
  clause jsonb;
  op text;
  val jsonb;
  bounds jsonb;
  bi int;
  path text[];
BEGIN
  IF pages IS NULL OR jsonb_typeof(pages) <> 'array' THEN
    RETURN pages;
  END IF;

  FOR pi IN 0 .. jsonb_array_length(pages) - 1 LOOP
    IF jsonb_typeof(pages -> pi -> 'next_rules') <> 'array' THEN
      CONTINUE;
    END IF;

    FOR ri IN 0 .. jsonb_array_length(pages -> pi -> 'next_rules') - 1 LOOP
      IF jsonb_typeof(pages -> pi -> 'next_rules' -> ri -> 'condition' -> 'clauses') <> 'array' THEN
        CONTINUE;
      END IF;

      FOR ci IN 0 .. jsonb_array_length(
                       pages -> pi -> 'next_rules' -> ri -> 'condition' -> 'clauses') - 1 LOOP
        clause := pages -> pi -> 'next_rules' -> ri -> 'condition' -> 'clauses' -> ci;
        op  := clause ->> 'op';
        val := clause -> 'value';
        path := ARRAY[pi::text, 'next_rules', ri::text, 'condition', 'clauses', ci::text, 'value'];

        IF op IN ('gt', 'gte', 'lt', 'lte') AND rovenue_sp7_numeric_str(val) THEN
          pages := jsonb_set(pages, path, to_jsonb((val #>> '{}')::numeric));

        ELSIF op = 'between' AND jsonb_typeof(val) = 'array' THEN
          bounds := val;
          FOR bi IN 0 .. jsonb_array_length(bounds) - 1 LOOP
            IF rovenue_sp7_numeric_str(bounds -> bi) THEN
              bounds := jsonb_set(
                bounds, ARRAY[bi::text],
                to_jsonb((bounds -> bi #>> '{}')::numeric));
            END IF;
          END LOOP;
          IF bounds <> val THEN
            pages := jsonb_set(pages, path, bounds);
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN pages;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE funnels
SET draft_pages_json = rovenue_sp7_coerce_pages(draft_pages_json)
WHERE draft_pages_json IS DISTINCT FROM rovenue_sp7_coerce_pages(draft_pages_json);

UPDATE funnel_versions
SET pages_json = rovenue_sp7_coerce_pages(pages_json)
WHERE pages_json IS DISTINCT FROM rovenue_sp7_coerce_pages(pages_json);

-- The helpers exist only for this migration; leaving them behind would
-- add permanent surface for a one-off repair.
DROP FUNCTION rovenue_sp7_coerce_pages(jsonb);
DROP FUNCTION rovenue_sp7_numeric_str(jsonb);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/funnel-operand-coercion.integration.test.ts
```
Expected: PASS, 4/4.

If the `drizzle-kit` journal complains that `0095` is unknown, note it in your report — this migration is hand-written (the repo has hand-written migrations already), and `meta/_journal.json` may need the same hand entry the sibling hand-written migrations use. Follow whatever those did; do not invent a new mechanism.

- [ ] **Step 5: Mutation-check the migration**

By hand, change the coercion guard so it never matches: in `rovenue_sp7_numeric_str`, replace the regex with `'^$'`. Re-run Step 4.
Expected: the "coerces numeric strings…" test goes RED on `clauses[0].value` (receives `"5"`, expected `5`).
Restore the regex by hand; re-run; PASS.

Then a second check that the *non-destructive* promise is real: by hand, change the `gt/gte/lt/lte` branch to also fire when `rovenue_sp7_numeric_str` is false (drop the guard). Re-run.
Expected: RED on `clauses[2].value` — `"abc"::numeric` raises `invalid input syntax`, proving the guard is load-bearing rather than decorative.
Restore; re-run; PASS.

- [ ] **Step 6: Write the audit script**

Create `packages/db/scripts/audit-funnel-clause-operands.ts`:

```ts
/**
 * Read-only audit of every branching clause operand stored in Postgres.
 *
 * Point it at any environment via DATABASE_URL. It reports offenders
 * grouped by (source, op, JSON type) AND ALWAYS PRINTS THE DENOMINATOR:
 * "0 offenders out of 0 clauses" says nothing, while "0 out of 4000"
 * is a real all-clear. A local dev database typically holds no clauses
 * at all, which is exactly why a local run cannot answer this question.
 *
 *   pnpm --filter @rovenue/db db:audit:funnel-operands
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/drizzle/client";

const AUDIT = sql`
  WITH all_pages AS (
    SELECT 'draft' AS src, id::text AS funnel_id,
           jsonb_array_elements("funnels"."draft_pages_json") AS page
    FROM "funnels"
    UNION ALL
    SELECT 'published', "funnel_versions"."funnel_id"::text,
           jsonb_array_elements("funnel_versions"."pages_json")
    FROM "funnel_versions"
  ),
  clauses AS (
    SELECT src, funnel_id,
           page ->> 'id'   AS page_id,
           clause ->> 'op' AS op,
           jsonb_typeof(clause -> 'value') AS value_type
    FROM all_pages,
         jsonb_array_elements(COALESCE(page -> 'next_rules', '[]'::jsonb)) AS rule,
         jsonb_array_elements(COALESCE(rule -> 'condition' -> 'clauses', '[]'::jsonb)) AS clause
  )
  SELECT src, op, value_type, count(*)::int AS n,
         (SELECT count(*)::int FROM clauses) AS total_clauses,
         min(funnel_id) AS example_funnel_id,
         min(page_id)   AS example_page_id
  FROM clauses
  WHERE (op IN ('contains','not_contains') AND value_type IS DISTINCT FROM 'string')
     OR (op IN ('gt','gte','lt','lte')     AND value_type IS DISTINCT FROM 'number')
     OR (op = 'between'                    AND value_type IS DISTINCT FROM 'array')
  GROUP BY src, op, value_type
  ORDER BY src, op
`;

const TOTALS = sql`
  WITH all_pages AS (
    SELECT jsonb_array_elements("funnels"."draft_pages_json") AS page FROM "funnels"
    UNION ALL
    SELECT jsonb_array_elements("funnel_versions"."pages_json") FROM "funnel_versions"
  )
  SELECT
    (SELECT count(*)::int FROM "funnels")         AS funnels,
    (SELECT count(*)::int FROM "funnel_versions") AS versions,
    (SELECT count(*)::int FROM all_pages)         AS pages,
    (SELECT count(*)::int
       FROM all_pages,
            jsonb_array_elements(COALESCE(page -> 'next_rules', '[]'::jsonb)) AS rule,
            jsonb_array_elements(COALESCE(rule -> 'condition' -> 'clauses', '[]'::jsonb)) AS clause
    ) AS clauses
`;

async function main() {
  const db = getDb();
  const totals = (await db.execute(TOTALS)).rows[0] as Record<string, number>;
  const offenders = (await db.execute(AUDIT)).rows as Array<Record<string, unknown>>;

  console.log("scope:", JSON.stringify(totals));

  if (totals.clauses === 0) {
    console.log(
      "INCONCLUSIVE: this database stores no branching clauses at all, so a clean " +
        "result here is not evidence. Re-run against an environment that has authored funnels.",
    );
    return;
  }

  if (offenders.length === 0) {
    console.log(`OK: 0 offending operands out of ${totals.clauses} clauses.`);
    return;
  }

  console.log(`FOUND ${offenders.length} offending group(s) out of ${totals.clauses} clauses:`);
  for (const row of offenders) console.log(" ", JSON.stringify(row));
  console.log(
    "\ngt/gte/lt/lte with a string value are repaired by migration 0095. " +
      "Anything still listed after 0095 has run needs an author decision — it cannot be guessed.",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
```

Register it in `packages/db/package.json`'s `scripts`, beside the sibling operational scripts:
```json
"db:audit:funnel-operands": "tsx --env-file-if-exists=../../.env scripts/audit-funnel-clause-operands.ts",
```

- [ ] **Step 7: Run the audit script**

```bash
pnpm --filter @rovenue/db db:audit:funnel-operands
```
Expected on the local dev DB: it prints a `scope:` line and then the **INCONCLUSIVE** message, because the local database holds no clauses. That is the correct output and the point of the denominator — record it verbatim in your report.

- [ ] **Step 8: Commit**

```bash
git status --short
git add packages/db/drizzle/migrations/0095_coerce_funnel_numeric_operands.sql \
        packages/db/scripts/audit-funnel-clause-operands.ts \
        packages/db/src/drizzle/repositories/funnel-operand-coercion.integration.test.ts \
        packages/db/package.json
git commit -m "fix(db): coerce stored numeric clause operands so pre-SP5 funnels publish again"
```
(If `meta/_journal.json` needed a hand entry in Step 4, add that path too.)

---

### Task 2: Delete the third operator vocabulary

**Why this exists:** `funnel-builder/types.ts` still exports a rule vocabulary that predates the shipping one and disagrees with it on every name (`"equals"` vs `"eq"`, `"not_answered"` vs `"is_not_answered"`, `qid` vs `question_id`, `combinator` vs `condition.op`). SP5 spent a CRITICAL finding on two operator tables drifting apart; this is a third in the same file. It is dead: the only other `Operator` in the repo is an unrelated locally-declared SQL-filter type in `components/queries/visual-builder.tsx`, and the only other `Rule[]` is feature-flags' own.

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts` (delete `Operator`, `RuleClause`, `Rule`; retype `Funnel.rules`)

**Interfaces:**
- Consumes: `NextRule` from `@rovenue/shared/funnel` (`branching-schema.ts:98`) — the type the view model and rule editor already use.
- Produces: nothing new; removes three exported names.

- [ ] **Step 1: Prove the names are unused**

```bash
cd /Volumes/Development/rovenue
grep -rn "RuleClause" apps/dashboard/src packages/*/src | grep -v "funnel-builder/types.ts"
grep -rn ": Operator\|<Operator\|Operator\[\]" apps/dashboard/src packages/*/src | grep -v "funnel-builder/types.ts"
```
Expected: the `RuleClause` search returns nothing. The `Operator` search returns exactly one hit, `components/queries/visual-builder.tsx`, which declares **its own** `type Operator = (typeof OPERATORS)[number]` for SQL filters and does not import from `funnel-builder/types`. Confirm that by reading its imports; if it *does* import from funnel-builder, STOP and report — the premise is wrong and the task needs rethinking.

- [ ] **Step 2: Delete the three types and retype the field**

In `apps/dashboard/src/components/funnel-builder/types.ts`, delete the whole `Operator` / `RuleClause` / `Rule` block (locate it by content — it begins `export type Operator =` and ends with the `Rule` declaration's closing brace).

Add `NextRule` to the existing `@rovenue/shared/funnel` type import at the top of the file (there is already an import from that module — extend it rather than adding a second).

Then change the `Funnel` type's rules field from
```ts
  rules: Record<string, Rule[]>;
```
to
```ts
  // The real rule type. Nothing reads this field today — the view model
  // holds rules in `this.rules: Record<string, NextRule[]>` — but typing
  // it as the shipping shape keeps a fourth vocabulary from growing here.
  rules: Record<string, NextRule[]>;
```

- [ ] **Step 3: Verify with the compiler — this is the real gate**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: clean. Deleting a still-referenced exported type cannot pass `tsc`, so a clean run is the proof that the deletion was safe. The five sites that write `rules: {}` keep compiling because `{}` satisfies a `Record`.

- [ ] **Step 4: Confirm the names are gone and the suite is unaffected**

```bash
grep -rn "RuleClause\|combinator" apps/dashboard/src/components/funnel-builder/ || echo "gone"
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
```
Expected: the grep prints `gone`. The suite matches its pre-task result: all green except the known `FunnelPreviewViewModel > jumps via 'paywall' literal goto`.

- [ ] **Step 5: Mutation-check the compiler gate**

The gate here is `tsc`, so prove `tsc` is actually watching. By hand, add `rules: Record<string, Rule[]>;` back (referencing the now-deleted `Rule`) and run `pnpm --filter @rovenue/dashboard exec tsc --noEmit`.
Expected: FAIL with "Cannot find name 'Rule'". Undo the edit by hand; re-run; clean. Record both outcomes.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/types.ts
git commit -m "refactor(dashboard): delete the legacy funnel operator vocabulary"
```

---

### Task 3: Fix the funnel-advance-answer flake at its cause

**Why this exists:** the test calls `vi.resetModules()` in `beforeEach` and then `await import("../src/app")` **inside the per-request helper**, so the entire Hono app graph is re-evaluated on every request. Under concurrent load that import exceeds the default 5 000 ms `testTimeout`; the timed-out test's orphaned `upsertMock` write then completes after the next test's `beforeEach` cleared `answerRows`, breaking that test's "not called" assertion. One slow import, two red tests.

**Files:**
- Modify: `apps/api/tests/funnel-advance-answer.test.ts`

**Interfaces:** none — test-only change.

- [ ] **Step 1: Measure the current cost, so the fix can be proved rather than asserted**

```bash
cd /Volumes/Development/rovenue
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts --reporter=verbose 2>&1 | tail -20
```
Record the per-test durations and the file total verbatim. This is the baseline; the fix must move it.

- [ ] **Step 2: Establish whether `vi.resetModules()` is load-bearing**

Every mock in this file is already reset explicitly (`findSessionById.mockReset()`, `upsertMock.mockReset()`, …), which is the usual reason `resetModules` is not needed. Determine whether the app graph holds module-level state that must be rebuilt per test — this repo does have a frozen-env-at-import pattern elsewhere, so check rather than assume.

Test it directly: hoist the import so it runs **once per test** instead of once per request, keeping `resetModules`:

```ts
  async function advance(body: Record<string, unknown>, sessionId = "session-id") {
    const { createApp } = await import("../src/app");
    const app = createApp();
    …
```
becomes — inside each test, or via a helper that imports once and is called once per test — a single import whose `app` is reused for every request that test makes. Look at how many requests each test actually issues: if every test issues exactly one, then the import count is already one per test and `resetModules` is NOT the problem; in that case the cost is the app graph itself, and the fix is to drop `resetModules()` so the graph is imported **once per file**.

**Report which of the two it is, with the evidence.** Do not guess — this item survived two prior passes precisely because nobody measured it.

- [ ] **Step 3: Apply the fix that your Step 2 evidence supports**

Either:
- **(a)** drop `vi.resetModules()` from `beforeEach` (if the explicit `mockReset()` calls already give each test a clean slate), so `../src/app` is imported once for the whole file; or
- **(b)** if some module-level state genuinely must be rebuilt, keep `resetModules()` but import the app exactly once per test rather than once per request.

Whichever you apply, add a comment saying why, so the next person does not "helpfully" restore the slow shape.

**Do NOT** simply raise `testTimeout`. That hides the cost and leaves the orphaned-write cascade armed. If after your fix the file is still near the limit, say so in the report rather than papering over it.

- [ ] **Step 4: Verify — solo, then under the load that produced the failure**

```bash
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts --reporter=verbose 2>&1 | tail -20
```
Expected: 6/6 pass, and the durations measurably below the Step 1 baseline. Quote both.

Then reproduce the original condition — the failure only appeared under a concurrent suite:
```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/ > /dev/null 2>&1 &
pnpm --filter @rovenue/api exec vitest run tests/funnel-advance-answer.test.ts --reporter=verbose 2>&1 | tail -20
wait
```
Expected: still 6/6. A green solo run alone is not evidence for this item.

- [ ] **Step 5: Mutation-check**

Confirm the tests still discriminate after the restructure — a shared `app` instance must not have made them pass vacuously. By hand, break the handler's answer write: in `apps/api/src/routes/public/funnels.ts`, comment out the `upsertAnswer` call on the `/advance` path. Re-run the file.
Expected: the "records the answer before evaluating…" test goes RED. Restore by hand; re-run; 6/6.
This is the check that matters most here, because restructuring module loading is exactly the change that can silently decouple a test from the code it claims to cover.

- [ ] **Step 6: Commit**

```bash
git status --short
git add apps/api/tests/funnel-advance-answer.test.ts
git commit -m "test(api): stop re-importing the app graph per request in the advance-answer test"
```

---

### Task 4: Wire the duplicate-page action

**Why this exists:** `duplicatePage` is correct, tested and mutation-checked, and unreachable — no caller anywhere. The thumb-rail has **no per-page actions at all** (each row is a single select `<button>`), so this introduces the builder's first one.

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/thumb-rail.tsx`
- Test: `apps/dashboard/src/components/funnel-builder/thumb-rail.duplicate.test.tsx` (create)

**Interfaces:**
- Consumes: `FunnelDraftViewModel.duplicatePage(id: string)` (`vm/funnel-draft.vm.ts:283`) — regenerates the copy's `question_id`, clones the page's own rules with clause references rewritten, and copies its `default_next`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/thumb-rail.duplicate.test.tsx`:

```tsx
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../i18n/config";
import { ThumbRail } from "./thumb-rail";

// The thumb-rail's page row is itself a <button>. The duplicate action
// therefore has to be a SIBLING, not a child — a nested button is invalid
// HTML and swallows both keyboard semantics and the click target. These
// tests pin the two things that restructuring can break: the action runs,
// and it does not also trigger the row's select underneath it.

function makeVm() {
  return {
    pages: [
      { id: "pg_1", type: "single_choice", question_id: "q_a", title: { en: "First" } },
      { id: "pg_2", type: "info", title: { en: "Second" } },
    ],
    selectedPageId: "pg_1",
    defaultLocale: "en",
    duplicatePage: vi.fn(),
    selectPage: vi.fn(),
    addPage: vi.fn(),
  } as never;
}

describe("ThumbRail — duplicate action", () => {
  it("calls duplicatePage for the row it belongs to", async () => {
    const vm = makeVm();
    render(<ThumbRail vm={vm} />);

    await userEvent.click(screen.getAllByRole("button", { name: /duplicate/i })[0]!);

    expect((vm as never as { duplicatePage: ReturnType<typeof vi.fn> }).duplicatePage)
      .toHaveBeenCalledWith("pg_1");
  });

  it("does not also select the row underneath when duplicating", async () => {
    // Without stopPropagation the click bubbles into the row button and
    // the visitor silently navigates while duplicating.
    const vm = makeVm();
    render(<ThumbRail vm={vm} />);

    await userEvent.click(screen.getAllByRole("button", { name: /duplicate/i })[1]!);

    const v = vm as never as {
      duplicatePage: ReturnType<typeof vi.fn>;
      selectPage: ReturnType<typeof vi.fn>;
    };
    expect(v.duplicatePage).toHaveBeenCalledWith("pg_2");
    expect(v.selectPage, "the duplicate click leaked into the row's select").not.toHaveBeenCalled();
  });

  it("exposes one duplicate action per page", () => {
    const vm = makeVm();
    render(<ThumbRail vm={vm} />);
    expect(screen.getAllByRole("button", { name: /duplicate/i })).toHaveLength(2);
  });
});
```

If `ThumbRail`'s real props differ from `{ vm }`, adapt the harness to the actual signature — read the component's props first. Do not change the component's API to suit the test.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/thumb-rail.duplicate.test.tsx
```
Expected: FAIL — no button with an accessible name matching `/duplicate/i` exists.

- [ ] **Step 3: Add the action affordance**

In `thumb-rail.tsx`, import `Copy` from `lucide-react` (the file already imports `Plus` from there — extend that import).

Wrap the existing page-row `<button>` and the new action button in a shared positioning container, and put the action **outside** the row button:

```tsx
<div className="group relative">
  <button
    type="button"
    onClick={() => vm.selectPage(p.id)}
    title={label}
    className={cn(/* …the row's existing classes, unchanged… */)}
  >
    {/* …the row's existing contents, unchanged… */}
  </button>

  {/* Sibling, not child: a button cannot contain a button. Hidden until
      the row is hovered or the action itself is focused, so it never
      obscures the rail but stays keyboard-reachable. */}
  <button
    type="button"
    aria-label={`Duplicate ${label}`}
    onClick={(e) => {
      // The row button sits beneath this one; without this the click
      // both duplicates AND navigates.
      e.stopPropagation();
      vm.duplicatePage(p.id);
    }}
    className="absolute right-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-500 opacity-0 transition hover:bg-rv-c3 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
  >
    <Copy size={10} />
  </button>
</div>
```

Note: the row button currently carries `group relative` itself. Move `group relative` to the new wrapper and drop it from the row button, so `group-hover` refers to the whole row area. Keep every other row class exactly as it is — this task changes reachability, not appearance.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/thumb-rail.duplicate.test.tsx
```
Expected: PASS, 3/3.

- [ ] **Step 5: Check the whole builder suite and types**

```bash
pnpm --filter @rovenue/dashboard exec vitest run src/components/funnel-builder/
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```
Expected: all green except the known `FunnelPreviewViewModel > jumps via 'paywall' literal goto`; `tsc` clean.

- [ ] **Step 6: Mutation-check, twice**

(a) By hand, remove `e.stopPropagation()`. Re-run Step 4.
Expected: the "does not also select the row underneath" test goes RED (`selectPage` was called). Restore by hand; PASS.

(b) By hand, change `vm.duplicatePage(p.id)` to `vm.duplicatePage("pg_1")` hard-coded. Re-run.
Expected: the second test goes RED (expected `"pg_2"`). Restore; PASS.

Both prove the tests are pinned to behaviour rather than to the button merely existing.

- [ ] **Step 7: Commit**

```bash
git status --short
git add apps/dashboard/src/components/funnel-builder/thumb-rail.tsx \
        apps/dashboard/src/components/funnel-builder/thumb-rail.duplicate.test.tsx
git commit -m "feat(dashboard): duplicate a funnel page from the thumb rail"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (numeric operands block publish; audit + migration; coerce not drop; denominator; integration test incl. publishability + idempotence) → Task 1. ✅
- Item 2 (delete `Operator`/`RuleClause`/`Rule`, retype `Funnel.rules` to `NextRule[]`, `tsc` as the gate) → Task 2. ✅
- Item 3 (per-request re-import diagnosis; measure; not a timeout bump; verify under concurrent load) → Task 3. ✅
- Item 4 (first per-page affordance; sibling not nested button; accessible name; stopPropagation; duplicate only) → Task 4. ✅
- Spec's "out of scope" (date operators, `contact_info`, wiring `removePage`, changing operator meaning) → no task touches any. ✅

**Placeholder scan:** no TBD/TODO; every code step carries complete code; no "similar to Task N". Task 3 Step 3 deliberately offers two branches because the correct one depends on a measurement the task itself performs — the decision rule and the required evidence are both stated, so it is a decision procedure, not a placeholder. ✅

**Type consistency:** `NextRule` is imported from `@rovenue/shared/funnel` in Task 2 and is the same type `evaluator.ts` and the rule editor use. `duplicatePage(id: string)` in Task 4 matches the VM signature at `vm/funnel-draft.vm.ts:283`. The migration filename `0095_coerce_funnel_numeric_operands.sql` is identical in the migration, the test's `readFileSync`, and the commit step. The audit script's npm name `db:audit:funnel-operands` is identical in `package.json`, the script's docstring, and the migration comment. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-sp7-deferred-maintenance.md`.
