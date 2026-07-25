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

/**
 * Every rule-store document, with the malformed ones kept separate.
 *
 * `jsonb_array_elements` RAISES on a non-array input, so calling it
 * unguarded lets one malformed row abort the whole audit — the opposite of
 * what an audit should do. Documents that are not arrays are counted and
 * reported instead of skipped silently or blowing up the run.
 */
const DOCS = `
  WITH docs AS (
    SELECT 'draft' AS src, "funnels"."id"::text AS funnel_id,
           "funnels"."draft_pages_json" AS doc
    FROM "funnels"
    UNION ALL
    SELECT 'published', "funnel_versions"."funnel_id"::text,
           "funnel_versions"."pages_json"
    FROM "funnel_versions"
  ),
  all_pages AS (
    SELECT src, funnel_id, page
    FROM docs,
         jsonb_array_elements(doc) AS page
    WHERE jsonb_typeof(doc) = 'array'
  ),
  clauses AS (
    SELECT src, funnel_id,
           page ->> 'id'   AS page_id,
           clause ->> 'op' AS op,
           jsonb_typeof(clause -> 'value') AS value_type
    FROM all_pages,
         -- Same hazard one level down: COALESCE only covers a MISSING key,
         -- not a present-but-non-array one.
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(page -> 'next_rules') = 'array'
                THEN page -> 'next_rules' ELSE '[]'::jsonb END) AS rule,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(rule -> 'condition' -> 'clauses') = 'array'
                THEN rule -> 'condition' -> 'clauses' ELSE '[]'::jsonb END) AS clause
  )
`;

// Every operand class the branching schema constrains. `in`/`not_in` require
// an array just as `between` does; omitting them would let a stored
// `{op:"in", value:"x"}` block publish while the audit still printed "OK".
const OFFENDER_PREDICATE = `
       (op IN ('contains','not_contains') AND value_type IS DISTINCT FROM 'string')
    OR (op IN ('gt','gte','lt','lte')     AND value_type IS DISTINCT FROM 'number')
    OR (op IN ('in','not_in','between')   AND value_type IS DISTINCT FROM 'array')
`;

const AUDIT = sql.raw(`
  ${DOCS}
  SELECT src, op, value_type, count(*)::int AS n,
         min(funnel_id) AS example_funnel_id,
         min(page_id)   AS example_page_id
  FROM clauses
  WHERE ${OFFENDER_PREDICATE}
  GROUP BY src, op, value_type
  ORDER BY src, op
`);

const MALFORMED = sql.raw(`
  WITH docs AS (
    SELECT 'draft' AS src, "funnels"."id"::text AS funnel_id,
           "funnels"."draft_pages_json" AS doc
    FROM "funnels"
    UNION ALL
    SELECT 'published', "funnel_versions"."funnel_id"::text,
           "funnel_versions"."pages_json"
    FROM "funnel_versions"
  )
  SELECT src, jsonb_typeof(doc) AS doc_type, count(*)::int AS n
  FROM docs
  WHERE jsonb_typeof(doc) IS DISTINCT FROM 'array'
  GROUP BY src, jsonb_typeof(doc)
  ORDER BY src
`);

// Reuses the guarded CTE so the denominator can never be produced by a
// different traversal than the offender count — and so a malformed
// document cannot abort the run here either.
const TOTALS = sql.raw(`
  ${DOCS}
  SELECT
    (SELECT count(*)::int FROM "funnels")         AS funnels,
    (SELECT count(*)::int FROM "funnel_versions") AS versions,
    (SELECT count(*)::int FROM all_pages)         AS pages,
    (SELECT count(*)::int FROM clauses)           AS clauses
`);

async function main() {
  const db = getDb();
  const totals = (await db.execute(TOTALS)).rows[0] as Record<string, number>;
  const offenders = (await db.execute(AUDIT)).rows as Array<Record<string, unknown>>;
  const malformed = (await db.execute(MALFORMED)).rows as Array<Record<string, unknown>>;

  console.log("scope:", JSON.stringify(totals));

  // Reported before anything else: these documents were SKIPPED by the
  // traversal, so both the denominator and the offender count exclude them.
  // Staying quiet here would let the numbers below look complete.
  if (malformed.length > 0) {
    console.log("WARNING: rule-store documents that are not JSON arrays, EXCLUDED from the counts:");
    for (const row of malformed) console.log(" ", JSON.stringify(row));
  }

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
