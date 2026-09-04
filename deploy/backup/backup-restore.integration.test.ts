// =============================================================
// backup.sh / restore.sh — a real round trip
// =============================================================
//
// Task 5 (self-hosting §C operations): backup.sh and restore.sh (Tasks 3
// and 4) had never been run against each other with real data. This is
// that run — a real Postgres, a real ClickHouse, a real MinIO, real
// containers, no mocked `pg_dump`/`pg_restore`/`mc`/`age`/`curl`. Known
// rows go in, backup.sh writes an encrypted manifest, everything is
// dropped, restore.sh reads it back, and both the row COUNTS and one
// row's CONTENT are compared byte-for-byte against what went in. A
// restore that silently produced empty tables must fail this test.
//
// The fingerprint guard is asserted in the same test, against the same
// backup, per the task brief: restoring it with a different
// ENCRYPTION_KEY must fail non-zero, not warn.
//
// Everything here is throwaway and isolated from the developer's running
// dev stack (docker ps showed rovenue-db-1 / rovenue-clickhouse-1 /
// rovenue-minio-1 already up while this was written):
//   - Postgres and MinIO run as bare, uniquely-named containers on their
//     own docker networks.
//   - ClickHouse MUST be started via `docker compose` — backup.sh and
//     restore.sh locate its container with
//     `docker compose --project-directory $ROOT_DIR ps -q clickhouse`,
//     which only matches a container carrying compose's own labels. A
//     unique COMPOSE_PROJECT_NAME (threaded through every docker compose
//     call, including the ones inside the scripts, via the env passed to
//     execFile) keeps this run's "clickhouse" service from ever aliasing
//     the dev stack's. An override file replaces its host port publish
//     (compose merges `ports:` by concatenation, not replacement, so the
//     override uses the `!reset` merge tag — verified empirically) so it
//     never fights the dev stack for :8124.
//   - The dev stack's clickhouse/minio host-forwarded ports are not used
//     at all, which sidesteps a real, reproducible failure mode
//     (documented in CLAUDE.md and in the operations doc this task
//     writes): connections to those services THROUGH Docker Desktop's
//     host port forwarding arrive with source IP 192.168.65.1, which
//     ClickHouse's <networks> allow-list rejects (reported to the client
//     as "password is incorrect") and which MinIO's GetBucketLocation
//     query path reproducibly fails on. A `socat` TCP relay container on
//     the SAME docker network as ClickHouse/MinIO, with only ITS OWN port
//     published to the host, launders every connection through a second,
//     docker-network-native hop — verified directly against throwaway
//     containers before writing this file (`mc mirror` and ClickHouse's
//     `BACKUP`/`RESTORE DATABASE` both succeed through the relay; neither
//     succeeds over a directly-published port from this host). This is
//     the same fix CLAUDE.md already prescribes for `db:clickhouse:migrate`
//     / `db:verify:clickhouse`, generalised to MinIO.
//
// Both backup.sh and restore.sh run as real subprocesses (`bash
// deploy/backup/backup.sh ...`), not through any Rovenue application
// code — this proves the SCRIPTS, the actual disaster-recovery artifact,
// not a mocked stand-in for them.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Client as PgClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAssetHeaders } from "../../scripts/verify-asset-headers";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, "..", "..");
const BACKUP_SH = path.join(ROOT_DIR, "deploy/backup/backup.sh");
const RESTORE_SH = path.join(ROOT_DIR, "deploy/backup/restore.sh");
const POSTGRES_DOCKERFILE_DIR = path.join(ROOT_DIR, "deploy/postgres");

// pg_dump/pg_restore/psql matching the server's major version (16) live
// here (Homebrew keg-only formula, not on default PATH) — see the task
// brief and docs/operations/backup-restore.md.
const PG_CLIENT_BIN_DIR = "/opt/homebrew/opt/postgresql@16/bin";

