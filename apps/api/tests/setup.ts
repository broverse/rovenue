// Seed env vars so lib/auth.ts and lib/env.ts can be imported under test
// without real OAuth credentials or a live database.
//
// Env resolution order (first wins):
//   1. Already-set process.env (e.g. shell export, CI, `pnpm --filter api
//      test` invoked after `source .env`).
//   2. `.env.test` at the repo root (opt-in per-developer overrides —
//      gitignored; copy `.env.test.example` to bootstrap).
//   3. The hardcoded fallbacks below, which target the dev stack defined
//      in `docker-compose.yml`:
//        - Postgres  : host 5433 -> container 5432, user/pwd/db = rovenue
//        - Redis     : host 6380 -> container 6379
//        - Redpanda  : host 19092 (external listener)
//        - ClickHouse: host 8124 -> container 8123, user rovenue / pwd rovenue
//
// Why not `dotenv`? Rovenue has no dotenv dep (see root package.json) and
// the rest of the codebase reads `process.env` directly. A ~15 line
// built-in parser below keeps the dep surface unchanged.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // file missing is fine — fallbacks cover it
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// This file lives at apps/api/tests/setup.ts — repo root is ../../..
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
loadEnvFile(resolve(repoRoot, ".env.test"));

process.env.NODE_ENV ??= "test";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-not-for-prod-xxxxx";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.DASHBOARD_URL ??= "http://localhost:5173";
process.env.GITHUB_CLIENT_ID ??= "test-github-id";
process.env.GITHUB_CLIENT_SECRET ??= "test-github-secret";
process.env.GOOGLE_CLIENT_ID ??= "test-google-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-secret";
// Match docker-compose.yml host port mappings (5433/6380/19092/8124) and
// the default rovenue/rovenue credentials. Tests that need an isolated
// DB (e.g. outbox-dispatcher.integration) override DATABASE_URL inline.
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
process.env.KAFKA_BROKERS ??= "localhost:19092";
process.env.CLICKHOUSE_URL ??= "http://localhost:8124";
process.env.CLICKHOUSE_USER ??= "rovenue";
process.env.CLICKHOUSE_PASSWORD ??= "rovenue";
process.env.ENCRYPTION_KEY ??=
  "6ecfcd0f73d5afe055ff651e0e4ce85679cdd12bb4cede7aa4338b693047b8f1";
