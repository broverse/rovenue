#!/usr/bin/env tsx
/**
 * ENCRYPTION_KEY rotation — re-encrypt every stored ciphertext from
 * OLD_KEY to NEW_KEY, in place, before the deployed env var changes.
 *
 *   DATABASE_URL=… OLD_KEY=<hex> NEW_KEY=<hex> \
 *     pnpm --filter @rovenue/scripts rotate-encryption-key -- --dry-run
 *   DATABASE_URL=… OLD_KEY=<hex> NEW_KEY=<hex> \
 *     pnpm --filter @rovenue/scripts rotate-encryption-key
 *
 * DATABASE_URL is deliberately NOT loaded from the repo's `.env` (unlike
 * the other scripts in this package). This tool rewrites every stored
 * credential in whatever database it is pointed at; an implicit default
 * lifted from a developer's `.env` is the wrong failure mode for that. It
 * must be named explicitly on the command line, and `createPool` throws if
 * it is missing.
 *
 * See docs/runbooks/secret-rotation.md for the full order of operations,
 * the backup-restore interaction, and the two KEY-DERIVED values that this
 * script CANNOT rotate (funnel email hashes and GDPR anonymous ids).
 *
 * ---------------------------------------------------------------------
 * WHAT IS ENCRYPTED, AND IN WHICH OF THE TWO WIRE SHAPES
 * ---------------------------------------------------------------------
 *
 * ENCRYPTION_KEY protects THREE tables, not one. The predecessor of this
 * script knew about `projects` only (and listed a `stripeCredentials`
 * column that migration 0087 had already dropped), so following it during
 * an incident would have left two tables encrypted under the compromised
 * key with no error to say so.
 *
 *   Shape A — tagged JSONB wrapper `{ v: 1, enc: "iv:tag:data" }`
 *     projects.appleCredentials
 *     projects.googleCredentials
 *   Written by `encryptCredential`, read by `decryptCredential`, detected
 *   by `isEncryptedCredential` (packages/db/src/helpers/encrypted-field.ts).
 *   `decryptCredential` also passes UNwrapped plaintext JSON through — rows
 *   predating encryption — so this path encrypts those under NEW_KEY too,
 *   but only when the unwrapped value is a credential OBJECT. A string, a
 *   number, an array or a mangled wrapper is reported as a failure rather
 *   than encrypted (see `describeUnwrappedDamage`).
 *
 *   Shape B — a bare `encrypt()` string, "iv:tag:data", in a text column
 *     copilot_credentials.api_key_encrypted   (an API key)
 *     integration_connections.credentials_cipher (encrypt(JSON.stringify(…)))
 *   Written and read by `encrypt`/`decrypt` from @rovenue/shared/crypto.
 *   `isEncryptedCredential` returns false for these: it requires an object
 *   with `v === 1`, and these are strings. They need their own path, which
 *   is why the two paths below are separate rather than unified.
 *
 * Shape B treats the plaintext as opaque bytes. Whether a column holds a
 * raw key or a JSON document is none of this script's business — it
 * decrypts to a string and re-encrypts that same string.
 *
 * ---------------------------------------------------------------------
 * ATOMICITY AND WHAT HAPPENS IF THE PROCESS DIES
 * ---------------------------------------------------------------------
 *
 * Every write happens inside ONE transaction. These are small configuration
 * tables (one credential row per project, a handful of integrations), so a
 * single transaction is affordable and it buys the property that matters
 * during an incident: there is no such thing as a half-rotated database. If
 * the process is killed, the network drops, or Postgres restarts mid-run,
 * the transaction rolls back and every row is still readable under OLD_KEY
 * — which is the key the still-running API is still configured with.
 *
 * So: the design is NOT resumable in the sense of "picks up where it left
 * off", because it never leaves anything half-done to pick up. A killed run
 * is simply re-run from the start with the same OLD_KEY/NEW_KEY.
 *
 * A COMPLETED run is idempotent: a value that already decrypts under
 * NEW_KEY is skipped, never re-encrypted, and a second run performs zero
 * writes. That is what makes re-running safe when you are unsure whether
 * the previous attempt committed.
 *
 * ---------------------------------------------------------------------
 * CONCURRENT WRITES ARE NOT HANDLED — THIS IS AN OPERATIONAL CONSTRAINT
 * ---------------------------------------------------------------------
 *
 * The selects below take no row locks, and the API stays live on OLD_KEY
 * for the whole run and until it is restarted. A credential saved from the
 * dashboard during that window is either clobbered (this tool's UPDATE
 * lands after it, writing the re-encryption of the value it read earlier)
 * or missed entirely (inserted after the select, so it stays under OLD_KEY
 * and becomes unreadable when the env var flips).
 *
 * `FOR UPDATE` is deliberately NOT used: it cannot lock a row that does not
 * exist yet, so it does not close the missed case, and for the clobbered
 * case it only makes the dashboard's write win with an OLD_KEY ciphertext
 * — a worse end state — at the cost of locking every credential row for the
 * length of the run. The closure is operational and lives in the runbook:
 * freeze credential edits across the run and the restart, then run this
 * tool a SECOND time afterwards (a no-op if nothing was written; it rotates
 * the missed rows if something was).
 *
 * ---------------------------------------------------------------------
 * ROWS THAT DECRYPT UNDER NEITHER KEY
 * ---------------------------------------------------------------------
 *
 * These are reported by table, column and row id, and counted as failures;
 * the process exits 1. They are NOT silently skipped, and they do not abort
 * the run — a row that decrypts under neither key will never rotate no
 * matter how many times the tool is run, so aborting would only guarantee
 * that the rows which CAN rotate never do. The operator gets the exact list
 * and decides (restore from backup, or delete and re-enter the credential).
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import {
  drizzle,
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from "@rovenue/db";
import { decrypt, encrypt, isEncryptedString } from "@rovenue/shared/crypto";

// A 32-byte key rendered as hex — the format ENCRYPTION_KEY itself uses,
// and what `openssl rand -hex 32` produces.
const KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const KEY_HEX_LENGTH = 64;

const DRY_RUN_FLAG = "--dry-run";

const EXIT_FAILURE = 1;

export type Db = typeof drizzle.db;
/** The handle drizzle hands the transaction callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// =============================================================
// Result vocabulary
// =============================================================

/** What happened to a single column of a single row. */
type Outcome =
  /** Already readable under NEW_KEY — nothing written. */
  | { readonly kind: "already-rotated" }
  /** Column is NULL — nothing to rotate. */
  | { readonly kind: "empty" }
  /** Decrypted under OLD_KEY, re-encrypted under NEW_KEY. */
  | { readonly kind: "rotated"; readonly next: unknown; readonly note?: string }
  /** Readable under neither key. Reported, never written. */
  | { readonly kind: "failed"; readonly reason: string };

