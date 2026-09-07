// =============================================================
// rotateEncryptionKey, proved against a real, disposable Postgres
// =============================================================
//
// WHY A CONTAINER AND NOT A MOCK
//
// The defect this file exists to prevent is a column list that has drifted
// away from the schema. The predecessor of this script rotated a
// `stripeCredentials` column that migration 0087 had deleted, and knew
// nothing about `copilot_credentials` or `integration_connections` at all —
// neither of which any mock would have caught, because a mock agrees with
// whatever the code asks it for. The only thing that can fail on drift is a
// real database built from the real migrations.
//
// The container is built from `deploy/postgres/` — the same image the
// compose stack runs — because the migration chain needs pg_partman, which
// stock `postgres:16` does not have. `runFreshInstall` then applies the
// whole journal (marking the TimescaleDB-era entries applied without
// executing them, exactly as CI and a fresh self-host do).
//
// THIS NEVER TOUCHES A DEVELOPER DATABASE. The container is created here,
// bound to an ephemeral host port, and destroyed in afterAll. Nothing in
// this file reads DATABASE_URL.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runFreshInstall } from "@rovenue/db/src/fresh-install";
import { encrypt, decrypt, generateKey } from "@rovenue/shared/crypto";
import { drizzle, encryptCredential } from "@rovenue/db";
import {
  ROTATED_COLUMNS,
  assertRotatableKeys,
  rotateEncryptionKey,
  type Db,
  type RotationSummary,
} from "./rotate-encryption-key";

const POSTGRES_CONTEXT = fileURLToPath(
  new URL("../deploy/postgres/", import.meta.url),
);
const POSTGRES_IMAGE_TAG = "rovenue-db-rotation-test:latest";
const POSTGRES_PORT = 5432;
const POSTGRES_USER = "rovenue";
const POSTGRES_PASSWORD = "rovenue-rotation-test";
const POSTGRES_DB = "rovenue_rotation_test";

// The postgres entrypoint starts the server once for initdb and again for
// real, so the readiness line appears twice.
const READY_LOG_OCCURRENCES = 2;

const CONTAINER_STARTUP_MS = 300_000;

// Three synthetic keys. NEITHER is any deployment's real key, and THIRD_KEY
// exists only to manufacture a row that decrypts under neither OLD nor NEW.
const OLD_KEY = generateKey();
const NEW_KEY = generateKey();
const THIRD_KEY = generateKey();

const APPLE_PLAINTEXT = { issuerId: "apple-issuer", keyId: "AK1", p8: "-----BEGIN-----" };
const GOOGLE_PLAINTEXT = { clientEmail: "svc@example.iam", privateKey: "goog-pk" };
const LEGACY_PLAINTEXT = { issuerId: "never-encrypted", keyId: "LEGACY" };
const COPILOT_API_KEY = "sk-rotation-test-abcdef";
const INTEGRATION_CREDENTIALS = { accessToken: "tok_123", pixelId: "99887766" };

const PROJECT_ENCRYPTED = "proj_rot_encrypted";
const PROJECT_LEGACY_PLAINTEXT = "proj_rot_plaintext";
const PROJECT_UNDECRYPTABLE = "proj_rot_undecryptable";
const PROJECT_EMPTY = "proj_rot_empty";
const PROJECT_SHAPE_B_IN_SHAPE_A = "proj_rot_shape_b_string";
const CONNECTION_OK = "conn_rot_ok";
const CONNECTION_CORRUPT = "conn_rot_corrupt";
const USER_ID = "user_rot_test";

/** apple×1 + google×1 on the encrypted project, the legacy plaintext row,
 *  the copilot key and the healthy integration connection. */
const EXPECTED_ROTATIONS = 5;
/** The THIRD_KEY project, the non-ciphertext connection, and the bare
 *  shape-B string sitting in a shape-A column. */
const EXPECTED_FAILURES = 3;

let container: StartedTestContainer;
let pool: Pool;
let db: Db;

/** Every log line the script emits, so assertions can prove an operator
 *  would actually SEE a failure rather than only find it in a counter. */
let logLines: string[] = [];
const capture = (line: string): void => {
  logLines.push(line);
};

