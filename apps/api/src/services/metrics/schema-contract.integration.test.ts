// =============================================================
// Metrics schema-contract test — the centrepiece
// =============================================================
//
// Every metrics unit test mocks ClickHouse (`vi.mock("../../lib/clickhouse")`,
// see charts.paywall.test.ts). Those tests prove the TypeScript composed the
// SQL string it meant to; nothing proves the SQL is valid against the real
// schema. That gap is exactly how `readFilterOptions` shipped broken:
//
//   Code: 47. DB::Exception: Unknown expression or function identifier
//   'subscriberCountry'
//   Code: 47. DB::Exception: Unknown expression or function identifier
//   'productGroupId'
//
// THE SEAM
// --------
// The mocked client lives at `../../lib/clickhouse`'s module-level
// singleton, built lazily from `env.CLICKHOUSE_*`. `mrr-clickhouse-only.
// integration.test.ts` and `analytics-clickhouse.integration.test.ts`
// already establish the pattern this file reuses: start a real ClickHouse
// (+ Redpanda, so the Kafka-Engine migration tables apply cleanly — see
// their headers), mutate the shared `env` object and call
// `__resetClickHouseForTests()`, then let production code run unmodified.
// No mock, no re-typed SQL — the exact query string the service builds is
// the one that executes. A re-typed copy would only prove the copy is
// valid; it is not reachable from here at all.
//
// A fresh, unused project id is used throughout and NO rows are seeded.
// Every ClickHouse query in the metrics services is bounded by
// `WHERE projectId = {projectId:String}` (see CLAUDE.md's Postgres
// convention mirrored here), so a fresh id always yields an empty result
// set. That is a PASS: this test checks schema validity — every column and
// function the query references actually exists — not data. A query with a
// bad column reference fails with `UNKNOWN_IDENTIFIER` regardless of row
// count, and asserting on rows would need fixtures and would make the test
// about something else.
//
// CATALOG-DRIVEN, NOT A HAND-KEPT LIST
// -------------------------------------
// Two enumeration sources, both derived from the code rather than retyped:
//
//   1. `SYSTEM_CHART_IDS` (chart-catalog.ts) drives one invocation of
//      `readChartSeries` per id. `readChartSeries`'s switch is documented
//      as the ONLY dispatch mechanism (charts.ts) — a chart wired up next
//      month is automatically exercised the moment its id lands in the
//      catalog, with no test file to remember to touch.
//   2. Every other ClickHouse-touching metrics module (charts.ts's
//      standalone readers, ltv.ts, ltv-prediction.ts, mrr.ts,
//      mrr-decomposition.ts, engagement.ts, summary.ts, overview.ts,
//      credits.ts, transactions.ts) is reflected over at runtime
//      (`Object.entries` on the imported namespace) against a REGISTRY of
//      invokers below. A function can't be forgotten silently: the
//      "harness completeness" test asserts every exported FUNCTION is
//      either invoked or explicitly exempted with a stated reason (pure
//      helper / cursor codec / Postgres-only). Exported constants bags
//      (`__chartsConstants` and friends) need no exemption — the check
//      skips non-functions outright. Add a new
//      exported query function without wiring an invoker and this suite
//      goes red naming exactly which export is uncovered — it cannot drift
//      back into the silently-mocked-forever state that shipped the
//      original bug.
//
// Functions that mix ClickHouse with Postgres (overview.ts, credits.ts,
// transactions.ts, summary.ts, ltv-prediction.ts) are invoked in full —
// the ambient per-worker Postgres template (tests/global-setup.ts) is
// already migrated and reachable via `DATABASE_URL`, and every Postgres
// read here is a plain `WHERE "projectId" = ...` scan that returns zero
// rows for a project that was never seeded, not an error.
//
// NOT parallel-safe: binds fixed host ports (see host-port-allocations.
// test.ts registry) CH_HOST_PORT=8232, BROKER_EXTERNAL_PORT=19104.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient } from "@clickhouse/client";
import { Kafka } from "kafkajs";
import { __resetClickHouseForTests } from "../../lib/clickhouse";
import { env } from "../../lib/env";
import { SYSTEM_CHART_IDS } from "./chart-catalog";
import * as analyticsRouterModule from "../analytics-router";
import * as chartsModule from "./charts";
import * as creditsModule from "./credits";
import * as engagementModule from "./engagement";
import * as ltvModule from "./ltv";
import * as ltvPredictionModule from "./ltv-prediction";
import * as mrrModule from "./mrr";
import * as mrrDecompositionModule from "./mrr-decomposition";
import * as overviewModule from "./overview";
import * as summaryModule from "./summary";
import * as transactionsModule from "./transactions";

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;

