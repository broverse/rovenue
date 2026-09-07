-- 0130_partman_register_revenue_credit.sql
--
-- Register `revenue_events` and `credit_ledger` with pg_partman so their
-- monthly partitions keep rolling forward. Both tables currently stop dead
-- at 2028-12.
--
-- -------------------------------------------------------------
-- The defect
-- -------------------------------------------------------------
--
-- 0015/0016 hand-created 60 monthly partitions covering 2024-01 .. 2028-12
-- and left the rolling window to 0019, which registers both parents with
-- `partman.create_parent(... p_start_partition => '2024-01-01')`.
--
-- 0019 never runs on a fresh install: `packages/db/src/fresh-install.ts`
-- lists it in TIMESCALE_LEGACY_TAGS and marks it applied without executing
-- it. That skip is correct — partman v5 names its children `_pYYYYMMDD`
-- while 0015/0016 named theirs `_YYYY_MM`, so starting at 2024-01-01 makes
-- partman try to attach a child over a range a hand-made child already
-- owns. Reproduced verbatim against this repo's own image
-- (deploy/postgres) on a database built by `runFreshInstall`:
--
--   ERROR:  partition "revenue_events_p20240101" would overlap partition
--           "revenue_events_2024_01"
--   CONTEXT: PL/pgSQL function create_partition_time(...) line 200 at EXECUTE
--
-- What the skip did NOT record is its consequence: with no `part_config`
-- row, nothing ever creates a 2029 partition, and an insert dated
-- 2029-01-01 or later fails outright. Also reproduced:
--
--   ERROR:  no partition of relation "revenue_events" found for row
--   DETAIL:  Partition key of the failing row contains ("eventDate")
--            = (2029-01-01 00:00:00+00).
--
-- That is a dated outage, not a hypothetical.
--
-- -------------------------------------------------------------
-- The fix
-- -------------------------------------------------------------
--
-- Register both parents starting at the first month NOT already covered by
-- a hand-made child, so partman never proposes a range that overlaps one.
-- The naming split is harmless: `partman.show_partitions` reads
-- `pg_inherits` + `relpartbound`, not table names — verified, it returns
-- all 60 `_YYYY_MM` children in bound order and correctly resolves the
-- newest one as the set's last partition, then continues from there with
-- its own `_pYYYYMMDD` naming.
--
-- The start month is COMPUTED from the catalog rather than hard-coded to
-- 2029-01-01, because "the hand-made children stop at 2028-12" is a fact
-- about the database in front of us, not a constant. A restored snapshot,
-- an operator who pre-created a month by hand, or a future migration that
-- extends the range all leave a parent whose newest child is some other
-- month, and registering such a database at 2029-01 would hand partman a
-- range a child already owns on its very first premake. Computing the
-- boundary makes the overlap this migration exists to avoid structurally
-- impossible instead of merely unlikely today.
--
-- CORRECTION (comment only; made after this file landed and before any
-- database had applied it). An earlier draft justified the computation by
-- saying `ensureRevenueEventPartitions`
-- (packages/db/src/drizzle/repositories/revenue-event-partitions.ts)
-- hand-creates `<table>_<yyyy>_<mm>` children for any month an import
-- touches. That premise stops being true the moment THIS migration runs:
-- with the parent in `partman.part_config` that function takes the
-- pg_partman branch, and anything it creates is named `_pYYYYMMDD`. The
-- computation is still right, for the reason above; only the example was.
--
-- -------------------------------------------------------------
-- Retention: deliberately NOT enabled (this registers PREMAKE only)
-- -------------------------------------------------------------
--
-- 0019 intended `retention = '7 years'` on both parents. Since then,
-- ROADMAP §9.2 shipped `apps/api/src/workers/retention-sweep.ts`, which
-- registers both tables with strategy DROP_PARTITION
-- (packages/shared/src/retention/policies.ts) and owns dropping them. That
-- sweep is tenant-safe in ways partman is not: it drops a partition only
-- at the LONGEST window any project resolved, only when EVERY project
-- resolved one, and writes a per-project audit row into each affected
-- project's hash chain first. Its floors (REVENUE_EVENTS_MINIMUM_DAYS /
-- CREDIT_LEDGER_MINIMUM_DAYS, both 365 days) are far shorter than 7 years,
-- so the sweep always reaches a partition first and partman's retention
-- could only ever be a second, unconditional, unaudited dropper.
--
-- So this migration leaves `retention` NULL on a fresh registration, and
-- CLEARS the values 0019 left behind on upgrade-path databases, so both
-- install paths end with exactly one owner of "when does a partition go
-- away". `infinite_time_partitions` stays true — that is premake
-- behaviour (keep making children even when the newest data is older than
-- now), not retention.
--
-- -------------------------------------------------------------
-- Idempotence and the availability guard
-- -------------------------------------------------------------
--
-- Upgrade-path databases already ran 0019 and already hold both parents in
-- `part_config`. Re-registering must be a no-op, so `create_parent` is
-- called only when the row is absent; the retention reset runs either way.
--
-- pg_partman is present in the image this repo ships (deploy/postgres) and
-- migrations 0051/0060 already hard-require it. This migration still
-- guards on `pg_available_extensions` and RAISES A NOTICE naming the exact
-- consequence when it skips, because a guard that cannot be distinguished
-- from success is how this whole class of defect got here in the first
-- place. A reader of the migration log sees either "registered" /
-- "already registered" per table, or one loud line saying partitions stop
-- at the last hand-made month.
--
-- -------------------------------------------------------------
-- Operational note: partman creates a DEFAULT partition
-- -------------------------------------------------------------
--
-- `create_parent` also attaches `<table>_default`, exactly as it already
-- did for funnel_sessions / funnel_answers / integration_deliveries
-- (0051/0060). A row dated beyond the premake horizon then lands there
-- instead of failing — but Postgres will refuse to attach the real
-- partition for that month afterwards ("updated partition constraint for
-- default partition would be violated by some row"), which is a silent
-- future maintenance failure. `partman.check_default()` reports how many
-- rows are stranded; it is the thing to watch, and it reads zero on a
-- healthy set.

DO $partman_register$
DECLARE
  -- One row per parent this migration owns. `outgoing_webhooks` is
  -- deliberately absent: its retention predicate is composite
  -- (status AND age), so a whole month is never uniformly expired, and a
  -- hand-rolled worker owns it (see 0019's own comment and
  -- packages/shared/src/retention/policies.ts).
  PARENT_TABLES CONSTANT text[] :=
    ARRAY['public.revenue_events', 'public.credit_ledger'];
  -- Index-aligned with PARENT_TABLES: the range-partition key column.
  CONTROL_COLUMNS CONSTANT text[] :=
    ARRAY['eventDate', 'createdAt'];

  PARTMAN_EXTENSION   CONSTANT text := 'pg_partman';
  PARTMAN_SCHEMA      CONSTANT text := 'partman';
  PARTITION_INTERVAL  CONSTANT text := '1 month';
  -- Matches 0019's intent: keep a year of empty months ahead of the data.
  PARTITION_PREMAKE   CONSTANT integer := 12;

  -- Pulls the upper bound out of `FOR VALUES FROM ('...') TO ('...')`.
  -- A DEFAULT partition's bound expression is the bare word DEFAULT and
  -- matches nothing, so it drops out of the max() rather than poisoning
  -- it. Mirrors `parsePartitionBoundExpr` in
  -- apps/api/src/workers/retention-sweep.ts.
  UPPER_BOUND_PATTERN CONSTANT text := 'TO \(''(.*?)''\)';

  v_parent_table  text;
  v_control       text;
  v_start_bound   timestamptz;
  v_registered    boolean;
  i               integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = PARTMAN_EXTENSION
  ) THEN
    RAISE NOTICE
      '0130 SKIPPED: extension % is not available on this server. '
      '% and % were NOT registered with pg_partman: no process will '
      'create their monthly partitions, so every insert dated on or '
      'after the month following their last hand-made partition '
      '(2028-12 on a stock install) will fail with "no partition of '
      'relation ... found for row". Install % (see deploy/postgres/'
      'Dockerfile) and re-run this migration.',
      PARTMAN_EXTENSION,
      PARENT_TABLES[1],
      PARENT_TABLES[2],
      PARTMAN_EXTENSION;
    RETURN;
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', PARTMAN_SCHEMA);
  EXECUTE format(
    'CREATE EXTENSION IF NOT EXISTS %I SCHEMA %I',
    PARTMAN_EXTENSION, PARTMAN_SCHEMA
  );

  -- Every bound below is read and written in UTC. The hand-made children
  -- from 0015/0016 have UTC bounds, and partman's own date_trunc on a
  -- timestamptz is TimeZone-sensitive; pinning it means a self-host whose
  -- server TimeZone is not UTC computes the same boundary as CI does.
  PERFORM set_config('TimeZone', 'UTC', true);

  FOR i IN 1 .. array_length(PARENT_TABLES, 1) LOOP
    v_parent_table := PARENT_TABLES[i];
    v_control      := CONTROL_COLUMNS[i];

    SELECT EXISTS (
      SELECT 1 FROM partman.part_config WHERE parent_table = v_parent_table
    ) INTO v_registered;

    IF v_registered THEN
      -- Upgrade path (0019 ran), or a re-run of this migration.
      RAISE NOTICE
        '0130: % is already in partman.part_config — registration skipped '
        '(no-op). The reconcile below still runs: it clears partman''s '
        'retention (the retention sweep owns dropping) and raises premake '
        'to at least %. A premake already above % is left alone.',
        v_parent_table, PARTITION_PREMAKE, PARTITION_PREMAKE;
    ELSE
      -- First month NOT already covered by a child partition. NULL only
      -- when the parent has no non-default children at all, which no
      -- install reaches (0015/0016 create 60 of them) but which must not
      -- silently become "start at the epoch".
      SELECT max(
               (substring(
                  pg_get_expr(child.relpartbound, child.oid)
                  FROM UPPER_BOUND_PATTERN
               ))::timestamptz
             )
        INTO v_start_bound
        FROM pg_inherits i2
        JOIN pg_class child ON child.oid = i2.inhrelid
       WHERE i2.inhparent = v_parent_table::regclass;

      IF v_start_bound IS NULL THEN
        RAISE EXCEPTION
          '0130: % has no bounded child partitions, so the first free '
          'month cannot be determined. Expected the 60 monthly children '
          'created by migrations 0015/0016.',
          v_parent_table;
      END IF;

      EXECUTE format(
        'SELECT %I.create_parent('
        '  p_parent_table    => %L,'
        '  p_control         => %L,'
        '  p_interval        => %L,'
        '  p_premake         => %s,'
        '  p_start_partition => %L)',
        PARTMAN_SCHEMA,
        v_parent_table,
        v_control,
        PARTITION_INTERVAL,
        PARTITION_PREMAKE,
        v_start_bound::text
      );

      RAISE NOTICE
        '0130: registered % with pg_partman — control=%, interval=%, '
        'premake=%, first partman-owned month starts %. Partitions now '
        'roll forward past the hand-made 2024-01..2028-12 range.',
        v_parent_table, v_control, PARTITION_INTERVAL,
        PARTITION_PREMAKE, v_start_bound;
    END IF;

    -- Premake only. See the retention-ownership note in the header: the
    -- retention sweep owns dropping these two tables, so partman must not
    -- also drop them. NULL retention disables partman's dropper; the two
    -- keep_* flags go back to partman's own defaults so nothing reads as
    -- armed. `infinite_time_partitions` is premake behaviour and stays on.
    --
    -- premake is a FLOOR, not an assignment. On an upgrade-path database
    -- an operator may have tuned it upward — that is a deliberate
    -- operational choice about how far ahead this install wants to run,
    -- and a migration that silently reverts it on every re-run is a
    -- worse outcome than one that never touched it. GREATEST() ignores
    -- NULLs in Postgres, so a NULL premake still lands on the floor.
    -- The direction that matters for correctness is upward: too little
    -- headroom strands inserts, too much only costs empty partitions.
    UPDATE partman.part_config
       SET retention                = NULL,
           retention_keep_table     = true,
           retention_keep_index     = true,
           infinite_time_partitions = true,
           premake                  = GREATEST(premake, PARTITION_PREMAKE)
     WHERE parent_table = v_parent_table;
  END LOOP;
END
$partman_register$;