async function seedFixtures(): Promise<void> {
  // Order matters: user → projects → the two credential tables (FKs).
  await pool.query(`DELETE FROM integration_connections`);
  await pool.query(`DELETE FROM copilot_credentials`);
  await pool.query(`DELETE FROM projects WHERE id LIKE 'proj_rot_%'`);
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [USER_ID]);

  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'Rotation Test', 'rotation@example.test', true, now(), now())`,
    [USER_ID],
  );

  const apple = encryptCredential(APPLE_PLAINTEXT, OLD_KEY);
  const google = encryptCredential(GOOGLE_PLAINTEXT, OLD_KEY);
  await pool.query(
    `INSERT INTO projects (id, name, "appleCredentials", "googleCredentials")
     VALUES ($1, 'encrypted', $2::jsonb, $3::jsonb)`,
    [PROJECT_ENCRYPTED, JSON.stringify(apple), JSON.stringify(google)],
  );

  // A row from before encryption was wired: bare plaintext JSON, which
  // `decryptCredential` passes through. Rotation must bring it under a key.
  await pool.query(
    `INSERT INTO projects (id, name, "appleCredentials") VALUES ($1, 'legacy', $2::jsonb)`,
    [PROJECT_LEGACY_PLAINTEXT, JSON.stringify(LEGACY_PLAINTEXT)],
  );

  // Encrypted under a key nobody running the rotation has.
  await pool.query(
    `INSERT INTO projects (id, name, "appleCredentials") VALUES ($1, 'undecryptable', $2::jsonb)`,
    [
      PROJECT_UNDECRYPTABLE,
      JSON.stringify(encryptCredential({ lost: true }, THIRD_KEY)),
    ],
  );

  // Both credential columns NULL — must be counted empty, never failed.
  await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'empty')`, [
    PROJECT_EMPTY,
  ]);

  // A bare shape-B ciphertext STRING in a shape-A jsonb column — what a
  // hand-written UPDATE, or code reaching for the wrong helper, leaves
  // behind. `isEncryptedCredential` says false for it (it is a string, not
  // an object with v === 1), so the naive reading is "legacy plaintext,
  // encrypt it" — which would wrap a ciphertext inside a ciphertext and
  // report it as a clean [OK] line.
  await pool.query(
    `INSERT INTO projects (id, name, "appleCredentials") VALUES ($1, 'shape-b-string', $2::jsonb)`,
    [
      PROJECT_SHAPE_B_IN_SHAPE_A,
      JSON.stringify(encrypt(JSON.stringify(APPLE_PLAINTEXT), OLD_KEY)),
    ],
  );

  await pool.query(
    `INSERT INTO copilot_credentials
       (project_id, provider, api_key_encrypted, default_model, updated_by_user_id)
     VALUES ($1, 'anthropic', $2, 'claude-3-5-sonnet', $3)`,
    [PROJECT_ENCRYPTED, encrypt(COPILOT_API_KEY, OLD_KEY), USER_ID],
  );

  await pool.query(
    `INSERT INTO integration_connections
       (id, project_id, provider_id, display_name, credentials_cipher, credentials_hint)
     VALUES ($1, $2, 'META_ADS', 'Meta', $3, 'Pixel 9988…7766')`,
    [
      CONNECTION_OK,
      PROJECT_ENCRYPTED,
      encrypt(JSON.stringify(INTEGRATION_CREDENTIALS), OLD_KEY),
    ],
  );

  // Not "iv:tag:data" at all — the shape a truncated/garbled write leaves.
  await pool.query(
    `INSERT INTO integration_connections
       (id, project_id, provider_id, display_name, credentials_cipher, credentials_hint)
     VALUES ($1, $2, 'CUSTOM_WEBHOOK', 'Broken', $3, 'hint')`,
    [CONNECTION_CORRUPT, PROJECT_ENCRYPTED, "this-is-not-ciphertext"],
  );
}

async function readColumn(
  table: string,
  idColumn: string,
  rowId: string,
  column: string,
): Promise<unknown> {
  const { rows } = await pool.query(
    `SELECT "${column}" AS v FROM ${table} WHERE "${idColumn}" = $1`,
    [rowId],
  );
  return rows[0]?.v ?? null;
}

