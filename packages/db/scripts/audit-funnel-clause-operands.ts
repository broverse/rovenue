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