export interface RotationFailure {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  readonly reason: string;
}

export interface RotationSummary {
  /** Column-values re-encrypted under NEW_KEY. */
  readonly rotated: number;
  /** Column-values already readable under NEW_KEY (a re-run, or a
   *  previously-interrupted run that committed). */
  readonly alreadyRotated: number;
  /** Column-values that were NULL. */
  readonly empty: number;
  /** Column-values readable under neither key. */
  readonly failed: number;
  /** Every failure, named precisely enough to act on. */
  readonly failures: readonly RotationFailure[];
  /** True when --dry-run was passed: the transaction was rolled back. */
  readonly dryRun: boolean;
}

// =============================================================
// Shape A — the tagged `{ v, enc }` wrapper on projects
// =============================================================

/** The keys that make a value *look like* the tagged wrapper. A value
 *  carrying either of them but failing `isEncryptedCredential` is a
 *  corrupted or half-written ciphertext, not a credential. */
const WRAPPER_KEYS = ["v", "enc"] as const;

/**
 * Why a non-wrapper value in a shape-A column is NOT legacy plaintext, or
 * `null` when it genuinely is.
 *
 * The only thing ever written to these columns unwrapped is a credential
 * *object* (`{ issuerId, keyId, privateKey, … }`), which is what
 * `decryptCredential` passes through. A string — in particular a bare
 * shape-B `"iv:tag:data"` ciphertext that landed here by mistake — a
 * number, an array, or a mangled `{ v, enc }` wrapper are all values that
 * must reach the operator's failure report instead of being encrypted.
 */