/** A snapshot of every ciphertext in the database. AES-GCM uses a fresh
 *  random IV per call, so ANY re-encryption changes these bytes — which
 *  makes byte-equality a real proof that a second run wrote nothing, not
 *  just a restatement of the script's own counter. */
async function ciphertextSnapshot(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT id,
            "appleCredentials"::text  AS apple,
            "googleCredentials"::text AS google
       FROM projects ORDER BY id`,
  );
  const { rows: copilot } = await pool.query(
    `SELECT project_id, api_key_encrypted FROM copilot_credentials ORDER BY project_id`,
  );
  const { rows: conns } = await pool.query(
    `SELECT id, credentials_cipher FROM integration_connections ORDER BY id`,
  );
  return JSON.stringify({ rows, copilot, conns });
}

beforeAll(async () => {
  const image = await GenericContainer.fromDockerfile(POSTGRES_CONTEXT).build(
    POSTGRES_IMAGE_TAG,
    { deleteOnExit: false },
  );
  container = await image
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB,
    })
    .withExposedPorts(POSTGRES_PORT)
    .withWaitStrategy(
      Wait.forLogMessage(
        /database system is ready to accept connections/,
        READY_LOG_OCCURRENCES,
      ),
    )
    .withStartupTimeout(CONTAINER_STARTUP_MS)
    .start();

  const connectionString =
    `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@` +
    `${container.getHost()}:${container.getMappedPort(POSTGRES_PORT)}/${POSTGRES_DB}`;

  pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await runFreshInstall(client);
  } finally {
    client.release();
  }
  db = drizzle.createDb(pool);
}, CONTAINER_STARTUP_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  logLines = [];
  await seedFixtures();
});

// =============================================================
// The encrypted surface, swept out of the source rather than restated
// =============================================================
//
// The predecessor of this block asserted `ROTATED_COLUMNS` against a
// hand-written copy of itself. That fails only when someone edits
// `buildTargets()` — which is the one case where they have already thought
// about rotation. The case that matters is the opposite one: a developer
// adds a FIFTH `encrypt()`-backed column in some route, never thinks about
// this file, and the rotation tool silently stops covering the whole
// surface. A literal in this file cannot see that happen.
//
// So the surface is derived from the source instead. Every call of the four
// crypto entry points across `apps/` and `packages/` is swept up and keyed
// `<repo-relative path>:<symbol>` with its call count, and that map is
// asserted against CRYPTO_CALL_SITES below. A new call site — a new file, a
// new symbol in an existing file, or one more call in a file that already
// had some — fails this test BY NAME, and whoever added it has to classify
// it: either it reads/writes a column the rotation tool covers, or it is
// OUT_OF_SCOPE with a reason. Classifying it as a column the tool does not
// rotate fails the second assertion, also by name.
//
// This is deliberately stricter than it needs to be. A false positive costs
// one line in the table below plus the thought that produced it; a false
// negative costs a credential nobody can decrypt after the next rotation.
//
// SCOPE — production call sites only. Test files and fixtures are swept out
// entirely. A test can call `encrypt()` a hundred times without introducing
// an encrypted *column*: only a production write path can do that, and the
// column is the thing rotation has to cover. Counting test calls made this
// guard go red for edits that cannot affect rotation coverage at all — 23 of
// its 39 counted calls lived in test files — and a guard that goes red for
// unrelated reasons is one people learn to edit past instead of read.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Where a stored credential could plausibly be written from. */
const SWEPT_ROOTS = ["apps", "packages"] as const;

const SWEPT_EXTENSION = /\.tsx?$/;
const TYPE_DECLARATION_EXTENSION = /\.d\.ts$/;

/** Build output and vendored code: not source anyone edits. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".git",
  "ios",
  "android",
  "target",
]);

/** The crypto helpers' own definitions. They *define* these symbols;
 *  sweeping them would report the implementation as a call site. Their
 *  `.test.ts` siblings need no entry here — `TEST_FILE_PATTERN` already
 *  excludes every test file. */
const CRYPTO_HELPER_FILES = new Set([
  "packages/shared/src/crypto.ts",
  "packages/db/src/helpers/encrypted-field.ts",
]);

/** Test files, by filename. Covers `*.test.ts(x)`, `*.spec.ts(x)` and
 *  therefore `*.integration.test.ts` too. */
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

/** Directories that hold only tests, fixtures or mocks. Everything under
 *  them is excluded whatever the filename — a fixture module named
 *  `seed-credentials.ts` is still not a production write path. */
const TEST_DIRECTORIES = new Set([
  "__tests__",
  "__fixtures__",
  "__mocks__",
  "fixtures",
  "tests",
]);

/** Longest-first so `encryptCredential` is never matched as `encrypt`. */
const CRYPTO_SYMBOLS = [
  "encryptCredential",
  "decryptCredential",
  "encrypt",
  "decrypt",
] as const;

/** A call of one of those symbols that is not a property access
 *  (`obj.encrypt(`) and not part of a longer identifier. */
const CRYPTO_CALL_PATTERN = new RegExp(
  `(?<![\\w.$])(${CRYPTO_SYMBOLS.join("|")})\\s*\\(`,
  "g",
);

const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
/** `[^:]` keeps `https://…` inside a string from eating the line. */
const LINE_COMMENT_PATTERN = /(^|[^:])\/\/[^\n]*/gm;

/** A call site that touches no stored column at all. None today; the
 *  classification exists so a future one can be recorded rather than
 *  silently widening the rotated set. */
const OUT_OF_SCOPE = "out-of-scope" as const;

interface RotatedColumn {
  readonly table: string;
  readonly column: string;
}

interface CryptoCallSite {
  /** `<repo-relative path>:<symbol>`, exactly as the sweep keys it. */
  readonly site: string;
  /** How many calls of that symbol the file makes. */
  readonly calls: number;
  /** The stored column this site reads or writes — which must therefore be
   *  in `ROTATED_COLUMNS` — or OUT_OF_SCOPE with a `note`. */
  readonly column: RotatedColumn | typeof OUT_OF_SCOPE;
  /** Required for OUT_OF_SCOPE; optional colour otherwise. */
  readonly note?: string;
}

const PROJECTS_APPLE: RotatedColumn = {
  table: "projects",
  column: "appleCredentials",
};
const PROJECTS_GOOGLE: RotatedColumn = {
  table: "projects",
  column: "googleCredentials",
};
const COPILOT_API_KEY_COLUMN: RotatedColumn = {
  table: "copilot_credentials",
  column: "api_key_encrypted",
};
const INTEGRATION_CIPHER_COLUMN: RotatedColumn = {
  table: "integration_connections",
  column: "credentials_cipher",
};

/**
 * Every call of `encrypt` / `decrypt` / `encryptCredential` /
 * `decryptCredential` in the **production** sources under `apps/` and
 * `packages/`, classified. Tests and fixtures are out of the sweep, so they
 * never appear here.
 *
 * `projects.appleCredentials` and `projects.googleCredentials` share their
 * call sites: the dashboard route is parameterised by `store`, and the
 * loader decrypts whichever column it was handed. Such a site is recorded
 * against the apple column — the assertion below only needs the SET of
 * columns to match, and both are rotated.
 */
const CRYPTO_CALL_SITES: readonly CryptoCallSite[] = [
  // --- shape A: projects.{apple,google}Credentials ---
  {
    site: "apps/api/src/lib/project-credentials.ts:decryptCredential",
    calls: 1,
    column: PROJECTS_APPLE,
    note: "reads either project credential column, by name",
  },
  {
    site: "apps/api/src/routes/dashboard/credentials.ts:encryptCredential",
    calls: 1,
    column: PROJECTS_GOOGLE,
    note: "writes either project credential column, by `store`",
  },
  // --- shape B: copilot_credentials.api_key_encrypted ---
  {
    site: "apps/api/src/routes/dashboard/copilot/chat.ts:decrypt",
    calls: 1,
    column: COPILOT_API_KEY_COLUMN,
  },
  {
    site: "apps/api/src/routes/dashboard/copilot/credentials.ts:encrypt",
    calls: 1,
    column: COPILOT_API_KEY_COLUMN,
  },
  {
    site: "apps/api/src/routes/dashboard/copilot/credentials.ts:decrypt",
    calls: 1,
    column: COPILOT_API_KEY_COLUMN,
  },
  {
    site: "apps/api/src/services/paywall-ai/generate.ts:decrypt",
    calls: 1,
    column: COPILOT_API_KEY_COLUMN,
  },
  {
    site: "apps/api/src/services/paywall-ai/translate.ts:decrypt",
    calls: 1,
    column: COPILOT_API_KEY_COLUMN,
  },
  // --- shape B: integration_connections.credentials_cipher ---
  {
    site: "apps/api/src/routes/dashboard/integrations.ts:encrypt",
    calls: 4,
    column: INTEGRATION_CIPHER_COLUMN,
  },
  {
    site: "apps/api/src/routes/dashboard/integrations.ts:decrypt",
    calls: 4,
    column: INTEGRATION_CIPHER_COLUMN,
  },
  {
    site: "apps/api/src/workers/integrations-deliver.ts:decrypt",
    calls: 1,
    column: INTEGRATION_CIPHER_COLUMN,
  },
];

function stripComments(source: string): string {
  return source
    .replace(BLOCK_COMMENT_PATTERN, "")
    .replace(LINE_COMMENT_PATTERN, "$1");
}

function* walkSource(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (TEST_DIRECTORIES.has(entry.name)) continue;
      yield* walkSource(full);
    } else if (
      SWEPT_EXTENSION.test(entry.name) &&
      !TYPE_DECLARATION_EXTENSION.test(entry.name) &&
      !TEST_FILE_PATTERN.test(entry.name)
    ) {
      yield full;
    }
  }
}

/** `<repo-relative path>:<symbol>` → number of calls. */
function sweepCryptoCallSites(): Record<string, number> {
  const sites: Record<string, number> = {};
  for (const root of SWEPT_ROOTS) {
    for (const file of walkSource(join(REPO_ROOT, root))) {
      const relativePath = relative(REPO_ROOT, file);
      if (CRYPTO_HELPER_FILES.has(relativePath)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(CRYPTO_CALL_PATTERN)) {
        const key = `${relativePath}:${match[1]}`;
        sites[key] = (sites[key] ?? 0) + 1;
      }
    }
  }
  return sites;
}

function sortColumns(columns: readonly RotatedColumn[]): RotatedColumn[] {
  return [...columns].sort((a, b) =>
    `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`),
  );
}