const RUN_ID = randomBytes(4).toString("hex");
const COMPOSE_PROJECT_NAME = `rovenue-backup-it-${RUN_ID}`;
const CLICKHOUSE_CONTAINER = `${COMPOSE_PROJECT_NAME}-clickhouse-1`;
const CLICKHOUSE_NETWORK = `${COMPOSE_PROJECT_NAME}_default`;
const POSTGRES_CONTAINER = `${COMPOSE_PROJECT_NAME}-pg`;
const POSTGRES_IMAGE_TAG = `rovenue-postgres-backup-it-${RUN_ID}`;
const MINIO_NETWORK = `${COMPOSE_PROJECT_NAME}-minio-net`;
const MINIO_CONTAINER = `${COMPOSE_PROJECT_NAME}-minio`;
const MC_ALIAS = `rovenue-backup-it-${RUN_ID}`;
const ASSET_BUCKET = `rovenue-backup-it-${RUN_ID}`;
const MINIO_ROOT_USER = "rovenue-backup-it";
const MINIO_ROOT_PASSWORD = "rovenue-backup-it-secret";

const CLICKHOUSE_WRITE_PASSWORD = "rovenue"; // matches docker-compose.yml's default CLICKHOUSE_PASSWORD_SHA256

const BEFORE_ALL_TIMEOUT_MS = 600_000;
const ROUND_TRIP_TEST_TIMEOUT_MS = 420_000;
const AFTER_ALL_TIMEOUT_MS = 180_000;

const PROJECT_ID = `bkuptest-project-${RUN_ID}`;
const SUBSCRIBER_ID = `bkuptest-subscriber-${RUN_ID}`;
const ROVENUE_ID = `bkuptest-rovenueid-${RUN_ID}`;
const APP_USER_ID = `bkuptest-appuser-${RUN_ID}`;
const CH_EVENT_ID = `bkuptest-event-${RUN_ID}`;
const ASSET_KEY = `${PROJECT_ID}/probe-asset.json`;
const ASSET_BODY = JSON.stringify({ probe: RUN_ID });
// Matches what apps/api's asset-store.ts actually sets at PutObject time
// (CacheControl: `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, immutable`)
// — the exact value the metadata sidecar must carry through backup and
// restore for restore.sh's own verify:asset-headers check to pass.
const SEED_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Must match backup.sh's/restore.sh's own ASSETS_METADATA_SIDECAR_FILENAME
// constant exactly — see either script's comment on it.
const ASSETS_METADATA_SIDECAR_FILENAME = ".rovenue-asset-metadata.json";

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BackupManifest {
  createdAt: string;
  rovenueVersion: string;
  encryptionKeyFingerprint: string;
  postgres: { file: string; encrypted: boolean; bytes: number };
  clickhouse: { database: string; file: string; encrypted: boolean; bytes: number };
  assets: { bucket: string; file: string; encrypted: boolean; fileCount: number; bytes: number };
  skipped: { redis: string; redpanda: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCmd(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
    };
  }
}

function assertOk(label: string, result: CmdResult): void {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (exit ${result.code})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForTcp(port: number, host = "127.0.0.1", attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host });
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(`nothing listening on ${host}:${port} after ${attempts}s`);
}