function describeUnwrappedDamage(value: unknown): string | null {
  if (isEncryptedString(value)) {
    return (
      'value is a bare "iv:tag:data" string in a { v, enc } column — ' +
      "encrypting it would double-encrypt a ciphertext, so it is left as is"
    );
  }
  if (typeof value !== "object") {
    return `value is a bare ${typeof value}, not the { v, enc } wrapper and not a plaintext credential object`;
  }
  if (Array.isArray(value)) {
    return "value is a JSON array, not the { v, enc } wrapper and not a plaintext credential object";
  }
  const obj = value as Record<string, unknown>;
  if (WRAPPER_KEYS.some((key) => key in obj)) {
    return (
      'value carries "v"/"enc" keys but is not a valid ' +
      '{ v: 1, enc: "iv:tag:data" } wrapper — a corrupted or half-written ' +
      "ciphertext, not plaintext"
    );
  }
  return null;
}

function rotateWrapped(
  value: unknown,
  oldKey: string,
  newKey: string,
): Outcome {
  if (value === null || value === undefined) return { kind: "empty" };

  if (!isEncryptedCredential(value)) {
    // "Not the wrapper" is NOT the same as "legacy plaintext". Only a
    // plain JSON object is plaintext this tool may encrypt; anything else
    // in one of these columns is damage, and encrypting it would wrap a
    // value nothing can ever unwrap — reported as an [OK] line, which is
    // the silent-loss failure mode this tool exists to prevent. Shape B
    // has the same guard, for the same reason.
    const damage = describeUnwrappedDamage(value);
    if (damage !== null) return { kind: "failed", reason: damage };

    // A row written before encryption was wired: `decryptCredential`
    // passes it through as plaintext, so the API still reads it. Rotation
    // is the moment to bring it under a key. Not a failure.
    return {
      kind: "rotated",
      next: encryptCredential(value, newKey),
      note: "was stored as plaintext",
    };
  }

  try {
    decryptCredential(value, newKey);
    return { kind: "already-rotated" };
  } catch {
    // Not yet rotated — fall through and try OLD_KEY. AES-GCM
    // authenticates, so a wrong key throws rather than returning garbage,
    // which is what makes this a trustworthy oracle.
  }

  let plaintext: unknown;
  try {
    plaintext = decryptCredential<unknown>(value, oldKey);
  } catch (err) {
    return {
      kind: "failed",
      reason: `decrypts under neither OLD_KEY nor NEW_KEY (${(err as Error).message})`,
    };
  }

  return { kind: "rotated", next: encryptCredential(plaintext, newKey) };
}

// =============================================================
// Shape B — a bare `encrypt()` string in a text column
// =============================================================

function rotateRawString(
  value: unknown,
  oldKey: string,
  newKey: string,
): Outcome {
  if (value === null || value === undefined || value === "") {
    return { kind: "empty" };
  }

  if (!isEncryptedString(value)) {
    // Not "iv:tag:data" at all. Never silently skipped: an unreadable
    // credential the operator does not know about is the failure mode this
    // whole tool exists to prevent.
    return {
      kind: "failed",
      reason: "value is not in iv:tag:data form — cannot be decrypted by any key",
    };
  }

  try {
    decrypt(value, newKey);
    return { kind: "already-rotated" };
  } catch {
    // Fall through to OLD_KEY.
  }

  let plaintext: string;
  try {
    plaintext = decrypt(value, oldKey);
  } catch (err) {
    return {
      kind: "failed",
      reason: `decrypts under neither OLD_KEY nor NEW_KEY (${(err as Error).message})`,
    };
  }

  return { kind: "rotated", next: encrypt(plaintext, newKey) };
}

