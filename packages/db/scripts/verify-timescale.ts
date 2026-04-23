#!/usr/bin/env tsx
import { getPool } from "../src/drizzle/pool";

// =============================================================
// TimescaleDB post-migration verifier
// =============================================================
//
// Prints the live state of the hypertables, continuous aggregates,
// and policies so an operator can confirm that `pnpm db:migrate`
// landed TimescaleDB features correctly. Non-zero exit if any
// expected object is missing OR if any expected setting drifts.
//
//   pnpm --filter @rovenue/db db:verify:timescale

interface Hypertable {
  hypertable_name: string;
  num_chunks: number;
  compression_enabled: boolean;
}

interface Cagg {
  view_name: string;
  materialization_hypertable_name: string;
}

interface Policy {
  proc_name: string;
  hypertable_name: string | null;
  scheduled: boolean;
  schedule_interval: string;
  config: Record<string, unknown> | null;
}

interface Dimension {
  hypertable_name: string;
  column_name: string;
  time_interval: string;
}

interface CompressionSetting {
  hypertable_name: string;
  attname: string;
  segmentby_column_index: number | null;
  orderby_column_index: number | null;
  orderby_asc: boolean | null;
}

// -------------------------------------------------------------
// Expected inventory — single source of truth.
// -------------------------------------------------------------
// Postgres reports intervals with values >=1 day as "N days" and
// shorter intervals as HH:MM:SS. The strings below match that
// convention so direct string comparison works on
// `time_interval::text`, `config ->> 'compress_after'`, etc.

type PartitionSpec = {
  column: string;
  chunkInterval: string; // Postgres interval, e.g. "1 day", "06:00:00"
};
type CompressionSpec = {
  segmentBy: string;
  orderBy: string;
  orderByAsc: boolean;
  compressAfter: string; // e.g. "30 days", "7 days"
};
type HypertableSpec = {
  partition: PartitionSpec;
  compression: CompressionSpec | null;
  retention: string | null;
};
type CaggRefreshSpec = {
  startOffset: string;
  endOffset: string;
  scheduleInterval: string; // schedule_interval column (HH:MM:SS for <1 day)
};
type CaggSpec = {
  columns: readonly string[];
  refresh: CaggRefreshSpec;
};

const EXPECTED: {
  hypertables: Record<string, HypertableSpec>;
  caggs: Record<string, CaggSpec>;
} = {
  hypertables: {
    revenue_events: {
      partition: { column: "eventDate", chunkInterval: "1 day" },
      compression: {
        segmentBy: "projectId",
        orderBy: "eventDate",
        orderByAsc: false,
        compressAfter: "30 days",
      },
      retention: null,
    },
    credit_ledger: {
      partition: { column: "createdAt", chunkInterval: "1 day" },
      compression: {
        segmentBy: "projectId",
        orderBy: "createdAt",
        orderByAsc: false,
        compressAfter: "30 days",
      },
      retention: null,
    },
    outgoing_webhooks: {
      partition: { column: "createdAt", chunkInterval: "06:00:00" },
      compression: {
        segmentBy: "projectId",
        orderBy: "createdAt",
        orderByAsc: false,
        compressAfter: "7 days",
      },
      retention: "90 days",
    },
  },
  caggs: {
    daily_mrr: {
      // Column-name pin. Type-check is out of scope — the Drizzle
      // binding in views.ts is the upstream contract; mismatched names
      // would make its .select() blow up at runtime.
      columns: [
        "projectId",
        "bucket",
        "gross_usd",
        "event_count",
        "active_subscribers",
      ],
      refresh: {
        startOffset: "7 days",
        endOffset: "01:00:00",
        scheduleInterval: "00:10:00",
      },
    },
  },
} as const;

// Mapping from cagg view name -> source hypertable, for freshness
// check. Extend when new caggs land.
const CAGG_SOURCES: Record<string, string> = {
  daily_mrr: "revenue_events",
};

function multisetEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortA = [...a].sort();
  const sortB = [...b].sort();
  return sortA.every((x, i) => x === sortB[i]);
}

