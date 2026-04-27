#!/usr/bin/env tsx
// =============================================================
// migrate-hypertable-to-partitioned.ts (Plan 3 Phase D helper)
// =============================================================
//
// Copies rows from a renamed legacy Timescale hypertable
// (`<table>_legacy_hypertable`) into the new declarative
// range-partitioned `<table>` produced by migrations 0015–0017.
// The migration only does the rename + create; this script does
// the data move, in one transaction PER PARTITION (not one per
// table, which would lock everything for hours and pile up WAL).
//
// Usage:
//   pnpm tsx packages/db/scripts/migrate-hypertable-to-partitioned.ts \
//       --table revenue_events \
//       --partition-column eventDate \
//       --start 2024-01 \
//       --end   2029-01
//
// Behaviour:
//   1. Verifies <table>_legacy_hypertable exists.
//   2. Computes min/max of the partition column on the legacy table;
//      errors if the user-supplied [start, end) range doesn't cover it.
//   3. For each [month_start, month_end) partition in the range:
//        BEGIN;
//          INSERT INTO <table> SELECT * FROM <table>_legacy_hypertable
//            WHERE col >= month_start AND col < month_end;
//        COMMIT;
//      Then asserts:
//        - row count of new partition = filtered count of legacy
//          for that range. Aborts loudly on mismatch (DOES NOT
//          drop the legacy table).
//   4. Emits one JSON line per partition for log shipping.
//
// Once every partition reports a 0 mismatch, run the legacy-drop
// migrations (0015a / 0016a / 0017a) with the PLAN3_LEGACY_DROP_VERIFIED=1
// env var set so the migrator can apply them.

import { Client } from "pg";

interface Args {
  table: string;
  partitionColumn: string;
  start: string; // YYYY-MM
  end: string; // YYYY-MM (exclusive)
  databaseUrl: string;
  dryRun: boolean;
}

interface PartitionReport {
  partition: string;
  rangeStart: string;
  rangeEnd: string;
  rowsCopied: number;
  legacyRows: number;
  match: boolean;
  durationMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    databaseUrl: process.env.DATABASE_URL,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--table") (args.table = v), i++;
    else if (k === "--partition-column") (args.partitionColumn = v), i++;
    else if (k === "--start") (args.start = v), i++;
    else if (k === "--end") (args.end = v), i++;
    else if (k === "--database-url") (args.databaseUrl = v), i++;
    else if (k === "--dry-run") args.dryRun = true;
  }
  for (const required of [
    "table",
    "partitionColumn",
    "start",
    "end",
    "databaseUrl",
  ] as const) {
    if (!args[required]) {
      throw new Error(
        `Missing required arg --${required.replace(/([A-Z])/g, "-$1").toLowerCase()}`,
      );
    }
  }
  return args as Args;
}

function monthIter(start: string, end: string): Array<[Date, Date]> {
  const ranges: Array<[Date, Date]> = [];
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  if (!sy || !sm || !ey || !em) throw new Error("--start / --end must be YYYY-MM");
  let cur = new Date(Date.UTC(sy, sm - 1, 1));
  const stop = new Date(Date.UTC(ey, em - 1, 1));
  while (cur.getTime() < stop.getTime()) {
    const next = new Date(
      Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1),
    );
    ranges.push([new Date(cur), next]);
    cur = next;
  }
  return ranges;
}

function partitionName(table: string, monthStart: Date): string {
  const yyyy = monthStart.getUTCFullYear();
  const mm = String(monthStart.getUTCMonth() + 1).padStart(2, "0");
  return `${table}_${yyyy}_${mm}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: args.databaseUrl });
  await client.connect();
  try {
    const legacyTable = `${args.table}_legacy_hypertable`;

    const legacyExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class
         WHERE relname = $1 AND relkind IN ('r','p','f')
       ) AS exists`,
      [legacyTable],
    );
    if (!legacyExists.rows[0]?.exists) {
      throw new Error(
        `Legacy table "${legacyTable}" not found. Run migration 0015/0016/0017 first.`,
      );
    }

    const bounds = await client.query<{ min: string | null; max: string | null }>(
      `SELECT min("${args.partitionColumn}")::text AS min,
              max("${args.partitionColumn}")::text AS max
         FROM "${legacyTable}"`,
    );
    const minVal = bounds.rows[0]?.min;
    const maxVal = bounds.rows[0]?.max;
    process.stdout.write(
      JSON.stringify({
        kind: "preflight",
        table: args.table,
        legacyMin: minVal,
        legacyMax: maxVal,
        rangeStart: args.start,
        rangeEnd: args.end,
      }) + "\n",
    );
    if (minVal && maxVal) {
      const startMs = Date.parse(`${args.start}-01T00:00:00Z`);
      const endMs = Date.parse(`${args.end}-01T00:00:00Z`);
      if (Date.parse(minVal) < startMs || Date.parse(maxVal) >= endMs) {
        throw new Error(
          `Supplied range [${args.start}, ${args.end}) does not cover the legacy data span [${minVal}, ${maxVal}].`,
        );
      }
    }

    const ranges = monthIter(args.start, args.end);
    const reports: PartitionReport[] = [];

    for (const [rangeStart, rangeEnd] of ranges) {
      const partition = partitionName(args.table, rangeStart);
      const t0 = Date.now();
      let rowsCopied = 0;
      if (!args.dryRun) {
        await client.query("BEGIN");
        try {
          const insertRes = await client.query(
            `INSERT INTO "${args.table}"
             SELECT * FROM "${legacyTable}"
              WHERE "${args.partitionColumn}" >= $1
                AND "${args.partitionColumn}" <  $2
             ON CONFLICT DO NOTHING`,
            [rangeStart.toISOString(), rangeEnd.toISOString()],
          );
          rowsCopied = insertRes.rowCount ?? 0;
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      }

      const legacyCount = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c
           FROM "${legacyTable}"
          WHERE "${args.partitionColumn}" >= $1
            AND "${args.partitionColumn}" <  $2`,
        [rangeStart.toISOString(), rangeEnd.toISOString()],
      );
      const partitionCount = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "${partition}"`,
      );
      const legacyRows = Number(legacyCount.rows[0]?.c ?? 0);
      const partitionRows = Number(partitionCount.rows[0]?.c ?? 0);

      const report: PartitionReport = {
        partition,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        rowsCopied,
        legacyRows,
        match: legacyRows === partitionRows,
        durationMs: Date.now() - t0,
      };
      reports.push(report);
      process.stdout.write(JSON.stringify({ kind: "partition", ...report }) + "\n");

      if (!report.match) {
        throw new Error(
          `Row-count mismatch on ${partition}: legacy ${legacyRows} vs partition ${partitionRows}. NOT proceeding to legacy drop.`,
        );
      }
    }

    process.stdout.write(
      JSON.stringify({
        kind: "summary",
        table: args.table,
        totalPartitions: reports.length,
        totalRows: reports.reduce((s, r) => s + r.legacyRows, 0),
        anyMismatch: reports.some((r) => !r.match),
      }) + "\n",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