// =============================================================
// The encrypted surface, enumerated
// =============================================================
//
// One descriptor per encrypted column. Each owns its own select and
// update so the column list is not a string array that has to be kept in
// agreement with a hand-written query somewhere else — which is exactly
// how the predecessor came to list a column that no longer existed.
// Adding a fourth encrypted column means adding one entry here, and the
// summary, the logging and the failure report all pick it up for free.

interface Target {
  readonly table: string;
  readonly column: string;
  select(tx: Tx): Promise<ReadonlyArray<{ rowId: string; value: unknown }>>;
  update(tx: Tx, rowId: string, next: unknown): Promise<void>;
  rotate(value: unknown, oldKey: string, newKey: string): Outcome;
}

/** Soft-deleted rows are rotated too. Their ciphertext is still sitting in
 *  the database under the compromised key, which is the thing being fixed;
 *  and leaving them behind would make the next run report them forever. */
function buildTargets(): readonly Target[] {
  const { projects, copilotCredentials, integrationConnections } = drizzle;

  const wrappedProjectColumn = (
    column: "appleCredentials" | "googleCredentials",
  ): Target => ({
    table: "projects",
    column,
    async select(tx) {
      return await tx
        .select({ rowId: projects.id, value: projects[column] })
        .from(projects);
    },
    async update(tx, rowId, next) {
      await tx
        .update(projects)
        .set({ [column]: next })
        .where(eq(projects.id, rowId));
    },
    rotate: rotateWrapped,
  });

  return [
    wrappedProjectColumn("appleCredentials"),
    wrappedProjectColumn("googleCredentials"),
    {
      table: "copilot_credentials",
      column: "api_key_encrypted",
      async select(tx) {
        return await tx
          .select({
            rowId: copilotCredentials.projectId,
            value: copilotCredentials.apiKeyEncrypted,
          })
          .from(copilotCredentials);
      },
      async update(tx, rowId, next) {
        await tx
          .update(copilotCredentials)
          .set({ apiKeyEncrypted: next as string })
          .where(eq(copilotCredentials.projectId, rowId));
      },
      rotate: rotateRawString,
    },
    {
      table: "integration_connections",
      column: "credentials_cipher",
      async select(tx) {
        return await tx
          .select({
            rowId: integrationConnections.id,
            value: integrationConnections.credentialsCipher,
          })
          .from(integrationConnections);
      },
      async update(tx, rowId, next) {
        await tx
          .update(integrationConnections)
          .set({ credentialsCipher: next as string })
          .where(eq(integrationConnections.id, rowId));
      },
      rotate: rotateRawString,
    },
  ];
}

/** The encrypted columns this tool covers, for the runbook and for tests
 *  that assert the surface has not silently grown. */
export const ROTATED_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
}> = buildTargets().map((t) => ({ table: t.table, column: t.column }));

// =============================================================
// Driver
// =============================================================

export interface RotateOptions {
  readonly oldKey: string;
  readonly newKey: string;
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
}

export function assertRotatableKeys(oldKey: string, newKey: string): void {
  for (const [name, value] of [
    ["OLD_KEY", oldKey],
    ["NEW_KEY", newKey],
  ] as const) {
    if (!KEY_HEX_PATTERN.test(value)) {
      throw new Error(
        `${name} must be ${KEY_HEX_LENGTH} hex chars (32 bytes) — generate with \`openssl rand -hex 32\``,
      );
    }
  }
  if (oldKey.toLowerCase() === newKey.toLowerCase()) {
    throw new Error("OLD_KEY and NEW_KEY are identical — nothing to rotate");
  }
}

