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
  | "UNHASHED_ROW"
  | "TIP_MISMATCH"
  | "MALFORMED_BUNDLE"
  | "UNSUPPORTED_FORMAT_VERSION";

export interface VerifyFailure {
  /** `null` for a failure that isn't about one particular entry
   *  (a malformed bundle, an unsupported format version, or a
   *  tip/entries mismatch spanning the whole array). */
  index: number | null;
  entryId: string | null;
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
  /** Present whenever `ok` is `false` -- there is no failure mode this
   *  verifier reports without also naming a reason. */
  failure?: VerifyFailure;
}

/** The shape a proof-bundle entry must have to be checked at all: the
 *  hashed payload fields (`AuditChainPayload`) plus `id` and `rowHash`.
 *  `rowHash` is typed permissively (`unknown`) because a malformed or
 *  legacy bundle can carry `null` -- that is the `UNHASHED_ROW` case,
 *  not a type error the verifier should throw on. */
type BundleEntry = AuditChainPayload & { id: unknown; rowHash: unknown };

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

/** A failure that isn't about one particular entry: the bundle itself
 *  is malformed, declares an unsupported format, or its `tip` doesn't
 *  agree with the entries actually present. */
function wholeBundleFailure(
  entriesChecked: number,
  truncated: boolean,
  reason: VerifyFailureReason,
): VerifyResult {
  return {
    ok: false,
    entriesChecked,
    truncated,
    failure: { index: null, entryId: null, reason },
  };
}

/** A failure tied to one entry at a known position in the chain. */
function entryFailure(
  entriesChecked: number,
  truncated: boolean,
  index: number,
  entryId: string,
  reason: VerifyFailureReason,
): VerifyResult {
  return {
    ok: false,
    entriesChecked,
    truncated,
    failure: { index, entryId, reason },
  };
}

/**
 * Verifies an audit-proof bundle entirely offline: recomputes every row
 * hash from its payload, re-walks the prev-hash chain (including the
 * link from the first entry back to the bundle's declared `origin`),
 * and checks that `tip` actually names the chain's last surviving row.
 *
 * Every failure mode is a HARD failure with a named reason -- there is
 * no soft-pass, no silent default, and no `ok: false` result without a
 * `failure.reason` a caller can act on:
 *
 * - A bundle that isn't a record, or whose `entries` isn't an array, or
 *   whose `origin`/`tip` carries the wrong shape (e.g. an `origin`
 *   object with no string `rowHash`) is `MALFORMED_BUNDLE`. Values are
 *   never coerced into looking valid (`String(undefined)` becoming the
 *   literal `"undefined"` and then comparing equal to nothing is
 *   exactly the failure mode this guards against).
 * - An unrecognized `formatVersion` is `UNSUPPORTED_FORMAT_VERSION`
 *   rather than guessing at a canonical form it doesn't implement.
 * - An entry with a missing or non-string `rowHash` is `UNHASHED_ROW`
 *   -- never skipped, because a chain with a silently-skipped link
 *   proves nothing about the rows around the gap.
 * - A `prevHash` that doesn't match the previous entry's `rowHash` (or
 *   `origin.rowHash` / `null` for the first entry) is
 *   `PREV_HASH_MISMATCH`.
 * - A `rowHash` that doesn't reproduce from its own payload is
 *   `ROW_HASH_MISMATCH`.
 * - A `tip` that disagrees with the last entry actually present --
 *   including a bundle that has entries but no `tip`, or a `tip` but
 *   no entries -- is `TIP_MISMATCH`. This is the only check that can
 *   catch a deleted TAIL: the `prevHash` walk only ever looks
 *   backward, so truncating a chain's newest rows leaves every
 *   remaining link internally consistent.
 */
export function verifyAuditBundle(bundle: unknown): VerifyResult {
  if (!isRecord(bundle)) {
    return wholeBundleFailure(0, true, "MALFORMED_BUNDLE");
  }

  // A bundle missing `truncated` entirely has not earned the benefit of
  // the doubt: treat it as truncated rather than assume completeness.
  const truncated = bundle.truncated === false ? false : true;

  if (bundle.formatVersion !== AUDIT_CHAIN_FORMAT_V1) {
    return wholeBundleFailure(0, truncated, "UNSUPPORTED_FORMAT_VERSION");
  }

  if (!Array.isArray(bundle.entries)) {
    // Missing, null, or non-array `entries` is the single easiest
    // tamper on a bundle (just delete the rows) -- it must never be
    // silently treated as "zero entries, nothing to check".
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE");
  }
  const entries = bundle.entries as BundleEntry[];

  // `origin`, when present, must carry a genuine string `rowHash` --
  // never coerced (`String(undefined)` would otherwise silently become
  // the comparable-looking literal `"undefined"`).
  let origin: { rowHash: string } | null;
  if (bundle.origin === null || bundle.origin === undefined) {
    origin = null;
  } else if (isRecord(bundle.origin) && typeof bundle.origin.rowHash === "string") {
    origin = { rowHash: bundle.origin.rowHash };
  } else {
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE");
  }

  // `tip.rowHash` is legitimately nullable in the wire format (it
  // carries a pre-chain legacy row's null hash through), so unlike
  // `origin` a null value here is a shape the format allows -- whether
  // it's the CORRECT value is decided later, by the tip rule below.
  let tip: { rowHash: string | null } | null;
  if (bundle.tip === null || bundle.tip === undefined) {
    tip = null;
  } else if (
    isRecord(bundle.tip) &&
    (typeof bundle.tip.rowHash === "string" || bundle.tip.rowHash === null)
  ) {
    tip = { rowHash: bundle.tip.rowHash as string | null };
  } else {
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE");
  }

  let expectedPrevHash: string | null = origin ? origin.rowHash : null;

  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    if (!isRecord(raw)) {
      return wholeBundleFailure(index, truncated, "MALFORMED_BUNDLE");
    }
    const entry = raw as BundleEntry;
    const entryId = entryIdOf(entry, index);

    if (typeof entry.rowHash !== "string" || entry.rowHash.length === 0) {
      return entryFailure(index, truncated, index, entryId, "UNHASHED_ROW");
    }

    if (entry.prevHash !== expectedPrevHash) {
      return entryFailure(index, truncated, index, entryId, "PREV_HASH_MISMATCH");
    }

    const recomputed = hashAuditRow(payloadOf(entry));
    if (recomputed !== entry.rowHash) {
      return entryFailure(index, truncated, index, entryId, "ROW_HASH_MISMATCH");
    }

    expectedPrevHash = entry.rowHash;
  }

  // Tip rule: `tip` must be null exactly when there are no entries, and
  // otherwise must name the LAST entry actually present. Every entry
  // that survived the loop above already has a verified string
  // `rowHash`, so this is a plain equality check, not another parse.
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry) {
    if (tip !== null) {
      return wholeBundleFailure(entries.length, truncated, "TIP_MISMATCH");
    }
  } else if (tip === null || tip.rowHash !== (lastEntry.rowHash as string)) {
    return wholeBundleFailure(entries.length, truncated, "TIP_MISMATCH");
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
    const { index, entryId, reason } = result.failure;
    if (index === null) {
      // A whole-bundle failure: nothing entry-specific to point at.
      console.error(`  ${reason}`);
    } else {
      console.error(`  entry #${index} (${entryId}): ${reason}`);
    }
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
