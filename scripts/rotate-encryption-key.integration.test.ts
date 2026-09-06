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
const CONNECTION_OK = "conn_rot_ok";
const CONNECTION_CORRUPT = "conn_rot_corrupt";
const USER_ID = "user_rot_test";

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

describe("the encrypted surface", () => {
  it("covers exactly the four known encrypted columns", () => {
    // A membership assertion, not a count: adding a fifth encrypted column
    // without adding it here should fail by NAME, so the diff says which.
    expect([...ROTATED_COLUMNS].sort((a, b) => a.table.localeCompare(b.table)))
      .toEqual(
        [
          { table: "copilot_credentials", column: "api_key_encrypted" },
          { table: "integration_connections", column: "credentials_cipher" },
          { table: "projects", column: "appleCredentials" },
          { table: "projects", column: "googleCredentials" },
        ].sort((a, b) => a.table.localeCompare(b.table)),
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

    // apple×2 encrypted + google×1 + legacy plaintext + copilot + one
    // integration = 5 rotations; the undecryptable project and the corrupt
    // connection fail; the remaining NULLs are empty.
    expect(summary.rotated).toBe(5);
    expect(summary.failed).toBe(2);

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
    expect(second.failed).toBe(2);
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
    for (const f of summary.failures) {
      expect(f.reason).not.toBe("");
    }
    // The operator sees them on stdout, not only in a returned object.
    expect(logLines.filter((l) => l.startsWith("[FAIL]"))).toHaveLength(2);

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

  it("--dry-run reports the same work but writes nothing", async () => {
    const before = await ciphertextSnapshot();

    const dry: RotationSummary = await rotateEncryptionKey(db, {
      oldKey: OLD_KEY,
      newKey: NEW_KEY,
      dryRun: true,
      log: capture,
    });

    expect(dry.dryRun).toBe(true);
    expect(dry.rotated).toBe(5);
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