// A TCP accept on the socat relay does not mean MinIO's own HTTP server
// is done initializing behind it — `mc alias set` (which probes with a
// throwaway bucket + GetBucketLocation) hit "Connection closed by
// foreign host" here until this landed. MinIO's unauthenticated
// liveness endpoint is the real readiness signal.
async function waitForMinioLive(baseUrl: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${baseUrl}/minio/health/live`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`MinIO at ${baseUrl} did not report live in time`);
}

async function waitForHealthy(containerName: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await runCmd("docker", [
      "inspect",
      containerName,
      "--format",
      "{{.State.Health.Status}}",
    ]);
    if (res.code === 0 && res.stdout.trim() === "healthy") return;
    await sleep(2000);
  }
  throw new Error(`${containerName} did not become healthy in time`);
}

async function waitForPostgres(connectionString: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const client = new PgClient({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // already dead
      }
      await sleep(1000);
    }
  }
  throw new Error(`Postgres at ${connectionString} did not become ready in time`);
}

const cleanupFns: Array<() => Promise<void>> = [];
function registerCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}
async function runCleanup(): Promise<void> {
  while (cleanupFns.length > 0) {
    const fn = cleanupFns.pop();
    if (!fn) continue;
    try {
      await fn();
    } catch (err) {
      // Cleanup must not abort partway through — a leaked container from
      // a failed teardown step is a nuisance; leaving the rest of the
      // stack running is worse.
      console.error("backup-restore.integration.test cleanup step failed:", err);
    }
  }
}

let pgPort: number;
let pgUrl: string;
let chBridgePort: number;
let chUrl: string;
let minioBridgePort: number;
let assetPublicBaseUrl: string;
let ageDir: string;
let ageIdentityPath: string;
let ageRecipient: string;
let backupEncryptionKey: string;
let scriptEnv: NodeJS.ProcessEnv;
let chClient: ClickHouseClient;

describe("backup.sh / restore.sh round trip", () => {
  beforeAll(async () => {
    // ---------------------------------------------------------------
    // 1. Postgres — try the real rovenue-postgres image (pg_partman),
    //    fall back to vanilla postgres:16 per the task brief.
    // ---------------------------------------------------------------
    pgPort = await getFreePort();
    let postgresImage = "postgres:16";
    const buildRes = await runCmd(
      "docker",
      ["build", "-q", "-t", POSTGRES_IMAGE_TAG, POSTGRES_DOCKERFILE_DIR],
      { timeout: 120_000 },
    );
    if (buildRes.code === 0) {
      postgresImage = POSTGRES_IMAGE_TAG;
      registerCleanup(async () => {
        await runCmd("docker", ["rmi", "-f", POSTGRES_IMAGE_TAG]);
      });
    } else {
      console.warn(
        `deploy/postgres image build failed or timed out; falling back to postgres:16.\n${buildRes.stderr}`,
      );
    }

    assertOk(
      "docker run postgres",
      await runCmd("docker", [
        "run",
        "-d",
        "--name",
        POSTGRES_CONTAINER,
        "-e",
        "POSTGRES_USER=rovenue",
        "-e",
        "POSTGRES_PASSWORD=rovenue",
        "-e",
        "POSTGRES_DB=rovenue",
        "-p",
        `${pgPort}:5432`,
        postgresImage,
      ]),
    );
    registerCleanup(async () => {
      await runCmd("docker", ["rm", "-f", POSTGRES_CONTAINER]);
    });
    pgUrl = `postgresql://rovenue:rovenue@127.0.0.1:${pgPort}/rovenue`;
    await waitForPostgres(pgUrl);

    // ---------------------------------------------------------------
    // 2. ClickHouse — MUST be a `docker compose` "clickhouse" service
    //    (backup.sh / restore.sh find it via `docker compose ps -q
    //    clickhouse`), under a unique COMPOSE_PROJECT_NAME so it can
    //    never resolve to the dev stack's container. The override
    //    removes the host port publish (compose concatenates `ports:`
    //    across -f files by default; `!reset` genuinely replaces it —
    //    verified against a throwaway container before writing this).
    // ---------------------------------------------------------------
    const overrideDir = await mkdtemp(path.join(tmpdir(), "rovenue-backup-it-compose-"));
    registerCleanup(async () => {
      await rm(overrideDir, { recursive: true, force: true });
    });
    const overrideFile = path.join(overrideDir, "clickhouse-no-publish.yml");
    await writeFile(overrideFile, "services:\n  clickhouse:\n    ports: !reset []\n");

    const composeEnv = { ...process.env, COMPOSE_PROJECT_NAME };
    assertOk(
      "docker compose up clickhouse",
      await runCmd(
        "docker",
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          overrideFile,
          "--project-directory",
          ROOT_DIR,
          "up",
          "-d",
          "clickhouse",
        ],
        { cwd: ROOT_DIR, env: composeEnv },
      ),
    );
    registerCleanup(async () => {
      await runCmd(
        "docker",
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          overrideFile,
          "--project-directory",
          ROOT_DIR,
          "down",
          "-v",
        ],
        { cwd: ROOT_DIR, env: composeEnv },
      );
    });
    await waitForHealthy(CLICKHOUSE_CONTAINER);

    // Relay so the host (and this test, and backup.sh/restore.sh run
    // from the host) never has to cross Docker Desktop's forwarded-port
    // IP-allow-list rejection — see the file header.
    chBridgePort = await getFreePort();
    const chSocatName = `${COMPOSE_PROJECT_NAME}-ch-socat`;
    assertOk(
      "docker run ch socat relay",
      await runCmd("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        chSocatName,
        "--network",
        CLICKHOUSE_NETWORK,
        "-p",
        `${chBridgePort}:${chBridgePort}`,
        "alpine/socat",
        `tcp-listen:${chBridgePort},fork,reuseaddr`,
        "tcp-connect:clickhouse:8123",
      ]),
    );
    registerCleanup(async () => {
      await runCmd("docker", ["rm", "-f", chSocatName]);
    });
    await waitForTcp(chBridgePort);
    chUrl = `http://127.0.0.1:${chBridgePort}`;

    // The image's CLICKHOUSE_DB env var does not reliably create the
    // database on first boot in this configuration (the default user is
    // removed by users.d/rovenue.xml) — clickhouse-migrate.ts's own
    // ensureDatabase() step handles this normally, but we need the
    // database to exist before that if we want to query it early, so
    // create it defensively; IF NOT EXISTS makes this a no-op either way.
    chClient = createClient({
      url: chUrl,
      username: "rovenue",
      password: CLICKHOUSE_WRITE_PASSWORD,
      database: "default",
    });
    await chClient.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });

    // ---------------------------------------------------------------
    // 3. MinIO on its own network + relay, same reasoning as ClickHouse
    //    (the brief's MinIO GetBucketLocation gotcha).
    // ---------------------------------------------------------------
    assertOk(
      "docker network create minio",
      await runCmd("docker", ["network", "create", MINIO_NETWORK]),
    );
    registerCleanup(async () => {
      await runCmd("docker", ["network", "rm", MINIO_NETWORK]);
    });
    assertOk(
      "docker run minio",
      await runCmd("docker", [
        "run",
        "-d",
        "--name",
        MINIO_CONTAINER,
        "--network",
        MINIO_NETWORK,
        "-e",
        `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
        "-e",
        `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}`,
        "minio/minio:RELEASE.2025-04-08T15-41-24Z",
        "server",
        "/data",
      ]),
    );
    registerCleanup(async () => {
      await runCmd("docker", ["rm", "-f", MINIO_CONTAINER]);
    });

    minioBridgePort = await getFreePort();
    const minioSocatName = `${COMPOSE_PROJECT_NAME}-minio-socat`;
    assertOk(
      "docker run minio socat relay",
      await runCmd("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        minioSocatName,
        "--network",
        MINIO_NETWORK,
        "-p",
        `${minioBridgePort}:${minioBridgePort}`,
        "alpine/socat",
        `tcp-listen:${minioBridgePort},fork,reuseaddr`,
        `tcp-connect:${MINIO_CONTAINER}:9000`,
      ]),
    );
    registerCleanup(async () => {
      await runCmd("docker", ["rm", "-f", minioSocatName]);
    });
    await waitForTcp(minioBridgePort);
    const minioEndpoint = `http://127.0.0.1:${minioBridgePort}`;
    await waitForMinioLive(minioEndpoint);
    assetPublicBaseUrl = `${minioEndpoint}/${ASSET_BUCKET}`;

    assertOk(
      "mc alias set",
      await runCmd("mc", [
        "alias",
        "set",
        MC_ALIAS,
        minioEndpoint,
        MINIO_ROOT_USER,
        MINIO_ROOT_PASSWORD,
      ]),
    );
    registerCleanup(async () => {
      await runCmd("mc", ["alias", "remove", MC_ALIAS]);
    });
    assertOk("mc mb", await runCmd("mc", ["mb", `${MC_ALIAS}/${ASSET_BUCKET}`]));

    // Same hand-authored s3:GetObject-only policy as minio-init in
    // docker-compose.yml (deliberately not `mc anonymous set download`,
    // which also grants ListBucket — see deploy/minio/README.md).
    const anonPolicyPath = path.join(overrideDir, "anon-read-policy.json");
    await writeFile(
      anonPolicyPath,
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: ["*"] },
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${ASSET_BUCKET}/*`],
          },
        ],
      }),
    );
    assertOk(
      "mc anonymous set-json",
      await runCmd("mc", ["anonymous", "set-json", anonPolicyPath, `${MC_ALIAS}/${ASSET_BUCKET}`]),
    );

    // Seed one real asset, with the Cache-Control a real upload sets at
    // PutObject time (apps/api's asset-store.ts) — Content-Type is
    // auto-detected by mc from the .json extension, ETag is MinIO's own
    // strong per-object hash, and X-Content-Type-Options: nosniff is
    // MinIO's own default response header — all verified directly
    // against a throwaway MinIO container before writing this test.
    const seedAssetPath = path.join(overrideDir, "probe-asset.json");
    await writeFile(seedAssetPath, ASSET_BODY);
    assertOk(
      "mc cp seed asset",
      await runCmd("mc", [
        "cp",
        "--attr",
        `Cache-Control=${SEED_CACHE_CONTROL}`,
        seedAssetPath,
        `${MC_ALIAS}/${ASSET_BUCKET}/${ASSET_KEY}`,
      ]),
    );

    // ---------------------------------------------------------------
    // 4. age keypair for the backup encryption round trip.
    // ---------------------------------------------------------------
    ageDir = await mkdtemp(path.join(tmpdir(), "rovenue-backup-it-age-"));
    registerCleanup(async () => {
      await rm(ageDir, { recursive: true, force: true });
    });
    ageIdentityPath = path.join(ageDir, "identity.txt");
    const keygenRes = await runCmd("age-keygen", ["-o", ageIdentityPath]);
    assertOk("age-keygen", keygenRes);
    const pubMatch = /Public key:\s*(age1\S+)/.exec(keygenRes.stderr);
    if (!pubMatch) {
      throw new Error(`could not parse age public key from age-keygen output:\n${keygenRes.stderr}`);
    }
    ageRecipient = pubMatch[1];

    backupEncryptionKey = randomBytes(32).toString("hex");

    // ---------------------------------------------------------------
    // 5. Real schema — Drizzle migrations on the throwaway Postgres,
    //    ClickHouse migrations on the throwaway ClickHouse. restore.sh's
    //    own built-in verification (Guard 4) hardcodes five Postgres
    //    table names and runs the real ClickHouse schema-drift verifier,
    //    so a hand-rolled toy schema would make restore.sh fail before
    //    ever reaching the assertions this test cares about.
    // ---------------------------------------------------------------
    const baseScriptEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${PG_CLIENT_BIN_DIR}:${process.env.PATH ?? ""}`,
      DATABASE_URL: pgUrl,
      CLICKHOUSE_URL: chUrl,
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: CLICKHOUSE_WRITE_PASSWORD,
      CLICKHOUSE_WRITE_PASSWORD,
      ENCRYPTION_KEY: backupEncryptionKey,
      ASSET_STORAGE_BUCKET: ASSET_BUCKET,
      ASSET_STORAGE_ENDPOINT: minioEndpoint,
      ASSET_STORAGE_REGION: "us-east-1",
      ASSET_STORAGE_ACCESS_KEY_ID: MINIO_ROOT_USER,
      ASSET_STORAGE_SECRET_ACCESS_KEY: MINIO_ROOT_PASSWORD,
      ASSET_PUBLIC_BASE_URL: assetPublicBaseUrl,
      ASSET_VERIFY_KEY: ASSET_KEY,
      BACKUP_AGE_RECIPIENT: ageRecipient,
      BACKUP_AGE_IDENTITY: ageIdentityPath,
      COMPOSE_PROJECT_NAME,
    };
    scriptEnv = baseScriptEnv;

    assertOk(
      "pnpm db:migrate",
      await runCmd("pnpm", ["--filter", "@rovenue/db", "db:migrate"], {
        cwd: ROOT_DIR,
        env: baseScriptEnv,
        timeout: 180_000,
      }),
    );
    assertOk(
      "pnpm db:clickhouse:migrate",
      await runCmd("pnpm", ["--filter", "@rovenue/db", "db:clickhouse:migrate"], {
        cwd: ROOT_DIR,
        env: baseScriptEnv,
        timeout: 180_000,
      }),
    );
  }, BEFORE_ALL_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await chClient?.close();
    } catch {
      // best effort
    }
    await runCleanup();
  }, AFTER_ALL_TIMEOUT_MS);

  it(
    "round-trips known Postgres/ClickHouse/asset data through a real backup, drop and restore, and rejects a mismatched ENCRYPTION_KEY",
    async () => {
      // -----------------------------------------------------------
      // Known rows in.
      // -----------------------------------------------------------
      const pg = new PgClient({ connectionString: pgUrl });
      await pg.connect();
      try {
        await pg.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
          PROJECT_ID,
          "backup-restore-it project",
        ]);
        await pg.query(
          'INSERT INTO subscribers (id, "projectId", "rovenueId", "appUserId") VALUES ($1, $2, $3, $4)',
          [SUBSCRIBER_ID, PROJECT_ID, ROVENUE_ID, APP_USER_ID],
        );
      } finally {
        await pg.end();
      }

      await chClient.insert({
        table: "rovenue.raw_exposures",
        values: [
          {
            eventId: CH_EVENT_ID,
            experimentId: "bkuptest-experiment",
            variantId: "control",
            projectId: PROJECT_ID,
            subscriberId: SUBSCRIBER_ID,
            platform: "ios",
            country: "US",
            exposedAt: "2026-09-04 00:00:00.000",
          },
        ],
        format: "JSONEachRow",
      });

      const preSubscriberCount = await countRows(pgUrl, "subscribers");
      const preProjectCount = await countRows(pgUrl, "projects");
      expect(preSubscriberCount).toBe(1);
      expect(preProjectCount).toBe(1);

      const preExposureRows = await queryRawExposures();
      expect(preExposureRows).toHaveLength(1);
      expect(preExposureRows[0].eventId).toBe(CH_EVENT_ID);

      // -----------------------------------------------------------
      // backup.sh — a real subprocess, real pg_dump / BACKUP DATABASE /
      // mc mirror / age.
      // -----------------------------------------------------------
      const backupOutDir = await mkdtemp(path.join(tmpdir(), "rovenue-backup-it-out-"));
      registerCleanup(async () => {
        await rm(backupOutDir, { recursive: true, force: true });
      });

      const backupResult = await runCmd(
        "bash",
        [BACKUP_SH, "--out", backupOutDir, "--mc-alias", MC_ALIAS],
        { cwd: ROOT_DIR, env: scriptEnv, timeout: 180_000 },
      );
      assertOk("backup.sh", backupResult);
      expect(backupResult.stdout).toContain("Backup complete");

      const manifestRaw = await readFile(path.join(backupOutDir, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as BackupManifest;

      const expectedFingerprint = createHash("sha256").update(backupEncryptionKey).digest("hex");
      expect(manifest.encryptionKeyFingerprint).toBe(expectedFingerprint);
      expect(manifest.postgres.encrypted).toBe(true);
      expect(manifest.postgres.file).toBe("postgres.dump.age");
      expect(manifest.postgres.bytes).toBeGreaterThan(0);
      expect(manifest.clickhouse.encrypted).toBe(true);
      expect(manifest.clickhouse.file).toBe("clickhouse/clickhouse.zip.age");
      expect(manifest.clickhouse.bytes).toBeGreaterThan(0);
      expect(manifest.assets.encrypted).toBe(true);
      expect(manifest.assets.file).toBe("assets.tar.age");
      expect(manifest.assets.bytes).toBeGreaterThan(0);
      expect(manifest.assets.fileCount).toBe(1);

      // Prove the metadata sidecar backup.sh's capture_assets_metadata
      // wrote is real, not just asserted to exist: decrypt the actual
      // assets archive this run produced and pull the sidecar member back
      // out of the tar, the same way restore.sh would.
      const sidecar = await readAssetsMetadataSidecar(
        path.join(backupOutDir, manifest.assets.file),
        ageIdentityPath,
      );
      console.log(
        `metadata sidecar (${manifest.assets.file}) contents:\n${JSON.stringify(sidecar, null, 2)}`,
      );
      expect(sidecar[ASSET_KEY]).toBeDefined();
      expect(sidecar[ASSET_KEY]["Cache-Control"]).toBe(SEED_CACHE_CONTROL);
      expect(sidecar[ASSET_KEY]["Content-Type"]).toBe("application/json");

      // -----------------------------------------------------------
      // Drop everything — a real disaster, not a filtered subset.
      // -----------------------------------------------------------
      await dropAllPostgresSchemas(pgUrl);
      await chClient.command({ query: "DROP DATABASE IF EXISTS rovenue" });
      assertOk(
        "mc rm --recursive (empty the bucket)",
        await runCmd("mc", ["rm", "--recursive", "--force", `${MC_ALIAS}/${ASSET_BUCKET}/`]),
      );

      const postDropSubscriberTable = await pgTableExists(pgUrl, "subscribers");
      expect(postDropSubscriberTable).toBe(false);

      // -----------------------------------------------------------
      // restore.sh — a real subprocess, asserted to exit 0. The asset
      // metadata sidecar (below) is what makes that possible: restore.sh's
      // own built-in verify:asset-headers check requires the restored
      // Cache-Control to still contain "immutable", which only holds if
      // the object's real S3 metadata survived the tar round trip.
      // -----------------------------------------------------------
      const restoreResult = await runCmd(
        "bash",
        [RESTORE_SH, "--from", backupOutDir, "--mc-alias", MC_ALIAS],
        { cwd: ROOT_DIR, env: scriptEnv, timeout: 240_000 },
      );
      assertOk("restore.sh", restoreResult);

      expect(restoreResult.stdout).toContain("Fingerprint guard OK");
      expect(restoreResult.stdout).toContain("Postgres restore complete");
      expect(restoreResult.stdout).toContain("Object storage restore complete");
      expect(restoreResult.stdout).toContain("ClickHouse restore complete");

      // -----------------------------------------------------------
      // Row counts AND one row's content, verified independently of
      // restore.sh's own summary/exit code — a restore that produced
      // empty tables must not pass this regardless of what the script
      // printed.
      // -----------------------------------------------------------
      const postSubscriberCount = await countRows(pgUrl, "subscribers");
      const postProjectCount = await countRows(pgUrl, "projects");
      expect(postSubscriberCount).toBe(preSubscriberCount);
      expect(postProjectCount).toBe(preProjectCount);

      const restoredSubscriber = await queryOne<{
        id: string;
        projectId: string;
        rovenueId: string;
        appUserId: string;
      }>(pgUrl, 'SELECT id, "projectId", "rovenueId", "appUserId" FROM subscribers WHERE id = $1', [
        SUBSCRIBER_ID,
      ]);
      expect(restoredSubscriber).toEqual({
        id: SUBSCRIBER_ID,
        projectId: PROJECT_ID,
        rovenueId: ROVENUE_ID,
        appUserId: APP_USER_ID,
      });

      const restoredProject = await queryOne<{ id: string; name: string }>(
        pgUrl,
        "SELECT id, name FROM projects WHERE id = $1",
        [PROJECT_ID],
      );
      expect(restoredProject).toEqual({ id: PROJECT_ID, name: "backup-restore-it project" });

      const postExposureRows = await queryRawExposures();
      expect(postExposureRows).toHaveLength(1);
      expect(postExposureRows[0]).toMatchObject({
        eventId: CH_EVENT_ID,
        experimentId: "bkuptest-experiment",
        variantId: "control",
        projectId: PROJECT_ID,
        subscriberId: SUBSCRIBER_ID,
        platform: "ios",
        country: "US",
      });

      // The restored asset's bytes, Content-Type AND Cache-Control all
      // survive the mc-mirror -> tar -> metadata-sidecar -> mc-cp-attr
      // round trip — see capture_assets_metadata (backup.sh) and
      // restore_one_asset_with_metadata (restore.sh). Checked three ways
      // below: the raw HTTP response, `mc stat` directly against MinIO,
      // and verify-asset-headers.ts's own check logic (which restore.sh
      // itself runs as Guard 4 — this is why restoreResult was asserted
      // to exit 0 above).
      const restoredAssetResponse = await fetch(`${assetPublicBaseUrl}/${ASSET_KEY}`);
      expect(restoredAssetResponse.status).toBe(200);
      expect(await restoredAssetResponse.text()).toBe(ASSET_BODY);
      expect(restoredAssetResponse.headers.get("cache-control")).toBe(SEED_CACHE_CONTROL);
      expect(restoredAssetResponse.headers.get("content-type")).toBe("application/json");

      // Query MinIO directly (not just the HTTP response) for the same
      // proof, via the real `mc` binary — independent evidence the
      // restored object's actual S3 metadata, not just what a proxy or
      // cache added in front of it, matches what was originally uploaded.
      const restoredStatResult = await runCmd("mc", [
        "stat",
        "--json",
        `${MC_ALIAS}/${ASSET_BUCKET}/${ASSET_KEY}`,
      ]);
      assertOk("mc stat (restored asset)", restoredStatResult);
      const restoredStat = JSON.parse(restoredStatResult.stdout) as {
        metadata: Record<string, string>;
      };
      console.log(`mc stat --json (restored asset) metadata:\n${JSON.stringify(restoredStat.metadata, null, 2)}`);
      expect(restoredStat.metadata["Cache-Control"]).toBe(SEED_CACHE_CONTROL);
      expect(restoredStat.metadata["Content-Type"]).toBe("application/json");

      const headerCheck = await verifyAssetHeaders(assetPublicBaseUrl, ASSET_KEY);
      expect(headerCheck.failures).toEqual([]);

      // -----------------------------------------------------------
      // Fingerprint guard, against the same backup: a different
      // ENCRYPTION_KEY must fail non-zero, before anything is touched —
      // not a warning, and (per restore.sh's own ordering) before
      // DATABASE_URL is even required, so this needs no live services.
      // -----------------------------------------------------------
      const wrongKeyEnv: NodeJS.ProcessEnv = {
        ...scriptEnv,
        ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      };
      const mismatchResult = await runCmd(
        "bash",
        [RESTORE_SH, "--from", backupOutDir, "--mc-alias", MC_ALIAS],
        { cwd: ROOT_DIR, env: wrongKeyEnv, timeout: 30_000 },
      );
      expect(mismatchResult.code).not.toBe(0);
      expect(mismatchResult.stderr).toContain("ENCRYPTION_KEY fingerprint mismatch");
    },
    ROUND_TRIP_TEST_TIMEOUT_MS,
  );
});

async function countRows(connectionString: string, table: string): Promise<number> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`);
    return Number(res.rows[0].count);
  } finally {
    await client.end();
  }
}

async function queryOne<T extends QueryResultRow>(
  connectionString: string,
  sql: string,
  params: unknown[],
): Promise<T | undefined> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const res = await client.query<T>(sql, params);
    return res.rows[0];
  } finally {
    await client.end();
  }
}

async function pgTableExists(connectionString: string, table: string): Promise<boolean> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ regclass: string | null }>(
      "SELECT to_regclass($1)::text AS regclass",
      [`public.${table}`],
    );
    return res.rows[0].regclass !== null;
  } finally {
    await client.end();
  }
}

async function dropAllPostgresSchemas(connectionString: string): Promise<void> {
  const client = new PgClient({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         AND schema_name NOT LIKE 'pg_toast%'`,
    );
    for (const { schema_name } of rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema_name}" CASCADE`);
    }
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

interface RawExposureRow {
  eventId: string;
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform: string;
  country: string;
}

async function queryRawExposures(): Promise<RawExposureRow[]> {
  const result = await chClient.query({
    query:
      "SELECT eventId, experimentId, variantId, projectId, subscriberId, platform, country FROM rovenue.raw_exposures FINAL WHERE eventId = {eventId:String}",
    query_params: { eventId: CH_EVENT_ID },
    format: "JSONEachRow",
  });
  return (await result.json()) as RawExposureRow[];
}

// Decrypts a real assets archive backup.sh produced and pulls the
// metadata sidecar member back out of the tar — the same two steps
// restore.sh's run_assets_restore performs, done independently here so
// the test can inspect the sidecar's actual content rather than trust
// that it exists.
async function readAssetsMetadataSidecar(
  archivePath: string,
  identityPath: string,
): Promise<Record<string, Record<string, string>>> {
  const decryptedTarPath = `${archivePath}.decrypted-for-test.tar`;
  assertOk(
    "age -d (assets archive, for sidecar inspection)",
    await runCmd("age", ["-d", "-i", identityPath, "-o", decryptedTarPath, archivePath]),
  );
  try {
    const extractResult = await runCmd("tar", [
      "-xO",
      "-f",
      decryptedTarPath,
      ASSETS_METADATA_SIDECAR_FILENAME,
    ]);
    assertOk("tar -xO (metadata sidecar member)", extractResult);
    return JSON.parse(extractResult.stdout) as Record<string, Record<string, string>>;
  } finally {
    await rm(decryptedTarPath, { force: true });
  }
}