describe("the encrypted surface", () => {
  it("has no crypto call site outside the classified set", () => {
    // FAILS BY NAME on a new file, a new symbol, or one more call in a file
    // that already had some. Fix by adding the site to CRYPTO_CALL_SITES
    // with the column it touches — and, if that column is not already in
    // ROTATED_COLUMNS, by teaching `buildTargets()` to rotate it.
    const expected: Record<string, number> = {};
    for (const site of CRYPTO_CALL_SITES) expected[site.site] = site.calls;
    expect(sweepCryptoCallSites()).toEqual(expected);
  });

  it("rotates exactly the columns those call sites touch", () => {
    const byName = new Map<string, RotatedColumn>();
    for (const site of CRYPTO_CALL_SITES) {
      if (site.column === OUT_OF_SCOPE) {
        expect(site.note, `${site.site} is OUT_OF_SCOPE without a reason`)
          .toBeTruthy();
        continue;
      }
      byName.set(`${site.column.table}.${site.column.column}`, site.column);
    }
    // Membership, by name: a column reachable from a classified call site
    // but absent from the tool (or the reverse) names itself in the diff.
    expect(sortColumns([...byName.values()])).toEqual(
      sortColumns(ROTATED_COLUMNS),
    );
  });
});

describe("key validation", () => {
  it("rejects a key that is not 64 hex chars", () => {
    expect(() => assertRotatableKeys("deadbeef", NEW_KEY)).toThrow(/OLD_KEY/);
    expect(() => assertRotatableKeys(OLD_KEY, "nope")).toThrow(/NEW_KEY/);
  });

  it("refuses to rotate a key onto itself", () => {
    expect(() => assertRotatableKeys(OLD_KEY, OLD_KEY)).toThrow(/identical/);
  });
});

