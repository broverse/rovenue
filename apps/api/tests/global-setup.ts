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
// WHY THE TEMPLATE IS CLONED AND NOT MIGRATED
//
// The obvious build is "create an empty database and run the migrations".
// That does not work here, and the reason is worth knowing: migration 0015a's
// lineage still does `CREATE EXTENSION timescaledb`, and the Postgres image
// this repo ships (deploy/postgres, pg_partman) has no timescaledb.control.
// The migrations therefore CANNOT be replayed from scratch on the current
// image — the working dev database is a historical artifact created under an
// older image. Fixing that is its own piece of work; until then the template
// is a clone of whatever database DATABASE_URL already points at.
//
// The template is built ONCE and kept. Cloning needs the source to have no
// other sessions, so building it terminates idle connections to the source —
// an intrusive act, deliberately made rare rather than something every test
// run does silently. Delete `rovenue_test_tpl` by hand to force a rebuild
// after a migration.

import { Client } from "pg";

export const TEMPLATE_DB = "rovenue_test_tpl";
/** Worker databases are named `<prefix><poolId>` — see tests/setup.ts. */
export const WORKER_DB_PREFIX = "rovenue_test_w";

function baseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://rovenue:rovenue@localhost:5433/rovenue"
  );
}

/** The database DATABASE_URL currently names — the clone source. */
export function sourceDbName(): string {
  return new URL(baseUrl()).pathname.replace(/^\//, "") || "rovenue";
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

export async function setup(): Promise<void> {
  await withAdmin(async (client) => {
    if (await exists(client, TEMPLATE_DB)) return;

    const source = sourceDbName();
    // CREATE DATABASE ... TEMPLATE refuses while any other session is on the
    // source. Terminate only IDLE ones and say so — an in-flight query is
    // somebody's work and killing it would be worse than failing loudly.
    const { rows } = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND state = 'idle'`,
      [source],
    );
    if (rows.length > 0) {
      console.log(
        `[test-db] terminating ${rows.length} idle connection(s) to "${source}" to build the template`,
      );
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid() AND state = 'idle'`,
        [source],
      );
    }

    console.log(`[test-db] building template "${TEMPLATE_DB}" from "${source}"`);
    await client.query(`CREATE DATABASE "${TEMPLATE_DB}" TEMPLATE "${source}"`);
  });
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
