import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@clickhouse/client";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = join(here, "..", "clickhouse", "migrations");

const url = process.env.CLICKHOUSE_URL;
const user = process.env.CLICKHOUSE_USER ?? "rovenue";
const password = process.env.CLICKHOUSE_PASSWORD;
if (!url) throw new Error("CLICKHOUSE_URL is required");
if (!password) throw new Error("CLICKHOUSE_PASSWORD is required");

// Note: migrations run as the write-capable `rovenue` user, not the
// read-only `rovenue_reader`. Production CI must supply the owner
// password here, and the API process uses the reader password.
const client = createClient({
  url,
  username: user,
  password,
  // 0001 creates the `rovenue` database. Start in `default` so the
  // first connection is well-defined; every migration file
  // qualifies its tables with `rovenue.` so the active database of
  // this client connection doesn't matter after bootstrap.
  database: "default",
  request_timeout: 60_000,
});

async function ensureDatabase(): Promise<void> {
  await client.command({
    query: "CREATE DATABASE IF NOT EXISTS rovenue",
  });
}

async function ensureMigrationsTable(): Promise<void> {
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS rovenue._migrations (
        filename String,
        sha256 FixedString(64),
        applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
      )
      ENGINE = ReplacingMergeTree(applied_at)
      ORDER BY filename
    `,
  });
}

async function loadApplied(): Promise<Map<string, string>> {
  const result = await client.query({
    query: "SELECT filename, sha256 FROM rovenue._migrations FINAL",
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{
    filename: string;
    sha256: string;
  }>;
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function applyMigration(
  filename: string,
  content: string,
): Promise<void> {
  // ClickHouse does not support multi-statement in a single query;
  // split on `;` that end a line. Migration files must not contain
  // `;` mid-statement — the raw_* schemas in this plan honour that.
  const statements = content
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const statement of statements) {
    await client.command({ query: statement });
  }

  await client.insert({
    table: "rovenue._migrations",
    values: [{ filename, sha256: sha256Hex(content) }],
    format: "JSONEachRow",
  });
}

async function main(): Promise<void> {
  await ensureDatabase();
  await ensureMigrationsTable();

  const applied = await loadApplied();
  const files = await listMigrations();

  let appliedNow = 0;
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const digest = sha256Hex(content);
    const recorded = applied.get(filename);

    if (recorded === undefined) {
      console.log(`apply ${filename}`);
      await applyMigration(filename, content);
      appliedNow += 1;
      continue;
    }

    if (recorded !== digest) {
      throw new Error(
        `migration ${filename} was previously applied with a different SHA-256. ` +
          `Refusing to re-apply; inspect the file or create a new migration to amend.`,
      );
    }
  }

  console.log(`clickhouse-migrate: ${appliedNow} new / ${files.length} total`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
