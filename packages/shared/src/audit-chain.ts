import { createHash } from "node:crypto";

// =============================================================
// Audit chain canonical form
// =============================================================
//
// The per-project audit hash chain (apps/api/src/lib/audit.ts) hashes
// each row over this canonical encoding. It lives here, rather than in
// the API, so an external verifier can recompute a hash without
// importing anything from the server it is auditing.
//
// `JSON.stringify` does not guarantee key order across engines. A
// compliance-grade chain must be byte-identical on re-hash, so keys are
// emitted in sorted order and arrays/objects are recursed explicitly.

/** Identifies which canonical encoding a proof bundle's hashes used.
 *  Written into every bundle; a verifier refuses a version it does not
 *  implement rather than guessing. */
export const AUDIT_CHAIN_FORMAT_V1 = "rovenue.audit-chain.v1";

/** Exactly the fields the row hash covers, in the order audit.ts builds
 *  them. Adding or reordering a field changes every subsequent hash. */
export interface AuditChainPayload {
  projectId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** ISO-8601. Stringified by the caller — this module never sees a Date. */
  createdAt: string;
  prevHash: string | null;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(",")}}`;
}

export function hashAuditRow(payload: AuditChainPayload): string {
  return createHash("sha256").update(canonicalJSON(payload)).digest("hex");
}

// =============================================================
// Proof bundle assembly (§9.3)
// =============================================================
//
// A "proof bundle" is exactly the fields `hashAuditRow` covers, plus
// the two identifiers a verifier needs to address and re-link a row
// (`id`, `rowHash`), wrapped with the metadata (`origin`/`tip`/
// `truncated`/`range`) that lets an external verifier confirm the
// bundle's own boundaries without trusting the server that produced
// it. This lives here — not in `apps/api/src/routes/dashboard/
// audit-logs.ts`, the only place that used to build one — so a SECOND
// producer (the CHECKPOINT_TRUNCATE retention strategy,
// `apps/api/src/services/audit-retention/checkpoint.ts`) assembles a
// bundle through the exact same function rather than a hand-rolled
// copy that could silently drift from the `/proof` endpoint's shape.

/** Key prefix every CHECKPOINT_TRUNCATE proof bundle is stored under
 *  (ROADMAP §9.2 Task 5). These bundles live in the SAME private
 *  bucket `apps/api/src/lib/import-store.ts` already manages for
 *  data-import uploads — never a third bucket, and never the public
 *  paywall-asset bucket (see that module's header comment: its MinIO
 *  policy grants anonymous `s3:GetObject` across the WHOLE bucket,
 *  which would publish the audit trail to the internet). Distinct from
 *  `IMPORT_STORAGE_PREFIX` ("imports") so the two namespaces never
 *  collide, and so `workers/import-retention.ts`'s sweep — which only
 *  ever deletes the exact keys it read off an `import_jobs` row, never
 *  scans the bucket — can never reach into this one even by accident. */
export const AUDIT_CHECKPOINT_STORAGE_PREFIX = "audit-checkpoints";

/** Cap on how many rows a single proof bundle may carry — shared by
 *  the `/proof` dashboard endpoint and the CHECKPOINT_TRUNCATE
 *  retention strategy, so a checkpoint bundle is never bigger than
 *  what a human export of the same range would produce. At exactly
 *  the cap, a bundle is otherwise byte-indistinguishable from a
 *  complete export, hence `truncated` below. */
export const AUDIT_PROOF_MAX_ENTRIES = 5000;

/** A proof-bundle row: exactly the fields `hashAuditRow` covers plus
 *  `id` and `rowHash`. `rowHash` is nullable because the column
 *  itself is nullable (rows predating the hash chain have no hash
 *  state) — a bundle must be able to say an unhashed row was in
 *  range rather than silently omit or coerce it. */
export interface AuditProofBundleEntry extends AuditChainPayload {
  id: string;
  rowHash: string | null;
}

