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
  -- A legacy key stored with an explicit JSON null means "no value" —
  -- drop it entirely (spec: null = delete, no tombstone). Filtering here
  -- keeps it out of jsonb_object_agg, which would otherwise preserve it
  -- as a jsonb null rather than removing the key.
  WHERE jsonb_typeof(kv.value) <> 'null'
)
WHERE s.attributes IS NOT NULL
  AND s.attributes <> '{}'::jsonb;
