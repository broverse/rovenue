import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { env } from "./env";
import { logger } from "./logger";

// =============================================================
// ClickHouse client wrapper
// =============================================================
//
// Source: superseded plan `docs/superpowers/plans/
// 2026-04-23-clickhouse-foundation-and-experiments.md` Task 5.1,
// copied verbatim per Phase F.1 of the Kafka+outbox pivot
// (2026-04-24-kafka-analytics-foundation.md). The read path is
// identical under outbox ingestion — no semantic change.
//
// Project-id scoping: every query accepts a `projectId` and
// threads it into `query_params` so SQL bodies can reference
// `{projectId:String}` without the caller fiddling with
// template strings. That single convention is also why all CH
// tables in this codebase carry a `project_id` column.

const log = logger.child("clickhouse");

let client: ClickHouseClient | null = null;

function getClient(): ClickHouseClient | null {
  if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_PASSWORD) return null;
  if (client) return client;
  client = createClient({
    host: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: "rovenue",
    request_timeout: 15_000,
    max_open_connections: 10,
  });
  log.info("client initialised", { host: env.CLICKHOUSE_URL });
  return client;
}

export class ClickHouseUnavailableError extends Error {
  constructor() {
    super("ClickHouse is not configured; analytics query skipped");
    this.name = "ClickHouseUnavailableError";
  }
}

// Light-weight histogram stub — the full prom-client registry
// lives in a later Phase G task. Observing here is a no-op that
// the caller can swap for a real metrics helper without a type
// change.
const observeAnalyticsQueryDuration = (ms: number): void => {
  if (env.NODE_ENV === "development" && ms > 1000) {
    log.warn("slow analytics query", { ms });
  }
};

export async function queryAnalytics<T>(
  projectId: string,
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const c = getClient();
  if (!c) throw new ClickHouseUnavailableError();

  const start = performance.now();
  try {
    const result = await c.query({
      query: sql,
      query_params: { ...params, projectId },
      format: "JSONEachRow",
    });
    return (await result.json()) as T[];
  } finally {
    observeAnalyticsQueryDuration(performance.now() - start);
  }
}

export function isClickHouseConfigured(): boolean {
  return Boolean(env.CLICKHOUSE_URL && env.CLICKHOUSE_PASSWORD);
}

// Exported for tests that want to reset the singleton between cases.
export function __resetClickHouseForTests(): void {
  client = null;
}