export interface AuditProofBundle {
  formatVersion: string;
  projectId: string;
  exportedAt: string;
  // Echoes the caller's requested `from`/`to` (ISO strings, `null` when
  // none was given). `origin` alone cannot distinguish a legitimate
  // ranged export from one whose head rows were deleted -- `origin` is
  // derived from `entries[0].prevHash`, so it is tautologically
  // consistent with `entries` no matter which case produced them.
  // `range` at least tells a reader THIS bundle was requested as a
  // slice.
  range: { from: string | null; to: string | null };
  origin: { rowHash: string } | null;
  tip: { rowHash: string | null; createdAt: string } | null;
  // True when the read hit `maxEntries`: at exactly the cap, a bundle
  // is otherwise byte-indistinguishable from a complete export, and a
  // verifier would wrongly declare a partial segment the whole
  // history. Derived, never trusted from the caller.
  truncated: boolean;
  entries: AuditProofBundleEntry[];
}

/**
 * Assembles a proof bundle from an already chain-ordered (createdAt
 * asc, id asc) read of `entries` — the SAME assembly the `/proof`
 * dashboard endpoint and the CHECKPOINT_TRUNCATE retention strategy
 * both use, so the two can never independently drift on what a
 * "bundle" is.
 *
 * `!= null` (not truthiness) on `firstEntry.prevHash` states the
 * actual intent: an absent `prevHash` is what makes `origin` null, not
 * a falsy string. Hashes are 64 hex chars so an empty string can't
 * occur in practice, but the check should say what it means.
 */
export function assembleAuditProofBundle(args: {
  projectId: string;
  entries: readonly AuditProofBundleEntry[];
  from: string | null;
  to: string | null;
  maxEntries: number;
}): AuditProofBundle {
  const { projectId, entries, from, to, maxEntries } = args;
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];

  const origin: AuditProofBundle["origin"] =
    firstEntry?.prevHash != null ? { rowHash: firstEntry.prevHash } : null;
  const tip: AuditProofBundle["tip"] = lastEntry
    ? { rowHash: lastEntry.rowHash, createdAt: lastEntry.createdAt }
    : null;

  return {
    formatVersion: AUDIT_CHAIN_FORMAT_V1,
    projectId,
    exportedAt: new Date().toISOString(),
    range: { from, to },
    origin,
    tip,
    truncated: entries.length === maxEntries,
    entries: [...entries],
  };
}