const BROKER_EXTERNAL_PORT = 19104;
const CH_HOST_PORT = 8232;

const RUN_ID = Date.now();
/** Fresh, never-seeded project id. Every metrics query scopes on
 *  `projectId`, so this always yields an empty (but schema-valid) result. */
const PROJECT = `prj_schema_contract_${RUN_ID}`;

const WINDOW_DAYS = 28;
const FROM = new Date("2026-01-01T00:00:00Z");
const TO = new Date("2026-12-31T00:00:00Z");

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}

beforeAll(async () => {
  network = await new Network().start();

  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withNetwork(network)
    .withNetworkAliases("redpanda")
    .withCommand([
      "redpanda",
      "start",
      "--smp=1",
      "--memory=512M",
      "--overprovisioned",
      "--node-id=0",
      "--check=false",
      `--kafka-addr=INTERNAL://0.0.0.0:9092,EXTERNAL://0.0.0.0:${BROKER_EXTERNAL_PORT}`,
      `--advertise-kafka-addr=INTERNAL://redpanda:9092,EXTERNAL://localhost:${BROKER_EXTERNAL_PORT}`,
    ])
    .withExposedPorts({
      container: BROKER_EXTERNAL_PORT,
      host: BROKER_EXTERNAL_PORT,
    })
    .start();
  const brokerUrl = `localhost:${BROKER_EXTERNAL_PORT}`;

  const kafkaAdmin = new Kafka({
    clientId: "schema-contract-setup",
    brokers: [brokerUrl],
  }).admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    topics: [
      { topic: "rovenue.exposures", numPartitions: 1 },
      { topic: "rovenue.revenue", numPartitions: 1 },
      { topic: "rovenue.credit", numPartitions: 1 },
    ],
  });
  await kafkaAdmin.disconnect();

  clickhouse = await new GenericContainer(
    "clickhouse/clickhouse-server:24.3-alpine",
  )
    .withNetwork(network)
    .withNetworkAliases("clickhouse")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  // `env` is `envSchema.parse(process.env)` evaluated once at import, so a
  // later process.env write alone is invisible to the already-built
  // singleton in lib/clickhouse.ts. Mutate the shared (unfrozen) env object
  // directly and drop the memoised client — see mrr-clickhouse-only's
  // header note, which is where this workaround was first diagnosed.
  const mEnv = env as {
    CLICKHOUSE_URL?: string;
    CLICKHOUSE_USER?: string;
    CLICKHOUSE_PASSWORD?: string;
  };
  mEnv.CLICKHOUSE_URL = chUrl;
  mEnv.CLICKHOUSE_USER = "rovenue";
  mEnv.CLICKHOUSE_PASSWORD = "rovenue_test";
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";
  __resetClickHouseForTests();

  let stableSuccesses = 0;
  await waitFor(async () => {
    const probe = createClient({
      url: chUrl,
      username: "rovenue",
      password: "rovenue_test",
    });
    try {
      const res = await probe.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
      const rows = (await res.json()) as Array<{ ok: number }>;
      if (rows[0]?.ok === 1) {
        stableSuccesses++;
        return stableSuccesses >= 3;
      }
      stableSuccesses = 0;
      return false;
    } finally {
      await probe.close();
    }
  }, 45_000);

  // --- apply every CH migration so the schema under test is the real one ---
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "default",
    request_timeout: 60_000,
  });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (
      filename String,
      sha256 FixedString(64),
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const mig = createClient({
    url: chUrl,
    username: "rovenue",
    password: "rovenue_test",
    database: "rovenue",
    request_timeout: 60_000,
  });

  const migrationsDir = join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "db",
    "clickhouse",
    "migrations",
  );
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content
      .split(/;\s*$/m)
      .map((s) => {
        const lines = s.split("\n");
        const firstNonComment = lines.findIndex(
          (l) => l.trim().length > 0 && !l.trim().startsWith("--"),
        );
        return firstNonComment >= 0
          ? lines.slice(firstNonComment).join("\n").trim()
          : "";
      })
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await mig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbName, tblName] = m[1]!.includes(".")
            ? m[1]!.split(".")
            : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await mig.query({
              query: `SELECT count() AS c FROM system.tables WHERE database = '${dbName}' AND name = '${tblName}'`,
              format: "JSONEachRow",
            });
            const rows = (await res.json()) as Array<{ c: string | number }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await mig.insert({
      table: "_migrations",
      values: [{ filename, sha256 }],
      format: "JSONEachRow",
    });
  }
  await mig.close();
}, 300_000);