describe("rotateEncryptionKey", () => {
  it("re-encrypts every column in all three tables under the new key", async () => {
    const summary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });

    expect(summary.rotated).toBe(EXPECTED_ROTATIONS);
    expect(summary.failed).toBe(EXPECTED_FAILURES);

    // --- shape A: the tagged {v,enc} wrapper on projects ---
    const apple = await readColumn(
      "projects",
      "id",
      PROJECT_ENCRYPTED,
      "appleCredentials",
    );
    expect(apple).toMatchObject({ v: 1 });
    expect(
      JSON.parse(decrypt((apple as { enc: string }).enc, NEW_KEY)),
    ).toEqual(APPLE_PLAINTEXT);

    const google = await readColumn(
      "projects",
      "id",
      PROJECT_ENCRYPTED,
      "googleCredentials",
    );
    expect(
      JSON.parse(decrypt((google as { enc: string }).enc, NEW_KEY)),
    ).toEqual(GOOGLE_PLAINTEXT);

    // The legacy plaintext row is now encrypted, and decrypts to what it held.
    const legacy = await readColumn(
      "projects",
      "id",
      PROJECT_LEGACY_PLAINTEXT,
      "appleCredentials",
    );
    expect(legacy).toMatchObject({ v: 1 });
    expect(
      JSON.parse(decrypt((legacy as { enc: string }).enc, NEW_KEY)),
    ).toEqual(LEGACY_PLAINTEXT);

    // --- shape B: bare encrypt() strings ---
    const copilotCipher = (await readColumn(
      "copilot_credentials",
      "project_id",
      PROJECT_ENCRYPTED,
      "api_key_encrypted",
    )) as string;
    expect(decrypt(copilotCipher, NEW_KEY)).toBe(COPILOT_API_KEY);

    const connCipher = (await readColumn(
      "integration_connections",
      "id",
      CONNECTION_OK,
      "credentials_cipher",
    )) as string;
    expect(JSON.parse(decrypt(connCipher, NEW_KEY))).toEqual(
      INTEGRATION_CREDENTIALS,
    );

    // And nothing is still readable under the old key.
    for (const cipher of [copilotCipher, connCipher]) {
      expect(() => decrypt(cipher, OLD_KEY)).toThrow();
    }
  });

  it("leaves NULL credential columns alone instead of failing them", async () => {
    const summary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });
    expect(summary.empty).toBeGreaterThan(0);
    expect(
      await readColumn("projects", "id", PROJECT_EMPTY, "appleCredentials"),
    ).toBeNull();
    expect(
      summary.failures.some((f) => f.rowId === PROJECT_EMPTY),
    ).toBe(false);
  });

  it("is idempotent: a second run rotates nothing and writes nothing", async () => {
    await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });
    const afterFirst = await ciphertextSnapshot();

    const second = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });

    expect(second.rotated).toBe(0);
    expect(second.alreadyRotated).toBeGreaterThan(0);
    // Byte-identical: a re-encryption would have produced a new random IV.
    expect(await ciphertextSnapshot()).toBe(afterFirst);
    // The two permanently-unreadable rows are still reported every run —
    // they never silently disappear from the report.
    expect(second.failed).toBe(EXPECTED_FAILURES);
  });

  it("names every row that decrypts under neither key, and rotates the rest anyway", async () => {
    const summary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });

    const failed = summary.failures.map((f) => `${f.table}.${f.column}:${f.rowId}`);
    expect(failed).toContain(`projects.appleCredentials:${PROJECT_UNDECRYPTABLE}`);
    expect(failed).toContain(
      `integration_connections.credentials_cipher:${CONNECTION_CORRUPT}`,
    );
    expect(failed).toContain(
      `projects.appleCredentials:${PROJECT_SHAPE_B_IN_SHAPE_A}`,
    );
    for (const f of summary.failures) {
      expect(f.reason).not.toBe("");
    }
    // The operator sees them on stdout, not only in a returned object.
    expect(logLines.filter((l) => l.startsWith("[FAIL]"))).toHaveLength(
      EXPECTED_FAILURES,
    );

    // Untouched, not corrupted: still exactly what was written.
    expect(
      await readColumn(
        "integration_connections",
        "id",
        CONNECTION_CORRUPT,
        "credentials_cipher",
      ),
    ).toBe("this-is-not-ciphertext");
    const stillThird = await readColumn(
      "projects",
      "id",
      PROJECT_UNDECRYPTABLE,
      "appleCredentials",
    );
    expect(
      JSON.parse(decrypt((stillThird as { enc: string }).enc, THIRD_KEY)),
    ).toEqual({ lost: true });

    // …and the healthy rows in the SAME tables still rotated.
    const ok = (await readColumn(
      "integration_connections",
      "id",
      CONNECTION_OK,
      "credentials_cipher",
    )) as string;
    expect(JSON.parse(decrypt(ok, NEW_KEY))).toEqual(INTEGRATION_CREDENTIALS);
  });

  it("fails a bare shape-B ciphertext in a shape-A column instead of double-encrypting it", async () => {
    const before = await readColumn(
      "projects",
      "id",
      PROJECT_SHAPE_B_IN_SHAPE_A,
      "appleCredentials",
    );

    const summary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      log: capture,
    });

    // Reported as a failure, by row id, with a reason that says what is
    // wrong — not swallowed as "was stored as plaintext".
    const failure = summary.failures.find(
      (f) => f.rowId === PROJECT_SHAPE_B_IN_SHAPE_A,
    );
    expect(failure).toBeDefined();
    expect(failure?.column).toBe("appleCredentials");
    expect(failure?.reason).toMatch(/iv:tag:data/);

    // Never counted as a rotation, and never wrapped.
    expect(
      logLines.some(
        (l) =>
          l.includes(PROJECT_SHAPE_B_IN_SHAPE_A) && l.includes("plaintext"),
      ),
    ).toBe(false);

    // Byte-identical: the row is left exactly as it was found, still a bare
    // string rather than a `{ v, enc }` wrapper around a ciphertext.
    const after = await readColumn(
      "projects",
      "id",
      PROJECT_SHAPE_B_IN_SHAPE_A,
      "appleCredentials",
    );
    expect(after).toBe(before);
    expect(typeof after).toBe("string");
    expect(JSON.parse(decrypt(after as string, OLD_KEY))).toEqual(
      APPLE_PLAINTEXT,
    );
  });

  it("--dry-run reports the same work but writes nothing", async () => {
    const before = await ciphertextSnapshot();

    const dry: RotationSummary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: true,
      log: capture,
    });

    expect(dry.dryRun).toBe(true);
    expect(dry.rotated).toBe(EXPECTED_ROTATIONS);
    expect(await ciphertextSnapshot()).toBe(before);
  });

  it("rolls the whole run back if a write fails midway", async () => {
    // Force a failure on the LAST table by making its column reject the
    // write, after the first two tables have already been updated in the
    // transaction. If the run were not atomic, projects would be left under
    // NEW_KEY while integration_connections stayed under OLD_KEY — a
    // database no single ENCRYPTION_KEY can read.
    await pool.query(
      `ALTER TABLE integration_connections
         ADD CONSTRAINT rotation_test_block_write
         CHECK (credentials_cipher = 'this-is-not-ciphertext') NOT VALID`,
    );
    try {
      const before = await ciphertextSnapshot();
      await expect(
        rotateEncryptionKey(db, {
          oldKey: OLD_KEY,
          newKey: NEW_KEY,
          log: capture,
        }),
      ).rejects.toThrow();
      expect(await ciphertextSnapshot()).toBe(before);
      // Still readable by the running API, which is still on OLD_KEY.
      const apple = await readColumn(
        "projects",
        "id",
        PROJECT_ENCRYPTED,
        "appleCredentials",
      );
      expect(
        JSON.parse(decrypt((apple as { enc: string }).enc, OLD_KEY)),
      ).toEqual(APPLE_PLAINTEXT);
    } finally {
      await pool.query(
        `ALTER TABLE integration_connections DROP CONSTRAINT rotation_test_block_write`,
      );
    }
  });
});