// =============================================================
// Offline bundle verifier (§9.3)
// =============================================================
//
// Verifies a proof bundle entirely offline: recomputes every row hash
// from its payload, re-walks the prev-hash chain (including the link
// from the first entry back to the bundle's declared `origin`), and
// checks that `tip` actually names the chain's last surviving row.
// Lives here (not in `scripts/verify-audit-bundle.ts`, which now just
// wraps this as a CLI) so `apps/api`'s own tests can run the exact
// same verifier a standalone auditor would, rather than a
// self-confirming copy — see `apps/api/src/services/audit-retention/
// checkpoint.integration.test.ts`.
//
// This module imports only `node:crypto` (via `hashAuditRow` above),
// so an external verifier — or an internal test — recomputes every
// hash without importing anything else from the server it is
// auditing.

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
  /** Echoes the bundle's own `range` field, whatever it is -- surfaced,
   *  not validated. The verifier has no independent way to confirm the
   *  server actually honoured this range (the same server supplied both
   *  `range` and `entries`), so this is "the bundle claims this range"
   *  information for a caller to weigh, never a pass/fail input.
   *  `undefined` when the bundle has no `range` key at all (a bundle
   *  produced before this field existed), which is distinct from a
   *  bundle that explicitly declares `{ from: null, to: null }`. */
  range?: unknown;
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
  range?: unknown,
): VerifyResult {
  return {
    ok: false,
    entriesChecked,
    truncated,
    range,
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
  range?: unknown,
): VerifyResult {
  return {
    ok: false,
    entriesChecked,
    truncated,
    range,
    failure: { index, entryId, reason },
  };
}

/**
 * Verifies an audit-proof bundle entirely offline. See the module
 * doc comment above; every failure mode is a HARD failure with a
 * named reason -- there is no soft-pass, no silent default, and no
 * `ok: false` result without a `failure.reason` a caller can act on:
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
 * - A `tip` that disagrees with the last entry actually present -- in
 *   `rowHash` OR `createdAt`, including a bundle that has entries but no
 *   `tip`, or a `tip` but no entries -- is `TIP_MISMATCH`. This is the
 *   only check that can catch a deleted TAIL: the `prevHash` walk only
 *   ever looks backward, so truncating a chain's newest rows leaves every
 *   remaining link internally consistent.
 */
export function verifyAuditBundle(bundle: unknown): VerifyResult {
  if (!isRecord(bundle)) {
    return wholeBundleFailure(0, true, "MALFORMED_BUNDLE");
  }

  // A bundle missing `truncated` entirely has not earned the benefit of
  // the doubt: treat it as truncated rather than assume completeness.
  const truncated = bundle.truncated === false ? false : true;

  // `range` is surfaced, never validated (see `VerifyResult.range`): a
  // bundle predating this field simply has no `range` key, which is
  // `undefined` here, distinct from an explicit `{ from: null, to: null }`.
  const range = "range" in bundle ? bundle.range : undefined;

  if (bundle.formatVersion !== AUDIT_CHAIN_FORMAT_V1) {
    return wholeBundleFailure(0, truncated, "UNSUPPORTED_FORMAT_VERSION", range);
  }

  if (!Array.isArray(bundle.entries)) {
    // Missing, null, or non-array `entries` is the single easiest
    // tamper on a bundle (just delete the rows) -- it must never be
    // silently treated as "zero entries, nothing to check".
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE", range);
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
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE", range);
  }

  // `tip.rowHash` is legitimately nullable in the wire format (it
  // carries a pre-chain legacy row's null hash through), so unlike
  // `origin` a null value here is a shape the format allows -- whether
  // it's the CORRECT value is decided later, by the tip rule below.
  // `tip.createdAt` is captured here too (a missing/non-string value
  // becomes `null`, which the tip rule below then treats as a mismatch
  // rather than as a separate malformed-bundle case) so that rule can
  // check it alongside `rowHash`.
  let tip: { rowHash: string | null; createdAt: string | null } | null;
  if (bundle.tip === null || bundle.tip === undefined) {
    tip = null;
  } else if (
    isRecord(bundle.tip) &&
    (typeof bundle.tip.rowHash === "string" || bundle.tip.rowHash === null)
  ) {
    tip = {
      rowHash: bundle.tip.rowHash as string | null,
      createdAt:
        typeof bundle.tip.createdAt === "string" ? bundle.tip.createdAt : null,
    };
  } else {
    return wholeBundleFailure(0, truncated, "MALFORMED_BUNDLE", range);
  }

  let expectedPrevHash: string | null = origin ? origin.rowHash : null;

  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    if (!isRecord(raw)) {
      return wholeBundleFailure(index, truncated, "MALFORMED_BUNDLE", range);
    }
    const entry = raw as BundleEntry;
    const entryId = entryIdOf(entry, index);

    if (typeof entry.rowHash !== "string" || entry.rowHash.length === 0) {
      return entryFailure(index, truncated, index, entryId, "UNHASHED_ROW", range);
    }

    if (entry.prevHash !== expectedPrevHash) {
      return entryFailure(index, truncated, index, entryId, "PREV_HASH_MISMATCH", range);
    }

    const recomputed = hashAuditRow(payloadOf(entry));
    if (recomputed !== entry.rowHash) {
      return entryFailure(index, truncated, index, entryId, "ROW_HASH_MISMATCH", range);
    }

    expectedPrevHash = entry.rowHash;
  }

  // Tip rule: `tip` must be null exactly when there are no entries, and
  // otherwise must name the LAST entry actually present -- both its
  // `rowHash` AND its `createdAt`. Every entry that survived the loop
  // above already has a verified string `rowHash`, so this is a plain
  // equality check, not another parse. A bundle whose `tip.createdAt`
  // disagrees with the last entry's is just as much a lie about "where
  // this chain ends" as a disagreeing `rowHash` would be, so it reuses
  // the same `TIP_MISMATCH` reason rather than getting a new one.
  const lastEntry = entries[entries.length - 1];
  if (!lastEntry) {
    if (tip !== null) {
      return wholeBundleFailure(entries.length, truncated, "TIP_MISMATCH", range);
    }
  } else if (
    tip === null ||
    tip.rowHash !== (lastEntry.rowHash as string) ||
    tip.createdAt !== lastEntry.createdAt
  ) {
    return wholeBundleFailure(entries.length, truncated, "TIP_MISMATCH", range);
  }

  return { ok: true, entriesChecked: entries.length, truncated, range };
}