async function main(): Promise<void> {
  const pool = getPool();
  const problems: string[] = [];

  try {
    // -----------------------------------------------------------
    // Hypertables (existence + compression_enabled)
    // -----------------------------------------------------------
    const hypertables = (
      await pool.query<Hypertable>(
        `SELECT hypertable_name, num_chunks, compression_enabled
         FROM timescaledb_information.hypertables
         WHERE hypertable_schema = 'public'
         ORDER BY hypertable_name`,
      )
    ).rows;
    console.log("Hypertables:");
    for (const h of hypertables) {
      console.log(
        `  ${h.hypertable_name}  chunks=${h.num_chunks}  compression=${h.compression_enabled}`,
      );
    }
    const actualHt = new Set(hypertables.map((h) => h.hypertable_name));
    const expectedHtNames = Object.keys(EXPECTED.hypertables);
    for (const name of expectedHtNames) {
      if (!actualHt.has(name)) problems.push(`missing hypertable: ${name}`);
    }
    for (const h of hypertables) {
      const spec = EXPECTED.hypertables[h.hypertable_name];
      if (spec?.compression && !h.compression_enabled) {
        problems.push(
          `compression disabled on hypertable: ${h.hypertable_name}`,
        );
      }
    }

    // -----------------------------------------------------------
    // B1. Chunk intervals per hypertable
    // -----------------------------------------------------------
    const dimensions = (
      await pool.query<Dimension>(
        `SELECT hypertable_name, column_name, time_interval::text AS time_interval
         FROM timescaledb_information.dimensions
         WHERE hypertable_name = ANY($1::text[])
         ORDER BY hypertable_name`,
        [expectedHtNames],
      )
    ).rows;
    console.log("\nChunk intervals:");
    for (const d of dimensions) {
      console.log(
        `  ${d.hypertable_name}  column=${d.column_name}  interval=${d.time_interval}`,
      );
    }
    const dimByTable = new Map(dimensions.map((d) => [d.hypertable_name, d]));
    for (const name of expectedHtNames) {
      const spec = EXPECTED.hypertables[name]!;
      const dim = dimByTable.get(name);
      if (!dim) {
        problems.push(`missing dimension row for hypertable: ${name}`);
        continue;
      }
      if (dim.column_name !== spec.partition.column) {
        problems.push(
          `hypertable ${name}: partition column drift — expected ${spec.partition.column}, got ${dim.column_name}`,
        );
      }
      if (dim.time_interval !== spec.partition.chunkInterval) {
        problems.push(
          `hypertable ${name}: chunk interval drift — expected ${spec.partition.chunkInterval}, got ${dim.time_interval}`,
        );
      }
    }

    // -----------------------------------------------------------
    // B2. Compression settings (segmentby + orderby per attribute)
    // -----------------------------------------------------------
    const compSettings = (
      await pool.query<CompressionSetting>(
        `SELECT hypertable_name, attname,
                segmentby_column_index, orderby_column_index, orderby_asc
         FROM timescaledb_information.compression_settings
         WHERE hypertable_name = ANY($1::text[])
         ORDER BY hypertable_name, attname`,
        [expectedHtNames],
      )
    ).rows;
    console.log("\nCompression settings:");
    for (const s of compSettings) {
      console.log(
        `  ${s.hypertable_name}  attname=${s.attname}  segmentby_idx=${s.segmentby_column_index ?? "-"}  orderby_idx=${s.orderby_column_index ?? "-"}  orderby_asc=${s.orderby_asc ?? "-"}`,
      );
    }
    for (const name of expectedHtNames) {
      const spec = EXPECTED.hypertables[name]!;
      if (!spec.compression) continue;
      const rows = compSettings.filter((s) => s.hypertable_name === name);
      const segRows = rows.filter(
        (r) =>
          r.attname === spec.compression!.segmentBy &&
          r.segmentby_column_index === 1,
      );
      if (segRows.length !== 1) {
        problems.push(
          `hypertable ${name}: expected exactly one segmentby row on ${spec.compression.segmentBy} (idx=1), found ${segRows.length}`,
        );
      }
      const orderRows = rows.filter(
        (r) =>
          r.attname === spec.compression!.orderBy &&
          r.orderby_column_index === 1 &&
          r.orderby_asc === spec.compression!.orderByAsc,
      );
      if (orderRows.length !== 1) {
        problems.push(
          `hypertable ${name}: expected exactly one orderby row on ${spec.compression.orderBy} (idx=1, asc=${spec.compression.orderByAsc}), found ${orderRows.length}`,
        );
      }
    }

    // -----------------------------------------------------------
    // Continuous aggregates (existence + materialization mapping)
    // -----------------------------------------------------------
    const caggs = (
      await pool.query<Cagg>(
        `SELECT view_name, materialization_hypertable_name
         FROM timescaledb_information.continuous_aggregates
         ORDER BY view_name`,
      )
    ).rows;
    console.log("\nContinuous aggregates:");
    for (const c of caggs) {
      console.log(`  ${c.view_name}  mat=${c.materialization_hypertable_name}`);
    }
    const actualCagg = new Set(caggs.map((c) => c.view_name));
    const expectedCaggNames = Object.keys(EXPECTED.caggs);
    for (const name of expectedCaggNames) {
      if (!actualCagg.has(name)) problems.push(`missing cagg: ${name}`);
    }
    // Reverse map: materialization hypertable name -> cagg view name
    const matToCagg = new Map(
      caggs.map((c) => [c.materialization_hypertable_name, c.view_name]),
    );

    // -----------------------------------------------------------
    // Policies (existence + scheduled) and B3/B4/B5 interval checks
    // -----------------------------------------------------------
    const policies = (
      await pool.query<Policy>(
        `SELECT proc_name, hypertable_name, scheduled,
                schedule_interval::text AS schedule_interval, config
         FROM timescaledb_information.jobs
         WHERE proc_name IN (
           'policy_compression',
           'policy_retention',
           'policy_refresh_continuous_aggregate'
         )
         ORDER BY proc_name, hypertable_name`,
      )
    ).rows;

    console.log("\nPolicies:");
    for (const p of policies) {
      console.log(
        `  ${p.proc_name}  on  ${p.hypertable_name ?? "(null)"}  scheduled=${p.scheduled}  schedule_interval=${p.schedule_interval}  config=${JSON.stringify(p.config)}`,
      );
    }

    const compressionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_compression")
        .map((p) => p.hypertable_name ?? ""),
    );
    const expectedCompressionTables = expectedHtNames.filter(
      (n) => EXPECTED.hypertables[n]!.compression !== null,
    );
    for (const name of expectedCompressionTables) {
      if (!compressionTargets.has(name))
        problems.push(`missing compression policy: ${name}`);
    }

    const retentionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_retention")
        .map((p) => p.hypertable_name ?? ""),
    );
    const expectedRetentionTables = expectedHtNames.filter(
      (n) => EXPECTED.hypertables[n]!.retention !== null,
    );
    for (const name of expectedRetentionTables) {
      if (!retentionTargets.has(name))
        problems.push(`missing retention policy: ${name}`);
    }

    const refreshCount = policies.filter(
      (p) => p.proc_name === "policy_refresh_continuous_aggregate",
    ).length;
    if (refreshCount < expectedCaggNames.length) {
      problems.push(
        `expected >= ${expectedCaggNames.length} refresh policies, found ${refreshCount}`,
      );
    }

    for (const p of policies) {
      if (!p.scheduled) {
        problems.push(
          `policy not scheduled: ${p.proc_name} on ${p.hypertable_name ?? "(null)"}`,
        );
      }
    }

    console.log("\nPolicy intervals:");
    // B3. Compression policy compress_after
    for (const p of policies.filter(
      (p) => p.proc_name === "policy_compression",
    )) {
      const name = p.hypertable_name ?? "";
      const spec = EXPECTED.hypertables[name];
      const compressAfter = (p.config?.compress_after as string | undefined) ?? "";
      console.log(
        `  compression ${name}: compress_after=${compressAfter} (expected ${spec?.compression?.compressAfter ?? "n/a"})`,
      );
      if (!spec?.compression) continue;
      if (compressAfter !== spec.compression.compressAfter) {
        problems.push(
          `compression policy ${name}: compress_after drift — expected ${spec.compression.compressAfter}, got ${compressAfter}`,
        );
      }
    }
    // B4. Retention policy drop_after
    for (const p of policies.filter(
      (p) => p.proc_name === "policy_retention",
    )) {
      const name = p.hypertable_name ?? "";
      const spec = EXPECTED.hypertables[name];
      const dropAfter = (p.config?.drop_after as string | undefined) ?? "";
      console.log(
        `  retention  ${name}: drop_after=${dropAfter} (expected ${spec?.retention ?? "n/a"})`,
      );
      if (!spec?.retention) continue;
      if (dropAfter !== spec.retention) {
        problems.push(
          `retention policy ${name}: drop_after drift — expected ${spec.retention}, got ${dropAfter}`,
        );
      }
    }
    // B5. Refresh policy start_offset / end_offset / schedule_interval
    for (const p of policies.filter(
      (p) => p.proc_name === "policy_refresh_continuous_aggregate",
    )) {
      const matName = p.hypertable_name ?? "";
      const caggName = matToCagg.get(matName);
      if (!caggName) {
        problems.push(
          `refresh policy references unknown materialization hypertable: ${matName}`,
        );
        continue;
      }
      const spec = EXPECTED.caggs[caggName];
      const startOffset =
        (p.config?.start_offset as string | undefined) ?? "";
      const endOffset = (p.config?.end_offset as string | undefined) ?? "";
      console.log(
        `  refresh    ${caggName}: start_offset=${startOffset}  end_offset=${endOffset}  schedule_interval=${p.schedule_interval}`,
      );
      if (!spec) {
        problems.push(
          `refresh policy for unexpected cagg: ${caggName}`,
        );
        continue;
      }
      if (startOffset !== spec.refresh.startOffset) {
        problems.push(
          `refresh policy ${caggName}: start_offset drift — expected ${spec.refresh.startOffset}, got ${startOffset}`,
        );
      }
      if (endOffset !== spec.refresh.endOffset) {
        problems.push(
          `refresh policy ${caggName}: end_offset drift — expected ${spec.refresh.endOffset}, got ${endOffset}`,
        );
      }
      if (p.schedule_interval !== spec.refresh.scheduleInterval) {
        problems.push(
          `refresh policy ${caggName}: schedule_interval drift — expected ${spec.refresh.scheduleInterval}, got ${p.schedule_interval}`,
        );
      }
    }

    // -----------------------------------------------------------
    // B6. Cagg column-name shape (pin against views.ts binding)
    // -----------------------------------------------------------
    console.log("\nCagg columns:");
    for (const caggName of expectedCaggNames) {
      const spec = EXPECTED.caggs[caggName]!;
      const rows = (
        await pool.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`,
          [caggName],
        )
      ).rows;
      const actual = rows.map((r) => r.column_name);
      console.log(`  ${caggName}: [${actual.join(", ")}]`);
      if (!multisetEqual(actual, spec.columns)) {
        const missing = spec.columns.filter((c) => !actual.includes(c));
        const extra = actual.filter((c) => !spec.columns.includes(c));
        problems.push(
          `cagg ${caggName}: column drift — missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
        );
      }
    }

    // -----------------------------------------------------------
    // B7. Cagg freshness (follow-up #23)
    // -----------------------------------------------------------
    // If the source hypertable has rows but the cagg is empty, the
    // operator almost certainly restored a DB without backfilling.
    // Flag with the exact command they need to run.
    console.log("\nCagg freshness:");
    for (const caggName of expectedCaggNames) {
      const source = CAGG_SOURCES[caggName];
      if (!source) {
        problems.push(
          `no CAGG_SOURCES mapping for cagg ${caggName} — extend verify-timescale.ts`,
        );
        continue;
      }
      const srcCountRow = (
        await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${source}`,
        )
      ).rows[0];
      const caggCountRow = (
        await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${caggName}`,
        )
      ).rows[0];
      const srcCount = BigInt(srcCountRow?.count ?? "0");
      const caggCount = BigInt(caggCountRow?.count ?? "0");
      console.log(
        `  ${caggName}: source=${source} src_count=${srcCount} cagg_count=${caggCount}`,
      );
      if (srcCount > 0n && caggCount === 0n) {
        problems.push(
          `cagg ${caggName} is empty but ${source} has ${srcCount} rows — run: CALL refresh_continuous_aggregate('${caggName}', NULL, NULL);`,
        );
      }
    }

    if (problems.length) {
      console.error("\nFAIL:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    console.log("\nOK — TimescaleDB state matches expectations.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("verify-timescale failed:", err);
  process.exit(1);
});
