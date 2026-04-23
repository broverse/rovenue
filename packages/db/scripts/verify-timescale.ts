#!/usr/bin/env tsx
import { getPool } from "../src/drizzle/pool";

// =============================================================
// TimescaleDB post-migration verifier
// =============================================================
//
// Prints the live state of the hypertables, continuous aggregates,
// and policies so an operator can confirm that `pnpm db:migrate`
// landed TimescaleDB features correctly. Non-zero exit if any
// expected object is missing.
//
//   pnpm --filter @rovenue/db db:verify:timescale

interface Hypertable {
  hypertable_name: string;
  num_chunks: number;
  compression_enabled: boolean;
}

interface Cagg {
  view_name: string;
}

interface Policy {
  proc_name: string;
  hypertable_name: string | null;
  scheduled: boolean;
}

const EXPECTED_HYPERTABLES = [
  "credit_ledger",
  "outgoing_webhooks",
  "revenue_events",
];

const EXPECTED_CAGGS = ["daily_mrr"];

const EXPECTED_COMPRESSION_POLICIES = [
  "credit_ledger",
  "outgoing_webhooks",
  "revenue_events",
];

const EXPECTED_RETENTION_POLICIES = ["outgoing_webhooks"];

const EXPECTED_REFRESH_POLICIES = ["daily_mrr"];

async function main(): Promise<void> {
  const pool = getPool();
  const problems: string[] = [];

  try {
    const hypertables = (
      await pool.query<Hypertable>(
        `SELECT hypertable_name, num_chunks, compression_enabled
         FROM timescaledb_information.hypertables
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
    for (const name of EXPECTED_HYPERTABLES) {
      if (!actualHt.has(name)) problems.push(`missing hypertable: ${name}`);
    }
    for (const h of hypertables) {
      if (
        EXPECTED_COMPRESSION_POLICIES.includes(h.hypertable_name) &&
        !h.compression_enabled
      ) {
        problems.push(
          `compression disabled on hypertable: ${h.hypertable_name}`,
        );
      }
    }

    const caggs = (
      await pool.query<Cagg>(
        `SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY view_name`,
      )
    ).rows;
    console.log("\nContinuous aggregates:");
    for (const c of caggs) console.log(`  ${c.view_name}`);
    const actualCagg = new Set(caggs.map((c) => c.view_name));
    for (const name of EXPECTED_CAGGS) {
      if (!actualCagg.has(name)) problems.push(`missing cagg: ${name}`);
    }

    const policies = (
      await pool.query<Policy>(
        `SELECT proc_name, hypertable_name, scheduled
         FROM timescaledb_information.jobs
         WHERE proc_name IN (
           'policy_compression',
           'policy_retention',
           'policy_refresh_continuous_aggregate'
         )
         ORDER BY proc_name, hypertable_name`,
      )
    ).rows;

    // policy_refresh_continuous_aggregate rows report the cagg name
    // via `hypertable_name` in 2.17 (the cagg's materialisation
    // hypertable). Print the raw rows so the operator can eyeball.
    console.log("\nPolicies:");
    for (const p of policies) {
      console.log(
        `  ${p.proc_name}  on  ${p.hypertable_name ?? "(null)"}  scheduled=${p.scheduled}`,
      );
    }

    const compressionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_compression")
        .map((p) => p.hypertable_name ?? ""),
    );
    for (const name of EXPECTED_COMPRESSION_POLICIES) {
      if (!compressionTargets.has(name))
        problems.push(`missing compression policy: ${name}`);
    }

    const retentionTargets = new Set(
      policies
        .filter((p) => p.proc_name === "policy_retention")
        .map((p) => p.hypertable_name ?? ""),
    );
    for (const name of EXPECTED_RETENTION_POLICIES) {
      if (!retentionTargets.has(name))
        problems.push(`missing retention policy: ${name}`);
    }

    // Refresh-policy rows reference the materialisation hypertable
    // (internal name like `_materialized_hypertable_NN`), not the
    // public cagg name. Count rows per proc as the existence check.
    const refreshCount = policies.filter(
      (p) => p.proc_name === "policy_refresh_continuous_aggregate",
    ).length;
    if (refreshCount < EXPECTED_REFRESH_POLICIES.length) {
      problems.push(
        `expected >= ${EXPECTED_REFRESH_POLICIES.length} refresh policies, found ${refreshCount}`,
      );
    }

    for (const p of policies) {
      if (!p.scheduled) {
        problems.push(
          `policy not scheduled: ${p.proc_name} on ${p.hypertable_name ?? "(null)"}`,
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