afterAll(async () => {
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

// =============================================================
// Part 1: every chart-catalog id, dispatched for real
// =============================================================

describe("chart catalog dispatch (readChartSeries) — every SYSTEM_CHART_IDS entry", () => {
  for (const id of SYSTEM_CHART_IDS) {
    it(`chartId="${id}" runs against the real schema without a ClickHouse exception`, async () => {
      await chartsModule.readChartSeries(PROJECT, id, WINDOW_DAYS);
    });
  }
});

// =============================================================
// Part 2: every other ClickHouse-touching export, via a registry
// checked for completeness against the live module exports
// =============================================================

type Invoker = () => Promise<unknown>;

interface ModuleCoverage {
  moduleName: string;
  module: Record<string, unknown>;
  /** Exported names that issue no ClickHouse query, with the reason —
   *  these are deliberately NOT invoked. */
  exempt: Record<string, string>;
  invokers: Record<string, Invoker>;
}

// THE ONE HAND-KEPT EDGE
// ----------------------
// Enumeration is reflection-driven WITHIN each listed module — a new
// export in any module below is caught by the completeness test at the
// bottom. The MODULE LIST ITSELF is manual. A brand-new
// `services/metrics/*.ts` that issues `queryAnalytics` and is never
// added here is silently uncovered, and nothing in this file will say
// so. Adding a metrics module means adding it to this array.
//
// (Globbing the directory instead would trade this gap for a worse one:
// every module would need an invoker guessed from its signature, and a
// module that cannot be invoked with a fresh project id — one needing
// seeded rows, say — would have to be exempted anyway.)
const REGISTRY: ReadonlyArray<ModuleCoverage> = [
  {
    moduleName: "charts",
    module: chartsModule as unknown as Record<string, unknown>,
    exempt: {
      readChartSeries: "covered above, once per SYSTEM_CHART_IDS entry",
      buildRatePoints:
        "pure arithmetic extracted specifically so it needs no ClickHouse — see its doc comment",
      buildMrrSeriesPoints:
        "pure arithmetic extracted specifically so it needs no ClickHouse — see its doc comment (task-2 revenue ids: mrr/arr/gross_vs_net/arpu)",
      buildCountSeriesPoints:
        "pure arithmetic extracted specifically so it needs no ClickHouse — see its doc comment (task-3 lifecycle ids: new_subs/reactivations/trials_started/churn — churn switched from a rate to a count in fix round 1, see task-3-fixes.md)",
    },
    invokers: {
      readChannels: () => chartsModule.readChannels(PROJECT, WINDOW_DAYS),
      readFunnel: () => chartsModule.readFunnel(PROJECT, WINDOW_DAYS),
      readHeatmap: () => chartsModule.readHeatmap(PROJECT, WINDOW_DAYS),
      readFilterOptions: () =>
        chartsModule.readFilterOptions(PROJECT, WINDOW_DAYS),
      // Mixes ClickHouse (gross/refunds per store) with Postgres
      // (resolveCommissionRate) — same pattern as overview/credits/
      // summary/ltv-prediction below. PROJECT is fresh and unseeded in
      // both stores, so this exercises the CH query's schema validity
      // with zero rows returned (a pass, per this file's header) and
      // issues no Postgres call at all in that case.
      readProceeds: () => chartsModule.readProceeds(PROJECT, WINDOW_DAYS),
    },
  },
  {
    moduleName: "ltv",
    module: ltvModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      getLtvDistribution: () => ltvModule.getLtvDistribution(PROJECT),
    },
  },
  {
    moduleName: "ltv-prediction",
    module: ltvPredictionModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      getLtvPrediction: () =>
        ltvPredictionModule.getLtvPrediction({
          projectId: PROJECT,
          horizonMonths: 12,
          minMatureCohorts: 1,
        }),
    },
  },
  {
    moduleName: "mrr",
    module: mrrModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      listDailyMrr: () =>
        mrrModule.listDailyMrr({ projectId: PROJECT, from: FROM, to: TO }),
    },
  },
  {
    moduleName: "mrr-decomposition",
    module: mrrDecompositionModule as unknown as Record<string, unknown>,
    exempt: {
      getMrrDecompositionDailyCounts:
        "covered above, once per SYSTEM_CHART_IDS entry — dispatched via readChartSeries's 'new_subs' and 'reactivations' cases (task-3)",
    },
    invokers: {
      getMrrDecomposition: () =>
        mrrDecompositionModule.getMrrDecomposition({
          projectId: PROJECT,
          from: FROM,
          to: TO,
        }),
    },
  },
  {
    moduleName: "engagement",
    module: engagementModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      listEngagement: () =>
        engagementModule.listEngagement({
          projectId: PROJECT,
          from: FROM,
          to: TO,
        }),
    },
  },
  {
    moduleName: "summary",
    module: summaryModule as unknown as Record<string, unknown>,
    exempt: {
      // Postgres-only (see summary.ts's daily-grain header comment) — no
      // ClickHouse schema to validate — but still exercised, once per
      // SYSTEM_CHART_IDS entry, via readChartSeries's 'trials_started'
      // and 'churn' cases (task-3).
      getTrialStartsDaily: "Postgres-only; covered above via 'trials_started'",
      getChurnDaily: "Postgres-only; covered above via 'churn'",
      // Unlike its two siblings above, this one IS ClickHouse (task 4:
      // see its doc comment) — still exempted here for the same reason
      // as getMrrDecompositionDailyCounts: it's exercised, once, via
      // SYSTEM_CHART_IDS's 'trial_to_paid' entry above, which schema-
      // validates the real SQL against the real container.
      getTrialConversionsDaily:
        "ClickHouse; covered above, once per SYSTEM_CHART_IDS entry — dispatched via readChartSeries's 'trial_to_paid' case (task-4)",
    },
    invokers: {
      getRevenueSummary: () =>
        summaryModule.getRevenueSummary({
          projectId: PROJECT,
          from: FROM,
          to: TO,
        }),
    },
  },
  {
    moduleName: "overview",
    module: overviewModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      getProjectOverview: () =>
        overviewModule.getProjectOverview({
          projectId: PROJECT,
          windowDays: WINDOW_DAYS,
        }),
    },
  },
  {
    moduleName: "credits",
    module: creditsModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      getCreditsRollup: () =>
        creditsModule.getCreditsRollup({
          projectId: PROJECT,
          windowDays: WINDOW_DAYS,
        }),
    },
  },
  {
    moduleName: "transactions",
    module: transactionsModule as unknown as Record<string, unknown>,
    exempt: {
      encodeCursor: "pure cursor codec, no ClickHouse query",
      decodeCursor: "pure cursor codec, no ClickHouse query",
      decodeOffsetCursor: "pure cursor codec, no ClickHouse query",
      syncTransactions:
        "Postgres-only outbox-lag probe (drizzle.schema.outboxEvents) — no ClickHouse query",
    },
    invokers: {
      listTransactions: () =>
        transactionsModule.listTransactions({
          projectId: PROJECT,
          scope: "all",
          limit: 10,
          cursor: null,
        }),
      exportTransactionsCsv: () =>
        transactionsModule.exportTransactionsCsv({
          projectId: PROJECT,
          scope: "all",
        }),
      listTransactionsVolume: () =>
        transactionsModule.listTransactionsVolume({
          projectId: PROJECT,
          windowDays: WINDOW_DAYS,
        }),
      listStoreBreakdown: () =>
        transactionsModule.listStoreBreakdown({
          projectId: PROJECT,
          windowDays: WINDOW_DAYS,
        }),
    },
  },
  {
    // Not under services/metrics/ (it lives at services/analytics-router.ts)
    // but registered here anyway: Task 3 of the experiments decision-engine
    // plan added the subscriber-level windowed value aggregates this reader
    // now runs, and this harness is exactly the guard that exists because a
    // reader querying columns that never existed once shipped green in CI
    // behind a mock (see this file's header). One invoker exercises all
    // three AnalyticsQuery kinds so every branch of the dispatcher's switch
    // gets schema-validated against the live ClickHouse, not just whichever
    // kind happened to be called first.
    moduleName: "analytics-router",
    module: analyticsRouterModule as unknown as Record<string, unknown>,
    exempt: {},
    invokers: {
      runAnalyticsQuery: async () => {
        await analyticsRouterModule.runAnalyticsQuery({
          kind: "experiment_results",
          projectId: PROJECT,
          experimentId: "exp_schema_contract",
          experimentKey: "exp_schema_contract_key",
        });
        await analyticsRouterModule.runAnalyticsQuery({
          kind: "experiment_revenue_by_store",
          projectId: PROJECT,
          experimentId: "exp_schema_contract",
        });
        await analyticsRouterModule.runAnalyticsQuery({
          kind: "placement_metrics",
          projectId: PROJECT,
          placementId: "plc_schema_contract",
        });
      },
    },
  },
];

describe("schema-contract harness completeness", () => {
  it("every exported function is either invoked or explicitly exempted", () => {
    const missing: string[] = [];
    for (const { moduleName, module, exempt, invokers } of REGISTRY) {
      for (const [key, value] of Object.entries(module)) {
        // Interfaces/types are erased at runtime and never appear here;
        // only functions and runtime constants land in Object.entries.
        if (typeof value !== "function") continue;
        if (key in exempt) continue;
        if (!(key in invokers)) missing.push(`${moduleName}.${key}`);
      }
    }
    expect(
      missing,
      `New export(s) not wired into the schema-contract harness: ${missing.join(", ")}. ` +
        `Add an invoker, or an exempt[key] entry with a reason, in schema-contract.integration.test.ts.`,
    ).toEqual([]);
  });
});

describe("metrics service queries — real ClickHouse, empty result is a pass", () => {
  for (const { moduleName, invokers } of REGISTRY) {
    describe(moduleName, () => {
      for (const [name, invoke] of Object.entries(invokers)) {
        it(`${name} runs against the real schema without a ClickHouse exception`, async () => {
          await invoke();
        });
      }
    });
  }
});
