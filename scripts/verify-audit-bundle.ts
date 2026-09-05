#!/usr/bin/env tsx
/**
 * Standalone, offline verifier for an audit-proof bundle
 * (`GET /dashboard/audit-logs/proof`, ROADMAP §9.3).
 *
 * An auditor running this is explicitly NOT trusting the server that
 * produced the bundle: this file imports only the canonical hash
 * encoder (`@rovenue/shared/audit-chain`, which itself hits only
 * `node:crypto`) and `node:` builtins. Nothing from `apps/api`, nothing
 * from `packages/db` -- no Rovenue server code runs during verification.
 *
 * Usage:
 *   tsx verify-audit-bundle.ts <path-to-bundle.json>
 *   pnpm --filter @rovenue/scripts verify:audit-bundle <path-to-bundle.json>
 */
import { readFileSync } from "node:fs";
import {
  AUDIT_CHAIN_FORMAT_V1,
  hashAuditRow,
  type AuditChainPayload,
} from "@rovenue/shared/audit-chain";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

export type VerifyFailureReason =
  | "ROW_HASH_MISMATCH"
  | "PREV_HASH_MISMATCH"
  | "UNHASHED_ROW";

export interface VerifyFailure {
  index: number;
  entryId: string;
  reason: VerifyFailureReason;
}

export interface VerifyResult {
  ok: boolean;
  entriesChecked: number;
  /** Mirrors the bundle's own `truncated` flag. A truncated-but-intact
   *  bundle is still `ok: true` -- truncation is a legitimate export
   *  state, not tampering -- but this field rides alongside `ok` so a
   *  programmatic consumer can't read one without the other. */
  truncated: boolean;
  failure?: VerifyFailure;
}

/** The shape a proof-bundle entry must have to be checked at all: the
 *  hashed payload fields (`AuditChainPayload`) plus `id` and `rowHash`.
 *  `rowHash` is typed permissively (`unknown`) because a malformed or
 *  legacy bundle can carry `null` -- that is the `UNHASHED_ROW` case,
 *  not a type error the verifier should throw on. */
type BundleEntry = AuditChainPayload & { id: unknown; rowHash: unknown };

interface ParsedBundle {
  formatVersion: unknown;
  origin: { rowHash: string } | null;
  truncated: unknown;
  entries: BundleEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Strips `id` and `rowHash` off a bundle entry to recover exactly the
 *  fields `hashAuditRow` covers -- the same split the endpoint and its
 *  tests use (`const { id, rowHash, ...payload } = entry`). */
function payloadOf(entry: BundleEntry): AuditChainPayload {
  const { id: _id, rowHash: _rowHash, ...payload } = entry;
  return payload;
}

function entryIdOf(entry: BundleEntry, index: number): string {
  return typeof entry.id === "string" ? entry.id : `<index ${index}>`;
}

function failureResult(
  entriesChecked: number,
  truncated: boolean,
  failure: VerifyFailure,
): VerifyResult {
  return { ok: false, entriesChecked, truncated, failure };
}

/**
 * Verifies an audit-proof bundle entirely offline: recomputes every row
 * hash from its payload and re-walks the prev-hash chain, including the
 * link from the first entry back to the bundle's declared `origin`.
 *
 * Any entry with a missing or null `rowHash` is a hard failure
 * (`UNHASHED_ROW`) -- never skipped and never a soft warning, because a
 * chain with a silently-skipped link proves nothing about the rows
 * around the gap.
 */
export function verifyAuditBundle(bundle: unknown): VerifyResult {
  if (!isRecord(bundle)) {
    // Not a well-formed bundle at all -- there is no `failure` reason
    // that honestly describes this (it isn't a row problem), so it is
    // omitted; `ok: false` alone is the correct signal.
    return { ok: false, entriesChecked: 0, truncated: true };
  }

  // A bundle missing `truncated` entirely has not earned the benefit of
  // the doubt: treat it as truncated rather than assume completeness.
  const truncated = bundle.truncated === false ? false : true;

  if (bundle.formatVersion !== AUDIT_CHAIN_FORMAT_V1) {
    return { ok: false, entriesChecked: 0, truncated };
  }

  const origin = isRecord(bundle.origin)
    ? { rowHash: String(bundle.origin.rowHash) }
    : null;
  const entries = Array.isArray(bundle.entries)
    ? (bundle.entries as BundleEntry[])
    : [];

  let expectedPrevHash: string | null = origin ? origin.rowHash : null;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const entryId = entryIdOf(entry, index);

    if (typeof entry.rowHash !== "string" || entry.rowHash.length === 0) {
      return failureResult(index, truncated, {
        index,
        entryId,
        reason: "UNHASHED_ROW",
      });
    }

    if (entry.prevHash !== expectedPrevHash) {
      return failureResult(index, truncated, {
        index,
        entryId,
        reason: "PREV_HASH_MISMATCH",
      });
    }

    const recomputed = hashAuditRow(payloadOf(entry));
    if (recomputed !== entry.rowHash) {
      return failureResult(index, truncated, {
        index,
        entryId,
        reason: "ROW_HASH_MISMATCH",
      });
    }

    expectedPrevHash = entry.rowHash;
  }

  return { ok: true, entriesChecked: entries.length, truncated };
}

function printResult(result: VerifyResult, path: string): void {
  console.log(`bundle: ${path}`);
  console.log(`truncated: ${result.truncated}`);
  if (result.ok) {
    console.log(`OK -- ${result.entriesChecked} entries verified`);
    return;
  }
  console.error(`FAIL -- ${result.entriesChecked} entries verified before failure`);
  if (result.failure) {
    console.error(
      `  entry #${result.failure.index} (${result.failure.entryId}): ${result.failure.reason}`,
    );
  }
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: verify-audit-bundle.ts <path-to-bundle.json>");
    process.exit(EXIT_FAILURE);
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`failed to read/parse ${path}: ${(err as Error).message}`);
    process.exit(EXIT_FAILURE);
  }

  const result = verifyAuditBundle(bundle);
  printResult(result, path);
  process.exit(result.ok ? EXIT_SUCCESS : EXIT_FAILURE);
}

const isMainModule = process.argv[1]?.endsWith("verify-audit-bundle.ts");
if (isMainModule) {
  main();
}
