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
    -- IS DISTINCT FROM (not <>): a page missing the "next_rules" key
    -- entirely (e.g. a terminal "info" page) makes the `->` lookup SQL
    -- NULL, and jsonb_typeof(NULL) is SQL NULL too, so a plain <>
    -- comparison is NULL — which plpgsql's IF treats as false, falling
    -- through into a FOR loop whose bound is NULL and raising
    -- "upper bound of FOR loop cannot be null". IS DISTINCT FROM treats
    -- NULL as a real value and CONTINUEs correctly.
    IF jsonb_typeof(pages -> pi -> 'next_rules') IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    FOR ri IN 0 .. jsonb_array_length(pages -> pi -> 'next_rules') - 1 LOOP
      IF jsonb_typeof(pages -> pi -> 'next_rules' -> ri -> 'condition' -> 'clauses') IS DISTINCT FROM 'array' THEN
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
