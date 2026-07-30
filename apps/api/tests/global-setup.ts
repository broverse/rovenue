// =============================================================
// Vitest globalSetup — the template database the workers clone
// =============================================================
//
// WHY THIS EXISTS
//
// Every integration suite in this package used to run against ONE shared
// Postgres, in parallel. Teardowns are written as if they own the database —
// `DELETE FROM "user"`, delete-the-project-and-cascade — so one file's cleanup
// routinely deleted rows another file was mid-test with. The symptom was not
// a stable set of failures but a MOVING one: two consecutive runs of the same
// commit produced 31 and 34 failures with different files each time, and a
// suite that passed 4/4 alone failed 3 of 4 in the pack. A suite like that
// cannot tell a regression from an interleaving.
//
// The fix is one database per vitest worker, cloned from a template. Files
// inside a worker keep sharing a database, which is fine: vitest runs them
// sequentially there, and that is the assumption the existing file-scoped
// teardowns were already written against. What goes away is the PARALLEL
// interference between workers — the part no single test file could fix.
//
// WHY THE TEMPLATE IS MIGRATED AND NOT CLONED
//
// It used to be cloned from whatever database DATABASE_URL pointed at,
// because the migrations could not be replayed: migration 0015a's lineage
// does `CREATE EXTENSION timescaledb`, and the Postgres image this repo
// ships (deploy/postgres, pg_partman) has no timescaledb.control. That made
// the test template a copy of a historical artifact — a database nobody
// could recreate, carrying whatever rows the developer happened to have.
//
// `runFreshInstall` (packages/db/src/fresh-install.ts) removes that
// constraint: it walks the journal and marks the timescale-era entries
// applied without executing them, landing the same schema the upgrade path
// produces. The template is now built from migrations alone, so it is empty,
// deterministic, and reproducible on a machine that has never had a dev
// database — which is what lets CI run these suites at all.
//
// The template is built ONCE and kept. Delete `rovenue_test_tpl` by hand to
// force a rebuild after adding a migration.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runFreshInstall } from "@rovenue/db/src/fresh-install";

const execFileAsync = promisify(execFile);

/** Repo root, from apps/api/tests/ — used to locate the seed script and
 *  the tsx binary that runs it. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const TEMPLATE_DB = "rovenue_test_tpl";
/** Worker databases are named `<prefix><poolId>` — see tests/setup.ts. */
export const WORKER_DB_PREFIX = "rovenue_test_w";

function baseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://rovenue:rovenue@localhost:5433/rovenue"
  );
}

/** The configured URL with its database swapped for `postgres`: neither
 *  CREATE nor DROP DATABASE may run while connected to the database being
 *  altered. */
export function adminUrl(): string {
  const u = new URL(baseUrl());
  u.pathname = "/postgres";
  return u.toString();
}

export function databaseUrlFor(dbName: string): string {
  const u = new URL(baseUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** DROP with FORCE (PG13+) so a connection left behind by a crashed run
 *  cannot wedge the next one. */
export async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

async function exists(client: Client, name: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [name],
  );
  return (rowCount ?? 0) > 0;
}

/** Run packages/db/seed.ts against the template.
 *
 *  The suites expect a seeded database — billing_tier_limits' four-tier
 *  ladder, the demo project, and the demo subscribers are all fixtures that
 *  no migration creates (the header note in billing-tier-limits-seed.test.ts
 *  says as much). While the template was a clone of the developer's database
 *  this came for free, because that database had been seeded by hand at some
 *  point. Building from migrations alone drops it, so the seed becomes an
 *  explicit step — which is the point: reproducible rather than inherited.
 *
 *  Spawned rather than imported because seed.ts is a script: it runs on
 *  import and reads DATABASE_URL when its pool module is first evaluated, so
 *  pointing it at the template means setting the variable in a child
 *  process, not in ours. */
async function seedTemplate(): Promise<void> {
  await execFileAsync(
    `${REPO_ROOT}node_modules/.bin/tsx`,
    [`${REPO_ROOT}packages/db/seed.ts`],
    {
      cwd: `${REPO_ROOT}packages/db`,
      env: { ...process.env, DATABASE_URL: databaseUrlFor(TEMPLATE_DB) },
    },
  );
}

export async function setup(): Promise<void> {
  const alreadyBuilt = await withAdmin((client) => exists(client, TEMPLATE_DB));
  if (alreadyBuilt) return;

  console.log(`[test-db] building template "${TEMPLATE_DB}" from migrations`);
  await withAdmin(async (client) => {
    await client.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  });

  // If either step throws, drop the half-built database rather than leave it
  // behind: `exists()` is the only staleness check there is, so an
  // empty-but-present template would be cloned by every subsequent run and
  // every suite would fail on missing tables instead of on the error that
  // actually happened.
  try {
    const client = new Client({ connectionString: databaseUrlFor(TEMPLATE_DB) });
    await client.connect();
    try {
      await runFreshInstall(client);
    } finally {
      // Close before seeding: seed.ts opens its own pool, and the template
      // must end up with no sessions at all — CREATE DATABASE ... TEMPLATE
      // refuses while any session is attached to it.
      await client.end();
    }
    await seedTemplate();
  } catch (err) {
    await withAdmin((c) => dropDatabase(c, TEMPLATE_DB));
    throw err;
  }
}

export async function teardown(): Promise<void> {
  // Worker databases go; the template stays, so the next run starts fast and
  // without touching anyone's connections.
  await withAdmin(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${WORKER_DB_PREFIX}%`],
    );
    for (const row of rows) {
      await dropDatabase(client, row.datname);
    }
  });
}