/** Signals a deliberate rollback of the --dry-run transaction. Carries the
 *  summary out, because drizzle has no "roll back and return a value". */
class DryRunRollback extends Error {
  constructor(readonly summary: RotationSummary) {
    super("dry-run rollback");
  }
}

export async function rotateEncryptionKey(
  db: Db,
  options: RotateOptions,
): Promise<RotationSummary> {
  const { oldKey, newKey } = options;
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? ((line: string) => console.log(line));

  assertRotatableKeys(oldKey, newKey);

  const targets = buildTargets();

  const run = async (tx: Tx): Promise<RotationSummary> => {
    let rotated = 0;
    let alreadyRotated = 0;
    let empty = 0;
    const failures: RotationFailure[] = [];

    for (const target of targets) {
      const rows = await target.select(tx);
      for (const row of rows) {
        const outcome = target.rotate(row.value, oldKey, newKey);
        switch (outcome.kind) {
          case "empty":
            empty += 1;
            break;
          case "already-rotated":
            alreadyRotated += 1;
            break;
          case "failed":
            failures.push({
              table: target.table,
              column: target.column,
              rowId: row.rowId,
              reason: outcome.reason,
            });
            log(
              `[FAIL] ${target.table}.${target.column} id=${row.rowId} — ${outcome.reason}`,
            );
            break;
          case "rotated":
            if (!dryRun) {
              await target.update(tx, row.rowId, outcome.next);
            }
            rotated += 1;
            log(
              `[${dryRun ? "DRY" : "OK"}]  ${target.table}.${target.column} id=${row.rowId}` +
                (outcome.note ? ` (${outcome.note})` : ""),
            );
            break;
        }
      }
    }

    return { rotated, alreadyRotated, empty, failed: failures.length, failures, dryRun };
  };

  if (!dryRun) {
    return await db.transaction(run);
  }

  // --dry-run still opens a transaction and still rolls it back, so a
  // dry run can never leave a write behind even if the guard above is
  // ever edited wrong.
  try {
    await db.transaction(async (tx) => {
      throw new DryRunRollback(await run(tx));
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.summary;
    throw err;
  }
  /* c8 ignore next */
  throw new Error("unreachable: dry-run transaction did not roll back");
}

export function formatSummary(summary: RotationSummary): string {
  const lines = [
    "",
    `Done${summary.dryRun ? " (dry-run — nothing was written)" : ""}.`,
    `  rotated=${summary.rotated} already-rotated=${summary.alreadyRotated} ` +
      `empty=${summary.empty} failed=${summary.failed}`,
  ];
  if (summary.failures.length > 0) {
    lines.push(
      "",
      "These values did NOT rotate and are still encrypted under a key this",
      "run could not read. Do NOT change the deployed ENCRYPTION_KEY until",
      "each one is resolved (restore from a backup taken under the key that",
      "wrote it, or delete the row and re-enter the credential):",
      "",
    );
    for (const f of summary.failures) {
      lines.push(`  ${f.table}.${f.column} id=${f.rowId} — ${f.reason}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const oldKey = process.env.OLD_KEY ?? "";
  const newKey = process.env.NEW_KEY ?? "";
  const dryRun = process.argv.includes(DRY_RUN_FLAG);

  const pool = drizzle.createPool();
  const db = drizzle.createDb(pool);
  try {
    const summary = await rotateEncryptionKey(db, { oldKey, newKey, dryRun });
    console.log(formatSummary(summary));
    if (summary.failed > 0) process.exitCode = EXIT_FAILURE;
    else if (!dryRun) {
      console.log(
        "\nNow update ENCRYPTION_KEY in the deployed environment to NEW_KEY and\n" +
          "restart every service that reads it. Keep OLD_KEY retrievable for as\n" +
          "long as you retain backups taken under it — see\n" +
          "docs/runbooks/secret-rotation.md.",
      );
    }
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a script; importing this module (tests) must
// not start a rotation.
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = EXIT_FAILURE;
  });
}
